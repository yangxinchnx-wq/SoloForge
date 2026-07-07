package com.soloforge.agent.persistence;

import lombok.Data;

import java.time.LocalDateTime;

/**
 * 经验案例实体 (对应 experience_case 表)
 *
 * 记录用户对 Agent 回复的 👍/👎 反馈及其完整上下文 (用户消息 + 助手回复),
 * 用于:
 *   1. 案例库管理 UI (用户可查看/删除)
 *   2. Agent 调用时检索相似案例作为 few-shot 参考 (RAG)
 *
 * 与 social_memory 表的区别:
 *   social_memory 存"多智能体社会集体事件" (语义混杂, 不适合复用);
 *   experience_case 专存"用户 Q&A 反馈对", 字段语义清晰。
 */
@Data
public class ExperienceCaseEntity {

    /** 主键: case_<uuid12> */
    private String id;

    /** 触发该回复的用户消息 (原始文本) */
    private String userMessage;

    /** Agent 的完整回复 (原始文本) */
    private String assistantResponse;

    /** 反馈: positive / negative / null (未评价) */
    private String feedback;

    /** 用户评语, 可空 */
    private String feedbackComment;

    /** 关联会话 ID, 可空 */
    private String chatId;

    /** 处理该问的 Agent ID */
    private String agentId;

    /** Agent 领域, 冗余便于按域检索 */
    private String domain;

    /** 是否纳入 few-shot 检索池 (1=是, 0=否), 默认 1 */
    private Integer included;

    private LocalDateTime createdAt;

    private LocalDateTime updatedAt;
}
