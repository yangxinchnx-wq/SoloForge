package com.soloforge.agent.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;
import java.util.Map;

/**
 * 聊天请求 DTO (训练模块使用: PromptOptimizer + DynamicChatModelResolver)
 *
 * 注: 原聊天端点 /api/chat/send 已移除，聊天路径由 RACER (Node.js) 独占。
 * 本 DTO 仅保留 LlmProvider 内部类供训练模块动态指定 LLM Provider。
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

    /** 副模型提供商列表 (并行 worker 使用, 如 Qwen2.5-Coder / DeepSeek-V3 等) */
    private List<LlmProvider> subProviders;

    /** 聊天设置 */
    @Builder.Default
    private ChatSettings settings = new ChatSettings();

    /** 是否流式返回 (默认 true) */
    @Builder.Default
    private Boolean stream = true;

    /** 对话历史 (前端透传, 格式: [{sender:"user"|"assistant", content:"..."}]) */
    private List<Map<String, Object>> history;

    /** 文件上下文 (前端透传, 格式: {name:"xxx", content:"..."}) */
    private Map<String, Object> fileContext;

    /**
     * LLM 提供商配置
     */
    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class LlmProvider {
        private String name;
        private String baseUrl;
        private String apiKey;
        private String model;
        /** 备用模型列表 (主模型失败时降级) */
        private String[] fallbackModels;
    }
}
