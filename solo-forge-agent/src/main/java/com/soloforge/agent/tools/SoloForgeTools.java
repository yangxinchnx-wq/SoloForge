package com.soloforge.agent.tools;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.io.*;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;

/**
 * Built-in tools executed directly in Java.
 *
 * <p>Implementation notes:
 * <ul>
 *   <li>read_file / write_file / list_files / search_code use Java NIO</li>
 *   <li>execute_cmd uses ProcessBuilder with cmd.exe /c on Windows</li>
 *   <li>canvas_push_ui relays to existing HTTP endpoint</li>
 * </ul>
 */
@Component
public class SoloForgeTools {
    private static final Logger log = LoggerFactory.getLogger(SoloForgeTools.class);

    public String readFile(String path) throws IOException {
        log.info("read_file: path={}", path);
        Path p = Path.of(path);
        if (!Files.exists(p)) {
            return "ERROR: File not found: " + path;
        }
        return Files.readString(p, StandardCharsets.UTF_8);
    }

    public String writeFile(String path, String content) throws IOException {
        log.info("write_file: path={}, contentLength={}", path, content.length());
        Path p = Path.of(path);
        Files.createDirectories(p.getParent());
        Files.writeString(p, content, StandardCharsets.UTF_8, StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING);
        return "OK: Written " + content.length() + " bytes to " + path;
    }

    public String listFiles(String dirPath) throws IOException {
        log.info("list_files: dirPath={}", dirPath);
        Path dir = Paths.get(dirPath);
        if (!Files.isDirectory(dir)) {
            return "ERROR: Not a directory: " + dirPath;
        }
        try (var stream = Files.list(dir)) {
            List<String> entries = stream.map(p -> p.getFileName().toString() + (Files.isDirectory(p) ? "/" : ""))
                    .toList();
            return String.join("\n", entries);
        }
    }

    public String searchCode(String pattern, String fileGlob) throws IOException {
        log.info("search_code: pattern={}, fileGlob={}", pattern, fileGlob);

        // 1) 编译正则表达式 (用户传入的是正则，不是纯文本)
        final Pattern regex;
        try {
            regex = Pattern.compile(pattern, Pattern.CASE_INSENSITIVE);
        } catch (PatternSyntaxException e) {
            return "ERROR: Invalid regex pattern: " + e.getMessage();
        }

        // 2) 将 glob 转为正则 (*.ts → ^.*\.ts$)
        final Pattern globRegex;
        if (fileGlob != null && !fileGlob.isBlank()) {
            String g = fileGlob.trim();
            // 只保留文件名匹配部分 (去掉路径前缀)
            if (g.contains("/") || g.contains("\\")) {
                g = g.substring(Math.max(g.lastIndexOf('/'), g.lastIndexOf('\\')) + 1);
            }
            StringBuilder rb = new StringBuilder("^");
            for (int i = 0; i < g.length(); i++) {
                char c = g.charAt(i);
                switch (c) {
                    case '*': rb.append(".*"); break;
                    case '?': rb.append('.'); break;
                    case '.': rb.append("\\."); break;
                    default:
                        // 转义正则特殊字符
                        if ("\\^$+{}[]|()".indexOf(c) >= 0) {
                            rb.append('\\');
                        }
                        rb.append(c);
                }
            }
            rb.append('$');
            globRegex = Pattern.compile(rb.toString());
        } else {
            globRegex = null;
        }

        // 3) 递归搜索，限制深度 5 层，最多 30 条结果
        List<String> matches = new ArrayList<>();
        int maxResults = 30;
        Path start = Paths.get("").toAbsolutePath();
        searchDirRecursive(start, regex, globRegex, matches, maxResults, 0);
        return matches.isEmpty() ? "No matches found for: " + pattern : String.join("\n", matches);
    }

    private void searchDirRecursive(Path dir, Pattern regex, Pattern globRegex,
                                     List<String> matches, int maxResults, int depth) {
        if (depth > 5 || matches.size() >= maxResults) return;
        DirectoryStream<Path> ds;
        try {
            ds = Files.newDirectoryStream(dir);
        } catch (IOException e) {
            return;
        }
        try (ds) {
            for (Path p : ds) {
                if (matches.size() >= maxResults) break;
                String name = p.getFileName().toString();
                // 跳过隐藏目录和黑名单
                if (name.startsWith(".") || name.equals("node_modules") || name.equals("dist")) {
                    continue;
                }
                if (Files.isDirectory(p)) {
                    searchDirRecursive(p, regex, globRegex, matches, maxResults, depth + 1);
                } else if (Files.isRegularFile(p)) {
                    // glob 过滤
                    if (globRegex != null && !globRegex.matcher(name).matches()) {
                        continue;
                    }
                    try {
                        List<String> lines = Files.readAllLines(p, StandardCharsets.UTF_8);
                        for (int i = 0; i < lines.size() && matches.size() < maxResults; i++) {
                            if (regex.matcher(lines[i]).find()) {
                                String rel = Paths.get("").toAbsolutePath().relativize(p).toString();
                                matches.add(rel + ":" + (i + 1) + ": " + lines.get(i).trim());
                            }
                        }
                    } catch (IOException e) {
                        // skip binary / unreadable files
                    }
                }
            }
        }
    }

    private static final long CMD_TIMEOUT_SECONDS = 30;
    private static final boolean IS_WINDOWS = System.getProperty("os.name", "").toLowerCase().contains("win");

    public String executeCmd(String command) throws IOException, InterruptedException {
        log.info("execute_cmd: command={}", command);

        // 跨平台: Windows 用 cmd.exe /c, Linux/Mac 用 sh -c
        List<String> cmd = IS_WINDOWS
                ? List.of("cmd.exe", "/c", command)
                : List.of("sh", "-c", command);
        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.redirectErrorStream(false); // 分离 stdout 和 stderr
        Process process = pb.start();

        // 并行读取 stdout 和 stderr
        StringBuilder stdout = new StringBuilder();
        StringBuilder stderr = new StringBuilder();
        Thread stdoutThread = new Thread(() -> drainStream(process.getInputStream(), stdout));
        Thread stderrThread = new Thread(() -> drainStream(process.getErrorStream(), stderr));
        stdoutThread.start();
        stderrThread.start();

        // 等待完成，超时 30 秒
        boolean finished = process.waitFor(CMD_TIMEOUT_SECONDS, java.util.concurrent.TimeUnit.SECONDS);
        if (!finished) {
            process.destroyForcibly();
            stdoutThread.join(1000);
            stderrThread.join(1000);
            return "ERROR: Command timed out after " + CMD_TIMEOUT_SECONDS + "s\n"
                    + stdout + (stderr.length() > 0 ? "\n[stderr]\n" + stderr : "");
        }

        stdoutThread.join(5000);
        stderrThread.join(5000);

        int exitCode = process.exitValue();
        StringBuilder result = new StringBuilder();
        result.append(stdout);
        if (stderr.length() > 0) {
            result.append("\n[stderr]\n").append(stderr);
        }

        log.info("execute_cmd result: exitCode={}, stdoutLen={}, stderrLen={}",
                exitCode, stdout.length(), stderr.length());
        return result.toString().trim();
    }

    private static void drainStream(InputStream is, StringBuilder sb) {
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                sb.append(line).append("\n");
            }
        } catch (IOException ignored) {
        }
    }

    private static final String UI_BASE_URL = System.getenv().getOrDefault("SOLOFORGE_UI_BASE_URL", "http://localhost:3000");

    public String canvasPushUi(String sessionId, String dslJson, String language) throws IOException {
        log.info("canvas_push_ui: sessionId={}, language={}", sessionId, language);

        // 构造 JSON 请求体 (与 TS 版本 tool-definitions.ts 对齐)
        String jsonBody = String.format(
                "{\"sessionId\":\"%s\",\"dsl\":%s,\"language\":\"%s\"}",
                escapeJson(sessionId),
                dslJson,  // 已经是 JSON 字符串，直接嵌入
                escapeJson(language != null ? language : "typescript")
        );

        try {
            HttpClient client = HttpClient.newBuilder()
                    .connectTimeout(Duration.ofSeconds(10))
                    .build();

            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(UI_BASE_URL + "/api/canvas/relay/push-ui"))
                    .header("Content-Type", "application/json")
                    .timeout(Duration.ofSeconds(15))
                    .POST(HttpRequest.BodyPublishers.ofString(jsonBody, StandardCharsets.UTF_8))
                    .build();

            HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));

            if (response.statusCode() == 200) {
                log.info("canvas_push_ui: success, sessionId={}, body={}", sessionId, response.body());
                return "OK: Canvas UI pushed for session " + sessionId;
            } else {
                String errMsg = "HTTP " + response.statusCode() + ": " + response.body();
                log.error("canvas_push_ui failed: {}", errMsg);
                return "ERROR: canvas_push_ui failed: " + errMsg;
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return "ERROR: canvas_push_ui interrupted: " + e.getMessage();
        } catch (Exception e) {
            log.error("canvas_push_ui error: {}", e.getMessage());
            return "ERROR: canvas_push_ui failed (" + UI_BASE_URL + "): " + e.getMessage();
        }
    }

    private static String escapeJson(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r");
    }
}
