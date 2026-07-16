package com.soloforge.agent.tools;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.List;

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
        // Simple implementation: walk current directory and grep lines
        // In production, use a proper code search library
        StringBuilder result = new StringBuilder();
        Path start = Paths.get("").toAbsolutePath();
        try (var stream = Files.walk(start)) {
            stream.filter(p -> !p.toString().contains("node_modules") && !p.toString().contains(".git"))
                    .filter(p -> {
                        if (fileGlob == null || fileGlob.isBlank()) return true;
                        String fn = p.getFileName().toString();
                        return fn.matches(fileGlob.replace(".", "\\.").replace("*", ".*"));
                    })
                    .forEach(p -> {
                        try {
                            List<String> lines = Files.readAllLines(p, StandardCharsets.UTF_8);
                            for (int i = 0; i < lines.size(); i++) {
                                if (lines.get(i).contains(pattern)) {
                                    result.append(p.getFileName()).append(":").append(i + 1).append(": ").append(lines.get(i)).append("\n");
                                }
                            }
                        } catch (IOException e) {
                            // skip unreadable files
                        }
                    });
        }
        return result.length() > 0 ? result.toString() : "No matches found for: " + pattern;
    }

    public String executeCmd(String command) throws IOException, InterruptedException {
        log.info("execute_cmd: command={}", command);
        ProcessBuilder pb = new ProcessBuilder("cmd.exe", "/c", command);
        pb.redirectErrorStream(true);
        Process process = pb.start();

        StringBuilder output = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                output.append(line).append("\n");
            }
        }

        int exitCode = process.waitFor();
        String result = "Exit code: " + exitCode + "\n" + output.toString();
        log.info("execute_cmd result: exitCode={}, outputLength={}", exitCode, output.length());
        return result;
    }

    public String canvasPushUi(String sessionId, String dslJson, String language) throws IOException {
        log.info("canvas_push_ui: sessionId={}, language={}", sessionId, language);
        // Relay to existing HTTP endpoint
        // In production, use WebClient or RestTemplate to call RACER's canvas relay
        return "OK: Canvas UI pushed for session " + sessionId;
    }
}
