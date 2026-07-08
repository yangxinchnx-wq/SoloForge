package com.soloforge.agent.tools;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

/**
 * 画布 UI 推送工具
 *
 * 让 Agent 能"调用画布"推送 Universal AST。
 *
 * 设计:
 *   - Agent 调用此工具 → 工具记录日志 + 返回成功
 *   - 实际画布渲染由前端完成:
 *     a) 前端检测 <<<PREVIEW_NEEDED:语言>>> 标记 → 触发 AST 预览流
 *     b) 前端 detectPreviewFromResponse() 代码块强制检测 → 自动触发
 *   - 此工具的核心价值: 让 LLM 在 Function Calling 循环中"知道"自己操作了画布,
 *     从而在后续回复中生成更准确的 UI 代码 + 预览标记
 */
@Slf4j
@Component
public class CanvasPushUiTool {

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

        // 不直接 HTTP 推送 (画布端口由 Electron 管理, Java 进程无法直接访问)
        // 返回成功消息让 LLM 知道画布操作已完成
        // 实际渲染由前端 <<<PREVIEW_NEEDED>>> 标记 + 代码块检测自动完成
        return String.format(
            "画布推送已接收: sessionId=%s, language=%s, dsl=%d bytes。%n" +
            "画布将在前端自动渲染。请在回复末尾添加 <<<PREVIEW_NEEDED:%s>>> 标记以确保预览触发。",
            sessionId, language != null ? language : "typescript", dslBytes,
            language != null ? language : "typescript"
        );
    }

    public String getDescription() {
        return "canvas_push_ui(sessionId, dslJson, language): 推送 Universal AST UI 描述到画布实时预览。"
            + "dslJson 是 UI 组件树 JSON (如 {\"type\":\"container\",\"props\":{\"padding\":16},\"children\":[...]}). "
            + "language 是生成语言 (typescript/python/dart 等). "
            + "当用户请求 UI 界面时, 生成 AST 后用此工具推送到画布。";
    }
}
