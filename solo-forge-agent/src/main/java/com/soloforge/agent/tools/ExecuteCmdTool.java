package com.soloforge.agent.tools;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;

/**
 * 命令执行工具
 */
@Slf4j
@Component
public class ExecuteCmdTool {

    public String execute(String command) {
        try {
            // Windows 默认用 cmd /c, Linux/Mac 用 bash -c
            String[] cmd = System.getProperty("os.name").toLowerCase().contains("win")
                ? new String[]{"cmd", "/c", command}
                : new String[]{"bash", "-c", command};

            ProcessBuilder pb = new ProcessBuilder(cmd);
            pb.redirectErrorStream(true);
            Process process = pb.start();

            String output;
            try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                output = reader.lines().collect(Collectors.joining("\n"));
            }

            boolean finished = process.waitFor(30, TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
                return "命令超时 (30s),已终止: " + command;
            }

            int exitCode = process.exitValue();
            if (exitCode != 0) {
                output = output + "\n[exit code: " + exitCode + "]";
            }
            return output;
        } catch (Exception e) {
            log.error("execute_cmd failed: {}", e.getMessage());
            return "执行失败: " + e.getMessage();
        }
    }

    public String getDescription() {
        return "execute_cmd(command): 执行终端命令,30秒超时,返回 stdout+stderr";
    }
}
