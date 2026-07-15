package com.soloforge.agent.tools;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

/**
 * 文件写入工具
 *
 * @deprecated Path C: 已迁移至 {@link com.soloforge.agent.tools.SoloForgeTools#writeFile}
 */
@Deprecated
@Slf4j
@Component
public class WriteFileTool {

    public String getDescription() {
        return "Write content to a file";
    }

    public String execute(String filePath, String content) {
        try {
            Path target = Paths.get(filePath);
            // 自动创建父目录
            if (target.getParent() != null) {
                Files.createDirectories(target.getParent());
            }
            Files.write(target, content.getBytes(StandardCharsets.UTF_8));
            log.info("WriteFileTool: 写入成功 {} ({} bytes)", filePath, content.length());
            return "OK: 已写入 " + filePath + " (" + content.length() + " bytes)";
        } catch (Exception e) {
            log.error("WriteFileTool: 写入失败 {} - {}", filePath, e.getMessage());
            return "ERROR: " + e.getMessage();
        }
    }
}
