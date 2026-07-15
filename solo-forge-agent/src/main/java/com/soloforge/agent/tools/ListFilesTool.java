package com.soloforge.agent.tools;

/** @deprecated Use {@link SoloForgeTools#listFiles(String, Boolean)} with {@code @Tool} annotation instead. */
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * 列出目录文件工具
 */
@Deprecated
@Slf4j
@Component
public class ListFilesTool {

    @Value("${soloforge.workspace:c:/Users/yangx/Desktop/SoloForge}")
    private String workspaceRoot;

    public String execute(String dirPath) {
        try {
            Path path = Paths.get(dirPath);
            if (!path.isAbsolute()) {
                path = Paths.get(workspaceRoot).resolve(path).normalize();
            }
            if (!Files.exists(path)) {
                return "目录不存在: " + dirPath;
            }
            if (!Files.isDirectory(path)) {
                return "路径不是目录: " + dirPath;
            }
            try (Stream<Path> stream = Files.list(path)) {
                return stream
                    .map(p -> {
                        String name = p.getFileName().toString();
                        String type = Files.isDirectory(p) ? "[DIR]" : "[FILE]";
                        long size = 0;
                        try { size = Files.size(p); } catch (IOException ignored) {}
                        return String.format("%-6s %8d  %s", type, size, name);
                    })
                    .sorted()
                    .collect(Collectors.joining("\n"));
            }
        } catch (Exception e) {
            log.error("list_files failed: {}", e.getMessage());
            return "列出失败: " + e.getMessage();
        }
    }

    public String getDescription() {
        return "list_files(dirPath): 列出目录内容,显示类型/大小/名称";
    }
}
