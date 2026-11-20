// ─────────────────────────────────────────────────────────────────
// strategies_test.go — 策略引擎自测
//
// 覆盖: 三策略特征数值 (对齐 TS)、信用驱动自适应阈值、
// 策略工厂回退、任务类型匹配规则、候选生成排序。
// ─────────────────────────────────────────────────────────────────
package agents

import (
	"math"
	"testing"
)

func TestPolicyScores(t *testing.T) {
	direct := DirectPolicy{}
	cot := ChainOfThoughtPolicy{}
	few := FewShotPolicy{}

	// Alpha: max(0.6, 0.95 - cpu*0.1)
	if got := direct.CalculateLatency(0); got != 0.95 {
		t.Fatalf("direct latency(0) = %v, 期望 0.95", got)
	}
	if got := direct.CalculateLatency(5); got != 0.6 {
		t.Fatalf("direct latency(5) 应触底 0.6, 实际 %v", got)
	}
	// Beta: max(0.1, 0.5 - cpu*0.2)
	if got := cot.CalculateLatency(0); got != 0.5 {
		t.Fatalf("cot latency(0) = %v, 期望 0.5", got)
	}
	if got := cot.CalculateLatency(5); got != 0.1 {
		t.Fatalf("cot latency(5) 应触底 0.1, 实际 %v", got)
	}
	// Gamma: max(0.3, 0.7 - cpu*0.15)
	if got := few.CalculateLatency(2); math.Abs(got-0.4) > 1e-9 {
		t.Fatalf("few latency(2) = %v, 期望 0.4", got)
	}

	// 质量/成本
	if direct.CalculateQuality() != 0.65 || cot.CalculateQuality() != 0.95 || few.CalculateQuality() != 0.80 {
		t.Fatalf("质量数值与 TS 不对齐")
	}
	if direct.CalculateCostEfficiency() != 0.8 || cot.CalculateCostEfficiency() != 0.3 || few.CalculateCostEfficiency() != 0.5 {
		t.Fatalf("成本数值与 TS 不对齐")
	}
}

func TestShouldAdaptThresholds(t *testing.T) {
	cot := ChainOfThoughtPolicy{}
	few := FewShotPolicy{}
	direct := DirectPolicy{}

	// 信誉 >= 0.5: cot 保持
	if cot.ShouldAdapt(0.5) != nil {
		t.Fatalf("信誉 0.5 时 cot 不应降级")
	}
	// 信誉 < 0.5: cot → direct
	if next := cot.ShouldAdapt(0.49); next == nil || next.Name() != "direct" {
		t.Fatalf("信誉 0.49 时 cot 应降级 direct, 实际 %v", next)
	}
	// 信誉 >= 0.3: few_shot 保持; < 0.3 降级
	if few.ShouldAdapt(0.3) != nil {
		t.Fatalf("信誉 0.3 时 few_shot 不应降级")
	}
	if next := few.ShouldAdapt(0.29); next == nil || next.Name() != "direct" {
		t.Fatalf("信誉 0.29 时 few_shot 应降级 direct")
	}
	// direct 永不自适应
	if direct.ShouldAdapt(0) != nil {
		t.Fatalf("direct 不应自适应")
	}
}

func TestCreateStrategyPolicy(t *testing.T) {
	if CreateStrategyPolicy("chain_of_thought").Name() != "chain_of_thought" {
		t.Fatalf("工厂创建失败")
	}
	if CreateStrategyPolicy("unknown-xyz").Name() != "direct" {
		t.Fatalf("未知名称应回退 direct")
	}
}

func TestSelectPolicyTaskMatching(t *testing.T) {
	if got := SelectPolicy("请帮我重构这个模块并修复其中的 bug"); got.Name() != "chain_of_thought" {
		t.Fatalf("复杂任务应选深度推理, 实际 %s", got.Name())
	}
	if got := SelectPolicy("列出目录下的文件"); got.Name() != "direct" {
		t.Fatalf("查询任务应选直接回答, 实际 %s", got.Name())
	}
	if got := SelectPolicy("总结一下今天的进展"); got.Name() != "few_shot" {
		t.Fatalf("中性任务应选少样本, 实际 %s", got.Name())
	}
	long := make([]byte, 2001)
	for i := range long {
		long[i] = 'a'
	}
	if got := SelectPolicy(string(long)); got.Name() != "chain_of_thought" {
		t.Fatalf("超长任务应按复杂处理, 实际 %s", got.Name())
	}
}

func TestAdaptPolicy(t *testing.T) {
	// 信誉 0.2: few_shot 应被适配为 direct
	got := AdaptPolicy(FewShotPolicy{}, 0.2)
	if got.Name() != "direct" {
		t.Fatalf("AdaptPolicy 应返回 direct, 实际 %s", got.Name())
	}
	// 信誉充足: 保持原策略
	if got := AdaptPolicy(FewShotPolicy{}, 0.9); got.Name() != "few_shot" {
		t.Fatalf("信誉充足应保持原策略, 实际 %s", got.Name())
	}
}

func TestCandidatesFromPolicies(t *testing.T) {
	cands := CandidatesFromPolicies([]PolicyAgentEntry{
		{AgentID: "slow-agent", Policy: ChainOfThoughtPolicy{}, CPULoad: 0.8, Reputation: 0.9},
		{AgentID: "fast-agent", Policy: DirectPolicy{}, CPULoad: 0.8, Reputation: 0.7},
	})
	if len(cands) != 2 {
		t.Fatalf("候选数错误: %d", len(cands))
	}
	// 延迟得分降序: direct (0.87) 在 cot (0.34) 之前
	if cands[0].ReasoningStrategy != "direct" {
		t.Fatalf("应按延迟得分降序: %+v", cands)
	}
	if cands[0].HistoricalSuccessIndex != 0.7 || cands[0].BaseGenerationQuality != 0.65 {
		t.Fatalf("候选字段错误: %+v", cands[0])
	}
}
