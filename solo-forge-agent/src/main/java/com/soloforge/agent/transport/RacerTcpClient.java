package com.soloforge.agent.transport;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Wrapper for sending messages to RACER via the TcpServer's accepted client connection.
 *
 * <p>Previously this class maintained its own TCP client connection to 127.0.0.1:8771,
 * which was architecturally incorrect (it would connect to its own server).
 * Now it delegates to {@link TcpServer#send(String)} which writes to the
 * RACER-side socket accepted by the TcpServer.
 *
 * <p>This bean is kept for backward compatibility with {@code MultiWorkerExecutionService}
 * which injects it.
 */
@Component
public class RacerTcpClient {
    private static final Logger log = LoggerFactory.getLogger(RacerTcpClient.class);

    private final TcpServer tcpServer;
    private final ObjectMapper objectMapper;

    public RacerTcpClient(TcpServer tcpServer, ObjectMapper objectMapper) {
        this.tcpServer = tcpServer;
        this.objectMapper = objectMapper;
    }

    /**
     * Send a raw JSON string message to RACER.
     */
    public void send(String message) {
        tcpServer.send(message);
    }

    /**
     * Serialize and send an object as JSON to RACER.
     */
    public void send(Object message) {
        try {
            send(objectMapper.writeValueAsString(message));
        } catch (Exception e) {
            log.error("Failed to serialize message", e);
        }
    }

    public boolean isConnected() {
        return tcpServer.isClientConnected();
    }
}
