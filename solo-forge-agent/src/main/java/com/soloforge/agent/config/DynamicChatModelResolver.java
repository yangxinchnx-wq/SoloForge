package com.soloforge.agent.config;

import com.soloforge.agent.dto.ChatRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.ai.openai.OpenAiChatModel;
import org.springframework.ai.openai.OpenAiChatOptions;
import org.springframework.context.ApplicationContext;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Dynamic ChatModel resolver.
 *
 * Resolves Spring AI ChatModel instances at runtime based on ChatRequest.LlmProvider.
 * Maintains a cache of dynamically created models keyed by baseUrl+model.
 *
 * Spring AI 2.0.0: OpenAiApi removed, baseUrl/apiKey go directly into OpenAiChatOptions.
 */
public class DynamicChatModelResolver {

    private static final Logger log = LoggerFactory.getLogger(DynamicChatModelResolver.class);

    private final ApplicationContext applicationContext;
    private final Map<String, ChatModel> dynamicCache = new ConcurrentHashMap<>();

    private static final Map<String, String> BEAN_NAME_MAP = Map.of(
            "openAiChatModel", "OPENAI",
            "deepseekChatModel", "DEEPSEEK",
            "anthropicChatModel", "CLAUDE"
    );

    public DynamicChatModelResolver(ApplicationContext applicationContext) {
        this.applicationContext = applicationContext;
    }

    /**
     * Resolve ChatModel for the given provider.
     */
    public ChatModel resolve(ChatRequest.LlmProvider provider) {
        // 1) Try matching from pre-registered beans
        for (Map.Entry<String, String> entry : BEAN_NAME_MAP.entrySet()) {
            if (entry.getValue().equalsIgnoreCase(provider.getName())) {
                try {
                    return applicationContext.getBean(entry.getKey(), ChatModel.class);
                } catch (Exception e) {
                    log.debug("Bean {} not found, falling back to dynamic", entry.getKey());
                }
            }
        }

        // 2) Dynamic creation by baseUrl+model cache key
        String cacheKey = provider.getBaseUrl() + "|" + provider.getModel();
        return dynamicCache.computeIfAbsent(cacheKey, k -> {
            log.info("Creating dynamic ChatModel for: baseUrl={} model={}",
                    provider.getBaseUrl(), provider.getModel());
            return createDynamicModel(provider);
        });
    }

    private ChatModel createDynamicModel(ChatRequest.LlmProvider provider) {
        return OpenAiChatModel.builder()
                .options(OpenAiChatOptions.builder()
                        .apiKey(provider.getApiKey())
                        .baseUrl(provider.getBaseUrl())
                        .model(provider.getModel())
                        .temperature(0.3)
                        .build())
                .build();
    }
}
