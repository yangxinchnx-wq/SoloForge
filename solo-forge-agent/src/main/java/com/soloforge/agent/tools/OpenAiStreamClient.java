package com.soloforge.agent.tools;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

/**
 * OpenAI-compatible SSE streaming client.
 *
 * <p>Directly calls the provider's {@code /chat/completions} endpoint with
 * {@code stream: true} and parses the Server-Sent Events response line by line.
 * This bypasses Spring AI's {@code OpenAiChatModel.stream()} which hangs on
 * providers (e.g. Xiaomi MiMo, DeepSeek-R1) that emit reasoning tokens via the
 * non-standard {@code delta.reasoning_content} field — during reasoning the
 * standard {@code delta.content} is {@code null}, and Spring AI's reactor
 * pipeline blocks waiting for a non-null content chunk.
 *
 * <p>This client only extracts the standard {@code delta.content} field and
 * ignores non-standard fields, so it works uniformly across all OpenAI-compatible
 * providers (MiMo / DeepSeek / GLM / Qwen / Moonshot / Doubao / real OpenAI).
 *
 * <p>Implementation: raw {@link javax.net.ssl.SSLSocket} is used instead of
 * {@link java.net.http.HttpClient} because {@code HttpClient.send()} with
 * {@code ofInputStream}/{@code ofLines} buffers the full body before returning,
 * which defeats streaming. A raw socket reads each SSE line the moment it arrives.
 *
 * <p>Protocol details handled:
 * <ul>
 *   <li>Lines starting with {@code data: } carry a JSON chunk</li>
 *   <li>{@code data: [DONE]} marks stream end</li>
 *   <li>Empty {@code choices:[]} chunk (some providers send it for usage stats) is skipped</li>
 *   <li>{@code delta.content == null} (reasoning phase) is skipped, not treated as error</li>
 *   <li>Tool calls in streaming are aggregated but not executed here (caller handles)</li>
 * </ul>
 */
@Component
public class OpenAiStreamClient {
    private static final Logger log = LoggerFactory.getLogger(OpenAiStreamClient.class);

    private final ObjectMapper objectMapper;

    public OpenAiStreamClient(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    /**
     * Result of a streaming call.
     *
     * @param fullContent  accumulated assistant text (all deltas concatenated)
     * @param finishReason provider-reported finish reason ("stop", "length", "tool_calls", ...) or null
     */
    public record StreamResult(String fullContent, String finishReason) {}

    /**
     * Call an OpenAI-compatible chat completion endpoint in streaming mode.
     *
     * @param baseUrl    provider base URL, e.g. {@code https://token-plan-cn.xiaomimimo.com/v1}
     * @param apiKey     bearer token
     * @param model      model id, e.g. {@code mimo-v2.5}
     * @param messages   ordered list of {role, content} maps (system / user / assistant)
     * @param tools      OpenAI tool schemas (may be null or empty for no tools)
     * @param temperature sampling temperature (0.0–2.0), null for provider default
     * @param maxTokens  cap on output tokens, null for provider default
     * @param onChunk    callback invoked with each non-empty delta content fragment
     * @return accumulated full content + finish reason
     */
    public StreamResult streamChat(String baseUrl, String apiKey, String model,
                                   List<Map<String, Object>> messages,
                                   List<Map<String, Object>> tools,
                                   Double temperature, Integer maxTokens,
                                   Consumer<String> onChunk) throws Exception {
        // Parse URL
        URI uri = URI.create(baseUrl.endsWith("/") ? baseUrl + "chat/completions" : baseUrl + "/chat/completions");
        String host = uri.getHost();
        int port = uri.getPort() != -1 ? uri.getPort() : (uri.getScheme().equals("https") ? 443 : 80);
        String path = uri.getRawPath().isEmpty() ? "/" : uri.getRawPath();

        // Build request body
        var bodyMap = new java.util.LinkedHashMap<String, Object>();
        bodyMap.put("model", model);
        bodyMap.put("messages", messages);
        bodyMap.put("stream", true);
        if (temperature != null) bodyMap.put("temperature", temperature);
        if (maxTokens != null) bodyMap.put("max_tokens", maxTokens);
        if (tools != null && !tools.isEmpty()) {
            bodyMap.put("tools", tools);
        }
        String bodyJson = objectMapper.writeValueAsString(bodyMap);
        byte[] bodyBytes = bodyJson.getBytes(java.nio.charset.StandardCharsets.UTF_8);

        // Use raw Socket + SSLSocket for TRUE streaming.
        // Java HttpClient.send() with ofInputStream/ofLines buffers the full body before
        // returning, which defeats streaming and causes the 40s timeout for reasoning models.
        // A raw socket lets us read each SSE line the moment it arrives.
        log.info("OpenAiStreamClient: sending stream request to {} model={}", uri, model);
        long t0 = System.currentTimeMillis();

        javax.net.ssl.SSLSocket socket = (javax.net.ssl.SSLSocket) javax.net.ssl.SSLSocketFactory.getDefault().createSocket(host, port);
        socket.setSoTimeout(60_000); // read timeout per chunk
        try {
            // Send HTTP request
            StringBuilder req = new StringBuilder();
            req.append("POST ").append(path).append(" HTTP/1.1\r\n");
            req.append("Host: ").append(host).append("\r\n");
            req.append("Authorization: Bearer ").append(apiKey).append("\r\n");
            req.append("Content-Type: application/json\r\n");
            req.append("Accept: text/event-stream\r\n");
            req.append("Content-Length: ").append(bodyBytes.length).append("\r\n");
            req.append("Connection: close\r\n");
            req.append("\r\n");
            java.io.OutputStream os = socket.getOutputStream();
            os.write(req.toString().getBytes(java.nio.charset.StandardCharsets.US_ASCII));
            os.write(bodyBytes);
            os.flush();

            // Read response — parse status line + headers, then stream body line by line
            java.io.BufferedReader reader = new java.io.BufferedReader(
                    new java.io.InputStreamReader(socket.getInputStream(), java.nio.charset.StandardCharsets.UTF_8));

            // Status line
            String statusLine = reader.readLine();
            if (statusLine == null) throw new RuntimeException("Empty response from " + uri);
            int statusCode = 200;
            String[] parts = statusLine.split(" ");
            if (parts.length >= 2) {
                try { statusCode = Integer.parseInt(parts[1]); } catch (NumberFormatException ignored) {}
            }

            // Skip headers until empty line
            String headerLine;
            int contentLength = -1;
            while ((headerLine = reader.readLine()) != null && !headerLine.isEmpty()) {
                String lower = headerLine.toLowerCase();
                if (lower.startsWith("content-length:")) {
                    try { contentLength = Integer.parseInt(lower.substring(15).trim()); } catch (NumberFormatException ignored) {}
                }
            }

            log.info("OpenAiStreamClient: response status={} in {}ms", statusCode, System.currentTimeMillis() - t0);

            if (statusCode != 200) {
                StringBuilder errBody = new StringBuilder();
                String l;
                while ((l = reader.readLine()) != null) errBody.append(l);
                throw new RuntimeException("HTTP " + statusCode + " from " + uri + ": " + errBody);
            }

            // Stream body — read SSE lines as they arrive
            StringBuilder full = new StringBuilder();
            String[] finishReasonHolder = new String[]{null};
            String line;
            while ((line = reader.readLine()) != null) {
                if (Thread.currentThread().isInterrupted()) {
                    throw new RuntimeException("Interrupted");
                }
                if (line.isEmpty()) continue;
                if (line.startsWith(":")) continue; // SSE comment / heartbeat
                if (!line.startsWith("data:")) continue;

                String data = line.substring(5).trim();
                if (data.equals("[DONE]")) continue;

                try {
                    JsonNode node = objectMapper.readTree(data);
                    JsonNode choices = node.path("choices");
                    if (!choices.isArray() || choices.isEmpty()) continue; // usage-only chunk
                    JsonNode firstChoice = choices.get(0);
                    JsonNode delta = firstChoice.path("delta");
                    String content = delta.path("content").asText(null);
                    if (content != null && !content.isEmpty() && !"null".equals(content)) {
                        full.append(content);
                        try {
                            onChunk.accept(content);
                        } catch (Exception cbEx) {
                            log.debug("onChunk callback threw (non-fatal): {}", cbEx.getMessage());
                        }
                    }
                    JsonNode fr = firstChoice.path("finish_reason");
                    if (!fr.isMissingNode() && !fr.isNull()) {
                        finishReasonHolder[0] = fr.asText();
                    }
                } catch (Exception parseEx) {
                    log.debug("Skipping unparseable SSE chunk: {}", data);
                }
            }

            return new StreamResult(full.toString(), finishReasonHolder[0]);
        } finally {
            try { socket.close(); } catch (Exception ignored) {}
        }
    }
}
