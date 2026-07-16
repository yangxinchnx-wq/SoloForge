package com.soloforge.agent.transport;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Newline-delimited JSON protocol for RACER <-> Java communication.
 *
 * <p>Message types (RACER -> Java):
 * <ul>
 *   <li>dispatch - start a multi-worker dispatch</li>
 *   <li>evaluate - judge evaluation / stop command</li>
 *   <li>tool_result - tool execution result from RACER</li>
 *   <li>ping - heartbeat</li>
 * </ul>
 *
 * <p>Message types (Java -> RACER):
 * <ul>
 *   <li>worker_started, worker_chunk, tool_call, worker_done, worker_failed</li>
 *   <li>pool_share, dispatch_done, tool_result (for remote tools)</li>
 *   <li>pong - heartbeat response</li>
 * </ul>
 */
@Component
public class MessageProtocol {
    private static final Logger log = LoggerFactory.getLogger(MessageProtocol.class);
    private final ObjectMapper objectMapper;

    public MessageProtocol(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    public String serialize(Object message) {
        try {
            return objectMapper.writeValueAsString(message);
        } catch (Exception e) {
            log.error("Failed to serialize message", e);
            return "{\"type\":\"error\",\"error\":\"" + e.getMessage() + "\"}";
        }
    }

    public Object deserialize(String json) {
        try {
            return objectMapper.readValue(json, Object.class);
        } catch (Exception e) {
            log.error("Failed to deserialize message: {}", json, e);
            return null;
        }
    }
}
