package com.soloforge.agent;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * SoloForge Agent Service 启动入口
 *
 * 职责（训练专用，运行时聊天由 RACER Node.js 独占）：
 *   - Agent 身份管理 CRUD (ChatController)
 *   - 离线 Prompt 优化 (PromptOptimizer + 定时调度)
 *   - 经验案例库 RAG (FeedbackController + ExperienceCaseRepository)
 *   - Spring AI 2.0.0 GA ChatModel 多 Provider 配置 (LlmConfig)
 *
 * 端口：8770
 */
@SpringBootApplication
@EnableScheduling
public class SoloForgeAgentApplication {

    public static void main(String[] args) {
        SpringApplication.run(SoloForgeAgentApplication.class, args);
    }
}
