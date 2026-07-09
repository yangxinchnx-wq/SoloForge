package com.soloforge.agent.tools;

import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;

import java.time.Duration;
import java.util.Map;

/**
 * 画布 UI 推送工具
 *
 * 让 Agent 能"调用画布"推送 Universal AST。
 *
 * 链路 (2026-07-09 修复):
 *   Agent 调用此工具
 *     → HTTP POST 到 Node.js 中转端点 (3001/api/canvas/relay/push-ui)
 *     → Node.js 查询当前 Flutter canvas port
 *     → Node.js 转发到 Flutter /push-ui
 *     → Flutter UiParser.parse + PlatformRenderer.build 渲染
 *
 * 之前的设计是"工具只 log, 靠前端 PREVIEW_NEEDED 标记重调 LLM 生成 preview",
 * 导致 LLM 被调用两次, 额度浪费。现在改为直接 HTTP 推送, 一次完成。
 */
@Slf4j
@Component
public class CanvasPushUiTool {

    /**
     * Node.js 中转端点 — Java 不直接访问 Flutter (端口由 Electron 动态分配)
     */
    @Value("${soloforge.canvas.relay-url:http://127.0.0.1:3001/api/canvas/relay/push-ui}")
    private String relayUrl;

    /**
     * 推送 UI DSL 到画布
     *
     * @param sessionId  画布 session ID (如 canvas_1, canvas-2)
     * @param dslJson    Universal AST JSON 字符串 (UI 描述树)
     * @param language   生成语言 (typescript/python/dart/go/rust/java/c/html)
     * @return 推送结果
     */
    public String execute(String sessionId, String dslJson, String language) {
        if (sessionId == null || sessionId.isBlank()) {
            return "推送失败: sessionId 为空";
        }
        if (dslJson == null || dslJson.isBlank()) {
            return "推送失败: dslJson 为空";
        }

        int dslBytes = dslJson.length();
        log.info("canvas_push_ui: sessionId={} language={} dslBytes={}", sessionId, language, dslBytes);

        // 解析 dslJson 为 Map (Node.js relay 期望 dsl 字段是对象, 不是字符串)
        Map<String, Object> dsl;
        try {
            // 用 Jackson 解析 (Spring Boot 自动配置 ObjectMapper)
            com.fasterxml.jackson.databind.ObjectMapper mapper = new com.fasterxml.jackson.databind.ObjectMapper();
            dsl = mapper.readValue(dslJson, Map.class);
        } catch (Exception e) {
            log.warn("canvas_push_ui: dslJson 解析失败, 退化为字符串透传: {}", e.getMessage());
            // 退化为包装形式: {type: "container", children: [{type: "text", props: {content: dslJson}}]}
            dsl = Map.of(
                "type", "container",
                "props", Map.of("padding", 16),
                "children", java.util.List.of(Map.of(
                    "type", "text",
                    "props", Map.of("content", "[DSL 解析失败] " + dslJson.substring(0, Math.min(200, dslJson.length())), "color", "#FF0000")
                ))
            );
        }

        String effectiveLang = (language != null && !language.isBlank()) ? language : "typescript";

        // HTTP 推送到 Node.js 中转端点 (同步阻塞, 让 LLM 知道结果)
        try {
            Map<String, Object> payload = Map.of(
                "sessionId", sessionId,
                "dsl", dsl,
                "language", effectiveLang
            );

            String response = WebClient.builder()
                .baseUrl(relayUrl)
                .defaultHeader(HttpHeaders.CONTENT_TYPE, MediaType.APPLICATION_JSON_VALUE)
                .build()
                .post()
                .bodyValue(payload)
                .retrieve()
                .bodyToMono(String.class)
                .timeout(Duration.ofSeconds(3))
                .block();

            log.info("canvas_push_ui: relay response={}", response);
            return String.format(
                "画布推送成功: sessionId=%s, language=%s, dsl=%d bytes。%n" +
                "Node.js relay 响应: %s",
                sessionId, effectiveLang, dslBytes, response
            );
        } catch (Exception e) {
            log.warn("canvas_push_ui: HTTP 推送失败 (非致命): {}", e.getMessage());
            // 失败不阻塞 LLM 流, 但告知 LLM 推送失败 (可让 LLM 在回复末尾加 PREVIEW_NEEDED 兜底)
            return String.format(
                "画布推送失败 (非致命, 可用 PREVIEW_NEEDED 兜底): sessionId=%s, language=%s, dsl=%d bytes。%n" +
                "原因: %s%n" +
                "请在回复末尾添加 <<<PREVIEW_NEEDED:%s>>> 标记以触发前端兜底预览。",
                sessionId, effectiveLang, dslBytes, e.getMessage(), effectiveLang
            );
        }
    }

    public String getDescription() {
        return "canvas_push_ui(sessionId, dslJson, language): 推送 Universal AST UI 描述到画布实时预览。"
            + "dslJson 是 UI 组件树 JSON (如 {\"type\":\"container\",\"props\":{\"padding\":16},\"children\":[...]}). "
            + "language 是生成语言 (typescript/python/dart 等). "
            + "当用户请求 UI 界面时, 生成 AST 后用此工具推送到画布。";
    }
}
