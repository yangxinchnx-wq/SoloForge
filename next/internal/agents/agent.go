// ─────────────────────────────────────────────────────────────────
// agents — Agent 运行时 (从 TS src/core/agent 迁移, 阶段 2)
//
// 语义对齐: AgentSnapshot 结构与旧 agent-registry.ts:26-37 一致,
// 事件名与 protocol.md §1 的 WS 消息名一致 (agent.task.dispatched 等)。
// ─────────────────────────────────────────────────────────────────
package agents

import (
	"fmt"
	"sync"
	"time"
)

// ReputationComponents 信誉构成 (对齐 TS ReputationComponents)
type ReputationComponents struct {
	Quality      float64 `json:"quality"`
	Reliability  float64 `json:"reliability"`
	Collaboration float64 `json:"collaboration"`
}

// Agent 单个智能体 (快照结构与旧版一致)
type Agent struct {
	AgentID            string               `json:"agentId"`
	StrategyType       string               `json:"strategyType"`
	Model              string               `json:"model,omitempty"`
	ReputationScore    float64              `json:"reputationScore"`
	ReputationComponents ReputationComponents `json:"reputationComponents"`
	EvidenceCount      int                  `json:"evidenceCount"`
	StakeBalance       float64              `json:"stakeBalance"`
	TotalExecutions    int                  `json:"totalExecutions"`
	TotalDisputes      int                  `json:"totalDisputes"`
	TotalWins          int                  `json:"totalWins"`
	TotalLosses        int                  `json:"totalLosses"`
	CreatedAt          time.Time            `json:"createdAt"`
}

// Pool agent 池 (进程内, 阶段 2 后续版本持久化关键变更)
type Pool struct {
	mu     sync.RWMutex
	agents map[string]*Agent
	order  []string // 注册顺序 (snapshot 输出稳定)
}

func NewPool() *Pool {
	return &Pool{agents: make(map[string]*Agent)}
}

// Register 注册 (存在则幂等返回)
func (p *Pool) Register(agentID, strategyType, model string) *Agent {
	p.mu.Lock()
	defer p.mu.Unlock()
	if a, ok := p.agents[agentID]; ok {
		return a
	}
	a := &Agent{
		AgentID:      agentID,
		StrategyType: strategyType,
		Model:        model,
		ReputationScore: 100,
		ReputationComponents: ReputationComponents{
			Quality: 100, Reliability: 100, Collaboration: 100,
		},
		StakeBalance: 10,
		CreatedAt:    time.Now(),
	}
	p.agents[agentID] = a
	p.order = append(p.order, agentID)
	return a
}

func (p *Pool) Get(agentID string) (*Agent, error) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	a, ok := p.agents[agentID]
	if !ok {
		return nil, fmt.Errorf("agent 不存在: %s", agentID)
	}
	return a, nil
}

// Snapshot 全量快照 (对齐旧 GET /api/agents/snapshot 语义)
func (p *Pool) Snapshot() []Agent {
	p.mu.RLock()
	defer p.mu.RUnlock()
	out := make([]Agent, 0, len(p.order))
	for _, id := range p.order {
		if a, ok := p.agents[id]; ok {
			out = append(out, *a)
		}
	}
	return out
}

func (p *Pool) Count() int {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return len(p.agents)
}

// AdjustReputation 信誉增减 (钳制 0..100)
func (p *Pool) AdjustReputation(agentID string, delta float64) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	a, ok := p.agents[agentID]
	if !ok {
		return fmt.Errorf("agent 不存在: %s", agentID)
	}
	a.ReputationScore = clamp(a.ReputationScore+delta, 0, 100)
	a.ReputationComponents.Quality = clamp(a.ReputationComponents.Quality+delta, 0, 100)
	return nil
}

func (p *Pool) RecordExecution(agentID string) error { return p.apply(agentID, func(a *Agent) { a.TotalExecutions++ }) }
func (p *Pool) RecordDispute(agentID string) error   { return p.apply(agentID, func(a *Agent) { a.TotalDisputes++ }) }
func (p *Pool) RecordWin(agentID string) error       { return p.apply(agentID, func(a *Agent) { a.TotalWins++ }) }
func (p *Pool) RecordLoss(agentID string) error      { return p.apply(agentID, func(a *Agent) { a.TotalLosses++ }) }

func (p *Pool) apply(agentID string, fn func(*Agent)) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	a, ok := p.agents[agentID]
	if !ok {
		return fmt.Errorf("agent 不存在: %s", agentID)
	}
	fn(a)
	return nil
}

func clamp(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
