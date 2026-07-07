package com.soloforge.agent.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * 聊天请求 (前端 POST /api/chat/send 的请求体)
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class ChatRequest {

    /** 用户消息内容 */
    private String message;

    /** 会话 ID */
    private String sessionId;

    /** LLM 提供商配置 (动态注入, 不依赖 application.yml) */
    private LlmProvider provider;

    /** 聊天设置 */
    @Builder.Default
    private ChatSettings settings = new ChatSettings();

    /** 是否流式返回 (默认 true) */
    @Builder.Default
    private Boolean stream = true;

    /**
     * LLM 提供商配置
     */
    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class LlmProvider {
        private String baseUrl;
        private String apiKey;
        private String model;
        /** 备用模型列表 (主模型失败时降级) */
        private String[] fallbackModels;
    }
}
