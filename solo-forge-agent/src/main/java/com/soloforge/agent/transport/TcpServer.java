package com.soloforge.agent.transport;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.io.*;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.*;
import java.util.function.Consumer;

/**
 * Raw TCP server listening on 127.0.0.1:8771.
 *
 * <p>Accepts a single persistent connection from RACER.
 * Messages are newline-delimited JSON.
 *
 * <p>Implementation notes:
 * <ul>
 *   <li>Bind to 127.0.0.1 only, not exposed externally</li>
 *   <li>Single acceptor thread, single active client connection</li>
 *   <li>Reads lines and dispatches to handler</li>
 *   <li>Stores client writer to enable bidirectional communication</li>
 *   <li>New client connections replace (and close) any existing connection</li>
 *   <li>send() detects client disconnects via checkError() and clears the writer</li>
 * </ul>
 */
@Component
public class TcpServer {
    private static final Logger log = LoggerFactory.getLogger(TcpServer.class);
    private static final String HOST = "127.0.0.1";
    private static final int PORT = 8771;

    private final ObjectMapper objectMapper;
    private final ExecutorService executor = Executors.newCachedThreadPool();
    private volatile ServerSocket serverSocket;
    private volatile Thread acceptorThread;
    private volatile boolean running = false;
    private volatile Consumer<String> onMessage;

    // Bidirectional: store the client writer for sending messages back to RACER.
    // All access to these fields is guarded by `this` monitor.
    private PrintWriter clientWriter;
    private Socket clientSocket;

    public TcpServer(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    public void setOnMessage(Consumer<String> onMessage) {
        this.onMessage = onMessage;
    }

    @PostConstruct
    public void init() {
        start();
    }

    @PreDestroy
    public void destroy() {
        stop();
    }

    public void start() {
        if (running) {
            log.warn("TCP server already running");
            return;
        }

        acceptorThread = new Thread(() -> {
            try {
                serverSocket = new ServerSocket();
                serverSocket.bind(new InetSocketAddress(HOST, PORT));
                running = true;
                log.info("TCP server listening on {}:{}", HOST, PORT);

                while (running && !serverSocket.isClosed()) {
                    try {
                        Socket client = serverSocket.accept();
                        log.info("TCP client connected: {}", client.getRemoteSocketAddress());
                        handleClient(client);
                    } catch (IOException e) {
                        if (running) {
                            log.error("Error accepting TCP connection", e);
                        }
                    }
                }
            } catch (IOException e) {
                if (running) {
                    log.error("TCP server error", e);
                }
            } finally {
                log.info("TCP server stopped");
            }
        }, "tcp-acceptor");
        acceptorThread.setDaemon(true);
        acceptorThread.start();
    }

    private void handleClient(Socket client) {
        executor.submit(() -> {
            // Close any existing client connection before accepting the new one.
            // RACER may reconnect without cleanly closing the old socket; we must not
            // allow two readers to fight over the clientWriter slot.
            synchronized (this) {
                if (clientSocket != null && !clientSocket.isClosed()) {
                    log.warn("New client connecting while an old one is still open; closing old connection");
                    try { clientSocket.close(); } catch (IOException ignored) {}
                }
                this.clientSocket = client;
                try {
                    client.setTcpNoDelay(true);
                    this.clientWriter = new PrintWriter(
                        new OutputStreamWriter(client.getOutputStream(), StandardCharsets.UTF_8),
                        true
                    );
                } catch (IOException e) {
                    log.error("Failed to setup client writer", e);
                    this.clientWriter = null;
                    this.clientSocket = null;
                    return;
                }
            }
            try {
                BufferedReader reader = new BufferedReader(
                    new InputStreamReader(client.getInputStream(), StandardCharsets.UTF_8)
                );
                String line;
                while ((line = reader.readLine()) != null) {
                    handleMessage(line);
                }
            } catch (IOException e) {
                log.debug("TCP client disconnected: {}", e.getMessage());
            } finally {
                synchronized (this) {
                    clientWriter = null;
                    clientSocket = null;
                }
                try {
                    client.close();
                } catch (IOException e) {
                    // ignore
                }
                log.info("TCP client disconnected");
            }
        });
    }

    /**
     * Handle an incoming message line.
     * Directly handles ping/pong; forwards everything else to the registered onMessage handler.
     */
    private void handleMessage(String line) {
        if (line == null || line.isBlank()) return;

        // Fast path: handle ping without JSON parse
        if (line.contains("\"type\":\"ping\"") || line.contains("\"type\": \"ping\"")) {
            send("{\"type\":\"pong\"}");
            return;
        }

        if (onMessage != null) {
            try {
                onMessage.accept(line);
            } catch (Exception e) {
                log.error("Error in onMessage handler", e);
            }
        } else {
            log.warn("No onMessage handler registered, dropping message: {}", line);
        }
    }

    /**
     * Send a message to the connected RACER client.
     * Messages are newline-terminated JSON.
     *
     * <p>If the underlying PrintWriter reports an error (e.g. the socket is broken),
     * the client writer is cleared so subsequent sends fail fast until the next
     * reconnect, instead of silently swallowing data.
     */
    public synchronized void send(String message) {
        if (clientWriter == null) {
            log.warn("Cannot send: no TCP client connected");
            return;
        }
        try {
            clientWriter.print(message);
            clientWriter.print("\n");
            clientWriter.flush();
            if (clientWriter.checkError()) {
                log.warn("TCP send failed (client writer reported error), clearing writer");
                closeClientQuietly();
            }
        } catch (Exception e) {
            log.error("Failed to send TCP message", e);
            closeClientQuietly();
        }
    }

    private void closeClientQuietly() {
        if (clientSocket != null) {
            try { clientSocket.close(); } catch (IOException ignored) {}
        }
        clientWriter = null;
        clientSocket = null;
    }

    /**
     * Check if a client is connected and writable.
     */
    public synchronized boolean isClientConnected() {
        return clientWriter != null
            && clientSocket != null
            && !clientSocket.isClosed()
            && clientSocket.isConnected();
    }

    public void stop() {
        running = false;
        try {
            if (serverSocket != null && !serverSocket.isClosed()) {
                serverSocket.close();
            }
        } catch (IOException e) {
            log.debug("Error closing server socket", e);
        }
        synchronized (this) {
            closeClientQuietly();
        }
        executor.shutdown();
        try {
            if (!executor.awaitTermination(2, TimeUnit.SECONDS)) {
                executor.shutdownNow();
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        log.info("TCP server shutting down");
    }
}
