package com.soloforge.agent.tools;

/**
 * @deprecated Use {@link SoloForgeTools} with {@code @Tool} annotations instead.
 *             Replaced by Spring AI 2.0 auto Schema generation in Path C migration (2026-07-15).
 *             This class will be removed in a future release. Retained for fallback reference.
 */
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 工具注册表
 *
 * 统一管理 6 个核心工具的元数据和调用入口 (本地执行)。
 * 扩展工具 (browser_*, bu_*, win_* 等) 通过 HTTP 转发到 Node.js 后端动态执行。
 *
 * 2026-07-13: 改造为 manifest 驱动 + 动态加载
 *   - 核心工具 (read_file/write_file/execute_cmd/search_code/list_files/canvas_push_ui) 保持本地硬编码
 *   - 扩展工具 schema 通过 HTTP 从 Node.js 后端拉取 (GET /api/tools/schemas)
 *   - 扩展工具调用通过 HTTP 转发到 Node.js 后端 (POST /api/tools/invoke)
 *   - Node.js 不可用时降级为仅核心工具, 不阻塞 Agent
 */
@Deprecated
@Slf4j
@Component
@RequiredArgsConstructor
public class ToolRegistry {

    /** 核心工具名集合 — 这些工具在 Java 本地执行, 不走 HTTP 转发 */
    private static final Set<String> CORE_TOOLS = Set.of(
        "read_file", "write_file", "execute_cmd",
        "search_code", "list_files", "canvas_push_ui"
    );

    private final ReadFileTool readFileTool;
    private final WriteFileTool writeFileTool;
    private final ExecuteCmdTool executeCmdTool;
    private final SearchCodeTool searchCodeTool;
    private final ListFilesTool listFilesTool;
    private final CanvasPushUiTool canvasPushUiTool;
    private final ObjectMapper objectMapper;

    /** HttpClient 单例 — 用于转发扩展工具请求到 Node.js 后端 */
    private final HttpClient httpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(5))
        .build();

    /**
     * 获取 Node.js 后端地址 (可通过环境变量 NODE_BACKEND_URL 覆盖)
     */
    private String getNodeBackendUrl() {
        String env = System.getenv("NODE_BACKEND_URL");
        return env != null ? env : "http://localhost:3000";
    }

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
     *
     * 路由逻辑:
     *   - 核心工具 (read_file, write_file, execute_cmd, search_code, list_files, canvas_push_ui) → 本地执行
     *   - 扩展工具 (browser_xxx, bu_xxx, win_xxx 等) → HTTP 转发到 Node.js 后端
     */
    public String invoke(String toolName, Map<String, Object> args) {
        log.info("invoke tool: {} args: {}", toolName, args);

        // 扩展工具: 不在核心工具集合中, 走 HTTP 转发到 Node.js 后端
        if (!CORE_TOOLS.contains(toolName)) {
            return invokeExtendedTool(toolName, args);
        }

        // 核心工具: 本地执行
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

    /**
     * 获取扩展工具的 OpenAI Function Calling schema 数组
     *
     * 通过 HTTP GET 请求到 Node.js 后端拉取前端 manifest.json 中定义的工具 schema。
     * 如果 Node.js 不可用或请求失败, 返回空列表 (不阻塞核心工具)。
     *
     * @param enabledToolIds 前端选中的工具 ID 列表 (如 browser_devtools, win_powershell)
     * @return OpenAI Function Calling 格式的 schema 数组, 每个元素形如:
     *         { "type": "function", "function": { "name": "...", "description": "...", "parameters": {...} } }
     */
    @SuppressWarnings("unchecked")
    public List<Map<String, Object>> getExtendedToolSchemas(List<String> enabledToolIds) {
        if (enabledToolIds == null || enabledToolIds.isEmpty()) {
            return List.of();
        }

        // 过滤掉核心工具 (核心工具已由 getToolSchemas 提供, 避免重复)
        List<String> extendedIds = enabledToolIds.stream()
            .filter(id -> !CORE_TOOLS.contains(id))
            .toList();
        if (extendedIds.isEmpty()) {
            return List.of();
        }

        String idsParam = String.join(",", extendedIds);
        String url = getNodeBackendUrl() + "/api/tools/schemas?ids=" + idsParam;

        try {
            HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .timeout(Duration.ofSeconds(5))
                .GET()
                .header("Accept", "application/json")
                .build();

            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));

            if (response.statusCode() != 200) {
                log.warn("getExtendedToolSchemas: Node.js 返回状态码 {} (ids={})", response.statusCode(), idsParam);
                return List.of();
            }

            String body = response.body();
            if (body == null || body.isBlank()) {
                return List.of();
            }

            // Node.js 返回 { success: true, tools: [...] } 格式，需要提取 tools 字段
            Map<String, Object> responseMap = objectMapper.readValue(body, Map.class);
            Object toolsObj = responseMap.get("tools");
            if (!(toolsObj instanceof List)) {
                log.warn("getExtendedToolSchemas: 响应中无 tools 字段 (ids={})", idsParam);
                return List.of();
            }

            @SuppressWarnings("unchecked")
            List<Map<String, Object>> schemas = (List<Map<String, Object>>) toolsObj;
            log.info("getExtendedToolSchemas: 拉取到 {} 个扩展工具 schema (ids={})", schemas.size(), idsParam);
            return schemas;
        } catch (Exception e) {
            // Node.js 不可用或请求失败 — 降级, 不阻塞 Agent
            log.warn("getExtendedToolSchemas 失败 (降级为空列表): {} (ids={})", e.getMessage(), idsParam);
            return List.of();
        }
    }

    /**
     * 获取技能内容 (SKILL.md 文本) — 用于 SystemPromptBuilder 注入系统提示
     *
     * 通过 HTTP GET 请求到 Node.js 后端拉取前端 manifest.json 中定义的技能 SKILL.md 内容。
     * 如果 Node.js 不可用或请求失败, 返回空列表 (不阻塞 Agent)。
     *
     * @param enabledSkillIds 前端选中的技能 ID 列表 (如 bug-fix, code-review)
     * @return 技能内容字符串列表, 每个元素是一个 SKILL.md 的完整文本
     */
    @SuppressWarnings("unchecked")
    public List<String> getSkillContents(List<String> enabledSkillIds) {
        if (enabledSkillIds == null || enabledSkillIds.isEmpty()) {
            return List.of();
        }

        String idsParam = String.join(",", enabledSkillIds);
        String url = getNodeBackendUrl() + "/api/skills/content?ids=" + idsParam;

        try {
            HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .timeout(Duration.ofSeconds(5))
                .GET()
                .header("Accept", "application/json")
                .build();

            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));

            if (response.statusCode() != 200) {
                log.warn("getSkillContents: Node.js 返回状态码 {} (ids={})", response.statusCode(), idsParam);
                return List.of();
            }

            String body = response.body();
            if (body == null || body.isBlank()) {
                return List.of();
            }

            // Node.js 返回 { success: true, skills: [{ id, name, content }] } 格式
            Map<String, Object> responseMap = objectMapper.readValue(body, Map.class);
            Object skillsObj = responseMap.get("skills");
            if (!(skillsObj instanceof List)) {
                log.warn("getSkillContents: 响应中无 skills 字段 (ids={})", idsParam);
                return List.of();
            }

            @SuppressWarnings("unchecked")
            List<Map<String, Object>> skills = (List<Map<String, Object>>) skillsObj;
            List<String> contents = new ArrayList<>();
            for (Map<String, Object> skill : skills) {
                Object content = skill.get("content");
                if (content instanceof String && !((String) content).isBlank()) {
                    contents.add((String) content);
                }
            }
            log.info("getSkillContents: 拉取到 {} 个技能内容 (ids={})", contents.size(), idsParam);
            return contents;
        } catch (Exception e) {
            // Node.js 不可用或请求失败 — 降级, 不阻塞 Agent
            log.warn("getSkillContents 失败 (降级为空列表): {} (ids={})", e.getMessage(), idsParam);
            return List.of();
        }
    }

    /**
     * 调用扩展工具 (通过 HTTP POST 转发到 Node.js 后端)
     *
     * 请求体: { "name": toolName, "arguments": args }
     * 返回: 工具执行结果字符串
     * 失败时返回错误信息字符串 (不抛异常, 避免中断 Agent 循环)
     *
     * @param toolName 扩展工具名 (如 browser_devtools, win_powershell)
     * @param args     工具参数
     * @return 工具执行结果或错误信息
     */
    public String invokeExtendedTool(String toolName, Map<String, Object> args) {
        String url = getNodeBackendUrl() + "/api/tools/invoke";

        try {
            Map<String, Object> requestBody = new LinkedHashMap<>();
            requestBody.put("name", toolName);
            requestBody.put("arguments", args != null ? args : Map.of());

            String jsonBody = objectMapper.writeValueAsString(requestBody);

            HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .timeout(Duration.ofSeconds(30))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(jsonBody, StandardCharsets.UTF_8))
                .build();

            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));

            if (response.statusCode() != 200) {
                log.error("invokeExtendedTool {}: Node.js 返回状态码 {} body={}",
                    toolName, response.statusCode(), response.body());
                return "扩展工具调用失败: Node.js 返回状态码 " + response.statusCode();
            }

            String body = response.body();
            log.info("invokeExtendedTool {}: 成功 ({} chars)", toolName,
                body != null ? body.length() : 0);
            return body != null ? body : "";
        } catch (Exception e) {
            // HTTP 请求失败 — 返回错误信息, 不中断 Agent 循环
            log.error("invokeExtendedTool {} 失败: {}", toolName, e.getMessage());
            return "扩展工具调用失败: " + e.getMessage();
        }
    }
}
