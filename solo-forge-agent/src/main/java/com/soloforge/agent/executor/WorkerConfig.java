package com.soloforge.agent.executor;

import java.util.Map;

/**
 * Worker configuration DTO.
 *
 * @param workerIdx   worker index
 * @param agentId     agent ID
 * @param provider    LLM provider config (baseUrl, apiKey, model)
 * @param maxRounds   max conversation rounds
 */
public record WorkerConfig(
        int workerIdx,
        String agentId,
        ProviderConfig provider,
        int maxRounds
) {
    public record ProviderConfig(
            String name,
            String baseUrl,
            String apiKey,
            String model
    ) {}
}
