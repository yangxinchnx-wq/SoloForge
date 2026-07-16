package com.soloforge.agent.advisor;

import com.soloforge.agent.tools.SoloForgeTools;
import org.springframework.ai.chat.client.ChatClientRequest;
import org.springframework.ai.chat.client.ChatClientResponse;
import org.springframework.ai.chat.client.advisor.api.CallAdvisor;
import org.springframework.ai.chat.client.advisor.api.CallAdvisorChain;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

/**
 * ContextEnrichmentAdvisor - adds runtime context to the request.
 *
 * <p>Implementation notes:
 * <ul>
 *   <li>Adds system information, time, environment</li>
 *   <li>Runs early in the advisor chain</li>
 * </ul>
 */
@Component
@Order(2)
public class ContextEnrichmentAdvisor implements CallAdvisor, Ordered {
    private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(ContextEnrichmentAdvisor.class);

    @Override
    public String getName() {
        return ContextEnrichmentAdvisor.class.getName();
    }

    @Override
    public ChatClientResponse adviseCall(ChatClientRequest request, CallAdvisorChain chain) {
        log.debug("ContextEnrichmentAdvisor: adding runtime context");
        // TODO: Add runtime context to the request
        return chain.nextCall(request);
    }

    @Override
    public int getOrder() {
        return 2;
    }
}
