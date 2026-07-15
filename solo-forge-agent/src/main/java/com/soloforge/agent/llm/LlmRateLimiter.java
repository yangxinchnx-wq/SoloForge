package com.soloforge.agent.llm;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

@Slf4j
@Component
public class LlmRateLimiter {

    private static final int MAX_CONCURRENT_PER_PROVIDER = 3;
    private static final int MAX_RPM_PER_PROVIDER = 50;
    private static final int ACQUIRE_TIMEOUT_SECONDS = 30;
    private static final int MAX_RETRIES = 3;
    private static final long BASE_BACKOFF_MS = 1_000;
    private static final long MAX_BACKOFF_MS = 60_000;

    private final Map<String, ProviderLimitState> states = new ConcurrentHashMap<>();

    private ProviderLimitState getOrCreate(String providerKey) {
        return states.computeIfAbsent(providerKey, k -> new ProviderLimitState());
    }

    public static String providerKey(String baseUrl, String model) {
        return (baseUrl != null ? baseUrl : "unknown") + "|" + (model != null ? model : "unknown");
    }

    public void acquire(String providerKey) {
        ProviderLimitState state = getOrCreate(providerKey);
        try {
            boolean acquired = state.concurrencySemaphore.tryAcquire(ACQUIRE_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            if (!acquired) {
                throw new RuntimeException("LLM 并发限流超时: provider=" + providerKey);
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new RuntimeException("获取 LLM 并发许可被中断", e);
        }
    }

    public void release(String providerKey) {
        ProviderLimitState state = states.get(providerKey);
        if (state != null) {
            state.concurrencySemaphore.release();
        }
    }

    public boolean checkRpm(String providerKey) {
        ProviderLimitState state = getOrCreate(providerKey);
        return state.checkAndRecordRpm();
    }

    public void waitForRpmSlot(String providerKey) {
        ProviderLimitState state = getOrCreate(providerKey);
        long waitStart = System.currentTimeMillis();
        while (!state.checkAndRecordRpm()) {
            long elapsed = System.currentTimeMillis() - waitStart;
            if (elapsed > ACQUIRE_TIMEOUT_SECONDS * 1000L) {
                log.warn("RPM 等待超时: provider={}, 强行放行", providerKey);
                break;
            }
            try {
                Thread.sleep(200);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
        }
    }

    public boolean shouldRetry(int statusCode, int attempt) {
        if (attempt >= MAX_RETRIES) return false;
        return statusCode == 429 || statusCode == 503 || (statusCode >= 500 && statusCode < 600) || statusCode == 0;
    }

    public long calculateBackoffMs(Long retryAfterSeconds, int attempt) {
        if (retryAfterSeconds != null && retryAfterSeconds > 0) {
            long retryAfterMs = retryAfterSeconds * 1000L;
            long jitter = (long) (retryAfterMs * 0.1 * Math.random());
            return Math.min(retryAfterMs + jitter, MAX_BACKOFF_MS);
        }
        long expDelay = (long) (BASE_BACKOFF_MS * Math.pow(2, attempt));
        long capped = Math.min(expDelay, MAX_BACKOFF_MS);
        long jitter = (long) (capped * 0.2 * (Math.random() * 2 - 1));
        return Math.max(100, capped + jitter);
    }

    public void waitBeforeRetry(Long retryAfterSeconds, int attempt) {
        long delayMs = calculateBackoffMs(retryAfterSeconds, attempt);
        log.info("LLM 退避重试 #{}: 等待 {}ms (retryAfter={}s)", attempt + 1, delayMs, retryAfterSeconds);
        try {
            Thread.sleep(delayMs);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    public static int extractStatusCode(Throwable e) {
        if (e == null || e.getMessage() == null) return 0;
        Pattern pattern = Pattern.compile("HTTP\\s+(\\d+)");
        Matcher matcher = pattern.matcher(e.getMessage());
        if (matcher.find()) {
            try { return Integer.parseInt(matcher.group(1)); } catch (NumberFormatException ignored) {}
        }
        return 0;
    }

    public static Long extractRetryAfter(Throwable e) {
        if (e == null || e.getMessage() == null) return null;
        Pattern pattern = Pattern.compile("(?i)retry-after\\s*[:=]\\s*(\\d+)");
        Matcher matcher = pattern.matcher(e.getMessage());
        if (matcher.find()) {
            try { return Long.parseLong(matcher.group(1)); } catch (NumberFormatException ignored) {}
        }
        return null;
    }

    public void recordSuccess(String providerKey) {
        ProviderLimitState state = states.get(providerKey);
        if (state != null) { state.consecutive429s.set(0); }
    }

    public void record429(String providerKey) {
        ProviderLimitState state = getOrCreate(providerKey);
        int count = state.consecutive429s.incrementAndGet();
        log.warn("LLM 429 限流: provider={} 连续 {} 次", providerKey, count);
    }

    public int getAvailablePermits(String providerKey) {
        ProviderLimitState state = states.get(providerKey);
        return state != null ? state.concurrencySemaphore.availablePermits() : MAX_CONCURRENT_PER_PROVIDER;
    }

    private static class ProviderLimitState {
        final Semaphore concurrencySemaphore = new Semaphore(MAX_CONCURRENT_PER_PROVIDER);
        final java.util.Deque<Long> rpmWindow = new java.util.concurrent.ConcurrentLinkedDeque<>();
        final AtomicInteger consecutive429s = new AtomicInteger(0);

        boolean checkAndRecordRpm() {
            long now = System.currentTimeMillis();
            long windowStart = now - 60_000L;
            while (!rpmWindow.isEmpty() && rpmWindow.peekFirst() != null && rpmWindow.peekFirst() < windowStart) {
                rpmWindow.pollFirst();
            }
            if (rpmWindow.size() >= MAX_RPM_PER_PROVIDER) { return false; }
            rpmWindow.addLast(now);
            return true;
        }
    }
}
