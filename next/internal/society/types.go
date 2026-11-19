// ─────────────────────────────────────────────────────────────────
// types — 社会域领域类型 (语义对齐 TS src/core/society/*.ts)
// ─────────────────────────────────────────────────────────────────
package society

import "time"

// ── 制度 (institution.ts) ───────────────────────────────────────

// Institution 社会制度 (宪法规范)
type Institution struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Rules       []string  `json:"rules"`
	Scope       string    `json:"scope"`       // global | cluster | agent
	Enforcement string    `json:"enforcement"` // strict | advisory
	Priority    float64   `json:"priority"`
	Status      string    `json:"status"` // active | deleted
	CreatedAt   int64     `json:"createdAt"`
	DeletedAt   int64     `json:"deletedAt,omitempty"`
}

// ── 社会记忆 (social-memory.ts) ─────────────────────────────────

// SocialMemory 社会记忆条目 (关键词倒排索引可检索)
type SocialMemory struct {
	ID           string         `json:"id"`
	Event        string         `json:"event"`
	Impact       string         `json:"impact"`    // positive | negative | neutral
	Severity     string         `json:"severity"`  // low | medium | high | critical
	Participants []string       `json:"participants"`
	Lessons      []string       `json:"lessons"`
	Keywords     []string       `json:"keywords"`  // 倒排索引分词结果
	Metadata     map[string]any `json:"metadata"`
	Importance   float64        `json:"importance"` // severity 映射 0..1
	CreatedAt    int64          `json:"createdAt"`
}

var severityImportance = map[string]float64{
	"low": 0.25, "medium": 0.5, "high": 0.75, "critical": 1.0,
}

// ── 文化模因 (culture.ts) ───────────────────────────────────────

// MemeticVector 法律模因 (在集群间传播的规范向量)
type MemeticVector struct {
	ID                string  `json:"id"`
	Content           string  `json:"content"`
	OriginClusterID   string  `json:"originClusterId"`
	Stance            float64 `json:"stance"`        // 集群意识形态立场 -1..1
	Strength          float64 `json:"strength"`      // 传播强度 0..1
	SpreadCount       int     `json:"spreadCount"`   // 传播次数
	LastPropagatedAt  int64   `json:"lastPropagatedAt"`
	CreatedAt         int64   `json:"createdAt"`
}

// ── 社会信誉 (reputation.ts) ────────────────────────────────────

// ComponentUpdate 信誉构成更新载荷 (对齐 TS reputation components)
type ComponentUpdate struct {
	Quality       float64 `json:"quality"`
	Reliability   float64 `json:"reliability"`
	Collaboration float64 `json:"collaboration"`
}

// SocialReputation 社会域信誉实体 (key: "type:id", 独立于 agent 池信誉)
type SocialReputation struct {
	EntityID    string          `json:"entityId"`
	EntityType  string          `json:"entityType"` // agent | coalition | cluster
	Score       float64         `json:"score"`      // 0..100
	Components  ComponentUpdate `json:"components"`
	History     []string        `json:"history"` // 证据流水
	UpdatedAt   int64           `json:"updatedAt"`
}

// PenaltySpec 惩罚载荷 (APPLY_REPUTATION_PENALTY)
type PenaltySpec struct {
	Amount float64 `json:"amount"` // 0..100
	Reason string  `json:"reason"`
}

// ── 联盟 (coalition.ts) ─────────────────────────────────────────

// Coalition 联盟
type Coalition struct {
	ID            string             `json:"id"`
	Name          string             `json:"name"`
	Members       []string           `json:"members"`
	Resources     float64            `json:"resources"`
	PayoutHistory []PayoutRecord     `json:"payoutHistory"`
	Status        string             `json:"status"` // active | dissolved
	CreatedAt     int64              `json:"createdAt"`
}

// PayoutRecord 分账记录 (级联 DISTRIBUTE_ROLE_ALLOCATION_REWARD 的台账)
type PayoutRecord struct {
	TraceID   string             `json:"traceId"`
	TotalPool float64            `json:"totalPool"`
	Shares    map[string]float64 `json:"shares"` // member → 分得份额
	At        int64              `json:"at"`
}

// ── 治理 (governance.ts) ────────────────────────────────────────

// GovernanceAction 治理动作定义
type GovernanceAction struct {
	Type      string  `json:"type"`      // patch_apply | restrict | audit ...
	Threshold float64 `json:"threshold"` // 触发阈值 (如越权次数)
}

// GovernancePolicy 治理策略 (默认种子: policy_sec_control)
type GovernancePolicy struct {
	ID          string             `json:"id"`
	PolicyID    string             `json:"policyId"`
	Owner       string             `json:"owner"` // SecurityPatchAgent ...
	Description string             `json:"description"`
	Actions     []GovernanceAction `json:"actions"`
	Priority    int                `json:"priority"`
	CreatedAt   int64              `json:"createdAt"`
}

// GovernanceAssessment 治理评估结果 (ASSESS_GOVERNANCE_TARGET 产物)
type GovernanceAssessment struct {
	ID            string  `json:"id"`
	TraceID       string  `json:"traceId"`
	TargetID      string  `json:"targetId"`
	TargetType    string  `json:"targetType"`
	Effectiveness float64 `json:"effectiveness"`
	Violations    int64   `json:"violations"`
	Notes         string  `json:"notes"`
	Verdict       string  `json:"verdict"` // healthy | watch | intervene
	CreatedAt     int64   `json:"createdAt"`
}

// InterventionParams 已应用的治理干预 (governance.intervention.applied 载荷)
type InterventionParams struct {
	PolicyID  string `json:"policyId"`
	TargetID  string `json:"targetId"`
	Action    string `json:"action"`
	TriggerType string `json:"triggerType"`
	AppliedAt int64  `json:"appliedAt"`
}

// ── 角色阶梯 (role-evolution.ts) ────────────────────────────────

// 角色演化阈值 (对齐 TS configCenter 默认值)
const (
	RoleValidatorThreshold = 70.0 // society.evolution.validator_threshold
	RoleGovernorThreshold  = 95.0 // society.evolution.governor_threshold
)

// 角色阶梯 (信誉 → 角色)
const (
	RoleWorker    = "worker"
	RoleValidator = "validator"
	RoleGovernor  = "governor"
)

// GovernanceModeBalanced 默认治理模式 (对齐 TS governanceMode 默认值)
const GovernanceModeBalanced = "balanced"

// PRIVILEGED_AGENT_THRESHOLD 越权尝试阈值 (对齐 TS governance.ts:73)
const PRIVILEGED_AGENT_THRESHOLD = 20

// ── 超参漂移 (hyperparameter-drift.service.ts) ──────────────────

// driftState 漂移实验状态
type driftState struct {
	active      bool
	driftType   string  // momentum (默认)
	baseline    float64 // 基线性能
	current     float64 // 当前漂移后参数
	steps       int64
	signals     int64 // 治理信号次数
	startedAt   int64
	lastResult  map[string]any
}

// DriftSummary 漂移摘要 (DRIFT_GET_SUMMARY 响应)
type DriftSummary struct {
	Active    bool           `json:"active"`
	DriftType string         `json:"driftType"`
	Steps     int64          `json:"steps"`
	Signals   int64          `json:"signals"`
	Baseline  float64        `json:"baseline"`
	Current   float64        `json:"current"`
	Last      map[string]any `json:"last,omitempty"`
}

var _ = time.Now // 保留 time 引用 (扩展用)
