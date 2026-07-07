package com.soloforge.agent.aisociety;

import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.OutputStream;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * MARL 训练 Client (推送训练轨迹到 8765 TCP)
 *
 * Agent 执行任务后推送 AGENT_TRAINING_DATA 帧到 MARL 服务,
 * 用于在线训练 Agent 的工具/策略选择能力。
 *
 * 帧格式 (行分隔 JSON):
 *   {"frameId":"...","type":"AGENT_TRAINING_DATA","payload":{...}}
 *
 * 10 动作空间 (与 agent_env.py 对齐):
 *   0=READ_FILE, 1=WRITE_FILE, 2=EXECUTE_CMD, 3=SEARCH_CODE,
 *   4=LIST_FILES, 5=ASK_USER, 6=FINISH_TASK,
 *   7=SWITCH_PRECISION, 8=SWITCH_CREATIVE, 9=SWITCH_DEEP
 */
@Slf4j
@Component
public class MarlTrainingClient {

    @Value("${ai-society.marl-host:127.0.0.1}")
    private String marlHost;

    @Value("${ai-society.marl-port:8765}")
    private int marlPort;

    private final ObjectMapper objectMapper = new ObjectMapper();

    /**
     * 推送训练轨迹 (异步,失败不阻塞)
     *
     * @param agentId Agent ID
     * @param observation 10 维观测 (任务特征 4 + Agent 状态 4 + 上下文 2)
     * @param action 实际选择的动作 (0-9)
     * @param reward 计算的 reward
     */
    public void pushTrace(String agentId, double[] observation, int action, double reward) {
        // 异步推送,不阻塞主流程
        new Thread(() -> {
            try {
                doPush(agentId, observation, action, reward);
            } catch (Exception e) {
                log.debug("MARL push failed (non-blocking): {}", e.getMessage());
            }
        }, "marl-push-" + agentId).start();
    }

    private void doPush(String agentId, double[] observation, int action, double reward) throws IOException {
        // Phase 5 修复: payload 必须含 trainingData 数组, 与 server.py _consume_agent_training_data 对齐
        Map<String, Object> trace = new LinkedHashMap<>();
        trace.put("observation", observation);
        trace.put("action", action);
        trace.put("log_prob", 0.0);          // 占位, MAPPO 训练时会重算
        trace.put("reward", reward);
        trace.put("value", 0.0);              // 占位, Critic 会重算
        trace.put("done", true);              // 单条 trace 即一个完整 episode
        trace.put("kernel_version", 1042);
        trace.put("agent_id", agentId);

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("trainingData", java.util.List.of(trace));  // server.py 期望 trainingData 数组
        payload.put("agent_id", agentId);

        Map<String, Object> frame = new LinkedHashMap<>();
        frame.put("frameId", "frame_" + java.util.UUID.randomUUID().toString().replace("-", "").substring(0, 12));
        frame.put("type", "AGENT_TRAINING_DATA");
        frame.put("currentTick", 0);
        frame.put("payload", payload);
        frame.put("kernelVersionSeal", 1042);

        String json = objectMapper.writeValueAsString(frame) + "\n";

        try (Socket socket = new Socket()) {
            socket.connect(new java.net.InetSocketAddress(marlHost, marlPort), (int) Duration.ofSeconds(2).toMillis());
            socket.setSoTimeout((int) Duration.ofSeconds(2).toMillis());
            OutputStream out = socket.getOutputStream();
            out.write(json.getBytes(StandardCharsets.UTF_8));
            out.flush();
            log.debug("MARL trace pushed: agent={} action={} reward={}", agentId, action, reward);
        }
    }

    /**
     * 10 动作枚举
     */
    public static final int ACTION_READ_FILE = 0;
    public static final int ACTION_WRITE_FILE = 1;
    public static final int ACTION_EXECUTE_CMD = 2;
    public static final int ACTION_SEARCH_CODE = 3;
    public static final int ACTION_LIST_FILES = 4;
    public static final int ACTION_ASK_USER = 5;
    public static final int ACTION_FINISH_TASK = 6;
    public static final int ACTION_SWITCH_PRECISION = 7;
    public static final int ACTION_SWITCH_CREATIVE = 8;
    public static final int ACTION_SWITCH_DEEP = 9;

    /**
     * 根据工具名映射到动作
     */
    public int actionFromToolName(String toolName) {
        if (toolName == null) return ACTION_FINISH_TASK;
        return switch (toolName) {
            case "read_file" -> ACTION_READ_FILE;
            case "write_file" -> ACTION_WRITE_FILE;
            case "execute_cmd" -> ACTION_EXECUTE_CMD;
            case "search_code" -> ACTION_SEARCH_CODE;
            case "list_files" -> ACTION_LIST_FILES;
            default -> ACTION_FINISH_TASK;
        };
    }
}
