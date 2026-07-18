package com.soloforge.agent.executor;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Future;

/**
 * Tracks running worker futures by (dispatchId, workerIdx) so that judge
 * stop commands from RACER can cancel a specific worker mid-execution.
 *
 * <p>Lifecycle:
 * <ul>
 *   <li>{@link #register} — called by {@code MultiWorkerExecutionService} right after
 *       submitting a worker task to the executor</li>
 *   <li>{@link #cancel} — called when a stop/kill command is received
 *       via HTTP endpoint</li>
 *   <li>{@link #cleanup} — called by {@code MultiWorkerExecutionService} after all
 *       workers complete (or the dispatch is torn down)</li>
 * </ul>
 *
 * <p>Key format: {@code "dispatchId:workerIdx"} (e.g. {@code "pkt_abc:0"}).
 */
@Component
public class WorkerStopRegistry {
    private static final Logger log = LoggerFactory.getLogger(WorkerStopRegistry.class);

    private final ConcurrentHashMap<String, Future<?>> runningWorkers = new ConcurrentHashMap<>();

    /**
     * Register a running worker so it can be cancelled later.
     */
    public void register(String dispatchId, int workerIdx, Future<?> future) {
        String key = key(dispatchId, workerIdx);
        runningWorkers.put(key, future);
        log.debug("Registered worker: key={}", key);
    }

    /**
     * Cancel a running worker. Returns true if a future was found and cancelled.
     *
     * @param dispatchId the dispatch ID
     * @param workerIdx the worker index, or -1 to cancel ALL workers in this dispatch
     * @return true if at least one future was cancelled
     */
    public boolean cancel(String dispatchId, int workerIdx) {
        if (workerIdx >= 0) {
            String key = key(dispatchId, workerIdx);
            Future<?> future = runningWorkers.remove(key);
            if (future != null) {
                boolean cancelled = future.cancel(true);
                log.info("Cancelled worker: key={}, cancelled={}", key, cancelled);
                return cancelled;
            }
            log.warn("No running worker found for key={}", key);
            return false;
        }

        // workerIdx == -1: cancel ALL workers in this dispatch
        String prefix = dispatchId + ":";
        boolean anyCancelled = false;
        for (var entry : runningWorkers.entrySet()) {
            if (entry.getKey().startsWith(prefix)) {
                Future<?> f = runningWorkers.remove(entry.getKey());
                if (f != null) {
                    f.cancel(true);
                    anyCancelled = true;
                    log.info("Cancelled worker (bulk): key={}", entry.getKey());
                }
            }
        }
        return anyCancelled;
    }

    /**
     * Remove all futures for a dispatch (call after dispatch completes normally).
     */
    public void cleanup(String dispatchId) {
        String prefix = dispatchId + ":";
        runningWorkers.keySet().removeIf(k -> k.startsWith(prefix));
        log.debug("Cleaned up workers for dispatchId={}", dispatchId);
    }

    private static String key(String dispatchId, int workerIdx) {
        return dispatchId + ":" + workerIdx;
    }
}
