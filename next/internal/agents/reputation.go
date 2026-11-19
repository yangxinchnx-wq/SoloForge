// ─────────────────────────────────────────────────────────────────
// reputation — 多维信誉引擎 + 流水台账 (从 TS reputation/multi-dimensional-reputation.ts
// 与 agent-registry.ts 的信誉操作部分迁移)
//
// 语义对齐:
//   - 组件化信誉: 组件分加权合成总分 (TS: competence .30 + reliability .30 +
//     integrity .25 + collaboration .15)。Go 侧组件对齐已有 agent.go 的三维
//     ReputationComponents {quality, reliability, collaboration}, 权重映射为
//     quality .55 (吸收 competence+integrity) / reliability .30 / collaboration .15
//   - 直接交互权重 0.75 > 间接闲谈权重 0.25 (RepuNet 3.3.1/3.3.2)
//   - CAS 版本号: 旧版本更新直接拒绝, 防同步竞态
//   - Gossip: 置信度 < 0.3 丢弃, 缓冲批处理, 60s 有效期, 默认置信度 0.5
//   - 惩罚/奖励: reason 含 'fraud' → 诚实维度 (Go 映射 quality), 否则 reliability;
//     court_victory 记 win, court_defeat 记 loss; 每次变更发 agent.reputation.updated
//   - 争议: 发 agent.dispute.raised (对齐 RuntimeEvent.AgentDisputeRaised)
//
// 与 TS 版差异:
//   - 分值刻度 0..100 (对齐已有 agent.go / routes.go 语义), TS 为 0..1
//   - 组件为三维 (TS 四维), integrity 并入 quality
//   - 台账为进程内流水 (重启清零), 每笔同时经 events 表落库审计
// ─────────────────────────────────────────────────────────────────
package agents

import (
	"context"
	"encoding/json"
	"sort"
	"strings"
	"sync"
	"time"

	"soloforge/next/internal/bus"
	"soloforge/next/internal/store"
)

// 信誉维度名 (Go 三维, json 对齐 agent.go ReputationComponents)
const (
	ReputationQuality       = "quality"
	ReputationReliability   = "reliability"
	ReputationCollaboration = "collaboration"
)

// 组件权重 (TS: competence .30 / reliability .30 / integrity .25 / collaboration .15;
// Go quality 吸收 competence+integrity → .30+.25=.55)
const (
	weightQuality       = 0.55
	weightReliability   = 0.30
	weightCollaboration = 0.15

	// 直接交互 vs 间接闲谈的权重比 (参考 RepuNet, 对齐 TS)
	directInteractionWeight = 0.75
	gossipInteractionWeight = 0.25
)

// Gossip 门槛参数 (对齐 TS: 置信度 < 0.3 丢弃, 缓冲 60s 有效期, 默认置信度 0.5)
const (
	gossipMinConfidence   = 0.3
	gossipValidityWindow  = 60 * time.Second
	gossipDefaultConf     = 0.5
)

// ReputationState 信誉快照 — 含聚合分与各维度 (对齐 TS ReputationSnapshot)
type ReputationState struct {
	EntityID       string               `json:"entityId"`
	Components     ReputationComponents `json:"components"`     // 复用 agent.go 三维组件 (0..100)
	AggregateScore float64              `json:"aggregateScore"` // 加权合成总分 (0..100)
	Version        int                  `json:"version"`        // CAS 版本号
	LastUpdated    int64                `json:"lastUpdated"`    // 毫秒时间戳
}

// GossipEvaluation 间接闲谈评价 (对齐 TS GossipMessage 核心字段, json 名不变)
type GossipEvaluation struct {
	AboutAgentID string  `json:"aboutAgentId"` // 被评价的 Agent
	Dimension    string  `json:"dimension"`    // 评价维度 (quality/reliability/collaboration)
	Score        float64 `json:"score"`        // 评价分值 (TS 语义 -1..1)
	Confidence   float64 `json:"confidence"`   // 置信度 (直接交互 > 间接闲谈)
	TS           int64   `json:"ts"`           // 毫秒时间戳 (缓冲有效期判定)
}

// ReputationEntry 信誉台账流水 (每笔组件更新/惩罚/奖励各记一条)
type ReputationEntry struct {
	Seq       int64   `json:"seq"`       // 引擎内单调递增
	TS        int64   `json:"ts"`        // 毫秒时间戳
	AgentID   string  `json:"agentId"`
	Kind      string  `json:"kind"`      // reward | penalty | direct | gossip | dispute
	Dimension string  `json:"dimension"` // 被更新的维度
	Delta     float64 `json:"delta"`     // 对 agent 总分的增减 (点数)
	Reason    string  `json:"reason"`    // 变更原因 (court_victory / court_defeat / task_success ...)
	NewScore  float64 `json:"newScore"`  // 变更后的总分
	Version   int     `json:"version"`   // 变更后的 CAS 版本
}

// ReputationEngine 多维信誉引擎
//
// 设计原则 (对齐 TS):
//  1. 信誉分组件化, 非单一分数
//  2. 直接交互权重 > 间接闲谈权重
//  3. 版本号 CAS, 解决同步竞态
//  4. Gossip 机制传播间接声誉
type ReputationEngine struct {
	pool  *Pool // 同包直访, 变更同步回 agent 池快照
	store *store.Store
	bus   *bus.EventBus

	mu           sync.Mutex
	states       map[string]*ReputationState
	ledger       []ReputationEntry
	ledgerSeq    int64
	gossipBuffer []GossipEvaluation
}

// NewReputationEngine 构造引擎 (pool 同步目标, store/bus 事件落库广播)
func NewReputationEngine(pool *Pool, st *store.Store, b *bus.EventBus) *ReputationEngine {
	return &ReputationEngine{
		pool:  pool,
		store: st,
		bus:   b,
		states: make(map[string]*ReputationState),
	}
}

// Register 注册实体初始声誉。initial 为 nil 时:
//   - 池中已有该 Agent → 以池内组件为初值 (保持快照一致)
//   - 池中不存在 → 默认 50/维 (TS 默认 0.5)
func (e *ReputationEngine) Register(entityID string, initial *ReputationComponents) *ReputationState {
	e.mu.Lock()
	defer e.mu.Unlock()
	if st, ok := e.states[entityID]; ok {
		return st
	}
	comp := ReputationComponents{Quality: 50, Reliability: 50, Collaboration: 50}
	if initial != nil {
		comp = *initial
	} else if a, err := e.pool.Get(entityID); err == nil {
		comp = a.ReputationComponents
	}
	st := &ReputationState{
		EntityID:       entityID,
		Components:     comp,
		AggregateScore: calcAggregate(comp),
		Version:        1,
		LastUpdated:    time.Now().UnixMilli(),
	}
	e.states[entityID] = st
	return st
}

// Get 获取实体信誉快照 (副本)
func (e *ReputationEngine) Get(entityID string) (ReputationState, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	st, ok := e.states[entityID]
	if !ok {
		return ReputationState{}, false
	}
	return *st, true
}

// Aggregate 聚合声誉分 (单一分数向后兼容; 未注册返回 50, 对齐 TS 0.5)
func (e *ReputationEngine) Aggregate(entityID string) float64 {
	e.mu.Lock()
	defer e.mu.Unlock()
	if st, ok := e.states[entityID]; ok {
		return st.AggregateScore
	}
	return 50
}

// UpdateFromDirectInteraction 直接交互驱动的信誉更新 (RepuNet 3.3.1)
// delta 为点数 (0..100 刻度); version 非零时做 CAS 校验, 旧版本拒绝
func (e *ReputationEngine) UpdateFromDirectInteraction(entityID, dimension string, delta float64, version int) *ReputationState {
	return e.update(entityID, dimension, delta*directInteractionWeight, version, "direct", "")
}

// UpdateFromGossip 间接闲谈驱动的信誉更新 (RepuNet 3.3.2)
// 闲谈权重低于直接交互
func (e *ReputationEngine) UpdateFromGossip(entityID, dimension string, delta float64) *ReputationState {
	return e.update(entityID, dimension, delta*gossipInteractionWeight, 0, "gossip", "")
}

// update 组件更新公共路径: CAS → 钳制更新 → 合成总分 → 台账 → 池同步
func (e *ReputationEngine) update(entityID, dimension string, deltaPoints float64, version int, kind, reason string) *ReputationState {
	e.mu.Lock()
	defer e.mu.Unlock()
	st, ok := e.states[entityID]
	if !ok {
		e.mu.Unlock()
		e.Register(entityID, nil)
		e.mu.Lock()
		st = e.states[entityID]
	}
	// CAS: 版本号检查, 防止旧数据覆盖新数据 (对齐 TS)
	if version != 0 && version < st.Version {
		return st
	}

	dim := normalizeDimension(dimension)
	old := st.AggregateScore
	applyComponent(&st.Components, dim, deltaPoints)
	st.AggregateScore = calcAggregate(st.Components)
	st.Version++
	st.LastUpdated = time.Now().UnixMilli()

	e.appendLedgerLocked(ReputationEntry{
		TS:        st.LastUpdated,
		AgentID:   entityID,
		Kind:      kind,
		Dimension: dim,
		Delta:     st.AggregateScore - old,
		Reason:    reason,
		NewScore:  st.AggregateScore,
		Version:   st.Version,
	})
	e.syncPoolLocked(entityID, st)
	return st
}

// ── 惩罚 / 奖励 (对齐 agent-registry.ts penalize/rewardReputation) ────

// Penalize 惩罚信誉: 总分扣 deduction 点; reason 含 'fraud' → quality, 否则 reliability
// court_defeat 记一次败诉; 广播 agent.reputation.updated
func (e *ReputationEngine) Penalize(ctx context.Context, agentID string, deduction float64, reason string) {
	if st := e.update(agentID, e.dimensionForReason(reason), -deduction, 0, "penalty", reason); st != nil {
		e.applyPoolCounters(agentID, false, reason)
		e.emitReputationUpdated(ctx, agentID, -deduction, reason, st.AggregateScore, st.Version)
	}
}

// Reward 奖励信誉: 总分加 bonus 点; 奖励走 quality (TS integrity 映射)
// court_victory 记一次胜诉; 广播 agent.reputation.updated
func (e *ReputationEngine) Reward(ctx context.Context, agentID string, bonus float64, reason string) {
	if st := e.update(agentID, ReputationQuality, bonus, 0, "reward", reason); st != nil {
		e.applyPoolCounters(agentID, true, reason)
		e.emitReputationUpdated(ctx, agentID, bonus, reason, st.AggregateScore, st.Version)
	}
}

// dimensionForReason 根据原因选维度: fraud → quality (TS integrity), 否则 reliability
func (e *ReputationEngine) dimensionForReason(reason string) string {
	if strings.Contains(reason, "fraud") {
		return ReputationQuality
	}
	return ReputationReliability
}

// RaiseDispute 提交争议: 记争议次数 + 台账 + 广播 agent.dispute.raised
// (对齐 agent-registry.ts raiseDispute 的事件载荷)
func (e *ReputationEngine) RaiseDispute(ctx context.Context, agentID, traceID, statement string, evidenceCount int) {
	_ = e.pool.RecordDispute(agentID)
	e.mu.Lock()
	e.appendLedgerLocked(ReputationEntry{
		TS:      time.Now().UnixMilli(),
		AgentID: agentID,
		Kind:    "dispute",
		Reason:  statement,
	})
	e.mu.Unlock()
	e.emit(ctx, "agent.dispute.raised", map[string]any{
		"traceId":       traceID,
		"agentId":       agentID,
		"statement":     statement,
		"evidenceCount": evidenceCount,
		"timestamp":     time.Now().UnixMilli(),
	})
}

// ── Gossip (RepuNet 间接声誉传播) ────────────────────────────────

// ReceiveGossip 接收 Gossip 消息并缓冲; 低置信度 (<0.3) 直接丢弃
func (e *ReputationEngine) ReceiveGossip(ev GossipEvaluation) {
	if ev.Confidence < gossipMinConfidence {
		return
	}
	if ev.TS == 0 {
		ev.TS = time.Now().UnixMilli()
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	e.gossipBuffer = append(e.gossipBuffer, ev)
}

// ProcessGossipBuffer 批量处理 Gossip 缓冲:
// 过滤过期 (>60s) → 按 score×confidence 应用闲谈更新 → 清空缓冲
func (e *ReputationEngine) ProcessGossipBuffer() {
	e.mu.Lock()
	now := time.Now()
	valid := make([]GossipEvaluation, 0, len(e.gossipBuffer))
	for _, g := range e.gossipBuffer {
		if now.Sub(time.UnixMilli(g.TS)) < gossipValidityWindow {
			valid = append(valid, g)
		}
	}
	e.gossipBuffer = e.gossipBuffer[:0]
	e.mu.Unlock()

	for _, g := range valid {
		// TS: score×confidence 作为闲谈 delta (score 为 -1..1 语义 → ×100 转点数)
		e.UpdateFromGossip(g.AboutAgentID, g.Dimension, g.Score*g.Confidence*100)
	}
}

// HandleACLMessage ACL GOSSIP 载荷入口 (ACLBus.OnGossip 钩子接入):
// 解析 {aboutAgentId, evaluation:{dimension, score, confidence}} 并缓冲
func (e *ReputationEngine) HandleACLMessage(msg ACLMessage) {
	if msg.Performative != PerfGossip {
		return
	}
	raw, err := json.Marshal(msg.Content)
	if err != nil {
		return
	}
	var payload struct {
		AboutAgentID string           `json:"aboutAgentId"`
		Evaluation   GossipEvaluation `json:"evaluation"`
	}
	if json.Unmarshal(raw, &payload) != nil {
		return
	}
	about := payload.AboutAgentID
	if about == "" {
		about = payload.Evaluation.AboutAgentID
	}
	if about == "" {
		return
	}
	ev := payload.Evaluation
	ev.AboutAgentID = about
	e.ReceiveGossip(ev)
}

// CreateGossipEvaluation 生成 Gossip 评价 (默认置信度 0.5, 对齐 TS createGossip)
func (e *ReputationEngine) CreateGossipEvaluation(aboutAgentID, dimension string, score float64) GossipEvaluation {
	return GossipEvaluation{
		AboutAgentID: aboutAgentID,
		Dimension:    normalizeDimension(dimension),
		Score:        score,
		Confidence:   gossipDefaultConf,
		TS:           time.Now().UnixMilli(),
	}
}

// ── 查询 / 快照 ────────────────────────────────────────────────

// Ledger 信誉台账流水 (按时间倒序; agentID 为空 = 全部; limit ≤0 时取 100)
func (e *ReputationEngine) Ledger(agentID string, limit int) []ReputationEntry {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := make([]ReputationEntry, 0, len(e.ledger))
	for _, entry := range e.ledger {
		if agentID == "" || entry.AgentID == agentID {
			out = append(out, entry)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Seq > out[j].Seq })
	if limit <= 0 {
		limit = 100
	}
	if len(out) > limit {
		out = out[:limit]
	}
	return out
}

// Snapshot 全量信誉快照 (按 EntityID 排序保证稳定输出)
func (e *ReputationEngine) Snapshot() []ReputationState {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := make([]ReputationState, 0, len(e.states))
	for _, st := range e.states {
		out = append(out, *st)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].EntityID < out[j].EntityID })
	return out
}

// ── 内部 ────────────────────────────────────────────────────────

// appendLedgerLocked 台账追加 (须持 e.mu)
func (e *ReputationEngine) appendLedgerLocked(entry ReputationEntry) {
	e.ledgerSeq++
	entry.Seq = e.ledgerSeq
	e.ledger = append(e.ledger, entry)
	// 台账内存上限 (防无限增长): 保留最近 10000 条
	if len(e.ledger) > 10000 {
		e.ledger = e.ledger[len(e.ledger)-10000:]
	}
}

// syncPoolLocked 把引擎快照同步回 agent 池 (同包直访 pool 字段, 须持 e.mu)
func (e *ReputationEngine) syncPoolLocked(entityID string, st *ReputationState) {
	e.pool.mu.Lock()
	if a, ok := e.pool.agents[entityID]; ok {
		a.ReputationScore = clamp(st.AggregateScore, 0, 100)
		a.ReputationComponents = st.Components
	}
	e.pool.mu.Unlock()
}

// applyPoolCounters 胜诉/败诉计数 (对齐 TS: court_victory→wins, court_defeat→losses)
func (e *ReputationEngine) applyPoolCounters(agentID string, win bool, reason string) {
	switch {
	case win && reason == "court_victory":
		_ = e.pool.RecordWin(agentID)
	case !win && reason == "court_defeat":
		_ = e.pool.RecordLoss(agentID)
	}
}

// emitReputationUpdated 广播信誉变更 (载荷对齐 TS RuntimeEvent.AgentReputationUpdated)
func (e *ReputationEngine) emitReputationUpdated(ctx context.Context, agentID string, delta float64, reason string, newScore float64, version int) {
	e.emit(ctx, "agent.reputation.updated", map[string]any{
		"agentId":  agentID,
		"delta":    delta,
		"reason":   reason,
		"newScore": newScore,
		"version":  version,
		"timestamp": time.Now().UnixMilli(),
	})
}

// emit 先落库后广播 (对齐 court.go emit 纪律)
func (e *ReputationEngine) emit(ctx context.Context, typ string, payload map[string]any) {
	if e.store == nil || e.bus == nil {
		return
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return
	}
	if ev, err := e.store.AppendEvent(ctx, typ, "agents.reputation", raw); err == nil {
		e.bus.Publish(ev)
	}
}

// calcAggregate 组件加权合成总分 (0..100 刻度)
func calcAggregate(c ReputationComponents) float64 {
	return c.Quality*weightQuality + c.Reliability*weightReliability + c.Collaboration*weightCollaboration
}

// normalizeDimension 维度名归一: TS 四维 (competence/integrity) → Go 三维
func normalizeDimension(dimension string) string {
	switch dimension {
	case ReputationReliability:
		return ReputationReliability
	case ReputationCollaboration:
		return ReputationCollaboration
	default:
		// quality / competence / integrity / 未知 → quality
		return ReputationQuality
	}
}

// applyComponent 按维度钳制更新组件分 (须持 e.mu; delta 可负)
func applyComponent(c *ReputationComponents, dimension string, deltaPoints float64) {
	switch dimension {
	case ReputationReliability:
		c.Reliability = clamp(c.Reliability+deltaPoints, 0, 100)
	case ReputationCollaboration:
		c.Collaboration = clamp(c.Collaboration+deltaPoints, 0, 100)
	default:
		c.Quality = clamp(c.Quality+deltaPoints, 0, 100)
	}
}
