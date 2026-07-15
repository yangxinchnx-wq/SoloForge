package com.soloforge.agent.orchestrator;

import com.soloforge.agent.dto.ChatRequest;
import com.soloforge.agent.dto.ChatSettings;
import com.soloforge.agent.executor.AgentExecutor; // @Deprecated - retained for fallback
import com.soloforge.agent.executor.SpringAiAgentExecutor; // Path C: new executor
import com.soloforge.agent.persistence.AgentIdentityEntity;
import com.soloforge.agent.persistence.AgentIdentityRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Multi-Agent Coordinator (3 patterns)
 *
 * A. ParallelVoter  - Parallel voting (multiple Agents solve independently, select best)
 * B. RoleDispatcher - Role division (Planner -> Executor -> Reviewer)
 * C. DebateLoop     - Debate loop (multiple rounds of debate to reach consensus)
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class MultiAgentCoordinator {

    private final AgentExecutor agentExecutor; // @Deprecated - retained for fallback
    private final SpringAiAgentExecutor springAiAgentExecutor; // Path C: new executor
    private final AgentIdentityRepository agentRepo;

    private final ExecutorService parallelExecutor = Executors.newFixedThreadPool(2);

    /**
     * A. Parallel voting
     *
     * Multiple Agents independently process the same task, select best result.
     * Suitable for: code generation, design proposals, etc.
     */
    public String parallelVote(String task, List<String> agentIds,
                               ChatSettings settings, ChatRequest.LlmProvider provider) {
        log.info("ParallelVoter: agents={} task='{}'", agentIds,
            task.length() > 60 ? task.substring(0, 60) + "..." : task);

        // Parallel execution
        List<CompletableFuture<String>> futures = agentIds.stream()
            .map(agentId -> CompletableFuture.supplyAsync(() -> {
                ChatSettings agentSettings = copySettings(settings, agentId);
                return springAiAgentExecutor.execute(task,
                        ChatRequest.builder().settings(agentSettings).provider(provider).build());
            }, parallelExecutor))
            .toList();

        // Collect results
        List<String> results = futures.stream()
            .map(CompletableFuture::join)
            .toList();

        // Select best (simplified: select longest, actual should let LLM evaluate)
        String best = selectBestResult(results);
        log.info("ParallelVoter completed: {} agents, best result {} chars",
            results.size(), best.length());
        return best;
    }

    /**
     * B. Role division
     *
     * Planner breaks down -> Executor executes -> Reviewer reviews
     * Suitable for: complex tasks, scenarios requiring quality assurance
     */
    public String roleDispatch(String task, ChatSettings settings, ChatRequest.LlmProvider provider) {
        log.info("RoleDispatcher: task='{}'",
            task.length() > 60 ? task.substring(0, 60) + "..." : task);

        // 1. Planner breaks down
        ChatSettings plannerSettings = copySettings(settings, "plan_agent");
        String plan = springAiAgentExecutor.execute(
            "Please break down the following task and give clear steps:\n" + task,
            ChatRequest.builder().settings(plannerSettings).provider(provider).build());
        log.info("Planner output: {} chars", plan.length());

        // 2. Executor executes
        ChatSettings executorSettings = copySettings(settings, "code_agent");
        String execution = springAiAgentExecutor.execute(
            "Execute the task according to the following plan:\n" + plan + "\n\nOriginal task: " + task,
            ChatRequest.builder().settings(executorSettings).provider(provider).build());
        log.info("Executor output: {} chars", execution.length());

        // 3. Reviewer reviews
        ChatSettings reviewerSettings = copySettings(settings, "debug_agent");
        String review = springAiAgentExecutor.execute(
            "Review the following execution result and point out issues:\n\nPlan:\n" + plan + "\n\nExecution result:\n" + execution,
            ChatRequest.builder().settings(reviewerSettings).provider(provider).build());
        log.info("Reviewer output: {} chars", review.length());

        // 4. If review finds issues, re-execute (simplified: directly return combined result)
        if (review.contains("issue") || review.contains("error") || review.contains("problem")) {
            ChatSettings reexecSettings = copySettings(settings, "code_agent");
            String reexec = springAiAgentExecutor.execute(
                "Fix based on review feedback:\n\nExecution result:\n" + execution + "\n\nReview feedback:\n" + review,
                ChatRequest.builder().settings(reexecSettings).provider(provider).build());
            return "## Plan\n" + plan + "\n\n## Execution (fixed)\n" + reexec + "\n\n## Review\n" + review;
        }

        return "## Plan\n" + plan + "\n\n## Execution\n" + execution + "\n\n## Review\n" + review;
    }

    /**
     * C. Debate loop
     *
     * Multiple Agents debate over multiple rounds, ultimately reaching consensus.
     * Suitable for: technology selection, proposal review, etc.
     */
    public String debate(String task, List<String> agentIds, int maxRounds,
                         ChatSettings settings, ChatRequest.LlmProvider provider) {
        log.info("DebateLoop: agents={} rounds={} task='{}'", agentIds, maxRounds,
            task.length() > 60 ? task.substring(0, 60) + "..." : task);

        List<String> positions = new ArrayList<>();

        for (int round = 0; round < maxRounds; round++) {
            log.info("Debate round {}", round + 1);
            for (String agentId : agentIds) {
                ChatSettings agentSettings = copySettings(settings, agentId);
                String prompt = round == 0
                    ? task
                    : "Task: " + task + "\n\nOther Agents' viewpoints:\n" + String.join("\n---\n", positions)
                        + "\n\nPlease give your viewpoint, you may agree or disagree with other Agents.";
                String position = springAiAgentExecutor.execute(prompt,
                        ChatRequest.builder().settings(agentSettings).provider(provider).build());
                positions.add("[" + agentId + "] " + position);
            }

            // Check consensus (simplified: if last 2 viewpoints both contain "agree", consider consensus reached)
            if (round >= 1 && checkConsensus(positions)) {
                log.info("Consensus reached at round {}", round + 1);
                break;
            }
        }

        // Arbitration (select last viewpoint as final answer)
        String verdict = positions.get(positions.size() - 1);
        log.info("Debate completed: {} positions, verdict {} chars", positions.size(), verdict.length());
        return "## Debate Process\n" + String.join("\n\n", positions) + "\n\n## Final Conclusion\n" + verdict;
    }

    private boolean checkConsensus(List<String> positions) {
        // Simplified: if recent 2 viewpoints both contain "agree", consider consensus reached
        if (positions.size() < 2) return false;
        String last = positions.get(positions.size() - 1).toLowerCase();
        String prev = positions.get(positions.size() - 2).toLowerCase();
        return (last.contains("agree") || last.contains("consensus"))
            && (prev.contains("agree") || prev.contains("consensus"));
    }

    private String selectBestResult(List<String> results) {
        // Simplified: select longest (actual should let LLM evaluate)
        return results.stream()
            .max((a, b) -> Integer.compare(a.length(), b.length()))
            .orElse("(no result)");
    }

    private ChatSettings copySettings(ChatSettings original, String agentId) {
        return ChatSettings.builder()
            .personality(original.getPersonality())
            .tone(original.getTone())
            .emojiMode(original.getEmojiMode())
            .emojiEnabled(original.getEmojiEnabled())
            .emojiType(original.getEmojiType())
            .enabledSkills(original.getEnabledSkills())
            .enabledTools(original.getEnabledTools())
            .enabledKnowledge(original.getEnabledKnowledge())
            .agentId(agentId)
            .workspaceFolder(original.getWorkspaceFolder())
            .canvasId(original.getCanvasId())
            .chatSessionId(original.getChatSessionId())
            .requesterChatSessionId(original.getRequesterChatSessionId())
            .extraContext(original.getExtraContext())
            .build();
    }
}
