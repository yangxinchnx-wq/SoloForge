// ─────────────────────────────────────────────────────────────────
// data — 消费者框架 + 12 个数据消费者
//
//	(从 TS src/data/consumers/*.ts 迁移)
//
// TS 侧 11 个消费者文件全部订阅 RuntimeEvent.TransactionCommitted
// (protocol.md §6 计 12 个 consumer — 第 12 个为本包 event-log-audit,
//
//	对齐 TS src/data/repositories/event-log-repository.ts 的事件审计链路,
//	统一记录 TransactionCommitted 与 data.*/outbox.* 审计事件)。
//
// 迁移语义: TS 各消费者把 Commit 事实 CREATE 进 SurrealDB 温表;
// Go 侧存储进程内化, 温表改为 Projections 内存投影表 (表名/字段名
// 与 TS SurrealDB 表字段逐一对应, 便于语义对照)。
// TS 用 IIFE 异步非阻塞; Go 侧分发在注册表 pump 协程内同步执行
// (内存投影写入为微秒级, 总线缓冲 256 + 慢消费者丢帧兜底)。
//
// 12 个消费者一览 (domain 过滤 → 目标投影表):
//  1. consensus-audit      ConsensusEngine            → distributed_consensus_ledger
//  2. court-adjudication   ConsensAgentCourt          → primary_court_verdict
//     LlmSupremeEscalation       → supreme_court_verdict
//  3. governor-shadow      AIRuntime                  → governor_shadow_decision (PPO 决策冷沉淀)
//  4. law-compliance       LawEngine                  → law_violation_record / law_execution_ledger
//  5. migration-audit      SandboxMigration           → sandbox_migration_history
//  6. reputation-analytics SocialReputation           → agent_reputation_history / law_penalty_levy
//  7. social-memory        SocialMemory               → collective_social_memory
//  8. society-culture      CoalitionEngine            → coalition_registry / coalition_payout_ledger
//     MemeticPropagation         → memetic_diffusion_history
//  9. society-evolution    RoleEvolution              → agent_regime_history
//     TokenEconomy               → agent_economic_ledger
//     CoalitionEngine            → coalition_formation_history / coalition_payout_history
//  10. society-governance   InstitutionEngine          → society_institution_registry
//     GovernancePolicy           → society_governance_assessment / action_log
//  11. telemetry-aggregation 全域                       → 指标计数 + 系统熵代理值
//  12. event-log-audit      全域 + data.*/outbox.*      → event_log (审计链路)
//
// ─────────────────────────────────────────────────────────────────
package data

import (
	"context"
	"fmt"
	"sort"
	"sync"
	"time"

	"soloforge/next/internal/bus"
	"soloforge/next/internal/store"
)

// ── 域名常量 (对齐 TS txPayload.domain 过滤值) ───────────────────

const (
	DomainConsensusEngine      = "ConsensusEngine"
	DomainConsensAgentCourt    = "ConsensAgentCourt"
	DomainLlmSupremeEscalation = "LlmSupremeEscalation"
	DomainAIRuntime            = "AIRuntime"
	DomainLawEngine            = "LawEngine"
	DomainSandboxMigration     = "SandboxMigration"
	DomainSocialReputation     = "SocialReputation"
	DomainSocialMemory         = "SocialMemory"
	DomainCoalitionEngine      = "CoalitionEngine"
	DomainMemeticPropagation   = "MemeticPropagation"
	DomainRoleEvolution        = "RoleEvolution"
	DomainTokenEconomy         = "TokenEconomy"
	DomainInstitutionEngine    = "InstitutionEngine"
	DomainGovernancePolicy     = "GovernancePolicy"
)

// ── 投影表名 (对齐 TS SurrealDB CREATE 目标表) ───────────────────

const (
	TableConsensusLedger        = "distributed_consensus_ledger"
	TablePrimaryCourtVerdict    = "primary_court_verdict"
	TableSupremeCourtVerdict    = "supreme_court_verdict"
	TableGovernorShadow         = "governor_shadow_decision"
	TableLawViolation           = "law_violation_record"
	TableLawExecution           = "law_execution_ledger"
	TableMigrationHistory       = "sandbox_migration_history"
	TableReputationHistory      = "agent_reputation_history"
	TablePenaltyLevy            = "law_penalty_levy"
	TableSocialMemory           = "collective_social_memory"
	TableCoalitionRegistry      = "coalition_registry"
	TableCoalitionPayoutLedger  = "coalition_payout_ledger"
	TableMemeticHistory         = "memetic_diffusion_history"
	TableRegimeHistory          = "agent_regime_history"
	TableEconomicLedger         = "agent_economic_ledger"
	TableCoalitionFormation     = "coalition_formation_history"
	TableCoalitionPayoutHistory = "coalition_payout_history"
	TableInstitutionRegistry    = "society_institution_registry"
	TableGovernanceAssessment   = "society_governance_assessment"
	TableGovernanceAction       = "society_governance_action_log"
	TableEventLog               = "event_log"
)

// court 裁决状态封印 (对齐 court.StatusEscapeToLLM / StatusDeadlockTrigger,
// TS telemetry 消费者按原始字符串判定)
const (
	SealEscapeToLLM = "ESCAPE_ROUTING_TO_LLM"
	SealDeadlock    = "CONSERVATIVE_DEADLOCK_TRIGGER"
)

// entropyWeight 系统熵启发式权重 (对齐 TS configCenter
// 'society.reputation.weight_error' 默认 0.3)
const entropyWeight = 0.3

// maxTableRecords 单投影表容量上限 (Go 增强: TS 表在 SurrealDB 无界,
// 进程内存需封顶, 满员丢弃最旧)
const maxTableRecords = 5000

// ── Consumer 框架 ────────────────────────────────────────────────

// Consumer 数据消费者 (对齐 TS initialize*Consumer 的订阅语义:
// EventTypes 声明订阅的事件类型, Handle 为消费体; TS 的 domain 过滤
// 留在 Handle 内部, 保持各消费者逻辑自包含)
type Consumer struct {
	Name       string                                        // 消费者名 (统计键)
	EventTypes []string                                      // 订阅事件类型 (空 = 全部)
	Handle     func(ctx context.Context, ev bus.Event) error // 消费体 (返回 error 仅计数, 不中断分发)
}

// matchType 消费者是否订阅该事件类型
func (c Consumer) matchType(typ string) bool {
	if len(c.EventTypes) == 0 {
		return true
	}
	for _, t := range c.EventTypes {
		if t == typ {
			return true
		}
	}
	return false
}

// ConsumerStat 消费者统计 (观测/对账用)
type ConsumerStat struct {
	Name      string `json:"name"`
	Processed uint64 `json:"processed"`
	Failed    uint64 `json:"failed"`
	LastError string `json:"lastError,omitempty"`
	LastAt    int64  `json:"lastAt,omitempty"`
}

// Projections 投影仓 — TS SurrealDB 温表的进程内等价物。
// 表 = 追加式记录列表 (CREATE 语义); 另存 telemetry 聚合计数与熵代理值。
type Projections struct {
	mu       sync.Mutex
	tables   map[string][]map[string]any
	counters map[string]int64 // telemetry 指标计数 (soloforge_*)
	entropy  float64          // soloforge_cluster_system_entropy (gauge)
}

// NewProjections 构造投影仓
func NewProjections() *Projections {
	return &Projections{
		tables:   make(map[string][]map[string]any),
		counters: make(map[string]int64),
	}
}

// Insert 追加一条投影记录 (对齐 TS CREATE <table> CONTENT {...}; 满员丢最旧)
func (p *Projections) Insert(table string, rec map[string]any) {
	p.mu.Lock()
	defer p.mu.Unlock()
	rows := append(p.tables[table], rec)
	if len(rows) > maxTableRecords {
		rows = rows[len(rows)-maxTableRecords:]
	}
	p.tables[table] = rows
}

// Table 取投影表快照 (升序副本; 不存在返回空表)
func (p *Projections) Table(name string, limit int) []map[string]any {
	p.mu.Lock()
	defer p.mu.Unlock()
	rows := p.tables[name]
	if limit <= 0 || limit > len(rows) {
		limit = len(rows)
	}
	out := make([]map[string]any, 0, limit)
	for _, r := range rows[len(rows)-limit:] {
		out = append(out, r)
	}
	return out
}

// Count 投影表行数
func (p *Projections) Count(table string) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.tables[table])
}

// Tables 已建投影表名列表
func (p *Projections) Tables() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	names := make([]string, 0, len(p.tables))
	for name := range p.tables {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// incr 指标计数 +1 (对齐 TS exporter.updateRegistryMetricValue(key, 1))
func (p *Projections) incr(metric string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.counters[metric]++
}

// setEntropy 更新系统熵代理值 (对齐 TS soloforge_cluster_system_entropy)
func (p *Projections) setEntropy(v float64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.entropy = v
}

// Metrics 指标快照 (计数 + 熵)
func (p *Projections) Metrics() (map[string]int64, float64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make(map[string]int64, len(p.counters))
	for k, v := range p.counters {
		out[k] = v
	}
	return out, p.entropy
}

// ── Registry: 订阅总线并分发 ─────────────────────────────────────

// Registry 消费者注册表: 订阅 bus.EventBus, 按 Consumer.EventTypes 分发。
// Start 时先重放 store 存量事件再进入实时流 (进程内存储重启即清零,
// 消费者重启后可由重放重建投影 — TS 无此步骤, Go 增强)。
type Registry struct {
	st        *store.Store
	b         *bus.EventBus
	consumers []Consumer

	mu    sync.Mutex
	stats map[string]*ConsumerStat

	subID    int64
	ch       <-chan bus.Event
	stop     chan struct{}
	done     chan struct{}
	stopOnce sync.Once
}

// NewRegistry 构造注册表 (需 Start 启动分发协程)
func NewRegistry(st *store.Store, b *bus.EventBus, consumers ...Consumer) *Registry {
	r := &Registry{
		st:        st,
		b:         b,
		consumers: make([]Consumer, 0, len(consumers)),
		stats:     make(map[string]*ConsumerStat),
		stop:      make(chan struct{}),
		done:      make(chan struct{}),
	}
	for _, c := range consumers {
		r.Register(c)
	}
	return r
}

// Register 注册消费者 (启动前调用; 同名覆盖)
func (r *Registry) Register(c Consumer) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.consumers = append(r.consumers, c)
	if _, ok := r.stats[c.Name]; !ok {
		r.stats[c.Name] = &ConsumerStat{Name: c.Name}
	}
}

// Consumers 已注册消费者名列表
func (r *Registry) Consumers() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	names := make([]string, 0, len(r.consumers))
	for _, c := range r.consumers {
		names = append(names, c.Name)
	}
	return names
}

// Start 启动分发 (幂等): 先订阅实时通道 (重放期间到达的新事件进缓冲),
// 再重放存量事件重建投影, 最后进入实时流。
func (r *Registry) Start(ctx context.Context) {
	id, ch := r.b.Subscribe()
	r.mu.Lock()
	if r.subID != 0 { // 已启动
		r.mu.Unlock()
		r.b.Unsubscribe(id)
		return
	}
	r.subID = id
	r.ch = ch
	r.mu.Unlock()

	r.replay(ctx) // 重放: 存量事件过一遍消费者 (重建投影)
	go r.pump(ctx)
}

// replay 存量事件重放 (游标分页扫全量)
func (r *Registry) replay(ctx context.Context) {
	cursor := int64(0)
	for {
		batch, err := r.st.EventsAfter(ctx, cursor, 1000)
		if err != nil || len(batch) == 0 {
			return
		}
		for _, ev := range batch {
			r.dispatch(ctx, ev)
		}
		cursor = batch[len(batch)-1].Seq
		if len(batch) < 1000 {
			return
		}
	}
}

// pump 实时分发循环
func (r *Registry) pump(ctx context.Context) {
	defer close(r.done)
	r.mu.Lock()
	ch := r.ch
	r.mu.Unlock()
	for {
		select {
		case <-ctx.Done():
			return
		case <-r.stop:
			return
		case ev := <-ch:
			r.dispatch(ctx, ev)
		}
	}
}

// Stats 消费者统计快照 (按名称排序)
func (r *Registry) Stats() []ConsumerStat {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]ConsumerStat, 0, len(r.stats))
	for _, s := range r.stats {
		cp := *s
		out = append(out, cp)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// Stop 停止分发并退订总线
func (r *Registry) Stop() {
	r.stopOnce.Do(func() { close(r.stop) })
	<-r.done
	r.mu.Lock()
	if r.subID != 0 {
		r.b.Unsubscribe(r.subID)
		r.subID = 0
	}
	r.mu.Unlock()
}

// dispatch 单事件分发到所有匹配消费者 (注册顺序; 错误只计数不中断)
func (r *Registry) dispatch(ctx context.Context, ev bus.Event) {
	r.mu.Lock()
	cons := make([]Consumer, len(r.consumers))
	copy(cons, r.consumers)
	r.mu.Unlock()

	now := time.Now().UnixMilli()
	for _, c := range cons {
		if !c.matchType(ev.Type) {
			continue
		}
		r.mu.Lock()
		st := r.stats[c.Name]
		r.mu.Unlock()
		if st == nil {
			continue
		}
		if err := c.Handle(ctx, ev); err != nil {
			r.mu.Lock()
			st.Failed++
			st.LastError = err.Error()
			st.LastAt = now
			r.mu.Unlock()
			continue
		}
		r.mu.Lock()
		st.Processed++
		st.LastAt = now
		r.mu.Unlock()
	}
}

// ── 默认 12 消费者 ───────────────────────────────────────────────

// DefaultConsumers 12 个消费者 (对齐 TS src/data/consumers/* 语义简化;
// p 为共享投影仓)
func DefaultConsumers(p *Projections) []Consumer {
	return []Consumer{
		consumerConsensusAudit(p),
		consumerCourtAdjudication(p),
		consumerGovernorShadow(p),
		consumerLawCompliance(p),
		consumerMigrationAudit(p),
		consumerReputationAnalytics(p),
		consumerSocialMemory(p),
		consumerSocietyCulture(p),
		consumerSocietyEvolution(p),
		consumerSocietyGovernance(p),
		consumerTelemetryAggregation(p),
		consumerEventLogAudit(p),
	}
}

// consumerConsensusAudit 1. 分布式共识账本沉淀
// (TS consensus-audit-consumer.ts: domain=ConsensusEngine →
// distributed_consensus_ledger)
func consumerConsensusAudit(p *Projections) Consumer {
	return Consumer{
		Name:       "consensus-audit",
		EventTypes: []string{EventTypeTransactionCommitted},
		Handle: func(ctx context.Context, ev bus.Event) error {
			tx, ok := ParseTx(ev)
			if !ok || tx.Domain != DomainConsensusEngine {
				return nil
			}
			p.Insert(TableConsensusLedger, map[string]any{
				"transaction_id":        tx.TxID,
				"replicated_log_index":  tx.Version, // 对齐 TS logIndex = version
				"kernel_version_seal":   tx.Version,
				"payload_snapshot_data": tx.Data,
				"synchronized_at":       time.Now().UnixMilli(),
			})
			return nil
		},
	}
}

// consumerCourtAdjudication 2. 司法账本沉淀
// (TS court-adjudication-consumer.ts: 一级仲裁庭 → primary_court_verdict,
// LLM 最高庭 → supreme_court_verdict)
func consumerCourtAdjudication(p *Projections) Consumer {
	return Consumer{
		Name:       "court-adjudication",
		EventTypes: []string{EventTypeTransactionCommitted},
		Handle: func(ctx context.Context, ev bus.Event) error {
			tx, ok := ParseTx(ev)
			if !ok {
				return nil
			}
			d := tx.DataMap()
			now := time.Now().UnixMilli()
			switch tx.Domain {
			case DomainConsensAgentCourt:
				// 对齐 TS: verdict_id / status_seal / winner_signature / metric_score
				p.Insert(TablePrimaryCourtVerdict, map[string]any{
					"transaction_id":    tx.TxID,
					"verdict_id":        dstr(d, "verdict_id"),
					"resolution_status": dstr(d, "status_seal"),
					"winning_agent":     dstr(d, "winner_signature"),
					"metric_score":      dnum(d, "metric_score"),
					"kernel_version":    tx.Version,
					"recorded_at":       now,
				})
			case DomainLlmSupremeEscalation:
				// 对齐 TS: supreme_verdict_id / ultimate_winner / evicted_loser /
				// semantic_rationale / confidence
				p.Insert(TableSupremeCourtVerdict, map[string]any{
					"transaction_id":     tx.TxID,
					"supreme_verdict_id": dstr(d, "supreme_verdict_id"),
					"ultimate_winner":    dstr(d, "ultimate_winner"),
					"evicted_loser":      dstr(d, "evicted_loser"),
					"semantic_rationale": dstr(d, "semantic_rationale"),
					"confidence_score":   dnum(d, "confidence"),
					"kernel_version":     tx.Version,
					"recorded_at":        now,
				})
			}
			return nil
		},
	}
}

// ppoActionCode PPO 动作编码 (对齐 TS governor-shadow-consumer.ts 的
// no_op=0 / spawn_agent=1 / pause_background=2 / switch_small_model=3 /
// reduce_context=4 / enable_gc=5)
func ppoActionCode(action string) int {
	switch action {
	case "spawn_agent":
		return 1
	case "pause_background":
		return 2
	case "switch_small_model":
		return 3
	case "reduce_context":
		return 4
	case "enable_gc":
		return 5
	default: // "no_op" 及未知值
		return 0
	}
}

// consumerGovernorShadow 3. 治理影子 (PPO 决策冷沉淀)
// (TS governor-shadow-consumer.ts: domain=AIRuntime 且 data.ppo_action 存在
// → governor_shadow_decision; rule_action 恒 0/'rule_fallback', winner='ppo')
func consumerGovernorShadow(p *Projections) Consumer {
	return Consumer{
		Name:       "governor-shadow",
		EventTypes: []string{EventTypeTransactionCommitted},
		Handle: func(ctx context.Context, ev bus.Event) error {
			tx, ok := ParseTx(ev)
			if !ok || tx.Domain != DomainAIRuntime {
				return nil
			}
			d := tx.DataMap()
			action := dstr(d, "ppo_action")
			if len(d) == 0 || action == "" {
				return nil // 对齐 TS: 跳过无 ppo_action 的载荷
			}
			confidence := dnum(d, "confidence")
			if confidence == 0 {
				confidence = 1.0 // 对齐 TS: data.confidence || 1.0
			}
			ts := int64(dnum(d, "committed_at"))
			if ts == 0 {
				ts = time.Now().UnixMilli() // 对齐 TS: data.committed_at || Date.now()
			}
			p.Insert(TableGovernorShadow, map[string]any{
				"id":                 fmt.Sprintf("shadow_%s_%d", tx.TxID, time.Now().UnixMilli()),
				"traceId":            dstr(d, "traceId"), // 对齐 TS: data.traceId || ''
				"telemetry_snapshot": dany(d, "telemetry_snapshot"),
				"rule_action":        0,
				"rule_action_name":   "rule_fallback",
				"ppo_action":         ppoActionCode(action),
				"ppo_action_name":    action,
				"ppo_prob":           dnum(d, "probability"),
				"ppo_value":          dany(d, "value"),
				"winner":             "ppo",
				"confidence":         confidence,
				"version":            tx.Version,
				"timestamp":          ts,
			})
			return nil
		},
	}
}

// consumerLawCompliance 4. 法律合规沉淀
// (TS law-compliance-consumer.ts: violation_id+law_name_seal → 违规记录;
//
//	execution_status='executed' → 执行台账)
func consumerLawCompliance(p *Projections) Consumer {
	return Consumer{
		Name:       "law-compliance",
		EventTypes: []string{EventTypeTransactionCommitted},
		Handle: func(ctx context.Context, ev bus.Event) error {
			tx, ok := ParseTx(ev)
			if !ok || tx.Domain != DomainLawEngine {
				return nil
			}
			d := tx.DataMap()
			now := time.Now().UnixMilli()
			if dstr(d, "violation_id") != "" && dstr(d, "law_name_seal") != "" {
				p.Insert(TableLawViolation, map[string]any{
					"transaction_id":      tx.TxID,
					"violation_id":        dstr(d, "violation_id"),
					"law_regime_name":     dstr(d, "law_name_seal"),
					"entity_id":           dstr(d, "target_entity"),
					"entity_type_string":  dstr(d, "target_type"),
					"evidence_seals":      dany(d, "evidence_fingerprints"),
					"kernel_version_seal": tx.Version,
					"logged_at":           now,
				})
				return nil
			}
			if dstr(d, "execution_status") == "executed" {
				p.Insert(TableLawExecution, map[string]any{
					"transaction_id":         tx.TxID,
					"violation_id":           dstr(d, "violation_id"),
					"authorizer_signature":   dstr(d, "executor_signature"),
					"penalty_mechanism":      dstr(d, "penalty_type"),
					"fined_credit_liquidity": dnum(d, "fine_amount"),
					"kernel_version_seal":    tx.Version,
					"enforced_at":            now,
				})
			}
			return nil
		},
	}
}

// consumerMigrationAudit 5. 沙箱迁移审计
// (TS migration-audit-consumer.ts: domain=SandboxMigration →
// sandbox_migration_history)
func consumerMigrationAudit(p *Projections) Consumer {
	return Consumer{
		Name:       "migration-audit",
		EventTypes: []string{EventTypeTransactionCommitted},
		Handle: func(ctx context.Context, ev bus.Event) error {
			tx, ok := ParseTx(ev)
			if !ok || tx.Domain != DomainSandboxMigration {
				return nil
			}
			d := tx.DataMap()
			p.Insert(TableMigrationHistory, map[string]any{
				"transaction_id":          tx.TxID,
				"migration_manifest_id":   dstr(d, "manifest_id"),
				"eviction_reason_code":    dstr(d, "eviction_code"),
				"memory_checksum_seal":    dstr(d, "serialized_state_checksum"),
				"relocated_isolate_bytes": dnum(d, "relocated_bytes"),
				"executed_at_clock_tick":  dnum(d, "clock_tick_marker"),
				"kernel_version_seal":     tx.Version,
				"persisted_at":            time.Now().UnixMilli(),
			})
			return nil
		},
	}
}

// consumerReputationAnalytics 6. 信誉分析沉淀
// (TS reputation-analytics-consumer.ts: recalibrated_score → 信誉历史;
//
//	points_deducted → 罚款执行足迹)
func consumerReputationAnalytics(p *Projections) Consumer {
	return Consumer{
		Name:       "reputation-analytics",
		EventTypes: []string{EventTypeTransactionCommitted},
		Handle: func(ctx context.Context, ev bus.Event) error {
			tx, ok := ParseTx(ev)
			if !ok || tx.Domain != DomainSocialReputation {
				return nil
			}
			d := tx.DataMap()
			now := time.Now().UnixMilli()
			if _, has := d["recalibrated_score"]; has { // 对齐 TS: !== undefined
				p.Insert(TableReputationHistory, map[string]any{
					"transaction_id":      tx.TxID,
					"reputation_id":       dstr(d, "reputation_block_id"),
					"target_entity_id":    dstr(d, "target_entity"),
					"consolidated_score":  dnum(d, "recalibrated_score"),
					"components_matrix":   dany(d, "components_snapshot"),
					"badges_held_count":   dnum(d, "badges_earned_count"),
					"kernel_version_seal": tx.Version,
					"calculated_at":       now,
				})
				return nil
			}
			if dnum(d, "points_deducted") != 0 { // 对齐 TS: data.points_deducted 真值
				p.Insert(TablePenaltyLevy, map[string]any{
					"transaction_id":        tx.TxID,
					"reputation_id":         dstr(d, "reputation_block_id"),
					"target_entity_id":      dstr(d, "target_entity"),
					"sanction_type_tag":     dstr(d, "sanction_type"),
					"deducted_points_value": dnum(d, "points_deducted"),
					"kernel_version_seal":   tx.Version,
					"levied_at":             now,
				})
			}
			return nil
		},
	}
}

// consumerSocialMemory 7. 集体社交记忆沉淀
// (TS social-memory-consumer.ts: domain=SocialMemory →
// collective_social_memory)
func consumerSocialMemory(p *Projections) Consumer {
	return Consumer{
		Name:       "social-memory",
		EventTypes: []string{EventTypeTransactionCommitted},
		Handle: func(ctx context.Context, ev bus.Event) error {
			tx, ok := ParseTx(ev)
			if !ok || tx.Domain != DomainSocialMemory {
				return nil
			}
			d := tx.DataMap()
			p.Insert(TableSocialMemory, map[string]any{
				"transaction_id":      tx.TxID,
				"memory_block_id":     dstr(d, "memory_id"),
				"event_log":           dstr(d, "event_description"),
				"extracted_tokens":    dany(d, "extracted_tokens"),
				"lessons_learned":     dany(d, "associated_lessons"),
				"active_participants": dany(d, "implicated_agents"),
				"kernel_version_seal": tx.Version,
				"metadata_extension":  dany(d, "serialized_metadata"),
				"settled_at":          time.Now().UnixMilli(), // 对齐 TS '沉淀_at'
			})
			return nil
		},
	}
}

// consumerSocietyCulture 8. 阵营与模因沉淀
// (TS society-culture-consumer.ts: faction_name → 联盟注册;
//
//	allocated_matrix → 分配台账; MemeticPropagation → 模因扩散史)
func consumerSocietyCulture(p *Projections) Consumer {
	return Consumer{
		Name:       "society-culture",
		EventTypes: []string{EventTypeTransactionCommitted},
		Handle: func(ctx context.Context, ev bus.Event) error {
			tx, ok := ParseTx(ev)
			if !ok {
				return nil
			}
			d := tx.DataMap()
			now := time.Now().UnixMilli()
			switch tx.Domain {
			case DomainCoalitionEngine:
				if dstr(d, "faction_name") != "" {
					p.Insert(TableCoalitionRegistry, map[string]any{
						"transaction_id": tx.TxID,
						"coalition_id":   dstr(d, "coalition_id"),
						"name":           dstr(d, "faction_name"),
						"members":        dany(d, "registered_members"),
						"resource_pool":  dany(d, "resource_pool"),
						"kernel_version": tx.Version,
						"created_at":     now,
					})
					return nil
				}
				if _, has := d["allocated_matrix"]; has {
					p.Insert(TableCoalitionPayoutLedger, map[string]any{
						"transaction_id":    tx.TxID,
						"coalition_id":      dstr(d, "coalition_id"),
						"payout_matrix":     dany(d, "allocated_matrix"),
						"total_distributed": dnum(d, "distributed_amount"),
						"kernel_version":    tx.Version,
						"distributed_at":    now,
					})
				}
			case DomainMemeticPropagation:
				p.Insert(TableMemeticHistory, map[string]any{
					"transaction_id":      tx.TxID,
					"target_cluster_id":   dstr(d, "target_cluster"),
					"meme_signature":      dstr(d, "meme_signature"),
					"historical_stance":   dany(d, "historical_stance"),
					"recalibrated_stance": dany(d, "recalibrated_stance"),
					"compliance_weight":   dany(d, "compliance_enforced"),
					"kernel_version":      tx.Version,
					"propagated_at":       now,
				})
			}
			return nil
		},
	}
}

// consumerSocietyEvolution 9. 演化与经济沉淀
// (TS society-evolution-consumer.ts: RoleEvolution → 政体史;
//
//	TokenEconomy → 经济台账; CoalitionEngine → 组建史 + 分配史)
func consumerSocietyEvolution(p *Projections) Consumer {
	return Consumer{
		Name:       "society-evolution",
		EventTypes: []string{EventTypeTransactionCommitted},
		Handle: func(ctx context.Context, ev bus.Event) error {
			tx, ok := ParseTx(ev)
			if !ok {
				return nil
			}
			d := tx.DataMap()
			now := time.Now().UnixMilli()
			switch tx.Domain {
			case DomainRoleEvolution:
				p.Insert(TableRegimeHistory, map[string]any{
					"transaction_id":  tx.TxID,
					"agent_id":        dstr(d, "agent_id"),
					"previous_regime": dstr(d, "old_regime"),
					"target_regime":   dstr(d, "new_regime"),
					"reputation_seal": dany(d, "reputation_snapshot"),
					"kernel_version":  tx.Version,
					"recorded_at":     now,
				})
			case DomainTokenEconomy:
				p.Insert(TableEconomicLedger, map[string]any{
					"transaction_id":       tx.TxID,
					"account_id":           dstr(d, "agent_id"),
					"allocated_bonus_mint": dnum(d, "allocated_bonus"),
					"consolidated_balance": dnum(d, "new_balance"),
					"tax_tier_factor":      dany(d, "tax_tier_snapshot"),
					"kernel_version":       tx.Version,
					"recorded_at":          now,
				})
			case DomainCoalitionEngine:
				// 对齐 TS: coalition_id 与 allocated_matrix 可同时落两张表
				if dstr(d, "coalition_id") != "" {
					p.Insert(TableCoalitionFormation, map[string]any{
						"transaction_id":     tx.TxID,
						"coalition_id":       dstr(d, "coalition_id"),
						"faction_name":       dstr(d, "faction_name"),
						"registered_members": dany(d, "registered_members"),
						"resource_pool":      dany(d, "resource_pool"),
						"kernel_version":     tx.Version,
						"recorded_at":        now,
					})
				}
				if _, has := d["allocated_matrix"]; has {
					p.Insert(TableCoalitionPayoutHistory, map[string]any{
						"transaction_id":     tx.TxID,
						"coalition_id":       dstr(d, "coalition_id"),
						"allocated_matrix":   dany(d, "allocated_matrix"),
						"distributed_amount": dnum(d, "distributed_amount"),
						"kernel_version":     tx.Version,
						"recorded_at":        now,
					})
				}
			}
			return nil
		},
	}
}

// consumerSocietyGovernance 10. 规范与治理沉淀
// (TS society-governance-consumer.ts: norm_name_seal → 制度注册;
//
//	assessment_id → 治理评估; triggered_action → 治理动作日志)
func consumerSocietyGovernance(p *Projections) Consumer {
	return Consumer{
		Name:       "society-governance",
		EventTypes: []string{EventTypeTransactionCommitted},
		Handle: func(ctx context.Context, ev bus.Event) error {
			tx, ok := ParseTx(ev)
			if !ok {
				return nil
			}
			d := tx.DataMap()
			now := time.Now().UnixMilli()
			switch tx.Domain {
			case DomainInstitutionEngine:
				if dstr(d, "norm_name_seal") == "" {
					return nil // 对齐 TS: 无 norm_name_seal 不落
				}
				p.Insert(TableInstitutionRegistry, map[string]any{
					"transaction_id": tx.TxID,
					"institution_id": dstr(d, "institution_id"),
					"norm_title":     dstr(d, "norm_name_seal"),
					"target_scope":   dstr(d, "scope_rank"),
					"priority_rank":  dnum(d, "priority_coefficient"),
					"kernel_version": tx.Version,
					"logged_at":      now,
				})
			case DomainGovernancePolicy:
				if dstr(d, "assessment_id") != "" {
					p.Insert(TableGovernanceAssessment, map[string]any{
						"transaction_id":    tx.TxID,
						"assessment_id":     dstr(d, "assessment_id"),
						"implicated_node":   dstr(d, "target_node"),
						"efficiency_index":  dnum(d, "calculated_efficiency"),
						"violation_tps":     dnum(d, "violation_tps_count"),
						"governance_status": dstr(d, "status_seal"),
						"recorded_tick":     dnum(d, "current_tick_stamp"),
						"kernel_version":    tx.Version,
						"assessed_at":       now,
					})
					return nil
				}
				if dstr(d, "triggered_action") != "" {
					p.Insert(TableGovernanceAction, map[string]any{
						"transaction_id":       tx.TxID,
						"associated_policy":    dstr(d, "policy_id"),
						"executed_action_type": dstr(d, "triggered_action"),
						"sanctioned_node":      dstr(d, "target_entity_node"),
						"triggered_tick":       dnum(d, "executed_at_tick"),
						"kernel_version":       tx.Version,
						"fired_at":             now,
					})
				}
			}
			return nil
		},
	}
}

// telemetry 指标键 (对齐 TS TelemetryMetricExporter 注册名)
const (
	MetricReputationSuccess    = "soloforge_reputation_success_total"
	MetricCoalitionFormed      = "soloforge_coalition_formed_total"
	MetricCourtEscalations     = "soloforge_court_llm_escalations_total"
	MetricCourtDecided         = "soloforge_court_arbitrations_decided"
	MetricLawViolations        = "soloforge_law_violations_intercepted"
	MetricSandboxMigrations    = "soloforge_sandbox_live_migrations_total"
	MetricClusterSystemEntropy = "soloforge_cluster_system_entropy"
)

// consumerTelemetryAggregation 11. 遥测聚合投影
// (TS telemetry-aggregation-consumer.ts: 按域路由计数 + 系统熵启发式;
// TS 还订阅 SnapshotCreated 统计 IPC 帧 — Go 侧进程内无 DistributedBroker,
// 该分支省略, 见报告差异说明)
func consumerTelemetryAggregation(p *Projections) Consumer {
	return Consumer{
		Name:       "telemetry-aggregation",
		EventTypes: []string{EventTypeTransactionCommitted}, // 全部 committed 事务
		Handle: func(ctx context.Context, ev bus.Event) error {
			tx, ok := ParseTx(ev)
			if !ok {
				return nil
			}
			d := tx.DataMap()

			// 1. 结构路由计数 (对齐 TS 按 domain 增量)
			switch tx.Domain {
			case DomainSocialReputation:
				p.incr(MetricReputationSuccess)
			case DomainCoalitionEngine:
				p.incr(MetricCoalitionFormed)
			case DomainConsensAgentCourt:
				// 升级/死锁 → escalations, 其余 → decided (对齐 TS status_seal 分支)
				seal := dstr(d, "status_seal")
				if seal == SealEscapeToLLM || seal == SealDeadlock {
					p.incr(MetricCourtEscalations)
				} else {
					p.incr(MetricCourtDecided)
				}
			case DomainLawEngine:
				p.incr(MetricLawViolations)
			case DomainSandboxMigration:
				p.incr(MetricSandboxMigrations)
			}

			// 2. 系统熵代理值 (对齐 TS 启发式: 默认 0.05;
			//    |1-metric_score|*权重封顶 1.0; 有 relocated_bytes → 0.75)
			entropy := 0.05
			if _, has := d["metric_score"]; has {
				entropy = abs1f(1.0-dnum(d, "metric_score")) * entropyWeight
				if entropy > 1.0 {
					entropy = 1.0
				}
			} else if _, has := d["relocated_bytes"]; has {
				entropy = 0.75
			}
			p.setEntropy(entropy)
			return nil
		},
	}
}

func abs1f(v float64) float64 {
	if v < 0 {
		return -v
	}
	return v
}

// consumerEventLogAudit 12. 事件审计链路 (protocol.md §6 计数的第 12 个
// consumer; 对齐 TS repositories/event-log-repository.ts: 全量事务 + 数据层
// 审计事件统一落 event_log, 幂等追加, 供 traceId 全链路追溯)
func consumerEventLogAudit(p *Projections) Consumer {
	return Consumer{
		Name: "event-log-audit",
		EventTypes: []string{
			EventTypeTransactionCommitted,
			EventTypeDeleteBlocked,
			EventTypeTrashSoftDeleted,
			EventTypeTrashRestored,
			EventTypeTrashPurged,
			EventTypeOutboxDeadLettered,
		},
		Handle: func(ctx context.Context, ev bus.Event) error {
			domain := ev.Source // 非事务事件的域 = 来源 (data)
			version := int64(0)
			traceID := ""
			if tx, ok := ParseTx(ev); ok {
				domain = tx.Domain
				version = tx.Version
				traceID = tx.TraceID
			}
			p.Insert(TableEventLog, map[string]any{
				"traceId":   traceID,
				"event":     ev.Type,
				"domain":    domain,
				"source":    ev.Source,
				"caller":    "data.consumer",
				"payload":   string(ev.Payload),
				"status":    "processed", // 同步分发完成即 processed (TS: pending/processed/failed)
				"version":   version,
				"seq":       ev.Seq,
				"timestamp": ev.TS,
			})
			return nil
		},
	}
}
