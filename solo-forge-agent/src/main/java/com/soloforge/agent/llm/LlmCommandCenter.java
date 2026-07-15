package com.soloforge.agent.llm;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.Deque;
import java.util.concurrent.ConcurrentLinkedDeque;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/**
 * LLM 指挥中心 — 全局决策中枢
 *
 * <p>不是被动管道, 而是<b>主动决策的指挥中心</b>。每次 LLM 请求前, 执行器
 * 会问指挥中心 "这个请求能不能发", 指挥中心返回一个决策:
 * <ul>
 *   <li>{@code PROCEED} — 放行, 正常调用 LLM</li>
 *   <li>{@code WAIT} — RPM 限速, 等待指定毫秒后重试</li>
 *   <li>{@code REJECT} — 熔断器打开或并发满载, 拒绝请求</li>
 * </ul>
 *
 * <p>五大核心能力:
 * <ol>
 *   <li><b>熔断器</b> — 连续 5 次 429 → OPEN (拒绝所有) → 30s 后 HALF_OPEN (探测) → 成功则 CLOSED</li>
 *   <li><b>RPM 限速</b> — 滑动窗口 60s, 超限返回 WAIT + 预估等待时间</li>
 *   <li><b>并发控制</b> — Semaphore 限制每个 provider 最大并发数 (动态, 来自 RateLimitProfile)</li>
 *   <li><b>请求去重</b> — 相同请求 (systemPrompt+userMessage+model+temperature 的 SHA-256 指纹)
 *       如果正在飞行中, 后续相同请求等待同一结果 (coalescing); 已完成的缓存 5 分钟</li>
 *   <li><b>容量校验</b> — 检查输入 token 是否超出模型 contextWindow 的 80%</li>
 * </ol>
 *
 * <p>数据流:
 * <pre>
 * SpringAiAgentExecutor.execute()
 *   ├─ commandCenter.checkCapacity()     → 容量溢出直接拒绝
 *   ├─ commandCenter.checkDuplicate()    → 缓存命中直接返回, 不调 LLM
 *   ├─ commandCenter.getInFlight()       → 相同请求等待, 不调 LLM
 *   ├─ commandCenter.registerInFlight()  → 注册为飞行中
 *   ├─ commandCenter.evaluate()          → 熔断器+RPM+并发 → PROCEED/WAIT/REJECT
 *   ├─ chatClient.call()                 → 实际 LLM 调用
 *   ├─ commandCenter.recordSuccess()     → 记录成功, 关闭熔断器
 *   └─ commandCenter.completeRequest()   → 缓存结果, 通知等待者
 * </pre>
 *
 * <p>相关文件:
 * <ul>
 *   <li>{@link RateLimitProfile} — 动态限流配置 (前端模型配置页面传入)</li>
 *   <li>{@code SpringAiAgentExecutor} — 指挥中心的调用方, 在 executor 包</li>
 *   <li>{@code DelegationTools} — 副模型委托工具, 也走指挥中心评估, 在 tools 包</li>
 * </ul>
 */
@Slf4j
@Component
public class LlmCommandCenter {
    /** 获取并发许可的最大等待时间 (秒) */
    private static final int ACQUIRE_TIMEOUT_SEC = 30;
    /** 最大重试次数 (连续 429/503/5xx 时) */
    private static final int MAX_RETRIES = 3;
    /** 指数退避基准延迟 (毫秒) */
    private static final long BASE_BACKOFF_MS = 1_000;
    /** 指数退避最大延迟 (毫秒) */
    private static final long MAX_BACKOFF_MS = 60_000;
    /** 连续 429/503 多少次后触发熔断 */
    private static final int CIRCUIT_OPEN_THRESHOLD = 5;
    /** 熔断器从 OPEN → HALF_OPEN 的恢复等待时间 (毫秒) */
    private static final long CIRCUIT_RESET_MS = 30_000;
    /** 响应缓存有效期 (毫秒, 5 分钟) */
    private static final long CACHE_TTL_MS = 300_000;

    /** Provider 状态注册表: providerKey → ProviderState (限流+熔断+监控) */
    private final Map<String, ProviderState> registry = new ConcurrentHashMap<>();
    /** 正在飞行中的请求: fingerprint → CompletableFuture (用于请求合并) */
    private final Map<String, CompletableFuture<CacheEntry>> inFlight = new ConcurrentHashMap<>();
    /** 已完成的响应缓存: fingerprint → CacheEntry (TTL 5 分钟) */
    private final Map<String, CacheEntry> cache = new ConcurrentHashMap<>();

    // ══ 请求去重 + 响应缓存 ══
    /**
     * 检查是否有相同请求正在进行或已完成
     * @return CacheEntry 如果命中缓存; null 如果需要发起新请求
     */
    public CacheEntry checkDuplicate(String systemPrompt, String userMessage, String model, double temperature) {
        String fp = fingerprint(systemPrompt, userMessage, model, temperature);
        // 1. 检查缓存 (已完成且未过期)
        CacheEntry cached = cache.get(fp);
        if (cached != null && System.currentTimeMillis() - cached.timestamp < CACHE_TTL_MS) {
            log.info("[CommandCenter] CACHE HIT: fp={} age={}ms", fp.substring(0,8), System.currentTimeMillis() - cached.timestamp);
            cached.hitCount.incrementAndGet();
            return cached;
        }
        if (cached != null) cache.remove(fp); // 过期清理
        return null;
    }

    /**
     * 注册一个正在进行的请求 — 后续相同请求会等待它完成
     */
    public CompletableFuture<CacheEntry> registerInFlight(String systemPrompt, String userMessage, String model, double temperature) {
        String fp = fingerprint(systemPrompt, userMessage, model, temperature);
        return inFlight.computeIfAbsent(fp, k -> {
            log.info("[CommandCenter] NEW REQUEST: fp={}", k.substring(0,8));
            return new CompletableFuture<>();
        });
    }

    /**
     * 请求完成后: 缓存结果 + 通知所有等待者
     */
    public void completeRequest(String systemPrompt, String userMessage, String model, double temperature, String response, long latencyMs) {
        String fp = fingerprint(systemPrompt, userMessage, model, temperature);
        CacheEntry entry = new CacheEntry(response, latencyMs);
        cache.put(fp, entry);
        CompletableFuture<CacheEntry> future = inFlight.remove(fp);
        if (future != null) future.complete(entry);
    }

    /**
     * 请求失败: 通知所有等待者
     */
    public void failRequest(String systemPrompt, String userMessage, String model, double temperature, Throwable error) {
        String fp = fingerprint(systemPrompt, userMessage, model, temperature);
        CompletableFuture<CacheEntry> future = inFlight.remove(fp);
        if (future != null) future.completeExceptionally(error);
    }

    /**
     * 检查是否有相同请求正在飞行中
     */
    public CompletableFuture<CacheEntry> getInFlight(String systemPrompt, String userMessage, String model, double temperature) {
        String fp = fingerprint(systemPrompt, userMessage, model, temperature);
        return inFlight.get(fp);
    }

    // ══ 容量校验 ══
    /**
     * 校验请求是否超出模型容量
     * @return null=通过; 非null=错误消息
     */
    public String checkCapacity(String systemPrompt, String userMessage, RateLimitProfile profile) {
        if (profile == null) return null;
        int ctx = profile.getContextWindow();
        if (ctx <= 0) return null; // 无容量数据, 放行
        int inputTokens = estimateTokens(systemPrompt) + estimateTokens(userMessage);
        if (inputTokens > ctx * 0.8) {
            String msg = "Input tokens (" + inputTokens + ") exceed 80% of context window (" + ctx + ")";
            log.warn("[CommandCenter] CAPACITY: {}", msg);
            return msg;
        }
        return null;
    }

    /** 粗略估算 token 数: 英文 ~4字符/token, 中文 ~2字符/token, 取 3 字符/token 折中 */
    private static int estimateTokens(String text) {
        if (text == null) return 0;
        return text.length() / 3 + 1;
    }

    // ══ fingerprint ══
    static String fingerprint(String systemPrompt, String userMessage, String model, double temperature) {
        try {
            String raw = (systemPrompt != null ? systemPrompt : "") + "||" + (userMessage != null ? userMessage : "") + "||" + (model != null ? model : "") + "||" + temperature;
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] hash = md.digest(raw.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (byte b : hash) sb.append(String.format("%02x", b));
            return sb.toString().substring(0, 16);
        } catch (Exception e) {
            return String.valueOf(rawHashCode(systemPrompt, userMessage, model, temperature));
        }
    }
    private static int rawHashCode(String a, String b, String c, double d) {
        return ((a != null ? a : "") + (b != null ? b : "") + (c != null ? c : "") + d).hashCode();
    }

    // ═══════════════════════════════════════════════
    // 决策入口 — 每次 LLM 请求前调用
    // 返回 PROCEED / WAIT / REJECT, 执行器据此决定是否发请求
    // ═══════════════════════════════════════════════
    public LlmDecision evaluate(String baseUrl, String model, RateLimitProfile profile) {
        String key = providerKey(baseUrl, model);
        ProviderState st = getOrCreate(key, profile);
        if (st.circuit == CircuitState.OPEN) {
            if (System.currentTimeMillis() - st.circuitOpenedAt > CIRCUIT_RESET_MS) {
                st.circuit = CircuitState.HALF_OPEN;
                log.info("[CommandCenter] HALF_OPEN: provider={}", key);
            } else {
                log.warn("[CommandCenter] REJECT (circuit OPEN): provider={}", key);
                return LlmDecision.reject("provider=" + key + " circuit open");
            }
        }
        if (!st.checkRpm()) {
            long wait = st.estimateRpmWaitMs();
            log.info("[CommandCenter] WAIT (RPM): provider={} wait={}ms", key, wait);
            return LlmDecision.wait_(wait);
        }
        try {
            if (!st.semaphore.tryAcquire(ACQUIRE_TIMEOUT_SEC, TimeUnit.SECONDS))
                return LlmDecision.reject("provider=" + key + " concurrency full");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return LlmDecision.reject("interrupted");
        }
        return LlmDecision.proceed(key);
    }

    // ═══════════════════════════════════════════════
    // 结果记录 — 每次 LLM 请求后调用, 更新健康状态和熔断器
    // ═══════════════════════════════════════════════
    /** 记录成功: 重置 429 计数, 记录延迟, 如果半开状态则关闭熔断器 */
    public void recordSuccess(String key, long latencyMs) {
        ProviderState st = getOrCreate(key, null);
        st.consecutive429s.set(0); st.failCount.set(0);
        st.recordLatency(latencyMs);
        if (st.circuit == CircuitState.HALF_OPEN) {
            st.circuit = CircuitState.CLOSED;
            log.info("[CommandCenter] CLOSED (recovered): provider={}", key);
        }
    }
    /**
     * 记录失败: 累加 429 计数, 连续达到阈值则触发熔断器 OPEN
     * @param key providerKey
     * @param statusCode HTTP 状态码 (429/503 触发熔断逻辑)
     */
    public void recordFailure(String key, int statusCode) {
        ProviderState st = getOrCreate(key, null);
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
    /** 释放并发许可 — finally 块中调用, 保证不泄漏 */
    public void release(String key) {
        ProviderState st = registry.get(key);
        if (st != null) st.semaphore.release();
    }

    // ═══════════════════════════════════════════════
    // 退避重试 — 429/503/5xx 时的指数退避策略
    // ═══════════════════════════════════════════════
    /** 判断是否应该重试: 429/503/5xx 且未超过最大重试次数 */
    public boolean shouldRetry(Throwable e, int attempt) {
        if (attempt >= MAX_RETRIES) return false;
        int sc = extractStatusCode(e);
        return sc == 429 || sc == 503 || (sc >= 500 && sc < 600) || sc == 0;
    }
    /** 执行退避等待: 优先用 Retry-After 头, 否则指数退避 2^n + 抖动 */
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

    // ═══════════════════════════════════════════════
    // 工具方法 — 静态方法, 供执行器和委托工具共用
    // ═══════════════════════════════════════════════
    /** 生成 provider 唯一标识: "baseUrl|model" */
    public static String providerKey(String baseUrl, String model) {
        return (baseUrl != null ? baseUrl : "?") + "|" + (model != null ? model : "?");
    }
    /** 从异常消息中提取 HTTP 状态码 (正则匹配 "HTTP 429" 等) */
    public static int extractStatusCode(Throwable e) {
        if (e == null || e.getMessage() == null) return 0;
        Matcher m = Pattern.compile("HTTP\\s+(\\d+)").matcher(e.getMessage());
        if (m.find()) try { return Integer.parseInt(m.group(1)); } catch (Exception ignored) {}
        return 0;
    }
    /** 从异常消息中提取 Retry-After 头的值 (秒) */
    public static Long extractRetryAfter(Throwable e) {
        if (e == null || e.getMessage() == null) return null;
        Matcher m = Pattern.compile("(?i)retry-after\\s*[:=]\\s*(\\d+)").matcher(e.getMessage());
        if (m.find()) try { return Long.parseLong(m.group(1)); } catch (Exception ignored) {}
        return null;
    }
    /** 获取或创建 Provider 状态 (首次见到某 provider 时用 profile 初始化) */
    private ProviderState getOrCreate(String key, RateLimitProfile profile) {
        return registry.computeIfAbsent(key, k -> new ProviderState(profile != null ? profile : RateLimitProfile.defaults()));
    }
    /** 获取全部 Provider 状态 (监控/调试用) */
    public Map<String, ProviderState> getRegistry() { return registry; }

    // ═══════════════════════════════════════════════
    // 决策对象 — evaluate() 的返回值
    // ═══════════════════════════════════════════════
    /** LLM 请求决策: 执行器根据 action 决定是否发请求 */
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

    // ═══════════════════════════════════════════════
    // 缓存条目 — 请求去重的缓存值
    // ═══════════════════════════════════════════════
    /** 响应缓存条目: 包含 LLM 响应文本 + 延迟 + 时间戳 + 命中计数 */
    public static class CacheEntry {
        public final String response;
        public final long latencyMs;
        public final long timestamp;
        public final AtomicInteger hitCount = new AtomicInteger(0);
        CacheEntry(String response, long latencyMs) {
            this.response = response; this.latencyMs = latencyMs; this.timestamp = System.currentTimeMillis();
        }
    }

    // ═══════════════════════════════════════════════
    // 熔断器状态机: CLOSED → (连续429) → OPEN → (30s) → HALF_OPEN → (成功) → CLOSED
    // ═══════════════════════════════════════════════
    enum CircuitState { CLOSED, OPEN, HALF_OPEN }

    // ═══════════════════════════════════════════════
    // Provider 状态 — 每个 LLM provider 一份 (限流+熔断+监控 合为一体)
    // 限流参数 (maxConcurrent/maxRpm) 在创建时从 RateLimitProfile 动态注入
    // ═══════════════════════════════════════════════
    public static class ProviderState {
        volatile int maxConcurrent = 3;
        volatile int maxRpm = 50;
        final Semaphore semaphore;
        final Deque<Long> rpmWindow = new ConcurrentLinkedDeque<>();
        final AtomicInteger consecutive429s = new AtomicInteger(0);
        final AtomicInteger failCount = new AtomicInteger(0);
        final AtomicLong totalRequests = new AtomicLong(0);
        final AtomicLong totalLatencyMs = new AtomicLong(0);
        volatile CircuitState circuit = CircuitState.CLOSED;
        volatile long circuitOpenedAt = 0;
        ProviderState(RateLimitProfile p) {
            maxConcurrent = p.getMaxConcurrent();
            maxRpm = p.getMaxRpm();
            semaphore = new Semaphore(maxConcurrent);
        }
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
            return Math.max(200, 60_000L - (System.currentTimeMillis() - oldest));
        }
        void recordLatency(long ms) {
            totalRequests.incrementAndGet();
            totalLatencyMs.addAndGet(ms);
        }
    }
}
