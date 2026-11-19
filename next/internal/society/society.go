// ─────────────────────────────────────────────────────────────────
// society — AI 社会层 (从 TS src/core/society/ 迁移)
//
// 覆盖 CommandBus 命令 (载荷语义对齐 docs/protocol.md §5):
//
//	CREATE_SOCIETY_INSTITUTION        创建制度        (institution.ts)
//	SOFT_DELETE_INSTITUTION           软删制度        (institution.ts)
//	PROPAGATE_LEGAL_MEME              法律模因传播    (culture.ts)
//	RECORD_SOCIAL_MEMORY              社会记忆记录    (social-memory.ts)
//	REGISTER_REPUTATION_ENTITY        注册信誉实体    (reputation.ts)
//	UPDATE_REPUTATION_SCORE           更新信誉分      (reputation.ts)
//	APPLY_REPUTATION_PENALTY          信誉惩罚        (reputation.ts)
//	FORM_COALITION                    组建联盟        (coalition.ts)
//	ALLOCATE_COALITION_PAYOUT         联盟分账        (coalition.ts)
//	EXECUTE_ROLE_EVOLUTION            角色演化        (role-evolution.ts)
//	ASSESS_GOVERNANCE_TARGET          治理评估        (governance.ts)
//	TRIGGER_GOVERNANCE_ACTION         治理动作        (governance.ts)
//	DISTRIBUTE_ROLE_ALLOCATION_REWARD 角色报酬        (旧 Economy 域, 新架构并入 society)
//	DRIFT_EXPERIMENT_START / DRIFT_STEP / DRIFT_GET_SUMMARY (hyperparameter-drift.service.ts)
//
// 级联关系保持 (对齐旧系统):
//
//	ALLOCATE_COALITION_PAYOUT → 逐成员 DISTRIBUTE_ROLE_ALLOCATION_REWARD
//	EXECUTE_ROLE_EVOLUTION    → DISTRIBUTE_ROLE_ALLOCATION_REWARD
//	级联经 CommandBus 派发 (cb 由 RegisterCommands 注入); 未注入时退化为直调
//
// 事件名对齐 docs/protocol.md §6:
//
//	society.agent.role.evolved / governance.intervention.applied /
//	drift.governance_intervention 为协议清单原名;
//	其余按 society.<域>.<动作> 点分风格命名 (对齐 law.violation.recorded 风格)
//
// ReputationTarget 由 agents.Pool 实现 — society 包不依赖 agents 包 (依赖倒置)
// 存储为进程内 map (无 SQLite, 重启清零 — 用户决策)
//
// 与旧版主要差异 (其余逐条见各文件注释):
//   - 旧 kernel 事务管理器/乐观锁 → 单互斥锁串行化 (等价临界区)
//   - 旧 configCenter 动态配置 → 同名默认值固化为常量
//   - 旧 DISTRIBUTE_ROLE_ALLOCATION_REWARD 落 Economy 代币 → 折算为
//     agent 池信誉增量 (rewardScale 可调) + 报酬台账
//
// ─────────────────────────────────────────────────────────────────
package society

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"soloforge/next/internal/bus"
	"soloforge/next/internal/store"
)

// ReputationTarget 信誉调整目标接口 (由 agents.Pool 实现, 避免包依赖)
// 对齐 internal/law/law.go 的同名模式; 联盟分账/角色演化的报酬级联
// 最终落到 agent 池信誉值上 (旧系统落到 Economy 代币)
type ReputationTarget interface {
	AdjustReputation(agentID string, delta float64) error
}

// Service 社会域聚合服务: 制度/记忆/文化/信誉/联盟/角色/治理/漂移
// 单一互斥锁保护全部内存 map (对齐 court.Service 风格)
type Service struct {
	store  *store.Store
	bus    *bus.EventBus
	target ReputationTarget // 可空: 报酬级联的目标信誉接口
	cb     *bus.CommandBus  // RegisterCommands 注入, 供级联命令经总线派发

	mu                  sync.Mutex
	institutions        map[string]*Institution      // 制度
	lockedTypes         map[string]bool              // 删除保护: 被锁定的实体类型
	memories            map[string]*SocialMemory     // 社会记忆
	keywordIndex        map[string]map[string]bool   // 关键词 → 记忆ID集合 (倒排索引)
	memes               map[string]*MemeticVector    // 活跃法律模因
	clusterStance       map[string]float64           // 集群意识形态立场
	reputations         map[string]*SocialReputation // 信誉, key: "type:id"
	coalitions          map[string]*Coalition        // 联盟
	agentToCoalition    map[string]string            // agentId → 联盟ID
	roles               map[string]string            // agentId → 当前角色
	rewards             map[string]float64           // agentId → 累计报酬台账
	policies            map[string]*GovernancePolicy
	assessments         map[string]*GovernanceAssessment
	interventions       map[string]*InterventionParams
	globalEffectiveness float64
	governanceMode      string

	drift driftState // 漂移实验状态

	tick        atomic.Int64 // 逻辑时钟 (替代旧 kernel.currentTick)
	idSeq       atomic.Int64 // 进程内 ID 序列
	rewardScale float64      // 报酬因子 → 信誉增量放大系数 (默认 10)
}

// New 构造社会域服务; target 可为 nil (报酬只记台账不落 agent 池)
func New(st *store.Store, b *bus.EventBus, target ReputationTarget) *Service {
	s := &Service{
		store:               st,
		bus:                 b,
		target:              target,
		institutions:        make(map[string]*Institution),
		lockedTypes:         make(map[string]bool),
		memories:            make(map[string]*SocialMemory),
		keywordIndex:        make(map[string]map[string]bool),
		memes:               make(map[string]*MemeticVector),
		clusterStance:       make(map[string]float64),
		reputations:         make(map[string]*SocialReputation),
		coalitions:          make(map[string]*Coalition),
		agentToCoalition:    make(map[string]string),
		roles:               make(map[string]string),
		rewards:             make(map[string]float64),
		policies:            make(map[string]*GovernancePolicy),
		assessments:         make(map[string]*GovernanceAssessment),
		interventions:       make(map[string]*InterventionParams),
		globalEffectiveness: 1.0,
		governanceMode:      GovernanceModeBalanced,
		rewardScale:         10.0,
	}
	s.seedDefaultInstitutions() // 对齐 TS initializeDefaultConstitutionalNorms
	s.seedDefaultPolicies()     // 对齐 TS initializeDefaultSystemPolicies
	return s
}

// RegisterCommands 注册全部社会域命令到 CommandBus。
// svc 为变参: 常规传入一个聚合 Service; 命令名全局唯一, 若传入多个实例,
// 后注册者覆盖先注册者 (对齐旧 kernel.commandBus.registerHandler 语义)。
func RegisterCommands(cb *bus.CommandBus, svc ...*Service) {
	for _, s := range svc {
		s.cb = cb // 注入命令总线, 供级联派发 (联盟分账/角色演化 → 报酬)
		s.registerCommands(cb)
	}
}

// registerCommands 命令 → 服务方法的载荷解码适配层 (payload 按 protocol.md §5)
func (s *Service) registerCommands(cb *bus.CommandBus) {
	// ── 制度 ──
	cb.Register("CREATE_SOCIETY_INSTITUTION", func(ctx context.Context, payload json.RawMessage) (any, error) {
		var p struct {
			TraceID     string         `json:"traceId"`
			Name        string         `json:"name"`
			Description string         `json:"description"`
			Rules       []string       `json:"rules"`
			Scope       string         `json:"scope"`
			Enforcement string         `json:"enforcement"`
			Priority    float64        `json:"priority"`
			Metadata    map[string]any `json:"metadata"`
		}
		if err := json.Unmarshal(payload, &p); err != nil {
			return nil, err
		}
		return s.CreateInstitution(ctx, p.TraceID, p.Name, p.Description, p.Rules, p.Scope, p.Enforcement, p.Priority, p.Metadata)
	})

	cb.Register("SOFT_DELETE_INSTITUTION", func(ctx context.Context, payload json.RawMessage) (any, error) {
		var p struct {
			TraceID       string `json:"traceId"`
			InstitutionID string `json:"institutionId"`
		}
		if err := json.Unmarshal(payload, &p); err != nil {
			return nil, err
		}
		return s.SoftDeleteInstitution(ctx, p.TraceID, p.InstitutionID), nil
	})

	// ── 文化 ──
	cb.Register("PROPAGATE_LEGAL_MEME", func(ctx context.Context, payload json.RawMessage) (any, error) {
		var p struct {
			TraceID              string  `json:"traceId"`
			TargetClusterID      string  `json:"targetClusterId"`
			SourceMemeID         string  `json:"sourceMemeId"`
			EnvironmentalEntropy float64 `json:"environmentalEntropy"`
		}
		if err := json.Unmarshal(payload, &p); err != nil {
			return nil, err
		}
		return s.PropagateMeme(ctx, p.TraceID, p.TargetClusterID, p.SourceMemeID, p.EnvironmentalEntropy)
	})

	// ── 社会记忆 ──
	cb.Register("RECORD_SOCIAL_MEMORY", func(ctx context.Context, payload json.RawMessage) (any, error) {
		var p struct {
			TraceID      string         `json:"traceId"`
			Event        string         `json:"event"`
			Impact       string         `json:"impact"`
			Severity     string         `json:"severity"`
			Participants []string       `json:"participants"`
			Lessons      []string       `json:"lessons"`
			Metadata     map[string]any `json:"metadata"`
		}
		if err := json.Unmarshal(payload, &p); err != nil {
			return nil, err
		}
		return s.RecordMemory(ctx, p.TraceID, p.Event, p.Impact, p.Severity, p.Participants, p.Lessons, p.Metadata)
	})

	// ── 信誉 ──
	cb.Register("REGISTER_REPUTATION_ENTITY", func(ctx context.Context, payload json.RawMessage) (any, error) {
		var p struct {
			TraceID    string `json:"traceId"`
			EntityID   string `json:"entityId"`
			EntityType string `json:"entityType"`
		}
		if err := json.Unmarshal(payload, &p); err != nil {
			return nil, err
		}
		return s.RegisterReputationEntity(ctx, p.TraceID, p.EntityID, p.EntityType), nil
	})

	cb.Register("UPDATE_REPUTATION_SCORE", func(ctx context.Context, payload json.RawMessage) (any, error) {
		var p struct {
			TraceID    string          `json:"traceId"`
			EntityID   string          `json:"entityId"`
			EntityType string          `json:"entityType"`
			Components ComponentUpdate `json:"components"`
			Evidence   string          `json:"evidence"`
		}
		if err := json.Unmarshal(payload, &p); err != nil {
			return nil, err
		}
		return s.UpdateReputationScore(ctx, p.TraceID, p.EntityID, p.EntityType, p.Components, p.Evidence), nil
	})

	cb.Register("APPLY_REPUTATION_PENALTY", func(ctx context.Context, payload json.RawMessage) (any, error) {
		var p struct {
			TraceID    string      `json:"traceId"`
			EntityID   string      `json:"entityId"`
			EntityType string      `json:"entityType"`
			Penalty    PenaltySpec `json:"penalty"`
		}
		if err := json.Unmarshal(payload, &p); err != nil {
			return nil, err
		}
		return s.ApplyReputationPenalty(ctx, p.TraceID, p.EntityID, p.EntityType, p.Penalty), nil
	})

	// ── 联盟 ──
	cb.Register("FORM_COALITION", func(ctx context.Context, payload json.RawMessage) (any, error) {
		var p struct {
			TraceID          string   `json:"traceId"`
			CoalitionName    string   `json:"coalitionName"`
			InitialMembers   []string `json:"initialMembers"`
			InitialResources float64  `json:"initialResources"`
		}
		if err := json.Unmarshal(payload, &p); err != nil {
			return nil, err
		}
		return s.FormCoalition(ctx, p.TraceID, p.CoalitionName, p.InitialMembers, p.InitialResources)
	})

	cb.Register("ALLOCATE_COALITION_PAYOUT", func(ctx context.Context, payload json.RawMessage) (any, error) {
		var p struct {
			TraceID            string             `json:"traceId"`
			CoalitionID        string             `json:"coalitionId"`
			TotalPayoutPool    float64            `json:"totalPayoutPool"`
			ReputationSnapshot map[string]float64 `json:"reputationSnapshot"`
		}
		if err := json.Unmarshal(payload, &p); err != nil {
			return nil, err
		}
		return s.AllocateCoalitionPayout(ctx, p.TraceID, p.CoalitionID, p.TotalPayoutPool, p.ReputationSnapshot)
	})

	// ── 角色演化 ──
	cb.Register("EXECUTE_ROLE_EVOLUTION", func(ctx context.Context, payload json.RawMessage) (any, error) {
		var p struct {
			TraceID           string  `json:"traceId"`
			AgentID           string  `json:"agentId"`
			CurrentReputation float64 `json:"currentReputation"`
			PreviousRole      string  `json:"previousRole"`
			TickID            int64   `json:"tickId"`
		}
		if err := json.Unmarshal(payload, &p); err != nil {
			return nil, err
		}
		return s.ExecuteRoleEvolution(ctx, p.TraceID, p.AgentID, p.CurrentReputation, p.PreviousRole, p.TickID)
	})

	// ── 治理 ──
	cb.Register("ASSESS_GOVERNANCE_TARGET", func(ctx context.Context, payload json.RawMessage) (any, error) {
		var p struct {
			TraceID       string  `json:"traceId"`
			TargetID      string  `json:"targetId"`
			TargetType    string  `json:"targetType"`
			Effectiveness float64 `json:"effectiveness"`
			Violations    int64   `json:"violations"`
			Notes         string  `json:"notes"`
		}
		if err := json.Unmarshal(payload, &p); err != nil {
			return nil, err
		}
		return s.AssessGovernanceTarget(ctx, p.TraceID, p.TargetID, p.TargetType, p.Effectiveness, p.Violations, p.Notes)
	})

	cb.Register("TRIGGER_GOVERNANCE_ACTION", func(ctx context.Context, payload json.RawMessage) (any, error) {
		var p struct {
			TraceID     string `json:"traceId"`
			PolicyID    string `json:"policyId"`
			TriggerType string `json:"triggerType"`
			TargetID    string `json:"targetId"`
		}
		if err := json.Unmarshal(payload, &p); err != nil {
			return nil, err
		}
		return s.TriggerGovernanceAction(ctx, p.TraceID, p.PolicyID, p.TriggerType, p.TargetID)
	})

	// ── 角色报酬 (级联终点, 旧 Economy 域) ──
	cb.Register("DISTRIBUTE_ROLE_ALLOCATION_REWARD", func(ctx context.Context, payload json.RawMessage) (any, error) {
		var p struct {
			TraceID               string  `json:"traceId"`
			AgentID               string  `json:"agentId"`
			TargetRole            string  `json:"targetRole"`
			AllocationBonusFactor float64 `json:"allocationBonusFactor"`
			TickID                int64   `json:"tickId"`
		}
		if err := json.Unmarshal(payload, &p); err != nil {
			return nil, err
		}
		return s.DistributeRoleAllocationReward(ctx, p.TraceID, p.AgentID, p.TargetRole, p.AllocationBonusFactor, p.TickID), nil
	})

	// ── 超参漂移 ──
	cb.Register("DRIFT_EXPERIMENT_START", func(ctx context.Context, payload json.RawMessage) (any, error) {
		var p struct {
			TraceID   string `json:"traceId"`
			DriftType string `json:"driftType"`
		}
		if err := json.Unmarshal(payload, &p); err != nil {
			return nil, err
		}
		return s.StartDriftExperiment(ctx, p.TraceID, p.DriftType), nil
	})

	cb.Register("DRIFT_STEP", func(ctx context.Context, payload json.RawMessage) (any, error) {
		var p struct {
			TraceID          string          `json:"traceId"`
			Performance      float64         `json:"performance"`
			GovernanceSignal json.RawMessage `json:"governanceSignal"` // bool 或数值
			DriftType        string          `json:"driftType"`
		}
		if err := json.Unmarshal(payload, &p); err != nil {
			return nil, err
		}
		return s.DriftStep(ctx, p.TraceID, p.Performance, truthy(p.GovernanceSignal), p.DriftType), nil
	})

	cb.Register("DRIFT_GET_SUMMARY", func(_ context.Context, _ json.RawMessage) (any, error) {
		return s.DriftSummary(), nil
	})
}

// ── 内部工具 ────────────────────────────────────────────────────

// emit 先落"库"后广播 (对齐 internal/court/court.go 纪律)
func (s *Service) emit(ctx context.Context, typ string, payload map[string]any) {
	raw, _ := json.Marshal(payload)
	if ev, err := s.store.AppendEvent(ctx, typ, "society", raw); err == nil {
		s.bus.Publish(ev)
	}
}

// newID 生成 "前缀_毫秒_序号" 形式的进程内唯一 ID (替代 TS 的 ulid/uuid)
func (s *Service) newID(prefix string) string {
	return fmt.Sprintf("%s_%d_%d", prefix, time.Now().UnixMilli(), s.idSeq.Add(1))
}

// AdvanceTick 推进逻辑时钟 (替代旧 kernel.currentTick; 由运行时每 tick 调用)
func (s *Service) AdvanceTick() int64 { return s.tick.Add(1) }

// CurrentTick 当前逻辑时钟
func (s *Service) CurrentTick() int64 { return s.tick.Load() }

// SetRewardScale 调整报酬放大系数 (默认 10; 旧系统报酬落 Economy 代币, 新架构折算为信誉增量)
func (s *Service) SetRewardScale(scale float64) {
	s.mu.Lock()
	s.rewardScale = scale
	s.mu.Unlock()
}

// roundTo 四舍五入到指定位小数 (对齐 TS parseFloat(x.toFixed(n)))
func roundTo(x float64, digits int) float64 {
	shift := math.Pow(10, float64(digits))
	return math.Round(x*shift) / shift
}

// truthy 宽松布尔解析 (治理信号可能是 bool 或数值, 对齐 TS 的 any 载荷)
func truthy(v json.RawMessage) bool {
	t := strings.TrimSpace(string(v))
	switch t {
	case "", "null", "false":
		return false
	case "true":
		return true
	}
	if f, err := strconv.ParseFloat(t, 64); err == nil {
		return f > 0.5
	}
	return false
}

// containsStr 切片包含判断
func containsStr(list []string, target string) bool {
	for _, v := range list {
		if v == target {
			return true
		}
	}
	return false
}
