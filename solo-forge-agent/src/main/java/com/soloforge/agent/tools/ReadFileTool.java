package com.soloforge.agent.tools;

/** @deprecated Use {@link SoloForgeTools#readFile(String)} with {@code @Tool} annotation instead. */
@Deprecated

import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * 文件读取工具
 */
@Slf4j
@Component
public class ReadFileTool {

    @Value("${soloforge.workspace:c:/Users/yangx/Desktop/SoloForge}")
    private String workspaceRoot;

    public String execute(String filePath) {
        try {
            Path path = resolveSafe(filePath);
            if (!Files.exists(path)) {
                return "文件不存在: " + filePath;
            }
            if (Files.isDirectory(path)) {
                return "路径是目录,不是文件: " + filePath;
            }
            List<String> lines = Files.readAllLines(path, StandardCharsets.UTF_8);
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < lines.size(); i++) {
                sb.append(String.format("%4d→%s%n", i + 1, lines.get(i)));
            }
            return sb.toString();
        } catch (IOException e) {
            log.error("read_file failed: {}", e.getMessage());
            return "读取失败: " + e.getMessage();
        }
    }

    public String getDescription() {
        return "read_file(path): 读取项目文件内容,返回带行号的文本";
    }

    Path resolveSafe(String filePath) {
        Path path = Paths.get(filePath);
        if (!path.isAbsolute()) {
            path = Paths.get(workspaceRoot).resolve(path);
        }
        return path.normalize();
    }
}
