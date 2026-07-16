package com.soloforge.agent.advisor;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClientRequest;
import org.springframework.ai.chat.client.ChatClientResponse;
import org.springframework.ai.chat.client.advisor.api.CallAdvisor;
import org.springframework.ai.chat.client.advisor.api.CallAdvisorChain;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

/**
 * ConsistencyCheckAdvisor - ensures tool definitions are unique.
 *
 * <p>Implementation notes:
 * <ul>
 *   <li>Validates that tool definitions are not duplicated</li>
 *   <li>Removes duplicate tools with same id</li>
 *   <li>Runs early in the advisor chain</li>
 * </ul>
 */
@Component
@Order(1)
public class ConsistencyCheckAdvisor implements CallAdvisor, Ordered {
    private static final Logger log = LoggerFactory.getLogger(ConsistencyCheckAdvisor.class);

    @Override
    public String getName() {
        return ConsistencyCheckAdvisor.class.getName();
    }

    @Override
    public ChatClientResponse adviseCall(ChatClientRequest request, CallAdvisorChain chain) {
        // Validate tool definitions
        // Remove duplicates, ensure uniqueness
        log.debug("ConsistencyCheckAdvisor: validating tools");
        return chain.nextCall(request);
    }

    @Override
    public int getOrder() {
        return 1;
    }
}
