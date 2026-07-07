package com.soloforge.agent.persistence;

import lombok.Data;

import java.time.LocalDateTime;

/**
 * Agent 训练历史实体 (对应 AI Society agent_training_history 表)
 *
 * 记录每次 PromptOptimizer / MAPPO 训练的 before/after 状态。
 */
@Data
public class AgentTrainingHistoryEntity {

    private String id;

    private String agentId;

    private LocalDateTime trainedAt;

    /** 触发原因: prompt_optimization / mappo_training / manual */
    private String triggerReason;

    private Integer sampleCount;

    private Double rewardBefore;
    private Double rewardAfter;

    private Integer promptVersionBefore;
    private Integer promptVersionAfter;

    private String checkpointPath;
    private String notes;

    private LocalDateTime createdAt;
}
