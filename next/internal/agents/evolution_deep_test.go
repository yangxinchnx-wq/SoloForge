// ─────────────────────────────────────────────────────────────────
// evolution_deep_test.go — 批次 3 深度行为自测
//
// 覆盖: 技能晋升/降级/失效条件、陈旧衰减清扫、经验打分细则、
// 优先级回放采样 (ε 探索)、30 天超龄经验清扫。
// ─────────────────────────────────────────────────────────────────
package agents

import (
	"testing"
	"time"
)

func mkSkill(id string, conf float64) SkillEntry {
	now := time.Now().UnixMilli()
	return SkillEntry{
		ID: id, Domain: "test", Pattern: "p-" + id,
		Confidence: conf, UsageCount: 0, SuccessRate: 1.0,
		CreatedAt: now, LastUsedAt: now,
	}
}

func TestSkillPromotion(t *testing.T) {
	l := NewSkillLibrary()
	l.AddSkill(mkSkill("s1", 0.5))

	// 使用 5 次全成功 → 晋升 candidate→validated (置信度 +0.2)
	for i := 0; i < 5; i++ {
		l.RecordUsage("s1", true)
	}
	s, ok := l.skills["s1"]
	if !ok {
		t.Fatal("技能应存在")
	}
	if s.Tier != skillTierValidated {
		t.Fatalf("5 次全成功应晋升到 validated, 实际 tier=%d", s.Tier)
	}
	if s.Confidence != 0.7 {
		t.Fatalf("晋升后置信度应 +0.2 → 0.7, 实际 %v", s.Confidence)
	}

	// 再用 5 次 → core
	for i := 0; i < 5; i++ {
		l.RecordUsage("s1", true)
	}
	if s := l.skills["s1"]; s.Tier != skillTierCore {
		t.Fatalf("10 次全成功应晋升到 core, 实际 tier=%d", s.Tier)
	}
}

func TestSkillDemotionAndInvalidation(t *testing.T) {
	l := NewSkillLibrary()
	l.AddSkill(mkSkill("s2", 1.0))
	// 先晋升到 core
	for i := 0; i < 10; i++ {
		l.RecordUsage("s2", true)
	}
	if l.skills["s2"].Tier != skillTierCore {
		t.Fatalf("前置晋升失败")
	}

	// 连续失败: 滑动窗口 ×0.9+0 → 降到 <0.4 时降级
	tierAfterFails := -1
	for i := 0; i < 20; i++ {
		l.RecordUsage("s2", false)
		s, ok := l.skills["s2"]
		if !ok {
			// 失效移除
			break
		}
		tierAfterFails = s.Tier
	}
	if _, ok := l.skills["s2"]; ok {
		if tierAfterFails == skillTierCore {
			t.Fatalf("连续失败应发生降级, tier 仍为 core")
		}
	}
	// 继续失败到 successRate < 0.2 → 移除
	for i := 0; i < 100; i++ {
		l.RecordUsage("s2", false)
		if _, ok := l.skills["s2"]; !ok {
			break
		}
	}
	if _, ok := l.skills["s2"]; ok {
		t.Fatalf("成功率 <0.2 应失效移除")
	}
}

func TestSkillSweepStale(t *testing.T) {
	l := NewSkillLibrary()
	now := time.Now().UnixMilli()

	fresh := mkSkill("fresh", 0.9)
	stale := mkSkill("stale", 0.5)
	stale.LastUsedAt = now - 8*86400000 // 8 天未用
	dying := mkSkill("dying", 0.09)     // 衰减后 <0.1 → 移除
	dying.LastUsedAt = now - 9*86400000
	l.AddSkill(fresh)
	l.AddSkill(stale)
	l.AddSkill(dying)

	removed := l.SweepStale(7)
	if removed != 1 {
		t.Fatalf("应移除 1 条 (dying), 实际 %d", removed)
	}
	if _, ok := l.skills["dying"]; ok {
		t.Fatalf("dying 应被移除")
	}
	if got := l.skills["stale"].Confidence; got != 0.5*0.95 {
		t.Fatalf("stale 置信度应 ×0.95, 实际 %v", got)
	}
	if got := l.skills["fresh"].Confidence; got != 0.9 {
		t.Fatalf("fresh 不应衰减, 实际 %v", got)
	}
}

func TestManualPromoteDemote(t *testing.T) {
	l := NewSkillLibrary()
	l.AddSkill(mkSkill("m1", 0.5))
	if !l.Promote("m1") || l.skills["m1"].Tier != skillTierValidated {
		t.Fatalf("手动晋升失败")
	}
	if l.Promote("m1") { // validated → core 也允许
		if l.skills["m1"].Tier != skillTierCore {
			t.Fatalf("二次晋升应到 core")
		}
	}
	// core 已到顶, 再晋升失败
	if l.Promote("m1") {
		t.Fatalf("core 再晋升应返回 false")
	}
	if !l.Demote("m1") || l.skills["m1"].Tier != skillTierValidated {
		t.Fatalf("手动降级失败")
	}
	if l.Demote("m404") {
		t.Fatalf("不存在的技能应返回 false")
	}
}

func TestScoreExperience(t *testing.T) {
	now := time.Now().UnixMilli()
	rec := &ExperienceRecord{
		SuccessRate: 1.0, TokenCost: 1000, ReuseCount: 10,
		CreatedAt: now,
	}
	// 0.5*1 + 0.2*1 + 0.2*1 + 0.1*1 = 1.0
	if got := ScoreExperience(rec, now); got < 0.999 {
		t.Fatalf("满分经验应 ≈1.0, 实际 %v", got)
	}
	// 高 token 消耗 + 无复用 + 30 天前
	old := &ExperienceRecord{
		SuccessRate: 0.4, TokenCost: 20000, ReuseCount: 0,
		CreatedAt: now - 30*86400000,
	}
	got := ScoreExperience(old, now) // 0.2 + 0 + 0 + 0
	if got < 0.19 || got > 0.21 {
		t.Fatalf("低质经验应 ≈0.2, 实际 %v", got)
	}
	if ScoreExperience(nil, now) != 0 {
		t.Fatalf("nil 应得 0")
	}
}

func TestSampleReplay(t *testing.T) {
	c := NewExperienceCache()
	now := time.Now().UnixMilli()
	// 造 5 条经验: 好坏分明
	good := &ExperienceRecord{Fingerprint: "g1", SuccessRate: 1.0, TokenCost: 500,
		ReuseCount: 10, CreatedAt: now, LastUsedAt: now}
	bad := &ExperienceRecord{Fingerprint: "b1", SuccessRate: 0.1, TokenCost: 20000,
		ReuseCount: 0, CreatedAt: now - 30*86400000, LastUsedAt: now - 1000}
	c.cache["g1"] = good
	c.cache["b1"] = bad
	c.cache["n1"] = &ExperienceRecord{Fingerprint: "n1", SuccessRate: 0.7, TokenCost: 3000,
		ReuseCount: 2, CreatedAt: now, LastUsedAt: now}

	// ε=0: 严格按分数贪心, 首个必是 g1
	top := c.SampleReplay(1, 0)
	if len(top) != 1 || top[0].Fingerprint != "g1" {
		t.Fatalf("贪心采样应取最高分 g1, 实际 %+v", top)
	}
	all := c.SampleReplay(10, 0)
	if len(all) != 3 {
		t.Fatalf("n 超池应截断为池大小 3, 实际 %d", len(all))
	}
	// 排序: g1 → n1 → b1
	if all[0].Fingerprint != "g1" || all[2].Fingerprint != "b1" {
		t.Fatalf("回放顺序应按分数降序: %v %v", all[0].Fingerprint, all[2].Fingerprint)
	}
	// ε=1: 纯随机, 仍是 3 条且无重复
	rand := c.SampleReplay(3, 1.0)
	if len(rand) != 3 {
		t.Fatalf("随机采样应取满 3 条")
	}
	seen := map[string]bool{}
	for _, r := range rand {
		seen[r.Fingerprint] = true
	}
	if len(seen) != 3 {
		t.Fatalf("采样应无重复")
	}
	if got := c.SampleReplay(0, 0); got != nil {
		t.Fatalf("n=0 应返回 nil")
	}
}

func TestExperienceCleanupExpired(t *testing.T) {
	c := NewExperienceCache()
	now := time.Now().UnixMilli()
	c.cache["new1"] = &ExperienceRecord{Fingerprint: "new1", CreatedAt: now}
	c.cache["old1"] = &ExperienceRecord{Fingerprint: "old1", CreatedAt: now - 31*86400000}
	c.cache["qa_old"] = &ExperienceRecord{Fingerprint: "qa_old", CreatedAt: now - 40*86400000}

	removed := c.CleanupExpired(30)
	if removed != 2 {
		t.Fatalf("应移除 2 条超龄经验, 实际 %d", removed)
	}
	if _, ok := c.cache["new1"]; !ok {
		t.Fatalf("新经验应保留")
	}
}
