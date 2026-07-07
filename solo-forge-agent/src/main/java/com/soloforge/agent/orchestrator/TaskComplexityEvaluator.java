package com.soloforge.agent.orchestrator;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 任务复杂度评估器
 *
 * 评估维度:
 *   1. 消息长度 (>500 字符 = 复杂)
 *   2. 关键词匹配 (重构/架构/设计/排查 = 复杂)
 *   3. 多步骤指示 (包含"然后"/"接着"/"第一步" = 复杂)
 *   4. 跨文件指示 (包含"多个文件"/"整个模块" = 复杂)
 *
 * 阈值 0.5: 简单/复杂各占一半
 */
@Slf4j
@Component
public class TaskComplexityEvaluator {

    private static final List<String> COMPLEX_KEYWORDS = List.of(
        "重构", "架构", "设计", "排查", "分析", "优化", "迁移",
        "refactor", "architecture", "design", "debug", "optimize"
    );

    private static final List<String> MULTI_STEP_KEYWORDS = List.of(
        "然后", "接着", "第一步", "第二步", "首先", "最后",
        "step 1", "step 2", "first", "then", "finally"
    );

    private static final List<String> CROSS_FILE_KEYWORDS = List.of(
        "多个文件", "整个模块", "全部", "批量", "所有",
        "multiple files", "entire module", "all files"
    );

    /**
     * 评估任务复杂度
     *
     * @return complexity 0.0-1.0, reasons 评估原因
     */
    public EvaluationResult evaluate(String message) {
        List<String> reasons = new ArrayList<>();
        double score = 0.0;

        // 1. 消息长度
        if (message.length() > 500) {
            score += 0.25;
            reasons.add("消息较长 (" + message.length() + " 字符)");
        } else if (message.length() > 200) {
            score += 0.1;
        }

        // 2. 关键词匹配
        int complexKwCount = 0;
        for (String kw : COMPLEX_KEYWORDS) {
            if (message.toLowerCase().contains(kw.toLowerCase())) {
                complexKwCount++;
            }
        }
        if (complexKwCount > 0) {
            score += Math.min(0.3, complexKwCount * 0.15);
            reasons.add("包含复杂关键词 (" + complexKwCount + " 个)");
        }

        // 3. 多步骤指示
        int multiStepCount = 0;
        for (String kw : MULTI_STEP_KEYWORDS) {
            if (message.toLowerCase().contains(kw.toLowerCase())) multiStepCount++;
        }
        if (multiStepCount > 0) {
            score += Math.min(0.25, multiStepCount * 0.1);
            reasons.add("多步骤任务 (" + multiStepCount + " 个指示)");
        }

        // 4. 跨文件指示
        int crossFileCount = 0;
        for (String kw : CROSS_FILE_KEYWORDS) {
            if (message.toLowerCase().contains(kw.toLowerCase())) crossFileCount++;
        }
        if (crossFileCount > 0) {
            score += Math.min(0.2, crossFileCount * 0.1);
            reasons.add("跨文件任务 (" + crossFileCount + " 个指示)");
        }

        score = Math.min(1.0, score);
        boolean isComplex = score >= 0.5;

        log.info("Task complexity: {} (isComplex={}, reasons={})",
            String.format("%.2f", score), isComplex, reasons);

        return new EvaluationResult(score, isComplex, reasons);
    }

    public record EvaluationResult(double complexity, boolean isComplex, List<String> reasons) {}
}
