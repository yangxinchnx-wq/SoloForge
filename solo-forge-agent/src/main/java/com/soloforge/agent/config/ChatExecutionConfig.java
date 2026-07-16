package com.soloforge.agent.config;

import com.soloforge.agent.tools.RemoteToolExecutor;
import com.soloforge.agent.tools.SoloForgeTools;
import com.soloforge.agent.transport.RacerTcpClient;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.ai.tool.ToolCallback;
import org.springframework.ai.tool.ToolCallbackProvider;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.util.List;

/**
 * Chat execution configuration.
 *
 * <p>Configures ChatClient, tools, and the executor for runtime chat execution.
 */
@Configuration
public class ChatExecutionConfig {

    @Bean
    public ChatClient chatClient(ChatModel chatModel) {
        return ChatClient.builder(chatModel)
                .build();
    }
}
