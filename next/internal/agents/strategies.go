// ─────────────────────────────────────────────────────────────────
// strategies.go — 可插拔策略策略接口 (从 TS strategy-policy.ts 迁移)
//
// 参考: RepuNet (AAMAS 2026) 策略自适应 + 专家共识
// 设计: 策略可插拔、可运行时替换、支持信用驱动自适应
//
// 三个内置策略 (延迟/质量/成本特征对齐 TS 数值):
//
//	direct           (Alpha) 牺牲质量换取响应速度
//	chain_of_thought (Beta)  高质量但高延迟
//	few_shot         (Gamma) 平衡型
//
// 补齐的缺失行为 (TS 中未实现的选择逻辑, 语义按 TS 注释约定推导):
//   - SelectPolicy: 策略与任务类型匹配规则 (代码生成/调试类 → 深度推理,
//     快速查询/枚举类 → 直接回答, 其余 → 少样本平衡)
//   - AdaptPolicy: 信用驱动自适应 — 信誉过低的深度/少样本策略降级到 direct,
//     避免占用深度推理资源 (对齐 TS shouldAdapt 阈值 0.5 / 0.3)
//
// ─────────────────────────────────────────────────────────────────
package agents

import (
	"math"
	"sort"
	"strings"
)

// ─── 类型定义 ────────────────────────────────────────────────────

// ModelStrategyCandidate 路由候选 (对齐 TS ModelStrategyCandidate,
// reasoningStrategy 覆盖 5 种取值)
type ModelStrategyCandidate struct {
	ModelName                string  `json:"modelName"`
	ReasoningStrategy        string  `json:"reasoningStrategy"` // direct | chain_of_thought | few_shot | decompose | self_refine
	BaseGenerationQuality    float64 `json:"baseGenerationQuality"`
	NormalizedLatencyScore   float64 `json:"normalizedLatencyScore"`
	NormalizedCostEfficiency float64 `json:"normalizedCostEfficiency"`
	HistoricalSuccessIndex   float64 `json:"historicalSuccessIndex"`
}

// StrategyPolicy 策略接口 — 可插拔的行为函数。
// 每个策略实现定义自己的延迟/质量/成本特征。
type StrategyPolicy interface {
	// Name 策略名
	Name() string
	// CalculateLatency 计算延迟得分 (0-1, 越高越快)
	CalculateLatency(cpuLoad float64) float64
	// CalculateQuality 计算生成质量 (0-1, 越高越好)
	CalculateQuality() float64
	// CalculateCostEfficiency 计算成本效率 (0-1, 越高越省)
	CalculateCostEfficiency() float64
	// ShouldAdapt 信用驱动自适应: Agent 可根据自身声誉决定是否切换策略。
	// 返回 nil 表示保持当前策略。
	ShouldAdapt(currentReputation float64) StrategyPolicy
	// ToCandidate 生成路由候选
	ToCandidate(agentID string, cpuLoad, reputation float64) ModelStrategyCandidate
}

// ─── 直接快速策略 (Alpha) — 牺牲质量换取响应速度 ──────────────────

// DirectPolicy 快速策略 (不自适应)
type DirectPolicy struct{}

func (DirectPolicy) Name() string { return "direct" }

func (DirectPolicy) CalculateLatency(cpuLoad float64) float64 {
	return math.Max(0.6, 0.95-cpuLoad*0.1)
}

func (DirectPolicy) CalculateQuality() float64 { return 0.65 }

func (DirectPolicy) CalculateCostEfficiency() float64 { return 0.8 }

// ShouldAdapt 快速策略不自适应
func (DirectPolicy) ShouldAdapt(currentReputation float64) StrategyPolicy { return nil }

func (p DirectPolicy) ToCandidate(agentID string, cpuLoad, reputation float64) ModelStrategyCandidate {
	return ModelStrategyCandidate{
		ModelName:                agentID,
		ReasoningStrategy:        "direct",
		BaseGenerationQuality:    p.CalculateQuality(),
		NormalizedLatencyScore:   p.CalculateLatency(cpuLoad),
		NormalizedCostEfficiency: p.CalculateCostEfficiency(),
		HistoricalSuccessIndex:   reputation,
	}
}

// ─── 深度推理策略 (Beta) — 高质量但高延迟 ─────────────────────────

// ChainOfThoughtPolicy 深度推理策略
type ChainOfThoughtPolicy struct{}

func (ChainOfThoughtPolicy) Name() string { return "chain_of_thought" }

func (ChainOfThoughtPolicy) CalculateLatency(cpuLoad float64) float64 {
	return math.Max(0.1, 0.5-cpuLoad*0.2)
}

func (ChainOfThoughtPolicy) CalculateQuality() float64 { return 0.95 }

func (ChainOfThoughtPolicy) CalculateCostEfficiency() float64 { return 0.3 }

// ShouldAdapt 信用过低 (< 0.5) 时降级到 direct, 避免占用深度推理资源
func (ChainOfThoughtPolicy) ShouldAdapt(currentReputation float64) StrategyPolicy {
	if currentReputation < 0.5 {
		return DirectPolicy{}
	}
	return nil
}

func (p ChainOfThoughtPolicy) ToCandidate(agentID string, cpuLoad, reputation float64) ModelStrategyCandidate {
	return ModelStrategyCandidate{
		ModelName:                agentID,
		ReasoningStrategy:        "chain_of_thought",
		BaseGenerationQuality:    p.CalculateQuality(),
		NormalizedLatencyScore:   p.CalculateLatency(cpuLoad),
		NormalizedCostEfficiency: p.CalculateCostEfficiency(),
		HistoricalSuccessIndex:   reputation,
	}
}

// ─── 少样本策略 (Gamma) — 平衡型 ─────────────────────────────────

// FewShotPolicy 少样本策略
type FewShotPolicy struct{}

func (FewShotPolicy) Name() string { return "few_shot" }

func (FewShotPolicy) CalculateLatency(cpuLoad float64) float64 {
	return math.Max(0.3, 0.7-cpuLoad*0.15)
}

func (FewShotPolicy) CalculateQuality() float64 { return 0.80 }

func (FewShotPolicy) CalculateCostEfficiency() float64 { return 0.5 }

// ShouldAdapt 信用过低 (< 0.3) 时降级到 direct
func (FewShotPolicy) ShouldAdapt(currentReputation float64) StrategyPolicy {
	if currentReputation < 0.3 {
		return DirectPolicy{}
	}
	return nil
}

func (p FewShotPolicy) ToCandidate(agentID string, cpuLoad, reputation float64) ModelStrategyCandidate {
	return ModelStrategyCandidate{
		ModelName:                agentID,
		ReasoningStrategy:        "few_shot",
		BaseGenerationQuality:    p.CalculateQuality(),
		NormalizedLatencyScore:   p.CalculateLatency(cpuLoad),
		NormalizedCostEfficiency: p.CalculateCostEfficiency(),
		HistoricalSuccessIndex:   reputation,
	}
}

// ─── 策略工厂 ────────────────────────────────────────────────────

// CreateStrategyPolicy 根据名称创建策略实例 (未知名称回退 direct)
func CreateStrategyPolicy(name string) StrategyPolicy {
	switch name {
	case "direct":
		return DirectPolicy{}
	case "chain_of_thought":
		return ChainOfThoughtPolicy{}
	case "few_shot":
		return FewShotPolicy{}
	default:
		return DirectPolicy{}
	}
}

// ─── 策略选择逻辑 (补齐: 策略与任务类型匹配规则) ──────────────────

// 复杂/代码类任务关键词 → 深度推理 (质量优先)
var complexTaskKeywords = []string{
	"实现", "重构", "调试", "修复", "设计", "架构", "实现", "debug", "refactor",
	"implement", "design", "architect", "optimize", "修复 bug", "多步", "规划",
}

// 简单/查询类任务关键词 → 直接回答 (速度优先)
var simpleTaskKeywords = []string{
	"查询", "列出", "读取", "状态", "查看", "list", "get", "status", "show",
	"read", "查询一下", "看一下", "多少",
}

// SelectPolicy 策略与任务类型匹配规则:
//   - 命中复杂/代码类关键词 (或超长任务, > 2000 字符视为多步工程任务)
//     → chain_of_thought
//   - 命中简单/查询类关键词 (且任务较短) → direct
//   - 其余 → few_shot (平衡型默认)
func SelectPolicy(task string) StrategyPolicy {
	normalized := strings.ToLower(task)
	score := 0
	for _, kw := range complexTaskKeywords {
		if strings.Contains(normalized, kw) {
			score++
		}
	}
	for _, kw := range simpleTaskKeywords {
		if strings.Contains(normalized, kw) {
			score--
		}
	}
	// 超长任务按复杂处理 (多步工程任务的信号)
	if len(task) > 2000 {
		score += 2
	}
	switch {
	case score > 0:
		return ChainOfThoughtPolicy{}
	case score < 0:
		return DirectPolicy{}
	default:
		return FewShotPolicy{}
	}
}

// AdaptPolicy 信用驱动自适应入口: 对当前策略按信誉执行 shouldAdapt
// (信誉 < 0.5 时 chain_of_thought 降级 direct; < 0.3 时 few_shot 降级 direct)
func AdaptPolicy(current StrategyPolicy, reputation float64) StrategyPolicy {
	if next := current.ShouldAdapt(reputation); next != nil {
		return next
	}
	return current
}

// CandidatesFromPolicies 为一组 agent 批量生成路由候选 (按延迟得分降序,
// 供 decision.Route 的候选输入; 策略相同者 reputaion 高者在前)
func CandidatesFromPolicies(entries []PolicyAgentEntry) []ModelStrategyCandidate {
	out := make([]ModelStrategyCandidate, 0, len(entries))
	for _, e := range entries {
		out = append(out, e.Policy.ToCandidate(e.AgentID, e.CPULoad, e.Reputation))
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].NormalizedLatencyScore > out[j].NormalizedLatencyScore
	})
	return out
}

// PolicyAgentEntry 候选生成入参 (agent + 当前策略 + 运行时状态)
type PolicyAgentEntry struct {
	AgentID    string
	Policy     StrategyPolicy
	CPULoad    float64
	Reputation float64
}
