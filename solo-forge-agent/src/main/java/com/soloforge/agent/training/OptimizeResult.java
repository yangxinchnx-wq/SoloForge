package com.soloforge.agent.training;

import lombok.Builder;
import lombok.Data;

/**
 * Prompt 优化结果
 */
@Data
@Builder
public class OptimizeResult {
    private String agentId;
    private boolean adopted;          // 是否采纳 (reward 提升 > 阈值)
    private double rewardBefore;
    private double rewardAfter;
    private int versionBefore;
    private int versionAfter;
    private int sampleCount;
    private String notes;
    private String status;            // success / skipped / failed

    public static OptimizeResult skipped(String agentId, String reason) {
        return OptimizeResult.builder()
                .agentId(agentId).adopted(false).status("skipped")
                .notes(reason).build();
    }

    public static OptimizeResult failed(String agentId, String reason) {
        return OptimizeResult.builder()
                .agentId(agentId).adopted(false).status("failed")
                .notes(reason).build();
    }

    public boolean isSuccess() {
        return "success".equals(status) || adopted;
    }
}
