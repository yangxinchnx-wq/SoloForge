package com.soloforge.agent;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * SoloForge Agent Service 启动入口
 *
 * 职责：
 *   - 接管 RACER 的 Agent 编排职能（运行时执行层）
 *   - 通过 Spring AI ChatClient + Advisor 链构建 12 层 System Prompt
 *   - 多 Agent 协作编排（并行投票 / 角色分工 / 对话辩论）
 *   - 接入 AI Society 的 law/governance/reputation 约束
 *   - 推送训练轨迹到 MARL 8765 + reputation 到 8766
 *   - Phase 5: 离线 Prompt 优化 (PromptOptimizer + 定时调度)
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
