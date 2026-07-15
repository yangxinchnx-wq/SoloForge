package com.soloforge.agent.persistence;

import lombok.Data;

import java.time.LocalDateTime;

/**
 * Agent training history entity (AI Society agent_training_history table)
 *
 * Records before/after status for each PromptOptimizer / MAPPO training run.
 */
@Data
public class AgentTrainingHistoryEntity {

    private String id;

    private String agentId;

    private LocalDateTime trainedAt;

    /** Trigger reason: prompt_optimization / mappo_training / manual */
    private String triggerReason;

    private Integer sampleCount;

    private Double rewardBefore;
    private Double rewardAfter;

    private Integer promptVersionBefore;
    private Integer promptVersionAfter;

    /** Alias fields for PromptOptimizer compatibility */
    private Integer fromVersion;
    private Integer toVersion;
    private Integer taskCount;
    private String comment;
    private Boolean adopted;

    private String checkpointPath;
    private String notes;

    private LocalDateTime createdAt;
}
