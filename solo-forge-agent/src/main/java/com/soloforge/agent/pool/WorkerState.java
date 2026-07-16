package com.soloforge.agent.pool;

import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Worker runtime state tracked in the MessagePool.
 */
public class WorkerState {
    private final AtomicInteger progress = new AtomicInteger(0);
    private volatile String status = "RUNNING"; // RUNNING, DONE, FAILED, STOPPED, TIMEOUT
    private volatile String lastOutput = "";
    private volatile long lastUpdate = System.currentTimeMillis();

    public void setProgress(int p) { this.progress.set(p); }
    public int getProgress() { return progress.get(); }

    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; this.lastUpdate = System.currentTimeMillis(); }

    public String getLastOutput() { return lastOutput; }
    public void setLastOutput(String lastOutput) { this.lastOutput = lastOutput; this.lastUpdate = System.currentTimeMillis(); }

    public long getLastUpdate() { return lastUpdate; }
}
