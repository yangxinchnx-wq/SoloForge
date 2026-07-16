package com.soloforge.agent.pool;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.concurrent.ConcurrentHashMap;

/**
 * MessagePool lifecycle manager.
 *
 * <p>Pools are created on demand and never evicted during runtime.
 * They are cleared only on application shutdown.
 */
@Component
public class PoolManager {
    private static final Logger log = LoggerFactory.getLogger(PoolManager.class);
    private final ConcurrentHashMap<String, MessagePool> pools = new ConcurrentHashMap<>();

    public MessagePool getOrCreate(String chatId) {
        return pools.computeIfAbsent(chatId, id -> {
            log.info("Creating MessagePool for chatId={}", id);
            return new MessagePool(id);
        });
    }

    public MessagePool get(String chatId) {
        return pools.get(chatId);
    }

    public void remove(String chatId) {
        MessagePool removed = pools.remove(chatId);
        if (removed != null) {
            log.info("Removed MessagePool for chatId={}", chatId);
        }
    }

    public int size() {
        return pools.size();
    }

    public void clear() {
        int count = pools.size();
        pools.clear();
        log.info("Cleared all MessagePools ({} pools)", count);
    }
}
