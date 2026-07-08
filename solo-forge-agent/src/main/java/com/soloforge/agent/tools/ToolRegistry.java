package com.soloforge.agent.tools;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 工具注册表
 *
 * 统一管理 5 个工具的元数据和调用入口。
 * Spring AI Function Calling 通过工具名调用对应方法。
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class ToolRegistry {

    private final ReadFileTool readFileTool;
    private final WriteFileTool writeFileTool;
    private final ExecuteCmdTool executeCmdTool;
    private final SearchCodeTool searchCodeTool;
    private final ListFilesTool listFilesTool;
    private final CanvasPushUiTool canvasPushUiTool;

    /**
     * 获取所有工具的描述 (用于 System Prompt 第 7 层)
     */
    public List<String> getToolDescriptions() {
        return List.of(
            readFileTool.getDescription(),
            writeFileTool.getDescription(),
            executeCmdTool.getDescription(),
            searchCodeTool.getDescription(),
            listFilesTool.getDescription(),
            canvasPushUiTool.getDescription()
        );
    }

    /**
     * 按名称调用工具
     */
    public String invoke(String toolName, Map<String, Object> args) {
        log.info("invoke tool: {} args: {}", toolName, args);
        try {
            return switch (toolName) {
                case "read_file" -> readFileTool.execute((String) args.get("path"));
                case "write_file" -> writeFileTool.execute(
                    (String) args.get("path"),
                    (String) args.get("content"));
                case "execute_cmd" -> executeCmdTool.execute((String) args.get("command"));
                case "search_code" -> searchCodeTool.execute(
                    (String) args.get("pattern"),
                    args.containsKey("fileGlob") ? (String) args.get("fileGlob") : null);
                case "list_files" -> listFilesTool.execute((String) args.get("dirPath"));
                case "canvas_push_ui" -> canvasPushUiTool.execute(
                    (String) args.get("sessionId"),
                    (String) args.get("dslJson"),
                    args.containsKey("language") ? (String) args.get("language") : "typescript");
                default -> "未知工具: " + toolName;
            };
        } catch (Exception e) {
            log.error("tool {} failed: {}", toolName, e.getMessage());
            return "工具调用失败: " + e.getMessage();
        }
    }

    /**
     * 获取所有工具名 (用于 Function Calling 注册)
     */
    public List<String> getToolNames() {
        return List.of("read_file", "write_file", "execute_cmd", "search_code", "list_files", "canvas_push_ui");
    }

    /**
     * 获取工具 JSON Schema (用于 OpenAI Function Calling)
     */
    public Map<String, Object> getToolSchemas() {
        Map<String, Object> schemas = new LinkedHashMap<>();

        schemas.put("read_file", Map.of(
            "type", "object",
            "properties", Map.of(
                "path", Map.of("type", "string", "description", "文件路径 (相对或绝对)")
            ),
            "required", List.of("path")
        ));

        schemas.put("write_file", Map.of(
            "type", "object",
            "properties", Map.of(
                "path", Map.of("type", "string", "description", "文件路径"),
                "content", Map.of("type", "string", "description", "文件内容")
            ),
            "required", List.of("path", "content")
        ));

        schemas.put("execute_cmd", Map.of(
            "type", "object",
            "properties", Map.of(
                "command", Map.of("type", "string", "description", "要执行的命令")
            ),
            "required", List.of("command")
        ));

        schemas.put("search_code", Map.of(
            "type", "object",
            "properties", Map.of(
                "pattern", Map.of("type", "string", "description", "正则表达式"),
                "fileGlob", Map.of("type", "string", "description", "文件扩展名过滤 (可选)")
            ),
            "required", List.of("pattern")
        ));

        schemas.put("list_files", Map.of(
            "type", "object",
            "properties", Map.of(
                "dirPath", Map.of("type", "string", "description", "目录路径")
            ),
            "required", List.of("dirPath")
        ));

        schemas.put("canvas_push_ui", Map.of(
            "type", "object",
            "properties", Map.of(
                "sessionId", Map.of("type", "string", "description", "画布 session ID (如 canvas_1, canvas-2)"),
                "dslJson", Map.of("type", "string", "description", "Universal AST JSON 字符串: UI 组件树, 如 {\"type\":\"container\",\"props\":{\"padding\":16},\"children\":[...]}"),
                "language", Map.of("type", "string", "description", "生成语言: typescript/python/dart/go/rust/java/c/html")
            ),
            "required", List.of("sessionId", "dslJson")
        ));

        return schemas;
    }
}
