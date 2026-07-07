package com.soloforge.agent.tools;

import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.FileVisitOption;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * 代码搜索工具 (正则匹配)
 */
@Slf4j
@Component
public class SearchCodeTool {

    @Value("${soloforge.workspace:c:/Users/yangx/Desktop/SoloForge}")
    private String workspaceRoot;

    public String execute(String pattern, String fileGlob) {
        try {
            Pattern regex = Pattern.compile(pattern);
            Path root = Paths.get(workspaceRoot);
            List<String> results = new ArrayList<>();
            int maxResults = 100;

            try (Stream<Path> stream = Files.walk(root, 10, FileVisitOption.FOLLOW_LINKS)) {
                stream.filter(p -> !isExcluded(p))
                    .filter(p -> fileGlob == null || fileGlob.isBlank() || p.getFileName().toString().endsWith(fileGlob.replace("*", "")))
                    .filter(Files::isRegularFile)
                    .forEach(p -> {
                        if (results.size() >= maxResults) return;
                        try {
                            List<String> lines = Files.readAllLines(p);
                            for (int i = 0; i < lines.size() && results.size() < maxResults; i++) {
                                if (regex.matcher(lines.get(i)).find()) {
                                    results.add(String.format("%s:%d: %s",
                                        root.relativize(p).toString().replace('\\', '/'),
                                        i + 1, lines.get(i).trim()));
                                }
                            }
                        } catch (IOException ignored) {
                            // 跳过不可读文件
                        }
                    });
            }

            if (results.isEmpty()) {
                return "未找到匹配: " + pattern;
            }
            return "找到 " + results.size() + " 处匹配:\n" + String.join("\n", results);
        } catch (Exception e) {
            log.error("search_code failed: {}", e.getMessage());
            return "搜索失败: " + e.getMessage();
        }
    }

    public String getDescription() {
        return "search_code(pattern, fileGlob?): 正则搜索代码,返回文件:行号:内容";
    }

    private boolean isExcluded(Path p) {
        String s = p.toString().toLowerCase().replace('\\', '/');
        return s.contains("/node_modules/") || s.contains("/.git/")
            || s.contains("/dist/") || s.contains("/build/")
            || s.contains("/__pycache__/") || s.contains("/.next/");
    }
}
