package com.soloforge.agent.llm;

import com.soloforge.agent.dto.ChatRequest;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;

import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * LLM Gateway
 *
 * 动态多 provider 支持: 每次请求从 ChatRequest.provider 注入 baseUrl/apiKey/model,
 * 不依赖 application.yml 的静态配置。
 *
 * 支持 OpenAI 兼容协议 (OpenAI / Claude / DeepSeek / GLM / 通义千问等)
 */
@Slf4j
@Component
public class LlmGateway {

    private static final Duration TIMEOUT = Duration.ofSeconds(120);

    /**
     * 同步调用 LLM (非流式)
     */
    public String chatCompletion(String systemPrompt,
                                  String userMessage,
                                  List<Map<String, String>> history,
                                  ChatRequest.LlmProvider provider,
                                  List<Map<String, Object>> tools) {
        ChatRequest.LlmProvider resolved = resolveProvider(provider);
        log.info("LLM call: baseUrl={} model={}", resolved.getBaseUrl(), resolved.getModel());

        try {
            WebClient client = buildClient(resolved);
            Map<String, Object> body = buildRequestBody(systemPrompt, userMessage, history, resolved, tools, false);

            Map<String, Object> response = client.post()
                .uri("/chat/completions")
                .bodyValue(body)
                .retrieve()
                .bodyToMono(Map.class)
                .timeout(TIMEOUT)
                .block();

            return extractContent(response);
        } catch (Exception e) {
            log.error("LLM call failed: {}", e.getMessage());
            // 降级到 fallback 模型
            if (resolved.getFallbackModels() != null && resolved.getFallbackModels().length > 0) {
                log.info("Falling back to: {}", resolved.getFallbackModels()[0]);
                ChatRequest.LlmProvider fallback = ChatRequest.LlmProvider.builder()
                    .baseUrl(resolved.getBaseUrl())
                    .apiKey(resolved.getApiKey())
                    .model(resolved.getFallbackModels()[0])
                    .build();
                return chatCompletion(systemPrompt, userMessage, history, fallback, tools);
            }
            throw new RuntimeException("LLM 调用失败: " + e.getMessage(), e);
        }
    }

    private WebClient buildClient(ChatRequest.LlmProvider provider) {
        return WebClient.builder()
            .baseUrl(provider.getBaseUrl())
            .defaultHeader(HttpHeaders.AUTHORIZATION, "Bearer " + provider.getApiKey())
            .defaultHeader(HttpHeaders.CONTENT_TYPE, MediaType.APPLICATION_JSON_VALUE)
            .build();
    }

    private Map<String, Object> buildRequestBody(String systemPrompt,
                                                   String userMessage,
                                                   List<Map<String, String>> history,
                                                   ChatRequest.LlmProvider provider,
                                                   List<Map<String, Object>> tools,
                                                   boolean stream) {
        List<Map<String, String>> messages = new ArrayList<>();

        // System prompt
        if (systemPrompt != null && !systemPrompt.isBlank()) {
            messages.add(Map.of("role", "system", "content", systemPrompt));
        }

        // History
        if (history != null) {
            messages.addAll(history);
        }

        // User message
        messages.add(Map.of("role", "user", "content", userMessage));

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("model", provider.getModel());
        body.put("messages", messages);
        body.put("stream", stream);
        body.put("temperature", 0.3);

        if (tools != null && !tools.isEmpty()) {
            body.put("tools", tools);
            body.put("tool_choice", "auto");
        }

        return body;
    }

    @SuppressWarnings("unchecked")
    private String extractContent(Map<String, Object> response) {
        if (response == null) return "(空响应)";
        List<Map<String, Object>> choices = (List<Map<String, Object>>) response.get("choices");
        if (choices == null || choices.isEmpty()) return "(无 choices)";
        Map<String, Object> message = (Map<String, Object>) choices.get(0).get("message");
        if (message == null) return "(无 message)";
        Object content = message.get("content");
        return content != null ? content.toString() : "(无 content)";
    }

    /**
     * 解析 provider: 如果请求未提供, 用默认值
     */
    private ChatRequest.LlmProvider resolveProvider(ChatRequest.LlmProvider provider) {
        if (provider == null || provider.getBaseUrl() == null) {
            return ChatRequest.LlmProvider.builder()
                .baseUrl(System.getProperty("soloforge.llm.baseUrl", "https://api.openai.com"))
                .apiKey(System.getProperty("soloforge.llm.apiKey", "placeholder"))
                .model(System.getProperty("soloforge.llm.model", "gpt-4o"))
                .build();
        }
        return provider;
    }
}
