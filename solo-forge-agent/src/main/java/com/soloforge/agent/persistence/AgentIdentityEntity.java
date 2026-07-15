package com.soloforge.agent.persistence;

import lombok.Data;

import java.time.LocalDateTime;

/**
 * Agent 身份实体 (对应 AI Society agent_identity 表)
 *
 * 这是 Agent 的权威配置源，存储在 ai_society.db SQLite 数据库中。
 * Java 端读取此表获取 Agent 配置，Python 端的 PromptOptimizer 可写入此表优化 system_prompt。
 */
@Data
public class AgentIdentityEntity {

    private String id;

    /** 角色: PLANNER / EXECUTOR / REVIEWER / REFLECTOR / GOVERNOR / CUSTOM */
    private String role;

    /** 模型绑定: gpt-4o / claude-3-5-sonnet / glm-5.2 等 */
    private String modelBinding;

    /** 完整 System Prompt (PromptOptimizer 可优化此字段) */
    private String systemPrompt;

    /** System Prompt 版本号 (每次优化自增) */
    private Integer systemPromptVersion;

    /** 当前训练 checkpoint 路径 */
    private String currentCheckpointPath;

    /** Checkpoint 版本号 */
    private Integer checkpointVersion;

    /** 累计任务数 */
    private Integer taskCount;

    /** 关联的 reputation 记录 ID */
    private String reputationId;

    /** 状态: active / paused / deprecated */
    private String status;

    /** 显示名称 */
    private String name;

    /** 头像: emoji 字符 (如 "🎨") 或图片 URL (如 "/avatars/code.png") 或 null */
    private String avatar;

    /** 专业领域: code-dev / planning / debugging / documentation */
    private String domain;

    /** 能力列表 JSON: ["read","write","search","execute","analyze"] */
    private String capabilities;

    /** 决策策略: direct / chain_of_thought */
    private String strategy;

    /** 等级: junior / senior / expert / master */
    private String level;

    /** 温度参数 */
    private Double temperature;

    /** 最大循环轮次 */
    private Integer maxRounds;

    /** 是否启用: 1=启用, 0=禁用 */
    private Integer enabled;

    private LocalDateTime createdAt;
    private LocalDateTime updatedAt;
    private LocalDateTime lastTrainingTime;
}
