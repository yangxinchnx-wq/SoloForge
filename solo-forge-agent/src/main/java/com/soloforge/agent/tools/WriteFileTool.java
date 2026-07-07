package com.soloforge.agent.tools;

import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

/**
 * 文件写入工具
 */
@Slf4j
@Component
public class WriteFileTool {

    @Value("${soloforge.workspace:c:/Users/yangx/Desktop/SoloForge}")
    private String workspaceRoot;

    public String execute(String filePath, String content) {
        try {
            Path path = resolveSafe(filePath);
            Files.createDirectories(path.getParent());
            Files.writeString(path, content, StandardCharsets.UTF_8);
            log.info("write_file: {} ({} chars)", path, content.length());
            return "写入成功: " + path + " (" + content.length() + " 字符)";
        } catch (IOException e) {
            log.error("write_file failed: {}", e.getMessage());
            return "写入失败: " + e.getMessage();
        }
    }

    public String getDescription() {
        return "write_file(path, content): 写入文件内容,自动创建父目录";
    }

    Path resolveSafe(String filePath) {
        Path path = Paths.get(filePath);
        if (!path.isAbsolute()) {
            path = Paths.get(workspaceRoot).resolve(path);
        }
        return path.normalize();
    }
}
