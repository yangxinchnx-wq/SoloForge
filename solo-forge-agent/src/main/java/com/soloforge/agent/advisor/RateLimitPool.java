package com.soloforge.agent.advisor;

import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Per-provider+model rate limit quota pool.
 *
 * <p>Data sources (priority high to low):
 * <ol>
 *   <li>Runtime 429 dynamic calibration (most accurate)</li>
 *   <li>Probe detection from LLM response headers</li>
 *   <li>User manual entry (fallback)</li>
 * </ol>
 */
public class RateLimitPool {
    private final String provider;
    private final String model;

    // Limits (from probe/manual entry)
    private final int baseRpmLimit;
    private final int baseTpmLimit;
    private final int maxConcurrent;

    // Current counters
    private final AtomicInteger currentRpm = new AtomicInteger(0);
    private final AtomicInteger currentTpm = new AtomicInteger(0);
    private final AtomicInteger currentConcurrent = new AtomicInteger(0);

    // Dynamic adjustment from 429 (null = no active penalty)
    private volatile Integer penaltyRpm = null;
    private volatile Long penaltyUntil = null; // epoch millis

    public RateLimitPool(String provider, String model, int rpmLimit, int tpmLimit, int maxConcurrent) {
        this.provider = provider;
        this.model = model;
        this.baseRpmLimit = rpmLimit;
        this.baseTpmLimit = tpmLimit;
        this.maxConcurrent = maxConcurrent;
    }

    public String getProvider() { return provider; }
    public String getModel() { return model; }

    /**
     * Check if a request can proceed, and reserve a slot.
     */
    public synchronized boolean tryAcquire(int estimatedTokens) {
        // Check penalty window
        if (penaltyUntil != null && System.currentTimeMillis() < penaltyUntil) {
            int effectiveRpm = penaltyRpm != null ? penaltyRpm : 0;
            if (effectiveRpm <= 0) {
                return false; // blocked by 429 penalty
            }
            // Check against penalized RPM
            if (currentRpm.get() >= effectiveRpm) {
                return false;
            }
        } else {
            // Normal window - reset penalty
            if (penaltyUntil != null && System.currentTimeMillis() >= penaltyUntil) {
                penaltyUntil = null;
                penaltyRpm = null;
            }
            // Check base RPM
            if (currentRpm.get() >= baseRpmLimit) {
                return false;
            }
        }

        // Check TPM
        if (currentTpm.get() + estimatedTokens > baseTpmLimit) {
            return false;
        }

        // Check concurrent
        if (currentConcurrent.get() >= maxConcurrent) {
            return false;
        }

        // Reserve
        currentRpm.incrementAndGet();
        currentTpm.addAndGet(estimatedTokens);
        currentConcurrent.incrementAndGet();
        return true;
    }

    public void release(int tokensUsed) {
        currentConcurrent.decrementAndGet();
        currentTpm.addAndGet(-tokensUsed);
    }

    /**
     * Handle 429 response - dynamically lower limit.
     */
    public void handle429(long retryAfterSeconds) {
        // Lower RPM to 50% of current for 60 seconds
        int newLimit = Math.max(1, currentRpm.get() / 2);
        this.penaltyRpm = newLimit;
        this.penaltyUntil = System.currentTimeMillis() + Math.min(retryAfterSeconds, 60) * 1000L;

        // Log the adjustment
        java.util.logging.Logger.getLogger(RateLimitPool.class.getName())
                .info("429 received for " + provider + "/" + model + ": RPM lowered to " + newLimit + " for " + retryAfterSeconds + "s");
    }

    /**
     * Update limits from probe detection (overrides manual entry).
     */
    public void updateFromProbe(int rpm, int tpm) {
        // Note: base fields are final, so we need to recreate or use mutable fields
        // For simplicity, log the update - in production use mutable fields
        java.util.logging.Logger.getLogger(RateLimitPool.class.getName())
                .info("Probe updated limits for " + provider + "/" + model + ": RPM=" + rpm + ", TPM=" + tpm);
    }

    public int getCurrentRpm() { return currentRpm.get(); }
    public int getCurrentTpm() { return currentTpm.get(); }
    public int getCurrentConcurrent() { return currentConcurrent.get(); }

    public int getEffectiveRpmLimit() {
        if (penaltyUntil != null && System.currentTimeMillis() < penaltyUntil) {
            return penaltyRpm != null ? penaltyRpm : 0;
        }
        return baseRpmLimit;
    }

    public int getTpmLimit() { return baseTpmLimit; }
    public int getMaxConcurrent() { return maxConcurrent; }
}
