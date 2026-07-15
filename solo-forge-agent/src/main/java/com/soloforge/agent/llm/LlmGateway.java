package com.soloforge.agent.llm;

/**
 * @deprecated Use {@link com.soloforge.agent.config.DynamicChatModelResolver} and
 *             {@link org.springframework.ai.chat.model.ChatModel} instead.
 *             Replaced by Spring AI 1.0.0 GA ChatClient in Path C migration (2026-07-15).
 *             This class will be removed in a future release. Retained for fallback reference.
 */
import com.fasterxml.jackson.databind.ObjectMapper;
import com.soloforge.agent.dto.ChatRequest;
import lombok.extern.slf4j.Slf4j;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.reactive.function.client.WebClientResponseException;
import reactor.core.publisher.Flux;

import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

/**
 * LLM Gateway
 *
 * 閸斻劍鈧礁顦?provider 閺€顖涘瘮: 濮ｅ繑顐肩拠閿嬬湴娴?ChatRequest.provider 濞夈劌鍙?baseUrl/apiKey/model,
 * 娑撳秳绶风挧?application.yml 閻ㄥ嫰娼ら幀渚€鍘ょ純顔衡偓?
 *
 * 閺€顖涘瘮 OpenAI 閸忕厧顔愰崡蹇氼唴 (OpenAI / Claude / DeepSeek / GLM / 闁矮绠熼崡鍐６缁?
 *
 * 2026-07-08: 閺傛澘顤?chatCompletionStream() 閻喎鐤勫ù浣哥础鐠嬪啰鏁? 鏉╂柨娲?Flux<String> 婢х偤鍣洪弬鍥ㄦ拱
 */
@Slf4j
@Component
public class LlmGateway {

    private static final Duration TIMEOUT = Duration.ofSeconds(90);
    private final ObjectMapper objectMapper = new ObjectMapper();

    @Autowired
    private LlmRateLimiter rateLimiter;

    /**
     * 閸氬本顒炵拫鍐暏 LLM (闂堢偞绁﹀?
     * 婵″倹鐏夌敮?tools 鐠嬪啰鏁ゆ潻鏂挎礀缁屽搫鍞寸€? 閼奉亜濮╅崢缁樺竴 tools 闁插秷鐦稉鈧▎?
     */
    public String chatCompletion(String systemPrompt,
                                  String userMessage,
                                  List<Map<String, String>> history,
                                  ChatRequest.LlmProvider provider,
                                  List<Map<String, Object>> tools) {
        return chatCompletion(systemPrompt, userMessage, history, provider, tools, 0.3);
    }

    /**
     * 閸氬本顒炵拫鍐暏 LLM (闂堢偞绁﹀? 閹稿洤鐣?temperature)
     * temperature 閻?agent 闁板秶鐤嗛崘鍐茬暰, 姒涙顓?0.3
     */
    public String chatCompletion(String systemPrompt,
                                  String userMessage,
                                  List<Map<String, String>> history,
                                  ChatRequest.LlmProvider provider,
                                  List<Map<String, Object>> tools,
                                  double temperature) {
        ChatRequest.LlmProvider resolved = resolveProvider(provider);
        log.info("LLM call: baseUrl={} model={} temperature={}", resolved.getBaseUrl(), resolved.getModel(), temperature);

        String pKey = LlmRateLimiter.providerKey(resolved.getBaseUrl(), resolved.getModel());
        try {
            WebClient client = buildClient(resolved);
            Map<String, Object> body = buildRequestBody(systemPrompt, userMessage, history, resolved, tools, false, temperature);

            Map<String, Object> response = null;
            for (int attempt = 0; attempt <= 3; attempt++) {
                rateLimiter.waitForRpmSlot(pKey);
                rateLimiter.acquire(pKey);
                try {
                    response = client.post()
                        .uri("/chat/completions")
                        .bodyValue(body)
                        .retrieve()
                        .bodyToMono(Map.class)
                        .timeout(TIMEOUT)
                        .block();
                    rateLimiter.recordSuccess(pKey);
                    break;
                } catch (Exception inner) {
                    int sc = LlmRateLimiter.extractStatusCode(inner);
                    if (rateLimiter.shouldRetry(sc, attempt)) {
                        Long ra = LlmRateLimiter.extractRetryAfter(inner);
                        log.warn("LLM call failed (HTTP {}), retrying #{}/3", sc, attempt + 1);
                        rateLimiter.record429(pKey);
                        rateLimiter.waitBeforeRetry(ra, attempt);
                        continue;
                    }
                    throw inner;
                } finally {
                    rateLimiter.release(pKey);
                }
            }

            String content = extractContent(response);
            
            // 婵″倹鐏夌敮?tools 鐠嬪啰鏁ゆ潻鏂挎礀缁屽搫鍞寸€? 閸樼粯甯€ tools 闁插秷鐦?
            if ((content == null || content.isBlank()) && tools != null && !tools.isEmpty()) {
                log.warn("LLM returned empty content with tools, retrying without tools...");
                Map<String, Object> bodyNoTools = buildRequestBody(systemPrompt, userMessage, history, resolved, null, false, temperature);
                response = client.post()
                    .uri("/chat/completions")
                    .bodyValue(bodyNoTools)
                    .retrieve()
                    .bodyToMono(Map.class)
                    .timeout(TIMEOUT)
                    .block();
                content = extractContent(response);
            }
            
            return content;
        } catch (Exception e) {
            log.error("LLM call failed: {}", e.getMessage());
            // 闂勫秶楠囬崚?fallback 濡€崇€?
            if (resolved.getFallbackModels() != null && resolved.getFallbackModels().length > 0) {
                log.info("Falling back to: {}", resolved.getFallbackModels()[0]);
                ChatRequest.LlmProvider fallback = ChatRequest.LlmProvider.builder()
                    .baseUrl(resolved.getBaseUrl())
                    .apiKey(resolved.getApiKey())
                    .model(resolved.getFallbackModels()[0])
                    .build();
                return chatCompletion(systemPrompt, userMessage, history, fallback, tools, temperature);
            }
            throw new RuntimeException("LLM 鐠嬪啰鏁ゆ径杈Е: " + formatLlmError(e, resolved), e);
        }
    }

    /**
     * 濞翠礁绱＄拫鍐暏 LLM 閳?鏉╂柨娲栨晶鐐哄櫤閺傚洦婀?Flux
     *
     * 濮ｅ繋閲?onNext 閺勵垯绔存稉?delta content 閻楀洦顔?(闂堢偛鐣弫鏉戞惙鎼?
     * Flux complete 鐞涖劎銇氬ù浣虹波閺?
     */
    public Flux<String> chatCompletionStream(String systemPrompt,
                                              String userMessage,
                                              List<Map<String, String>> history,
                                              ChatRequest.LlmProvider provider,
                                              List<Map<String, Object>> tools) {
        return chatCompletionStream(systemPrompt, userMessage, history, provider, tools, null, 0.3);
    }

    /**
     * 閳?濞翠礁绱＄拫鍐暏 LLM (鐢?usage 閸ョ偠鐨?
     *
     * usageConsumer 閸︺劍绁﹀蹇曠波閺夌喐妞傜悮顐ョ殶閻劋绔村▎? 閹煎搫鐢張顒冪枂 LLM 鐠嬪啰鏁ら惃?token 缂佺喕顓?
     * (闂団偓鐟?provider 閺€顖涘瘮 stream_options.include_usage, OpenAI 閸忕厧顔愰崡蹇氼唴閸у洦鏁幐?
     */
    public Flux<String> chatCompletionStream(String systemPrompt,
                                              String userMessage,
                                              List<Map<String, String>> history,
                                              ChatRequest.LlmProvider provider,
                                              List<Map<String, Object>> tools,
                                              Consumer<Usage> usageConsumer) {
        return chatCompletionStream(systemPrompt, userMessage, history, provider, tools, usageConsumer, 0.3);
    }

    /**
     * 閳?濞翠礁绱＄拫鍐暏 LLM (鐢?usage 閸ョ偠鐨?+ 閹稿洤鐣?temperature)
     * temperature 閻?agent 闁板秶鐤嗛崘鍐茬暰, 姒涙顓?0.3
     */
    public Flux<String> chatCompletionStream(String systemPrompt,
                                              String userMessage,
                                              List<Map<String, String>> history,
                                              ChatRequest.LlmProvider provider,
                                              List<Map<String, Object>> tools,
                                              Consumer<Usage> usageConsumer,
                                              double temperature) {
        ChatRequest.LlmProvider resolved = resolveProvider(provider);
        log.info("LLM stream call: baseUrl={} model={} temperature={}", resolved.getBaseUrl(), resolved.getModel(), temperature);

        WebClient client = buildClient(resolved);
        Map<String, Object> body = buildRequestBody(systemPrompt, userMessage, history, resolved, tools, true, temperature);

        // 缁鳖垳袧閸樼喓鏁?tool_calls 閸掑棛澧?(濞翠礁绱?mode 娑?arguments 閸掑棛澧栭崚鎷屾彧)
        StringBuilder toolCallName = new StringBuilder();
        StringBuilder toolCallArgs = new StringBuilder();
        boolean[] hasToolCall = {false};

        return client.post()
            .uri("/chat/completions")
            .bodyValue(body)
            .retrieve()
            .bodyToFlux(new ParameterizedTypeReference<ServerSentEvent<String>>() {})
            .map(ServerSentEvent::data)
            .filter(data -> data != null && !"[DONE]".equals(data))
            .mapNotNull(sseData -> {
                // 1. 閸忓牊顥呴弻?delta.tool_calls (閸樼喓鏁?function calling)
                try {
                    Map<String, Object> chunk = objectMapper.readValue(sseData, Map.class);
                    // 閳?濡偓閺?usage (濞翠礁绱￠張鈧崥搴濈鐢勬儭鐢? 闂団偓 stream_options.include_usage=true)
                    if (usageConsumer != null && chunk.get("usage") != null) {
                        try {
                            Map<String, Object> u = (Map<String, Object>) chunk.get("usage");
                            // 閳?閸忕厧顔?3 缁?provider 閻ㄥ嫮绱︾€涙ê鎳℃稉顓炵摟濞?
                            //   OpenAI:    usage.prompt_tokens_details.cached_tokens
                            //   DeepSeek:  usage.prompt_cache_hit_tokens
                            //   Anthropic: usage.cache_read_input_tokens
                            int cached = 0;
                            Object ptd = u.get("prompt_tokens_details");
                            if (ptd instanceof Map) {
                                cached = toInt(((Map<String, Object>) ptd).get("cached_tokens"));
                            }
                            if (cached == 0) cached = toInt(u.get("prompt_cache_hit_tokens"));
                            if (cached == 0) cached = toInt(u.get("cache_read_input_tokens"));
                            Usage usage = new Usage(
                                toInt(u.get("prompt_tokens")),
                                toInt(u.get("completion_tokens")),
                                toInt(u.get("total_tokens")),
                                cached);
                            usageConsumer.accept(usage);
                        } catch (Exception ue) {
                            log.debug("Failed to parse usage: {}", ue.getMessage());
                        }
                    }
                    List<Map<String, Object>> choices = (List<Map<String, Object>>) chunk.get("choices");
                    if (choices != null && !choices.isEmpty()) {
                        Map<String, Object> delta = (Map<String, Object>) choices.get(0).get("delta");
                        if (delta != null) {
                            Object tcObj = delta.get("tool_calls");
                            if (tcObj != null) {
                                List<Map<String, Object>> tcs = (List<Map<String, Object>>) tcObj;
                                if (!tcs.isEmpty()) {
                                    Map<String, Object> tc = tcs.get(0);
                                    Map<String, Object> fn = (Map<String, Object>) tc.get("function");
                                    if (fn != null) {
                                        hasToolCall[0] = true;
                                        if (fn.get("name") != null) {
                                            toolCallName.setLength(0);
                                            toolCallName.append(fn.get("name"));
                                        }
                                        if (fn.get("arguments") != null) {
                                            toolCallArgs.append(fn.get("arguments"));
                                        }
                                    }
                                }
                                // 閺?tool_calls 閺? delta.content 闁艾鐖舵稉?null, 鏉╂柨娲栫粚鍝勫窗娴?
                                return null;
                            }
                        }
                    }
                } catch (Exception e) {
                    log.debug("Failed to parse SSE chunk for tool_calls: {}", e.getMessage());
                }
                // 2. 濮濓絽鐖堕幓鎰絿 delta content
                return extractDeltaContent(sseData);
            })
            .doOnComplete(() -> {
                if (hasToolCall[0] && toolCallName.length() > 0) {
                    log.info("Stream accumulated native tool_call: {} args_len={}",
                        toolCallName, toolCallArgs.length());
                }
            })
            .concatWith(Flux.defer(() -> {
                // 濞翠胶绮ㄩ弶鐔锋倵: 婵″倹鐏夌槐顖溞濇禍鍡楀斧閻?tool_calls, 濞夈劌鍙?```json 閸ф顔€ tryParseToolCall 鐠囧棗鍩?
                if (hasToolCall[0] && toolCallName.length() > 0) {
                    String argsStr = toolCallArgs.toString();
                    try {
                        Map<String, Object> args = objectMapper.readValue(argsStr, Map.class);
                        String toolJson = objectMapper.writeValueAsString(
                            Map.of("tool", toolCallName.toString(), "args", args));
                        return Flux.just("```json\n" + toolJson + "\n```");
                    } catch (Exception e) {
                        return Flux.just("```json\n{\"tool\":\"" + toolCallName + "\",\"args\":" + argsStr + "}\n```");
                    }
                }
                return Flux.empty();
            }))
            .doOnError(e -> log.error("LLM stream error: {}", e.getMessage()))
            .onErrorMap(e -> e instanceof WebClientResponseException
                ? new RuntimeException(formatLlmError(e, resolved), e)
                : e)
            .timeout(TIMEOUT);
    }

    /** 閳?Token 娴ｈ法鏁ょ紒鐔活吀 (cachedTokens: 缂傛挸鐡ㄩ崨鎴掕厬閻?prompt token 閺? */
    public record Usage(int promptTokens, int completionTokens, int totalTokens, int cachedTokens) {}

    private static int toInt(Object v) {
        if (v instanceof Number n) return n.intValue();
        if (v instanceof String s) { try { return Integer.parseInt(s); } catch (Exception e) { return 0; } }
        return 0;
    }

    /**
     * 娴?SSE data 鐎涙顔屾稉顓熷絹閸?delta content
     *
     * 閳?FIX 2026-07-12: reasoning_content 閻?\u0001 閸撳秶绱戦弽鍥唶, ChatController 閹诡喗顒濋崣鎴︹偓?'reasoning' 娴滃娆㈤妴?
     * 閸撳秶顏弨璺哄煂 reasoning 娴滃娆㈤崥搴″涧閸︺劍绁﹂柅浣稿隘閺勫墽銇? 娑撳秴鏉虹紒?IncrementalCanvasPusher,
     * 闁灝鍘ら幀婵娾偓鍐箖缁嬪鑵戦惃?``` 鐎涙顑侀獮鍙夊娴狅絿鐖滈崸妤侇梾濞村鈧?
     */
    @SuppressWarnings("unchecked")
    private String extractDeltaContent(String sseData) {
        try {
            Map<String, Object> chunk = objectMapper.readValue(sseData, Map.class);
            List<Map<String, Object>> choices = (List<Map<String, Object>>) chunk.get("choices");
            if (choices == null || choices.isEmpty()) return null;
            Map<String, Object> delta = (Map<String, Object>) choices.get(0).get("delta");
            if (delta == null) return null;
            Object content = delta.get("content");
            if (content != null) return content.toString();
            // reasoning model: 閻?\u0001 閸撳秶绱戦弽鍥唶 reasoning_content
            Object reasoning = delta.get("reasoning_content");
            if (reasoning != null) return "\u0001" + reasoning.toString();
            return null;
        } catch (Exception e) {
            log.debug("Failed to parse SSE chunk: {}", e.getMessage());
            return null;
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
                                                   boolean stream,
                                                   double temperature) {
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
        body.put("temperature", temperature);

        // 閳?濞翠礁绱￠弮鎯邦嚞濮?usage 缂佺喕顓?(OpenAI 閸忕厧顔愰崡蹇氼唴: stream_options.include_usage)
        if (stream) {
            body.put("stream_options", Map.of("include_usage", true));
        }

        if (tools != null && !tools.isEmpty()) {
            body.put("tools", tools);
            body.put("tool_choice", "auto");
        }

        return body;
    }

    @SuppressWarnings("unchecked")
    private String extractContent(Map<String, Object> response) {
        if (response == null) return "(缁屽搫鎼锋惔?";
        List<Map<String, Object>> choices = (List<Map<String, Object>>) response.get("choices");
        if (choices == null || choices.isEmpty()) {
            log.warn("LLM response has no choices: {}", response.keySet());
            return "(閺?choices)";
        }
        Map<String, Object> message = (Map<String, Object>) choices.get(0).get("message");
        if (message == null) return "(閺?message)";
        
        // 濡偓閺屻儱甯悽?tool_calls (OpenAI Function Calling 閺嶇厧绱?
        Object toolCallsObj = message.get("tool_calls");
        if (toolCallsObj != null) {
            try {
                List<Map<String, Object>> toolCalls = (List<Map<String, Object>>) toolCallsObj;
                if (!toolCalls.isEmpty()) {
                    Map<String, Object> tc = toolCalls.get(0);
                    Map<String, Object> function = (Map<String, Object>) tc.get("function");
                    if (function != null) {
                        String toolName = (String) function.get("name");
                        String argsStr = (String) function.get("arguments");
                        log.info("LLM native tool_call: {} args={}", toolName, argsStr);
                        
                        // 鏉烆剚宕叉稉?tryParseToolCall 閼冲€熺槕閸掝偆娈?```json 閺嶇厧绱?
                        try {
                            Map<String, Object> args = objectMapper.readValue(argsStr, Map.class);
                            String toolJson = objectMapper.writeValueAsString(Map.of("tool", toolName, "args", args));
                            return "```json\n" + toolJson + "\n```";
                        } catch (Exception e) {
                            // arguments 娑撳秵妲搁崥鍫熺《 JSON, 閻╁瓨甯撮崠鍛帮紮
                            return "```json\n{\"tool\":\"" + toolName + "\",\"args\":" + argsStr + "}\n```";
                        }
                    }
                }
            } catch (Exception e) {
                log.warn("Failed to parse native tool_calls: {}", e.getMessage());
            }
        }
        
        Object content = message.get("content");
        if (content == null) {
            // 閸欘垵鍏橀弰?reasoning model, 濡偓閺?reasoning_content 鐎涙顔?
            Object reasoning = message.get("reasoning_content");
            if (reasoning != null) return reasoning.toString();
            return "(閺?content)";
        }
        String result = content.toString();
        if (result.isBlank()) {
            log.warn("LLM returned blank content. Message keys: {}", message.keySet());
        }
        return result;
    }

    /**
     * Resolve provider: if request does not provide one, throw error instead of defaulting to OpenAI
     * (OpenAI is unreachable in some network environments, would cause 90s timeout)
     */
    private ChatRequest.LlmProvider resolveProvider(ChatRequest.LlmProvider provider) {
        if (provider == null || provider.getBaseUrl() == null || provider.getBaseUrl().isBlank()) {
            throw new RuntimeException("LLM Provider not configured: please set baseUrl/apiKey/model in frontend Settings, then retry.");
        }
        if (provider.getApiKey() == null || provider.getApiKey().isBlank()) {
            throw new RuntimeException("LLM Provider apiKey is empty: please set API key in frontend Settings.");
        }
        if (provider.getModel() == null || provider.getModel().isBlank()) {
            throw new RuntimeException("LLM Provider model is empty: please set model name in frontend Settings.");
        }
        return provider;
    }

    /**
     * Format LLM error: use Spring WebClient response info to build "HTTP {status}" style error.
     * Compatible with classifyStreamError for error classification.
     *
     * Format: "HTTP {status} {statusText}: {bodyPreview} (baseUrl={baseUrl} model={model})"
     * Example: "HTTP 404 Not Found: {"error":{"message":"Model not found"}} (baseUrl=https://api.openai.com/v1 model=gpt-4o)"
     */
    private String formatLlmError(Throwable e, ChatRequest.LlmProvider provider) {
        String baseUrl = provider.getBaseUrl();
        String model = provider.getModel();

        if (e instanceof WebClientResponseException wcre) {
            int status = wcre.getStatusCode().value();
            String statusText = wcre.getStatusText();
            String bodyPreview = "";
            try {
                String body = new String(wcre.getResponseBodyAsByteArray());
                bodyPreview = body.length() > 200 ? body.substring(0, 200) : body;
            } catch (Exception ignored) {}
            return String.format("HTTP %d %s 閳?%s (baseUrl=%s model=%s)",
                status, statusText, bodyPreview, baseUrl, model);
        }

        // 闂?HTTP 闁挎瑨顕?(鐡掑懏妞傞妴浣界箾閹恒儲瀚嗙紒婵堢搼)
        return String.format("HTTP 500 %s (baseUrl=%s model=%s)", e.getMessage(), baseUrl, model);
    }
}
