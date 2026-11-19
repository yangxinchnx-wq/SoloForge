// ─────────────────────────────────────────────────────────────────
// core — 制度 / 社会记忆 / 文化模因 / 社会信誉 的方法实现
// ─────────────────────────────────────────────────────────────────
package society

import (
	"context"
	"strings"
	"time"
)

// ── 制度 (CREATE/SOFT_DELETE_INSTITUTION) ───────────────────────

// CreateInstitution 创建制度
func (s *Service) CreateInstitution(ctx context.Context, traceID, name, description string,
	rules []string, scope, enforcement string, priority float64, metadata map[string]any) (*Institution, error) {
	s.mu.Lock()
	// 同名去重 (对齐 TS: 已存在同名 active 制度则幂等返回)
	for _, inst := range s.institutions {
		if inst.Status == "active" && inst.Name == name {
			s.mu.Unlock()
			return inst, nil
		}
	}
	inst := &Institution{
		ID:          s.newID("institution"),
		Name:        name,
		Description: description,
		Rules:       rules,
		Scope:       defaultStr(scope, "global"),
		Enforcement: defaultStr(enforcement, "strict"),
		Priority:    priority,
		Status:      "active",
		CreatedAt:   time.Now().UnixMilli(),
	}
	s.institutions[inst.ID] = inst
	s.mu.Unlock()
	s.emit(ctx, "society.institution.created", map[string]any{
		"institutionId": inst.ID, "name": inst.Name, "traceId": traceID,
	})
	return inst, nil
}

// SoftDeleteInstitution 软删制度 (幂等; 对齐 TS softDelete)
func (s *Service) SoftDeleteInstitution(ctx context.Context, traceID, institutionID string) map[string]any {
	s.mu.Lock()
	inst, ok := s.institutions[institutionID]
	if !ok || inst.Status == "deleted" {
		s.mu.Unlock()
		return map[string]any{"ok": false, "reason": "不存在或已删除", "institutionId": institutionID}
	}
	inst.Status = "deleted"
	inst.DeletedAt = time.Now().UnixMilli()
	s.mu.Unlock()
	s.emit(ctx, "society.institution.deleted", map[string]any{
		"institutionId": institutionID, "traceId": traceID,
	})
	return map[string]any{"ok": true, "institutionId": institutionID}
}

// seedDefaultInstitutions 种子宪法规范 (对齐 TS initializeDefaultConstitutionalNorms)
func (s *Service) seedDefaultInstitutions() {
	defaults := []Institution{
		{
			Name: "透明决策规范", Description: "重大决策须记录 traceId 并可审计",
			Rules: []string{"所有决策必须产生事件", "审计事件不可删除"}, Scope: "global", Enforcement: "strict", Priority: 100,
		},
		{
			Name: "互不侵犯规范", Description: "agent 不得对同级 agent 执行不可逆破坏操作",
			Rules: []string{DestroyMarkerN + " 操作强制升级最高法庭"}, Scope: "global", Enforcement: "strict", Priority: 90,
		},
	}
	for i := range defaults {
		inst := &defaults[i]
		inst.ID = s.newID("institution")
		inst.Status = "active"
		inst.CreatedAt = time.Now().UnixMilli()
		s.institutions[inst.ID] = inst
	}
}

// DestroyMarkerN 熔断关键词引用 (与 court 包语义一致, 避免跨包依赖)
const DestroyMarkerN = "IRREVERSIBLE_DESTRUCTION_OPERATION"

// ── 社会记忆 (RECORD_SOCIAL_MEMORY) ─────────────────────────────

// RecordMemory 记录社会记忆 (severity → importance, 关键词入倒排索引)
func (s *Service) RecordMemory(ctx context.Context, traceID, event, impact, severity string,
	participants, lessons []string, metadata map[string]any) (*SocialMemory, error) {
	m := &SocialMemory{
		ID:           s.newID("memory"),
		Event:        event,
		Impact:       defaultStr(impact, "neutral"),
		Severity:     defaultStr(severity, "medium"),
		Participants: participants,
		Lessons:      lessons,
		Metadata:     metadata,
		Importance:   severityImportance[defaultStr(severity, "medium")],
		CreatedAt:    time.Now().UnixMilli(),
	}
	// 关键词 = 事件分词 (简单空格切分; 对齐 TS 简易倒排)
	for _, kw := range strings.Fields(event) {
		kw = strings.Trim(kw, ",.;:!?")
		if kw == "" {
			continue
		}
		if s.keywordIndex[kw] == nil {
			s.keywordIndex[kw] = make(map[string]bool)
		}
		s.keywordIndex[kw][m.ID] = true
		m.Keywords = append(m.Keywords, kw)
	}

	s.mu.Lock()
	s.memories[m.ID] = m
	s.mu.Unlock()
	s.emit(ctx, "society.memory.recorded", map[string]any{
		"memoryId": m.ID, "event": m.Event, "importance": m.Importance, "traceId": traceID,
	})
	return m, nil
}

// ── 文化模因 (PROPAGATE_LEGAL_MEME) ─────────────────────────────

// PropagateMeme 法律模因传播: 集群立场按模因强度偏移 (熵抑制)
func (s *Service) PropagateMeme(ctx context.Context, traceID, targetClusterID, sourceMemeID string, entropy float64) (map[string]any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	meme, ok := s.memes[sourceMemeID]
	if !ok {
		return nil, errNotFound("源模因不存在: " + sourceMemeID)
	}
	stanceBefore := s.clusterStance[targetClusterID]
	shift := meme.Strength * (1 - clamp01(entropy))
	s.clusterStance[targetClusterID] = clamp11(stanceBefore+shift)
	meme.SpreadCount++
	meme.LastPropagatedAt = time.Now().UnixMilli()

	out := map[string]any{
		"memeId": sourceMemeID, "targetClusterId": targetClusterID,
		"stanceBefore": roundTo(stanceBefore, 4), "stanceAfter": roundTo(s.clusterStance[targetClusterID], 4),
		"spreadCount": meme.SpreadCount, "traceId": traceID,
	}
	// 异步 emit (锁内不宜持 store 锁, 落库在解锁后)
	go func() {
		ctxAsync := context.Background()
		s.emit(ctxAsync, "society.meme.propagated", out)
	}()
	_ = ctx
	return out, nil
}

// ── 社会信誉 (REGISTER/UPDATE/APPLY) ────────────────────────────

// RegisterReputationEntity 注册信誉实体 (幂等)
func (s *Service) RegisterReputationEntity(ctx context.Context, traceID, entityID, entityType string) map[string]any {
	key := entityType + ":" + entityID
	s.mu.Lock()
	rep, ok := s.reputations[key]
	if !ok {
		rep = &SocialReputation{
			EntityID: entityID, EntityType: entityType, Score: 100,
			Components: ComponentUpdate{Quality: 100, Reliability: 100, Collaboration: 100},
			UpdatedAt:  time.Now().UnixMilli(),
		}
		s.reputations[key] = rep
	}
	s.mu.Unlock()
	s.emit(ctx, "society.reputation.registered", map[string]any{
		"entityId": entityID, "entityType": entityType, "traceId": traceID,
	})
	return map[string]any{"entityId": entityID, "score": rep.Score}
}

// UpdateReputationScore 更新信誉分 (构成加权合成: 质量0.5/可靠0.3/协作0.2)
func (s *Service) UpdateReputationScore(ctx context.Context, traceID, entityID, entityType string,
	components ComponentUpdate, evidence string) map[string]any {
	key := entityType + ":" + entityID
	s.mu.Lock()
	rep, ok := s.reputations[key]
	if !ok {
		rep = &SocialReputation{EntityID: entityID, EntityType: entityType, Score: 100,
			UpdatedAt: time.Now().UnixMilli()}
		s.reputations[key] = rep
	}
	rep.Components = components
	rep.Score = roundTo(components.Quality*0.5+components.Reliability*0.3+components.Collaboration*0.2, 2)
	if evidence != "" {
		rep.History = append(rep.History, evidence)
	}
	rep.UpdatedAt = time.Now().UnixMilli()
	score := rep.Score
	s.mu.Unlock()
	s.emit(ctx, "society.reputation.updated", map[string]any{
		"entityId": entityID, "score": score, "traceId": traceID,
	})
	return map[string]any{"entityId": entityID, "score": score}
}

// ApplyReputationPenalty 信誉惩罚 (钳制 0..100)
func (s *Service) ApplyReputationPenalty(ctx context.Context, traceID, entityID, entityType string, penalty PenaltySpec) map[string]any {
	key := entityType + ":" + entityID
	s.mu.Lock()
	rep, ok := s.reputations[key]
	if !ok {
		rep = &SocialReputation{EntityID: entityID, EntityType: entityType, Score: 100,
			UpdatedAt: time.Now().UnixMilli()}
		s.reputations[key] = rep
	}
	rep.Score = clamp01(rep.Score - penalty.Amount)
	rep.UpdatedAt = time.Now().UnixMilli()
	score := rep.Score
	s.mu.Unlock()
	s.emit(ctx, "society.reputation.penalty.applied", map[string]any{
		"entityId": entityID, "penalty": penalty.Amount, "score": score, "traceId": traceID,
	})
	return map[string]any{"entityId": entityID, "score": score}
}

// ── 工具 ────────────────────────────────────────────────────────

func defaultStr(v, def string) string {
	if v == "" {
		return def
	}
	return v
}

func clamp01(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}

func clamp11(v float64) float64 {
	if v < -1 {
		return -1
	}
	if v > 1 {
		return 1
	}
	return v
}

var errNotFound = func(msg string) error { return &notFoundError{msg} }

type notFoundError struct{ msg string }

func (e *notFoundError) Error() string { return e.msg }
