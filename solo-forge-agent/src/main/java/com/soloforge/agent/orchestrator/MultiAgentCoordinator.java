package com.soloforge.agent.orchestrator;

import com.soloforge.agent.dto.ChatRequest;
import com.soloforge.agent.dto.ChatSettings;
import com.soloforge.agent.executor.AgentExecutor; // @Deprecated 鈥?淇濈暀 fallback
import com.soloforge.agent.executor.SpringAiAgentExecutor; // 鈽?Path C: 鏂版墽琛屽櫒
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
 * 澶?Agent 鍗忎綔缂栨帓鍣?(3 绉嶅舰鎬?
 *
 * A. ParallelVoter  鈥?骞惰鎶曠エ (澶?Agent 鐙珛姹傝В, 閫夋渶浣?
 * B. RoleDispatcher 鈥?瑙掕壊鍒嗗伐 (Planner鈫扙xecutor鈫扲eviewer)
 * C. DebateLoop     鈥?瀵硅瘽杈╄ (澶氳疆杈╄鍚庤揪鎴愬叡璇?
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class MultiAgentCoordinator {

    private final AgentExecutor agentExecutor; // @Deprecated 鈥?淇濈暀鐢ㄤ簬 fallback
    private final SpringAiAgentExecutor springAiAgentExecutor; // 鈽?Path C: 鏂版墽琛屽櫒
    private final AgentIdentityRepository agentRepo;

    private final ExecutorService parallelExecutor = Executors.newFixedThreadPool(2);

    /**
     * A. 骞惰鎶曠エ
     *
     * 澶氫釜 Agent 鐙珛澶勭悊鍚屼竴浠诲姟,閫夋渶浼樼粨鏋溿€?     * 閫傜敤浜? 浠ｇ爜鐢熸垚銆佹柟妗堣璁＄瓑"澶氳В"闂
     */
    public String parallelVote(String task, List<String> agentIds,
                               ChatSettings settings, ChatRequest.LlmProvider provider) {
        log.info("ParallelVoter: agents={} task='{}'", agentIds,
            task.length() > 60 ? task.substring(0, 60) + "..." : task);

        // 骞惰鎵ц
        List<CompletableFuture<String>> futures = agentIds.stream()
            .map(agentId -> CompletableFuture.supplyAsync(() -> {
                ChatSettings agentSettings = copySettings(settings, agentId);
                return springAiAgentExecutor.execute(task,
                        ChatRequest.builder().settings(agentSettings).provider(provider).build());
            }, parallelExecutor))
            .toList();

        // 鏀堕泦缁撴灉
        List<String> results = futures.stream()
            .map(CompletableFuture::join)
            .toList();

        // 閫夋渶浼?(绠€鍖栫増: 閫夋渶闀跨殑,瀹為檯搴旇 LLM 璇勫垽)
        String best = selectBestResult(results);
        log.info("ParallelVoter completed: {} agents, best result {} chars",
            results.size(), best.length());
        return best;
    }

    /**
     * B. 瑙掕壊鍒嗗伐
     *
     * Planner 鎷嗚В 鈫?Executor 鎵ц 鈫?Reviewer 瀹℃煡
     * 閫傜敤浜? 澶嶆潅浠诲姟銆侀渶瑕佽川閲忎繚璇佺殑鍦烘櫙
     */
    public String roleDispatch(String task, ChatSettings settings, ChatRequest.LlmProvider provider) {
        log.info("RoleDispatcher: task='{}'",
            task.length() > 60 ? task.substring(0, 60) + "..." : task);

        // 1. Planner 鎷嗚В
        ChatSettings plannerSettings = copySettings(settings, "plan_agent");
        String plan = springAiAgentExecutor.execute(
            "璇锋媶瑙ｄ互涓嬩换鍔?缁欏嚭鏄庣‘鐨勬楠?\n" + task,
            ChatRequest.builder().settings(plannerSettings).provider(provider).build());
        log.info("Planner output: {} chars", plan.length());

        // 2. Executor 鎵ц
        ChatSettings executorSettings = copySettings(settings, "code_agent");
        String execution = springAiAgentExecutor.execute(
            "鎸夌収浠ヤ笅璁″垝鎵ц浠诲姟:\n" + plan + "\n\n鍘熷浠诲姟: " + task,
            ChatRequest.builder().settings(executorSettings).provider(provider).build());
        log.info("Executor output: {} chars", execution.length());

        // 3. Reviewer 瀹℃煡
        ChatSettings reviewerSettings = copySettings(settings, "debug_agent");
        String review = springAiAgentExecutor.execute(
            "瀹℃煡浠ヤ笅鎵ц缁撴灉,鎸囧嚭闂:\n\n璁″垝:\n" + plan + "\n\n鎵ц缁撴灉:\n" + execution,
            ChatRequest.builder().settings(reviewerSettings).provider(provider).build());
        log.info("Reviewer output: {} chars", review.length());

        // 4. 濡傛灉瀹℃煡鍙戠幇闂,閲嶆柊鎵ц (绠€鍖栫増: 鐩存帴杩斿洖缁煎悎缁撴灉)
        if (review.contains("闂") || review.contains("閿欒")) {
            ChatSettings reexecSettings = copySettings(settings, "code_agent");
            String reexec = springAiAgentExecutor.execute(
                "鏍规嵁瀹℃煡鎰忚淇:\n\n鎵ц缁撴灉:\n" + execution + "\n\n瀹℃煡鎰忚:\n" + review,
                ChatRequest.builder().settings(reexecSettings).provider(provider).build());
            return "## 璁″垝\n" + plan + "\n\n## 鎵ц(淇鍚?\n" + reexec + "\n\n## 瀹℃煡\n" + review;
        }

        return "## 璁″垝\n" + plan + "\n\n## 鎵ц\n" + execution + "\n\n## 瀹℃煡\n" + review;
    }

    /**
     * C. 瀵硅瘽杈╄
     *
     * 澶氫釜 Agent 澶氳疆杈╄,鏈€缁堣揪鎴愬叡璇嗐€?     * 閫傜敤浜? 鎶€鏈€夊瀷銆佹柟妗堣瘎瀹＄瓑"澶氳鐐?闂
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
                    : "浠诲姟: " + task + "\n\n鍏朵粬 Agent 鐨勮鐐?\n" + String.join("\n---\n", positions)
                        + "\n\n璇风粰鍑轰綘鐨勮鐐?鍙互璧炲悓鎴栧弽椹冲叾浠?Agent銆?;
                String position = springAiAgentExecutor.execute(prompt,
                        ChatRequest.builder().settings(agentSettings).provider(provider).build());
                positions.add("[" + agentId + "] " + position);
            }

            // 妫€鏌ュ叡璇?(绠€鍖栫増: 绗?2 杞悗濡傛灉瑙傜偣瓒嬪悓鍒欑粨鏉?
            if (round >= 1 && checkConsensus(positions)) {
                log.info("Consensus reached at round {}", round + 1);
                break;
            }
        }

        // 浠茶 (閫夋渶鍚庝竴涓鐐逛綔涓烘渶缁堢瓟妗?
        String verdict = positions.get(positions.size() - 1);
        log.info("Debate completed: {} positions, verdict {} chars", positions.size(), verdict.length());
        return "## 杈╄杩囩▼\n" + String.join("\n\n", positions) + "\n\n## 鏈€缁堢粨璁篭n" + verdict;
    }

    private boolean checkConsensus(List<String> positions) {
        // 绠€鍖栫増: 濡傛灉鏈€杩?2 涓鐐归兘鍖呭惈"鍚屾剰"鎴?璧炲悓",璁や负杈炬垚鍏辫瘑
        if (positions.size() < 2) return false;
        String last = positions.get(positions.size() - 1).toLowerCase();
        String prev = positions.get(positions.size() - 2).toLowerCase();
        return (last.contains("鍚屾剰") || last.contains("璧炲悓"))
            && (prev.contains("鍚屾剰") || prev.contains("璧炲悓"));
    }

    private String selectBestResult(List<String> results) {
        // 绠€鍖栫増: 閫夋渶闀跨殑 (瀹為檯搴旇 LLM 璇勫垽)
        return results.stream()
            .max((a, b) -> Integer.compare(a.length(), b.length()))
            .orElse("(鏃犵粨鏋?");
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
