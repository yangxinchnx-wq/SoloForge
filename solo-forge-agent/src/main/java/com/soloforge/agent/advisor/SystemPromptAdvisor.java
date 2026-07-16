package com.soloforge.agent.advisor;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClientRequest;
import org.springframework.ai.chat.client.ChatClientResponse;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.ai.chat.prompt.PromptTemplate;
import org.springframework.core.io.ClassPathResource;
import org.springframework.core.io.Resource;
import org.springframework.stereotype.Component;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.stream.Collectors;

/**
 * SystemPromptAdvisor - 12-layer system prompt assembly.
 *
 * <p>Implementation notes:
 * <ul>
 *   <li>Assembles 12 layers of system prompt from various sources</li>
 *   <li>Layer 12 reads permission mode rules from UI/resources/rules/</li>
 *   <li>Layer 9 reads active skills from UI/resources/skills/</li>
 *   <li>Layers 1-8 come from agent identity, frontend settings, and runtime context</li>
 * </ul>
 */
@Component
public class SystemPromptAdvisor {
    private static final Logger log = LoggerFactory.getLogger(SystemPromptAdvisor.class);
    private static final String RULES_DIR = "rules/";

    private final ChatModel chatModel;

    public SystemPromptAdvisor(ChatModel chatModel) {
        this.chatModel = chatModel;
    }

    public String buildSystemPrompt(Map<String, Object> context) {
        StringBuilder prompt = new StringBuilder();

        // Layer 1: Identity
        prompt.append("[Layer 1: Identity]\n");
        prompt.append(context.getOrDefault("identity", "You are SoloForge AI Agent.\n"));

        // Layer 2: Personality
        prompt.append("\n[Layer 2: Personality]\n");
        prompt.append(context.getOrDefault("personality", "You are helpful and professional.\n"));

        // Layer 3: Tone
        prompt.append("\n[Layer 3: Tone]\n");
        prompt.append(context.getOrDefault("tone", "Use clear, concise language.\n"));

        // Layer 4: Emoji preference
        prompt.append("\n[Layer 4: Emoji]\n");
        prompt.append(context.getOrDefault("emojiMode", "false").equals(true) ? "Use emoji when appropriate.\n" : "Do not use emoji.\n");

        // Layer 5: Capabilities
        prompt.append("\n[Layer 5: Capabilities]\n");
        prompt.append(context.getOrDefault("capabilities", "read, write, search, analyze, execute commands\n"));

        // Layer 6: Workspace
        prompt.append("\n[Layer 6: Workspace]\n");
        prompt.append("Your workspace is: ").append(context.getOrDefault("workspaceFolder", ".")).append("\n");

        // Layer 7: Tools
        prompt.append("\n[Layer 7: Tools]\n");
        prompt.append(context.getOrDefault("toolsDescription", "You have access to file operations, code search, and command execution.\n"));

        // Layer 8: Canvas
        prompt.append("\n[Layer 8: Canvas]\n");
        String canvasContext = (String) context.get("canvasContext");
        if (canvasContext != null && !canvasContext.isBlank()) {
            prompt.append("Canvas context:\n").append(canvasContext).append("\n");
        }

        // Layer 9: Skills
        prompt.append("\n[Layer 9: Skills]\n");
        @SuppressWarnings("unchecked")
        List<String> activeSkills = (List<String>) context.getOrDefault("activeSkills", List.of());
        if (!activeSkills.isEmpty()) {
            for (String skillId : activeSkills) {
                String skillContent = readSkillContent(skillId);
                if (skillContent != null) {
                    prompt.append("\n--- Skill: ").append(skillId).append(" ---\n");
                    prompt.append(skillContent);
                }
            }
        }

        // Layer 10: Knowledge
        prompt.append("\n[Layer 10: Knowledge]\n");
        @SuppressWarnings("unchecked")
        List<String> activeKnowledge = (List<String>) context.getOrDefault("activeKnowledge", List.of());
        if (!activeKnowledge.isEmpty()) {
            prompt.append("Active knowledge bases: ").append(String.join(", ", activeKnowledge)).append("\n");
        }

        // Layer 11: Experience
        prompt.append("\n[Layer 11: Experience]\n");
        String experience = (String) context.getOrDefault("experience", "");
        if (!experience.isBlank()) {
            prompt.append(experience).append("\n");
        }

        // Layer 12: Behavior rules
        prompt.append("\n[Layer 12: Behavior Rules]\n");
        String permissionMode = (String) context.getOrDefault("permissionMode", "normal");
        String rules = readRules(permissionMode);
        prompt.append(rules);

        log.info("System prompt assembled: {} layers, {} chars", 12, prompt.length());
        return prompt.toString();
    }

    private String readSkillContent(String skillId) {
        try {
            String path = "skills/" + skillId + "/SKILL.md";
            Resource resource = new ClassPathResource(path);
            if (!resource.exists()) {
                log.warn("Skill not found: {}", path);
                return null;
            }
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(resource.getInputStream(), StandardCharsets.UTF_8))) {
                return reader.lines().collect(Collectors.joining("\n"));
            }
        } catch (IOException e) {
            log.warn("Failed to read skill: {}", skillId, e);
            return null;
        }
    }

    private String readRules(String permissionMode) {
        try {
            String path = RULES_DIR + permissionMode + ".md";
            Resource resource = new ClassPathResource(path);
            if (!resource.exists()) {
                log.warn("Rules file not found: {}, falling back to normal.md", path);
                path = RULES_DIR + "normal.md";
                resource = new ClassPathResource(path);
            }
            if (!resource.exists()) {
                return "Default behavior rules apply.";
            }
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(resource.getInputStream(), StandardCharsets.UTF_8))) {
                return reader.lines().collect(Collectors.joining("\n"));
            }
        } catch (IOException e) {
            log.error("Failed to read rules for mode: {}", permissionMode, e);
            return "Default behavior rules apply.";
        }
    }
}
