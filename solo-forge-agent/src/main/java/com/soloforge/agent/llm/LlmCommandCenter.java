package com.soloforge.agent.llm;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.Deque;
import java.util.concurrent.ConcurrentLinkedDeque;

/** LLM 指挥中心 — 全局决策中枢 */
@Slf4j
@Component
public class LlmCommandCenter {
    private static final int DEFAULT_MAX_CONCURRENT = 3;
    private static final int DEFAULT_MAX_RPM = 50;
    private static final int ACQUIRE_TIMEOUT_SEC = 30;
    private static final int MAX_RETRIES = 3;
    private static final long BASE_BACKOFF_MS = 1_000;
    private static final long MAX_BACKOFF_MS = 60_000;
    private static final int CIRCUIT_OPEN_THRESHOLD = 5;
    private static final long CIRCUIT_RESET_MS = 30_000;
    private final Map<String, ProviderState> registry = new ConcurrentHashMap<>();

    // ── 决策入口 ──
    public LlmDecision evaluate(String baseUrl, String model, RateLimitProfile profile) {
        String key = providerKey(baseUrl, model);
        ProviderState st = getOrCreate(key, profile);
        // 1. 熔断器
        if (st.circuit == CircuitState.OPEN) {
            if (System.currentTimeMillis() - st.circuitOpenedAt > CIRCUIT_RESET_MS) {
                st.circuit = CircuitState.HALF_OPEN;
                log.info("[CommandCenter] HALF_OPEN: provider={}", key);
            } else {
                log.warn("[CommandCenter] REJECT (circuit OPEN): provider={}", key);
                return LlmDecision.reject("provider=" + key + " circuit open");
            }
        }
        // 2. RPM 限速
        if (!st.checkRpm()) {
            long wait = st.estimateRpmWaitMs();
            log.info("[CommandCenter] WAIT (RPM): provider={} wait={}ms", key, wait);
            return LlmDecision.wait_(wait);
        }
        // 3. 并发控制
        try {
            if (!st.semaphore.tryAcquire(ACQUIRE_TIMEOUT_SEC, TimeUnit.SECONDS))
                return LlmDecision.reject("provider=" + key + " concurrency full");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return LlmDecision.reject("interrupted");
        }
        return LlmDecision.proceed(key);
    }

    // ── 结果记录 ──
    public void recordSuccess(String key, long latencyMs) {
        ProviderState st = getOrCreate(key, profile);
        st.consecutive429s.set(0);
        st.failCount.set(0);
        st.recordLatency(latencyMs);
        if (st.circuit == CircuitState.HALF_OPEN) {
            st.circuit = CircuitState.CLOSED;
            log.info("[CommandCenter] CLOSED (recovered): provider={}", key);
        }
    }
    public void recordFailure(String key, int statusCode) {
        ProviderState st = getOrCreate(key, profile);
        st.totalRequests.incrementAndGet();
        if (statusCode == 429 || statusCode == 503) {
            int c = st.consecutive429s.incrementAndGet();
            log.warn("[CommandCenter] 429/503: provider={} count={}", key, c);
            if (c >= CIRCUIT_OPEN_THRESHOLD && st.circuit != CircuitState.OPEN) {
                st.circuit = CircuitState.OPEN;
                st.circuitOpenedAt = System.currentTimeMillis();
                log.error("[CommandCenter] CIRCUIT OPEN: provider={} ({} consecutive 429s)", key, c);
            }
        }
    }
    public void release(String key) {
        ProviderState st = registry.get(key);
        if (st != null) st.semaphore.release();
    }

    // ── 退避重试 ──
    public boolean shouldRetry(Throwable e, int attempt) {
        if (attempt >= MAX_RETRIES) return false;
        int sc = extractStatusCode(e);
        return sc == 429 || sc == 503 || (sc >= 500 && sc < 600) || sc == 0;
    }
    public void waitBeforeRetry(Throwable e, int attempt) {
        Long ra = extractRetryAfter(e);
        long delay = calculateBackoff(ra, attempt);
        log.info("[CommandCenter] retry #{}: wait={}ms", attempt + 1, delay);
        try { Thread.sleep(delay); } catch (InterruptedException ex) { Thread.currentThread().interrupt(); }
    }
    private long calculateBackoff(Long retryAfterSec, int attempt) {
        if (retryAfterSec != null && retryAfterSec > 0) {
            long ms = retryAfterSec * 1000L;
            return Math.min(ms + (long)(ms * 0.1 * Math.random()), MAX_BACKOFF_MS);
        }
        long exp = (long)(BASE_BACKOFF_MS * Math.pow(2, attempt));
        long capped = Math.min(exp, MAX_BACKOFF_MS);
        long jitter = (long)(capped * 0.2 * (Math.random() * 2 - 1));
        return Math.max(100, capped + jitter);
    }

    // ── 工具方法 ──
    public static String providerKey(String baseUrl, String model) {
        return (baseUrl != null ? baseUrl : "?") + "|" + (model != null ? model : "?");
    }
    public static int extractStatusCode(Throwable e) {
        if (e == null || e.getMessage() == null) return 0;
        Matcher m = Pattern.compile("HTTP\\s+(\\d+)").matcher(e.getMessage());
        if (m.find()) try { return Integer.parseInt(m.group(1)); } catch (Exception ignored) {}
        return 0;
    }
    public static Long extractRetryAfter(Throwable e) {
        if (e == null || e.getMessage() == null) return null;
        Matcher m = Pattern.compile("(?i)retry-after\\s*[:=]\\s*(\\d+)").matcher(e.getMessage());
        if (m.find()) try { return Long.parseLong(m.group(1)); } catch (Exception ignored) {}
        return null;
    }
    private ProviderState getOrCreate(String key, RateLimitProfile profile) {
        return registry.computeIfAbsent(key, k -> new ProviderState(profile != null ? profile : RateLimitProfile.defaults()));
    }
    public int getAvailablePermits(String key) {
        ProviderState st = registry.get(key);
        return st != null ? st.semaphore.availablePermits() : DEFAULT_MAX_CONCURRENT;
    }
    public Map<String, ProviderState> getRegistry() { return registry; }

    // ── 决策对象 ──
    public static class LlmDecision {
        public enum Action { PROCEED, WAIT, REJECT }
        public final Action action;
        public final String providerKey;
        public final long waitMs;
        public final String reason;
        private LlmDecision(Action a, String key, long wait, String reason) {
            this.action = a; this.providerKey = key; this.waitMs = wait; this.reason = reason;
        }
        static LlmDecision proceed(String key) { return new LlmDecision(Action.PROCEED, key, 0, null); }
        static LlmDecision wait_(long ms) { return new LlmDecision(Action.WAIT, null, ms, "RPM limit"); }
        static LlmDecision reject(String reason) { return new LlmDecision(Action.REJECT, null, 0, reason); }
    }

    // ── 熔断器状态枚举 ──
    enum CircuitState { CLOSED, OPEN, HALF_OPEN }

    // ── Provider 状态 (监控+限流+熔断 合为一体) ──
    public static class ProviderState {
        final Semaphore semaphore = new Semaphore(DEFAULT_MAX_CONCURRENT);
        final Deque<Long> rpmWindow = new ConcurrentLinkedDeque<>();
        final AtomicInteger consecutive429s = new AtomicInteger(0);
        final AtomicInteger failCount = new AtomicInteger(0);
        final AtomicLong totalRequests = new AtomicLong(0);
        final AtomicLong totalLatencyMs = new AtomicLong(0);
        volatile CircuitState circuit = CircuitState.CLOSED;
        volatile long circuitOpenedAt = 0;
        boolean checkRpm() {
            long now = System.currentTimeMillis();
            long start = now - 60_000L;
            while (!rpmWindow.isEmpty() && rpmWindow.peekFirst() != null && rpmWindow.peekFirst() < start)
                rpmWindow.pollFirst();
            if (rpmWindow.size() >= maxRpm) return false;
            rpmWindow.addLast(now);
            return true;
        }
        long estimateRpmWaitMs() {
            if (rpmWindow.isEmpty()) return 200;
            Long oldest = rpmWindow.peekFirst();
            if (oldest == null) return 200;
            long wait = 60_000L - (System.currentTimeMillis() - oldest);
            return Math.max(200, wait);
        }
        void recordLatency(long ms) {
            totalRequests.incrementAndGet();
            totalLatencyMs.addAndGet(ms);
        }
    }
}
