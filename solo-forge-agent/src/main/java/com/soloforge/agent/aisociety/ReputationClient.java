package com.soloforge.agent.aisociety;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;

import java.time.Duration;
import java.util.Map;

/**
 * 信誉 Client (推送 reputation 到 8766 + 查询 reputation 表)
 *
 * 任务完成后推送 reputation 增量到 AI Society 8766 HTTP 端点。
 * 选路时查询 reputation 表获取 Agent 当前信誉分。
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class ReputationClient {

    private final JdbcTemplate jdbcTemplate;

    @Value("${ai-society.reputation-url:http://127.0.0.1:8766/sync/reputation}")
    private String reputationUrl;

    /**
     * 查询 Agent 信誉分 (从 reputation 表)
     */
    public double getScore(String agentId) {
        try {
            var rows = jdbcTemplate.queryForList(
                "SELECT score FROM reputation WHERE entity_id = ? AND entity_type = 'agent' LIMIT 1",
                agentId);
            if (!rows.isEmpty()) {
                return ((Number) rows.get(0).get("score")).doubleValue();
            }
        } catch (Exception e) {
            log.warn("ReputationClient.getScore failed: {}", e.getMessage());
        }
        return 1.0; // 默认信誉分
    }

    /**
     * 推送 reputation 增量到 8766 (异步,失败不阻塞)
     */
    public void pushIncrement(String agentId, double delta, String reason) {
        try {
            Map<String, Object> payload = Map.of(
                "commandId", "cmd_rep_" + java.util.UUID.randomUUID().toString().replace("-", "").substring(0, 12),
                "txId", "tx_" + java.util.UUID.randomUUID().toString().replace("-", "").substring(0, 12),
                "traceId", "trace_" + agentId,
                "agentClusterId", agentId,
                "reputationIncrement", delta,
                "reasonCode", reason,
                "kernelVersionSeal", 1042,
                "timestamp", System.currentTimeMillis()
            );

            WebClient.builder()
                .baseUrl(reputationUrl.replace("/sync/reputation", ""))
                .defaultHeader(HttpHeaders.CONTENT_TYPE, MediaType.APPLICATION_JSON_VALUE)
                .build()
                .post()
                .uri("/sync/reputation")
                .bodyValue(payload)
                .retrieve()
                .bodyToMono(String.class)
                .timeout(Duration.ofSeconds(2))
                .doOnError(e -> log.warn("Reputation push failed (non-blocking): {}", e.getMessage()))
                .onErrorResume(e -> reactor.core.publisher.Mono.empty())
                .subscribe(r -> log.debug("Reputation pushed: agent={} delta={} reason={}", agentId, delta, reason));
        } catch (Exception e) {
            log.warn("ReputationClient.pushIncrement failed: {}", e.getMessage());
        }
    }

    /**
     * 计算信誉增量 (任务成功 +0.1, 失败 -0.2, 工具错误 -0.05)
     */
    public double computeDelta(boolean success, int toolErrors) {
        double delta = success ? 0.1 : -0.2;
        delta -= toolErrors * 0.05;
        return Math.max(-0.5, Math.min(0.3, delta)); // clamp [-0.5, 0.3]
    }

    /**
     * Push reputation synchronously (convenience method for SpringAiAgentExecutor)
     */
    public void pushReputationSync(String agentId, Map<String, Object> data) {
        try {
            Object lastAction = data.getOrDefault("lastAction", "unknown");
            double delta = 0.0;
            pushIncrement(agentId, delta, lastAction.toString());
        } catch (Exception e) {
            log.warn("pushReputationSync failed: {}", e.getMessage());
        }
    }
}
