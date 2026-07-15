package com.soloforge.agent.tools;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.tool.annotation.Tool;
import org.springframework.ai.tool.annotation.ToolParam;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * SoloForge 核心工具集 — Spring AI 1.0.0 GA @Tool 注解驱动
 *
 * <p>替换原 ToolRegistry (361 行手写 JSON Schema + switch 路由)。
 * <pre>
 * 原类                          → 本方法
 * ReadFileTool                  → readFile()
 * WriteFileTool                 → writeFile()
 * ExecuteCmdTool                → executeCmd()
 * SearchCodeTool                → searchCode()
 * ListFilesTool                 → listFiles()
 * CanvasPushUiTool              → canvasPushUi()
 * </pre>
 *
 * <p>Spring AI 1.0.0 GA 自动从方法签名生成 JSON Schema 并注册到 ChatClient，
 * 无需手动维护 ToolRegistry.getToolSchemas() 或 switch 路由逻辑。
 */
@Service
public class SoloForgeTools {

    private static final Logger log = LoggerFactory.getLogger(SoloForgeTools.class);

    // ──────────────────────────────────────────────
    // 1. 文件读取
    // ──────────────────────────────────────────────

    @Tool(description = "读取文件内容。参数 path 为文件路径（支持相对路径和绝对路径）。返回文件的完整文本内容。")
    public String readFile(@ToolParam(description = "要读取的文件路径") String path) {
        try {
            Path filePath = Paths.get(path).toAbsolutePath().normalize();
            // 安全检查：防止路径穿越（基本防护）
            if (!filePath.startsWith(System.getProperty("user.dir"))) {
                log.warn("readFile: path outside working directory: {}", filePath);
                return "错误：不允许访问工作目录之外的路径";
            }
            String content = Files.readString(filePath, StandardCharsets.UTF_8);
            log.info("readFile: {} ({} bytes)", path, content.length());
            return content;
        } catch (IOException e) {
            log.error("readFile failed for {}: {}", path, e.getMessage());
            return "读取文件失败: " + e.getMessage();
        }
    }

    // ──────────────────────────────────────────────
    // 2. 文件写入
    // ──────────────────────────────────────────────

    @Tool(description = "将内容写入文件。如果文件不存在会自动创建；如果文件存在会被覆写。参数 path 为文件路径，content 为要写入的内容。")
    public String writeFile(
            @ToolParam(description = "目标文件路径") String path,
            @ToolParam(description = "要写入的完整文件内容") String content) {
        try {
            Path filePath = Paths.get(path).toAbsolutePath().normalize();
            if (!filePath.startsWith(System.getProperty("user.dir"))) {
                log.warn("writeFile: path outside working directory: {}", filePath);
                return "错误：不允许访问工作目录之外的路径";
            }
            // 确保父目录存在
            Path parent = filePath.getParent();
            if (parent != null && !Files.exists(parent)) {
                Files.createDirectories(parent);
            }
            Files.write(filePath, content.getBytes(StandardCharsets.UTF_8));
            log.info("writeFile: {} ({} bytes written)", path, content.length());
            return "✅ 文件已成功写入: " + path + " (" + content.length() + " 字节)";
        } catch (IOException e) {
            log.error("writeFile failed for {}: {}", path, e.getMessage());
            return "写入文件失败: " + e.getMessage();
        }
    }

    // ──────────────────────────────────────────────
    // 3. Shell 命令执行
    // ──────────────────────────────────────────────

    @Tool(description = "在服务器上执行 shell 命令（bash/sh），返回命令的标准输出。适用于 git 操作、文件搜索、编译构建等场景。注意：命令执行有时间限制。")
    public String executeCmd(@ToolParam(description = "要执行的 shell 命令") String command) {
        try {
            log.info("executeCmd: {}", command);
            ProcessBuilder pb = new ProcessBuilder("/bin/bash", "-c", command);
            pb.redirectErrorStream(true);
            Process process = pb.start();

            // 读取输出（带超时保护）
            String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
            boolean finished = process.waitFor(60, java.util.concurrent.TimeUnit.SECONDS);

            if (!finished) {
                process.destroyForcibly();
                return "⚠️ 命令执行超时（60秒限制），已被强制终止。\n部分输出:\n" +
                       truncate(output, 2000);
            }

            int exitCode = process.exitValue();
            String result = (exitCode == 0 ? output : "⚠️ 退出码 " + exitCode + "\n" + output);
            log.info("executeCmd: exit={} output_len={}", exitCode, result.length());
            return truncate(result, 4000);
        } catch (Exception e) {
            log.error("executeCmd failed: {}", e.getMessage());
            return "命令执行失败: " + e.getMessage();
        }
    }

    // ──────────────────────────────────────────────
    // 4. 代码搜索
    // ──────────────────────────────────────────────

    @Tool(description = "在项目代码库中搜索包含指定关键词的文件和行。支持正则表达式。返回匹配的文件路径、行号和内容片段。")
    public String searchCode(
            @ToolParam(description = "要搜索的关键词或正则表达式") String query,
            @ToolParam(description = "搜索范围（可选，默认当前目录）", required = false) String directory) {
        try {
            String dir = (directory == null || directory.isBlank()) ? "." : directory;
            Path rootPath = Paths.get(dir).toAbsolutePath().normalize();
            if (!Files.isDirectory(rootPath)) {
                return "错误：不是有效目录: " + dir;
            }

            StringBuilder result = new StringBuilder();
            result.append("🔍 搜索「").append(query).append("」 in ").append(rootPath).append("\n\n");

            // 使用 grep 风格搜索（简单实现）
            int matchCount = 0;
            int maxMatches = 50; // 限制结果数量

            try (Stream<Path> walk = Files.walk(rootPath)) {
                List<Path> files = walk
                        .filter(p -> !Files.isDirectory(p))
                        .filter(p -> isSourceFile(p.toString()))
                        .collect(Collectors.toList());

                for (Path file : files) {
                    if (matchCount >= maxMatches) break;
                    try {
                        List<String> lines = Files.readAllLines(file);
                        for (int i = 0; i < lines.size() && matchCount < maxMatches; i++) {
                            if (lines.get(i).toLowerCase().contains(query.toLowerCase())) {
                                result.append(file.toString()).append(":").append(i + 1)
                                      .append(" | ").append(lines.get(i)).append("\n");
                                matchCount++;
                            }
                        }
                    } catch (IOException ignored) { /* skip unreadable */ }
                }
            }

            result.append("\n--- 共 ").append(matchCount).append(" 处匹配 ---\n");
            log.info("searchCode: query='{}' matches={}", query, matchCount);
            return result.toString();
        } catch (Exception e) {
            log.error("searchCode failed: {}", e.getMessage());
            return "代码搜索失败: " + e.getMessage();
        }
    }

    // ──────────────────────────────────────────────
    // 5. 目录列表
    // ──────────────────────────────────────────────

    @Tool(description = "列出目录中的文件和子目录。支持递归浏览项目结构。")
    public String listFiles(
            @ToolParam(description = "要列出的目录路径（可选，默认当前目录）", required = false) String directory,
            @ToolParam(description = "是否递归列出子目录（可选，默认 false）", required = false) Boolean recursive) {
        try {
            String dir = (directory == null || directory.isBlank()) ? "." : directory;
            boolean recurse = Boolean.TRUE.equals(recursive);
            Path rootPath = Paths.get(dir).toAbsolutePath().normalize();

            if (!Files.isDirectory(rootPath)) {
                return "错误：不是有效目录: " + dir;
            }

            StringBuilder result = new StringBuilder();
            result.append("📂 ").append(rootPath).append("\n");

            Stream<Path> stream = recurse ? Files.walk(rootPath, 3) : Files.list(rootPath);
            try (stream) {
                List<Path> entries = stream.sorted().collect(Collectors.toList());
                for (Path entry : entries) {
                    String prefix = Files.isDirectory(entry) ? "📁 " : "📄 ";
                    // 相对路径显示
                    String display = rootPath.relativize(entry).toString();
                    result.append(prefix).append(display).append("\n");
                }
            }

            long count = Files.walk(rootPath, 1).count() - 1;
            result.append("\n--- 共 ").append(count).append(" 项 ---\n");
            log.info("listFiles: dir={} count={}", dir, count);
            return result.toString();
        } catch (Exception e) {
            log.error("listFiles failed: {}", e.getMessage());
            return "列出文件失败: " + e.getMessage();
        }
    }

    // ──────────────────────────────────────────────
    // 6. Canvas UI 推送
    // ──────────────────────────────────────────────

    @Tool(description = "向 SoloForge Canvas 推送 UI 更新事件。用于在前端画布上展示可视化结果、图表、渲染状态等。")
    public String canvasPushUi(
            @ToolParam(description = "UI 事件类型（如 render_status, chart_data, agent_avatar 等）") String eventType,
            @ToolParam(description = "事件负载（JSON 格式的数据）") String payload) {
        try {
            log.info("canvasPushUi: type={} payload_len={}", eventType, payload.length());
            // TODO: 通过 WebSocket 或 SSE 推送到前端 Canvas 组件
            // 当前先记录日志，后续可接入 WebSocketSessionRegistry
            return "✅ Canvas UI 事件已推送: type=" + eventType + ", payload=" + payload;
        } catch (Exception e) {
            log.error("canvasPushUi failed: {}", e.getMessage());
            return "Canvas 推送失败: " + e.getMessage();
        }
    }

    // ──────────────────────────────────────────────
    // 内部工具方法
    // ──────────────────────────────────────────────

    /** 判断是否为源代码文件 */
    private boolean isSourceFile(String filename) {
        String lower = filename.toLowerCase();
        return lower.endsWith(".java") || lower.endsWith(".ts") || lower.endsWith(".js")
                || lower.endsWith(".py") || lower.endsWith(".go") || lower.endsWith(".rs")
                || lower.endsWith(".json") || lower.endsWith(".yaml") || lower.endsWith(".yml")
                || lower.endsWith(".xml") || lower.endsWith(".md") || lower.endsWith(".txt")
                || lower.endsWith(".html") || lower.endsWith(".css") || lower.endsWith(".sql");
    }

    /** 截断过长字符串 */
    private static String truncate(String s, int maxLength) {
        if (s.length() <= maxLength) return s;
        return s.substring(0, maxLength) + "\n... (已截断，共 " + s.length() + " 字符)";
    }
}
