package com.soloforge.agent.config;

import com.soloforge.agent.dto.ChatRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.anthropic.AnthropicChatModel;
import org.springframework.ai.anthropic.api.AnthropicApi;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.ai.model.function.ToolCallingManager;
import org.springframework.ai.openai.OpenAiChatModel;
import org.springframework.ai.openai.api.OpenAiApi;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.ApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Spring AI 2.0 多 Provider 配置
 *
 * <p>替换原 LlmGateway (WebClient 手搓 /chat/completions)。
 *
 * <p>核心设计：
 * <ul>
 *   <li>每个常用 provider 预创建一个 {@link ChatModel} Bean</li>
 *   <li>{@link DynamicChatModelResolver} 在运行时按 provider 名称路由</li>
 *   <li>支持请求级动态 baseUrl/apiKey/model 注入（兼容原有 ChatRequest.LlmProvider）</li>
 * </ul>
 */
@Configuration
public class LlmConfig {

    private static final Logger log = LoggerFactory.getLogger(LlmConfig.class);

    // ──────────────────────────────────────────────
    // 1. OpenAI / OpenAI 兼容 (GPT-4o / DeepSeek / GLM / 通义千问)
    // ──────────────────────────────────────────────

    @Bean(name = "openAiChatModel")
    public ChatModel openAiChatModel(
            @Value("${soloforge.llm.openai.api-key:placeholder}") String apiKey,
            @Value("${soloforge.llm.openai.base-url:https://api.openai.com}") String baseUrl,
            @Value("${soloforge.llm.openai.model:gpt-4o}") String model) {
        return OpenAiChatModel.builder()
                .openAiApi(OpenAiApi.builder()
                        .apiKey(apiKey)
                        .baseUrl(baseUrl)
                        .build())
                .defaultOptions(org.springframework.ai.openai.OpenAiChatOptions.builder()
                        .model(model)
                        .temperature(0.3f)
                        .build())
                .build();
    }

    // ──────────────────────────────────────────────
    // 2. DeepSeek (OpenAI 兼容协议，独立 Bean 以便独立配置)
    // ──────────────────────────────────────────────

    @Bean(name = "deepseekChatModel")
    public ChatModel deepseekChatModel(
            @Value("${soloforge.llm.deepseek.api-key:placeholder}") String apiKey,
            @Value("${soloforge.llm.deepseek.base-url:https://api.deepseek.com}") String baseUrl,
            @Value("${soloforge.llm.deepseek.model:deepseek-chat}") String model) {
        return OpenAiChatModel.builder()
                .openAiApi(OpenAiApi.builder()
                        .apiKey(apiKey)
                        .baseUrl(baseUrl)
                        .build())
                .defaultOptions(org.springframework.ai.openai.OpenAiChatOptions.builder()
                        .model(model)
                        .temperature(0.3f)
                        .build())
                .build();
    }

    // ──────────────────────────────────────────────
    // 3. Anthropic Claude (原生 SDK 实现)
    // ──────────────────────────────────────────────

    @Bean(name = "anthropicChatModel")
    public ChatModel anthropicChatModel(
            @Value("${soloforge.llm.anthropic.api-key:placeholder}") String apiKey,
            @Value("${soloforge.llm.anthropic.model:claude-sonnet-4-20250514}") String model) {
        return AnthropicChatModel.builder()
                .anthropicApi(AnthropicApi.builder()
                        .apiKey(apiKey)
                        .build())
                .defaultOptions(org.springframework.ai.anthropic.AnthropicChatOptions.builder()
                        .model(model)
                        .temperature(0.3f)
                        .build())
                .build();
    }

    // ──────────────────────────────────────────────
    // 4. 动态路由器 — 替代 LlmGateway.resolveProvider()
    // ──────────────────────────────────────────────

    /**
     * 运行时动态解析 ChatModel。
     *
     * <p>优先级：
     * <ol>
     *   <li>从已注册的 Bean 按名称查找（预配置的 provider）</li>
     *   <li>若未找到且请求携带了自定义 baseUrl/apiKey，则动态创建并缓存</li>
     * </ol>
     */
    @Bean
    public DynamicChatModelResolver dynamicChatModelResolver(ApplicationContext ctx) {
        return new DynamicChatModelResolver(ctx);
    }

    // ──────────────────────────────────────────────
    // 5. Tool Calling Manager (Spring AI 2.0 内置)
    // ──────────────────────────────────────────────

    @Bean
    public ToolCallingManager toolCallingManager() {
        return new ToolCallingManager();
    }
}

/**
 * 动态 ChatModel 路由器
 *
 * <p>解决 Spring AI ChatModel 单例模式与 SoloForge 请求级动态 Provider 注入的冲突。
 * 原有 LlmGateway 每次请求都从 ChatRequest.LlmProvider 动态注入 baseUrl/apiKey/model，
 * 此组件保持相同能力的同时利用 Spring AI 标准化 API。
 */
class DynamicChatModelResolver {

    private final ApplicationContext applicationContext;
    private final Map<String, ChatModel> dynamicCache = new ConcurrentHashMap<>();

    private static final Logger log = LoggerFactory.getLogger(DynamicChatModelResolver.class);

    // 预定义的 Bean 名称 → provider 类型映射
    private static final Map<String, String> BEAN_NAME_MAP = Map.of(
            "openAiChatModel", "OPENAI",
            "deepseekChatModel", "DEEPSEEK",
            "anthropicChatModel", "CLAUDE"
    );

    DynamicChatModelResolver(ApplicationContext applicationContext) {
        this.applicationContext = applicationContext;
    }

    /**
     * 根据 ChatRequest.LlmProvider 解析对应的 ChatModel。
     *
     * @param provider 从请求体注入的 provider 信息（含 baseUrl/apiKey/model/fallbackModels）
     * @return 可用的 ChatModel 实例
     */
    public ChatModel resolve(ChatRequest.LlmProvider provider) {
        // 1) 先尝试从预注册 Bean 匹配
        for (Map.Entry<String, String> entry : BEAN_NAME_MAP.entrySet()) {
            if (entry.getValue().equalsIgnoreCase(provider.name())) {
                try {
                    return applicationContext.getBean(entry.getKey(), ChatModel.class);
                } catch (Exception e) {
                    log.debug("Bean {} not found, falling back to dynamic", entry.getKey());
                }
            }
        }

        // 2) 按 baseUrl+model 缓存键查找或动态创建
        String cacheKey = provider.getBaseUrl() + "|" + provider.getModel();
        return dynamicCache.computeIfAbsent(cacheKey, k -> {
            log.info("Creating dynamic ChatModel for: baseUrl={} model={}",
                    provider.getBaseUrl(), provider.getModel());
            return createDynamicModel(provider);
        });
    }

    private ChatModel createDynamicModel(ChatRequest.LlmProvider provider) {
        // 默认走 OpenAI 兼容协议（覆盖 DeepSeek/GLM/通义千问等）
        return OpenAiChatModel.builder()
                .openAiApi(OpenAiApi.builder()
                        .apiKey(provider.getApiKey())
                        .baseUrl(provider.getBaseUrl())
                        .build())
                .defaultOptions(org.springframework.ai.openai.OpenAiChatOptions.builder()
                        .model(provider.getModel())
                        .temperature(0.3f)
                        .build())
                .build();
    }
}
