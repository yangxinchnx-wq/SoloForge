package com.soloforge.agent.executor;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.model.ChatResponse;
import reactor.core.publisher.Flux;
import org.springframework.stereotype.Component;

/**
 * 流式响应适配器 — 处理 reasoning_content 与普通文本的分离
 *
 * <p><strong>关键兼容性</strong>: SoloForge 前端依赖 {@code \u0001} 前缀来区分"推理过程"和"最终答案"，
 * 并通过 SSE 分别发送 {@code reasoning} 和 {@code text} 事件。
 *
 * <p>Spring AI 1.0.0 GA 的 {@link ChatResponse} 如果包含 reasoning content（如 DeepSeek-R1 / Claude extended thinking），
 * 此 Adapter 将其转换为带 {@code \u0001} 前缀的字符串流，使下游 ChatController 无需修改 SSE 发送逻辑。
 */
@Component
public class StreamingResponseAdapter {

    private static final Logger log = LoggerFactory.getLogger(StreamingResponseAdapter.class);

    /** reasoning 内容的前缀标记（与前端协议一致） */
    public static final String REASONING_PREFIX = "\u0001";

    /**
     * 将 Spring AI 1.0.0 GA 的 Flux&lt;ChatResponse&gt; 适配为 SoloForge 协议的 Flux&lt;String&gt;
     *
     * <p>转换规则：
     * <ul>
     *   <li>有 reasoningContent → 输出 {@code \u0001} + reasoningContent</li>
     *   <li>无 reasoningContent → 直接输出 text</li>
     *   <li>null/空内容 → 跳过</li>
     * </ul>
     */
    public Flux<String> adapt(Flux<ChatResponse> responseFlux) {
        return responseFlux.flatMapIterable(response -> {
            if (response == null || response.getResults() == null || response.getResults().isEmpty()) {
                return java.util.Collections.emptyList();
            }

            var output = response.getResults().get(0).getOutput();
            java.util.List<String> chunks = new java.util.ArrayList<>(2);

            // 1) Reasoning content（如果有）
            boolean hasReasoning = false;
            try {
                Object reasoningRaw = output.getMetadata().get("reasoning_content");
                if (reasoningRaw != null && !reasoningRaw.toString().isBlank()) {
                    chunks.add(REASONING_PREFIX + reasoningRaw.toString());
                    hasReasoning = true;
                }
            } catch (Exception e) {
                log.debug("No reasoning_content in response metadata: {}", e.getMessage());
            }

            // 2) 普通文本内容
            String text = output.getText();
            if (text != null && !text.isBlank()) {
                chunks.add(text);
            }

            return chunks;
        });
    }
}
