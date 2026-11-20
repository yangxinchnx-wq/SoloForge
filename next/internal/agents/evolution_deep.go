// ─────────────────────────────────────────────────────────────────
// evolution_deep.go — 进化/训练深度行为补齐 (批次 3)
//
// 对齐待办清单标注的四个缺口:
//  1. 经验评估打分细则    → ScoreExperience (0..1 综合分)
//  2. 技能晋升/降级条件   → 技能层级 (候选/已验证/核心) + RecordUsage
//     内联晋升降级 (见 evolution.go) + SweepStale 衰减
//  3. 经验回放的采样策略  → ExperienceCache.SampleReplay (优先级回放 + ε 探索)
//  4. 30 天旧经验衰减     → ExperienceCache.CleanupExpired (对齐 TS load
//     的 ageDays > 30 丢弃规则, Go 无 JSONL 落盘
//     故改为周期清扫, 由 EvolutionPipeline.janitor 驱动)
//
// 说明: TS 中"自动衰减"仅在 skill-library.ts 头部声明、未实现; 本文件的
// 衰减/晋升/降级数值为按 TS 既有滑动窗口语义推导的补齐规则, 非逐行移植。
// ─────────────────────────────────────────────────────────────────
package agents

import (
	"math/rand"
	"sort"
	"time"
)

// ─── 技能层级与晋升/降/失效阈值 ──────────────────────────────────

// 技能层级 (TS 未实现, 补齐; 数值语义: 越高越被信任)
const (
	skillTierCandidate = 0 // 候选: 提炼自少量成功轨迹
	skillTierValidated = 1 // 已验证: 复用中持续成功
	skillTierCore      = 2 // 核心: 高频高成功率, 派发时优先注入
)

// 晋升/降级/失效阈值 (推导规则, 与经验缓存 0.3 失效阈值同风格)
const (
	skillPromoteMinUsage           = 5    // 使用次数门槛
	skillPromoteMinRate            = 0.8  // 成功率门槛
	skillPromoteConfidenceStep     = 0.2  // 晋升置信度步长
	skillDemoteRate                = 0.4  // 低于此成功率降级
	skillDemoteConfidenceFactor    = 0.6  // 降级置信度衰减系数
	skillInvalidRate               = 0.2  // 低于此成功率失效移除
	skillStaleSweepConfidenceDecay = 0.95 // 陈旧衰减系数 (TS 头部声明的"自动衰减")
	skillStaleSweepMinConfidence   = 0.1  // 衰减后低于此值移除
	evolutionSkillStaleDays        = 7    // 陈旧判定天数
)

// TierName 技能层级名 (诊断输出用)
func TierName(tier int) string {
	switch tier {
	case skillTierValidated:
		return "validated"
	case skillTierCore:
		return "core"
	default:
		return "candidate"
	}
}

// SweepStale 陈旧技能衰减 (补齐 TS skill-library.ts 头部声明但未实现的
// "自动衰减"): 超过 staleDays 未被使用的技能置信度 ×0.95;
// 衰减后置信度 < 0.1 的技能移除。返回移除数量。
func (l *SkillLibrary) SweepStale(staleDays int) int {
	if staleDays <= 0 {
		staleDays = evolutionSkillStaleDays
	}
	cutoff := time.Now().UnixMilli() - int64(staleDays)*86400000
	removed := 0

	l.mu.Lock()
	defer l.mu.Unlock()
	for id, s := range l.skills {
		if s.LastUsedAt >= cutoff {
			continue
		}
		s.Confidence *= skillStaleSweepConfidenceDecay
		if s.Confidence < skillStaleSweepMinConfidence {
			delete(l.skills, id)
			removed++
			continue
		}
		l.skills[id] = s
	}
	return removed
}

// Promote 手动晋升技能 (治理/仲裁路径; 成功即返回 true)
func (l *SkillLibrary) Promote(skillID string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	s, ok := l.skills[skillID]
	if !ok || s.Tier >= skillTierCore {
		return false
	}
	s.Tier++
	s.Confidence = minFloat(1, s.Confidence+skillPromoteConfidenceStep)
	l.skills[skillID] = s
	return true
}

// Demote 手动降级技能 (治理/仲裁路径; 不存在的技能返回 false)
func (l *SkillLibrary) Demote(skillID string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	s, ok := l.skills[skillID]
	if !ok {
		return false
	}
	if s.Tier > skillTierCandidate {
		s.Tier--
		s.Confidence *= skillDemoteConfidenceFactor
	} else {
		s.Confidence *= skillDemoteConfidenceFactor
	}
	l.skills[skillID] = s
	return true
}

func minFloat(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}

// ─── 经验评估打分细则 ────────────────────────────────────────────

// 经验打分权重 (0..1 综合分; 用于回放采样优先级与统计排序)
const (
	expScoreWeightSuccess = 0.5   // 成功率 (滑动窗口)
	expScoreWeightTokens  = 0.2   // token 效率
	expScoreWeightReuse   = 0.2   // 复用热度
	expScoreWeightRecency = 0.1   // 新鲜度
	expTokenEffIdeal      = 1000  // token ≤1000 视为满分效率
	expTokenEffWorst      = 20000 // token ≥20000 视为 0 效率
	expReuseFullCount     = 10    // 复用 ≥10 次热度满分
	expRecencyFreshDays   = 7     // 7 天内新鲜度满分
	expRecencyMaxDays     = 30    // 30 天新鲜度衰减到 0
)

// ScoreExperience 经验评估打分细则 (0..1, 补齐):
//
//	score = 0.5 × successRate
//	      + 0.2 × tokenEfficiency   (tokenCost ≤1000 → 1.0, ≥20000 → 0, 线性)
//	      + 0.2 × reuseHeat         (reuseCount/10 封顶)
//	      + 0.1 × recency           (7 天内 = 1.0, 30 天线性衰减到 0)
//
// 经验路径复用决策 (Lookup 命中后的相似度阈值) 不受此分影响;
// 该分只用于回放采样优先级与经验列表排序。
func ScoreExperience(rec *ExperienceRecord, nowMs int64) float64 {
	if rec == nil {
		return 0
	}
	score := expScoreWeightSuccess * rec.SuccessRate

	// token 效率: 线性插值 [expTokenEffIdeal, expTokenEffWorst] → [1, 0]
	tok := float64(rec.TokenCost)
	tokEff := 1.0
	switch {
	case tok <= expTokenEffIdeal:
		tokEff = 1.0
	case tok >= expTokenEffWorst:
		tokEff = 0.0
	default:
		tokEff = 1 - (tok-expTokenEffIdeal)/(expTokenEffWorst-expTokenEffIdeal)
	}
	score += expScoreWeightTokens * tokEff

	// 复用热度
	heat := float64(rec.ReuseCount) / float64(expReuseFullCount)
	if heat > 1 {
		heat = 1
	}
	score += expScoreWeightReuse * heat

	// 新鲜度: 7 天内 1.0, [7,30] 天线性衰减到 0
	ageDays := float64(nowMs-rec.CreatedAt) / 86400000
	recency := 1.0
	switch {
	case ageDays <= expRecencyFreshDays:
		recency = 1.0
	case ageDays >= expRecencyMaxDays:
		recency = 0.0
	default:
		recency = 1 - (ageDays-expRecencyFreshDays)/(expRecencyMaxDays-expRecencyFreshDays)
	}
	score += expScoreWeightRecency * recency

	return score
}

// ─── 经验回放的采样策略 ──────────────────────────────────────────

// SampleReplay 经验回放采样 (补齐: RL prioritized replay 语义)。
//
// 策略: 按 ScoreExperience 优先级无放回采样;
// 每一步以 epsilon 概率均匀随机探索 (避免只回放高分经验导致过拟合),
// 否则取剩余经验中得分最高者。分数并列时按 LastUsedAt 新者优先。
// n ≤ 0 或池为空返回 nil。
func (c *ExperienceCache) SampleReplay(n int, epsilon float64) []ExperienceRecord {
	if n <= 0 {
		return nil
	}
	if epsilon < 0 {
		epsilon = 0
	}
	if epsilon > 1 {
		epsilon = 1
	}
	now := time.Now().UnixMilli()

	c.mu.RLock()
	pool := make([]ExperienceRecord, 0, len(c.cache))
	for _, rec := range c.cache {
		pool = append(pool, *rec)
	}
	c.mu.RUnlock()
	if len(pool) == 0 {
		return nil
	}

	type scored struct {
		rec   ExperienceRecord
		score float64
	}
	scoredPool := make([]scored, len(pool))
	for i := range pool {
		scoredPool[i] = scored{pool[i], ScoreExperience(&pool[i], now)}
	}
	// 预排序: 分数降序, 并列时最近使用优先
	sort.SliceStable(scoredPool, func(i, j int) bool {
		if scoredPool[i].score != scoredPool[j].score {
			return scoredPool[i].score > scoredPool[j].score
		}
		return scoredPool[i].rec.LastUsedAt > scoredPool[j].rec.LastUsedAt
	})

	if n > len(scoredPool) {
		n = len(scoredPool)
	}
	out := make([]ExperienceRecord, 0, n)
	remaining := scoredPool
	for len(out) < n && len(remaining) > 0 {
		if epsilon > 0 && rand.Float64() < epsilon {
			// ε 探索: 均匀随机取一条 (rand 全局函数, 并发安全)
			idx := rand.Intn(len(remaining))
			out = append(out, remaining[idx].rec)
			remaining = append(remaining[:idx], remaining[idx+1:]...)
			continue
		}
		// 贪心: 取剩余最高分 (排序头部)
		out = append(out, remaining[0].rec)
		remaining = remaining[1:]
	}
	return out
}

// ─── 30 天旧经验衰减 (对齐 TS load 的 ageDays > 30 丢弃) ─────────

// CleanupExpired 清扫超龄经验 (TS: 加载时只保留最近 30 天;
// Go 无 JSONL 落盘, 由 janitor 周期调用实现同等衰减语义)。
// maxAgeDays ≤0 时取 30。返回移除数量。
func (c *ExperienceCache) CleanupExpired(maxAgeDays int) int {
	if maxAgeDays <= 0 {
		maxAgeDays = 30
	}
	cutoff := time.Now().UnixMilli() - int64(maxAgeDays)*86400000
	removed := 0

	c.mu.Lock()
	defer c.mu.Unlock()
	for fp, rec := range c.cache {
		if rec.CreatedAt < cutoff {
			delete(c.cache, fp)
			removed++
		}
	}
	return removed
}

// ─── janitor (EvolutionPipeline 周期清扫) ────────────────────────

// evolutionJanitorInterval 清扫周期 (10 分钟; 经验/技能都是低频变化数据)
const evolutionJanitorInterval = 10 * time.Minute

// janitor 周期清扫: 超龄经验 (>30 天) + 陈旧技能衰减 (>7 天)。
// 生命周期挂在 p.stop (Shutdown 时关闭)。
func (p *EvolutionPipeline) janitor() {
	ticker := time.NewTicker(evolutionJanitorInterval)
	defer ticker.Stop()
	for {
		select {
		case <-p.stop:
			return
		case <-ticker.C:
			p.experience.CleanupExpired(30)
			p.schedulerSkills().SweepStale(evolutionSkillStaleDays)
		}
	}
}
