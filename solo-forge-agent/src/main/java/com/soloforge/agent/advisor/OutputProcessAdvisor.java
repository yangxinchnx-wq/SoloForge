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
 * OutputProcessAdvisor - final output processing.
 *
 * <p>Implementation notes:
 * <ul>
 *   <li>Post-processes final output before sending to RACER</li>
 *   <li>Applies any final formatting or filtering</li>
 *   <li>Last advisor in the chain</li>
 * </ul>
 */
@Component
@Order(8)
public class OutputProcessAdvisor implements CallAdvisor, Ordered {
    private static final Logger log = LoggerFactory.getLogger(OutputProcessAdvisor.class);

    @Override
    public String getName() {
        return OutputProcessAdvisor.class.getName();
    }

    @Override
    public ChatClientResponse adviseCall(ChatClientRequest request, CallAdvisorChain chain) {
        log.debug("OutputProcessAdvisor: processing final output");
        // TODO: Implement final output processing
        return chain.nextCall(request);
    }

    @Override
    public int getOrder() {
        return 8;
    }
}
