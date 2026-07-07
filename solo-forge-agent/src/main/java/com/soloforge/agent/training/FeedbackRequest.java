package com.soloforge.agent.training;

import lombok.Data;

/**
 * 用户反馈请求
 */
@Data
public class FeedbackRequest {
    /** Agent ID (必填) */
    private String agentId;

    /** true=👍 正向反馈, false=👎 负向反馈 */
    private boolean positive;

    /** 用户的原始消息 */
    private String message;

    /** Agent 的回复内容 */
    private String response;

    /** 会话 ID (可选, 用于追踪) */
    private String chatId;

    /** 反馈备注 (可选, 用户可输入文字说明) */
    private String comment;
}
