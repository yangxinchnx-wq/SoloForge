// ─────────────────────────────────────────────────────────────────
// evolution — Agent 进化/训练语义 (从 TS src/core/agent/evolution/ 目录迁移:
// training-scheduler.ts + auto-training-trigger.ts + experience-cache.ts +
// skill-library.ts, 共 4 文件 1104 行)
//
// 语义对齐 (docs/protocol.md §3 DistributedBroker 8765 ↔ Python MARL):
//   - AGENT_TRAINING_DATA 帧 {frameId:'train-<agentId>-<ts>', agentId, reason,
//     payload:{trainingData}} → AGENT_TRAINING_ACK {accepted, trained_this_call,
//     loss, checkpoint_written} (5s 超时)  [training-scheduler.ts:257-289]
//   - POLICY_QUERY/POLICY_ANSWER {action, confidence, source} (1s 超时回退
//     action=0) [training-scheduler.ts:347-375]
//   - 训练样本字段对齐 AgentObservation.to_array() 的 10 维观测 +
//     trainer.train_step() 的 (obs, action, log_prob, reward, value, done,
//     kernel_version)
//
// 组件构成 (对齐 TS 四文件):
//   - TrainingScheduler    全局训练调度器: 轨迹 → 训练队列 (单飞) → MARL
//     提交 + ACK; 策略查询; 轨迹 → 技能库兜底提炼
//   - AutoTrainingTrigger  每 Agent 训练触发器: 批量满触发 / 成功率骤降紧急触发
//   - SkillLibrary         技能库: 工具组合模式 / 策略偏好, 置信度衰减
//   - ExperienceCache      经验缓存: 问题指纹 (归一化 sha256 前 16) 精确/模糊
//     匹配, 复用衰减, 差评淘汰
//   - EvolutionPipeline    进化管线门面: 信誉阈值触发训练 (Go 扩展) / 经验
//     积累 / policy checkpoint 记账 + 决策层回调
//
// 与 TS 版差异:
//   - TS EventEmitter('training_triggered') → Go 回调 SetHandler;
//     TS 单例 getInstance → Go 显式构造注入 (对齐 next 包风格, 无全局单例)
//   - TS POLICY_QUERY 为 8765 裸 TCP §3 帧; Go 侧经 marl.Client (§4
//     ShadowGovernorClient 协议, id 关联) 承载, 语义等价 (obs → action),
//     外层 1s 守卫对齐 TS 超时; 训练提交仍走 §3 原始帧
//   - 训练队列 TS setTimeout(processQueue, 1000) → Go 后台 pump goroutine
//     (相邻任务间隔 1s 对齐); pump 使用独立 background context, 不随调用方
//     请求取消
//   - TS ExperienceCache JSONL 落盘 (2s 防抖) → Go 进程内 (对齐 store 包
//     "存储全部进程内化"决策, 重启清零)
//   - 技能 ID 随机后缀 → 时间戳+序号 (确定性生成)
//   - 归一化字符类 \s 细微差异 (JS 含 unicode 空白, Go 为 ASCII); 指纹仅在
//     Go 侧自洽使用, 不跨系统共享
//   - POLICY_ANSWER 的 fallback_error 源: marl.Client 内部跳过非 JSON 行,
//     Go 侧查询失败统一回退 fallback (常量保留对齐 TS 枚举)
//   - 信誉阈值触发训练 (reason=reputation_drop) 为 Go 扩展: 订阅
//     agent.reputation.updated 事件, 聚合分低于阈值时排空触发器缓冲送训
//   - TS logger → 事件先落库后广播 (emit 纪律, 对齐 court.go), 事件名
//     protocol.md 未定义, 为 Go 侧扩展 (agent.training.* / agent.policy.* /
//     agent.experience.*)
//
// ─────────────────────────────────────────────────────────────────
package agents

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"soloforge/next/internal/bus"
	"soloforge/next/internal/marl"
	"soloforge/next/internal/store"
)

// ── 帧类型 (protocol.md §3, 对齐 TS) ─────────────────────────────

const (
	FrameTypeTrainingData = "AGENT_TRAINING_DATA" // Node→Py 训练 trace 提交
	FrameTypeTrainingAck  = "AGENT_TRAINING_ACK"  // Py→Node 训练 ACK (5s 超时)
	FrameTypePolicyQuery  = "POLICY_QUERY"        // Node→Py 策略查询
	FrameTypePolicyAnswer = "POLICY_ANSWER"       // Py→Node 策略答复 (1s 超时)
)

// ── 超时/间隔参数 (对齐 TS training-scheduler.ts) ────────────────

const (
	trainingAckTimeout  = 5 * time.Second // AGENT_TRAINING_ACK 等待超时 (TS 5000ms)
	policyQueryTimeout  = 1 * time.Second // POLICY_QUERY 超时回退 (TS 1000ms)
	trainingJobInterval = 1 * time.Second // 相邻训练任务的出队间隔 (TS setTimeout 1000)
	defaultMARLAddr     = "127.0.0.1:8765"
)

// ── 训练原因 (TS reason: 'batch_ready' | 'emergency'; reputation_drop 为 Go 扩展) ──

const (
	TrainingReasonBatchReady = "batch_ready"     // 轨迹积累够 batch_size
	TrainingReasonEmergency  = "emergency"       // 成功率骤降紧急训练
	TrainingReasonReputation = "reputation_drop" // Go 扩展: 信誉低于阈值
)

// ── 策略决策来源 (对齐 TS queryTrainedPolicy 的 source 枚举) ─────

const (
	PolicySourceTrained       = "trained_policy" // MARL 训练策略答复
	PolicySourceFallback      = "fallback"       // 超时/连接失败 → 启发式 (action=0)
	PolicySourceFallbackError = "fallback_error" // 响应解析失败 (见头部差异说明)
	PolicySourceNoTrainer     = "no_trainer"     // 未注入训练客户端
)

// ── 进化事件名 (protocol.md 未定义, Go 侧扩展; 命名对齐 agent.* 风格) ──

const (
	EventTrainingTriggered     = "agent.training.triggered"     // 训练任务入队
	EventTrainingCompleted     = "agent.training.completed"     // 训练 ACK 终态
	EventPolicyUpdated         = "agent.policy.updated"         // 策略 checkpoint 更新
	EventExperienceRecorded    = "agent.experience.recorded"    // 经验首次入库
	EventExperienceInvalidated = "agent.experience.invalidated" // 经验差评失效删除
)

// 信誉阈值触发参数 (Go 扩展; 信誉刻度 0..100, 对齐 reputation.go)
const (
	evolutionReputationThreshold = 40                         // 聚合分低于此值触发训练
	evolutionRepCooldownMs       = 5 * 60 * 1000              // 信誉触发冷却 5 分钟 (对齐 TS cooldownMs)
	reputationEventName          = "agent.reputation.updated" // reputation.go 广播的事件名
)

// ════════════════════════════════════════════════════════════════
// 执行轨迹 (对齐 TS ExecutionTrace, 10 维观测与 agent_env.py 对齐)
// ════════════════════════════════════════════════════════════════

// TraceObservation 10 维观测 (字段序对齐 AgentObservation.to_array())
type TraceObservation struct {
	TaskComplexity         float64 `json:"taskComplexity"`         // 任务复杂度
	TaskDomainMatch        float64 `json:"taskDomainMatch"`        // 任务领域匹配度
	TaskCodeLines          float64 `json:"taskCodeLines"`          // 任务代码行数
	TaskRequiresTools      float64 `json:"taskRequiresTools"`      // 是否需要工具
	AgentSkillCount        float64 `json:"agentSkillCount"`        // Agent 技能数
	AgentSuccessRate       float64 `json:"agentSuccessRate"`       // Agent 历史成功率
	AgentCurrentRound      float64 `json:"agentCurrentRound"`      // 当前轮次
	AgentToolErrorRate     float64 `json:"agentToolErrorRate"`     // 工具错误率
	ContextHasExistingCode float64 `json:"contextHasExistingCode"` // 上下文已有代码
	ContextFileCount       float64 `json:"contextFileCount"`       // 上下文文件数
}

// Array 展开为 10 维向量 (序对齐 TS observation 数组构造)
func (o TraceObservation) Array() []float64 {
	return []float64{
		o.TaskComplexity, o.TaskDomainMatch, o.TaskCodeLines, o.TaskRequiresTools,
		o.AgentSkillCount, o.AgentSuccessRate, o.AgentCurrentRound, o.AgentToolErrorRate,
		o.ContextHasExistingCode, o.ContextFileCount,
	}
}

// ExecutionTrace 单条执行轨迹 (每次 Agent 执行完任务后记录)
type ExecutionTrace struct {
	AgentID       string           `json:"agentId"`
	TaskID        string           `json:"taskId"`
	Timestamp     int64            `json:"timestamp"`
	Observation   TraceObservation `json:"observation"` // 10 维观测
	ToolsUsed     []string         `json:"toolsUsed"`   // 动作记录: 使用的工具
	StrategyUsed  string           `json:"strategyUsed"`
	Success       bool             `json:"success"`
	DurationMs    int64            `json:"durationMs"`
	ToolCallCount int              `json:"toolCallCount"`
	Reward        float64          `json:"reward"` // 奖励信号
}

// ════════════════════════════════════════════════════════════════
// MARL 训练格式 (对齐 TS sendToMarlService 的 trainingData 字段)
// ════════════════════════════════════════════════════════════════

// TrainingSample 单条训练样本 (json 字段名对齐 trainer.train_step 入参)
type TrainingSample struct {
	Observation   []float64 `json:"observation"` // 10 维观测
	Action        int       `json:"action"`      // 离散动作空间索引
	LogProb       float64   `json:"log_prob"`    // 由 trainer 内部 rollout 记录; 此处占位
	Reward        float64   `json:"reward"`
	Value         float64   `json:"value"`          // 简化: 成功轨迹价值=1, 失败=0
	Done          bool      `json:"done"`           // 每个 trace 是独立 episode 末尾
	KernelVersion int64     `json:"kernel_version"` // 内核版本封印
	ToolsUsed     []string  `json:"tools_used"`
	Strategy      string    `json:"strategy"`
	Success       bool      `json:"success"`
}

// TrainingAck AGENT_TRAINING_ACK 解析结果 (对齐 TS sendToMarlService 返回)
type TrainingAck struct {
	OK                bool               `json:"ok"`
	Accepted          int                `json:"accepted,omitempty"`
	Trained           bool               `json:"trained,omitempty"` // trained_this_call
	Loss              map[string]float64 `json:"loss,omitempty"`
	CheckpointWritten bool               `json:"checkpointWritten,omitempty"` // 策略 checkpoint 已持久化 (policy.pt)
	Error             string             `json:"error,omitempty"`
}

// PolicyDecision 策略查询终态 (对齐 TS queryTrainedPolicy 返回; 失败回退 action=0)
type PolicyDecision struct {
	Action     int     `json:"action"`
	Confidence float64 `json:"confidence"`
	Source     string  `json:"source"` // trained_policy | fallback | fallback_error | no_trainer
}

// PolicyUpdatedEvent 策略更新通知 (对齐 TS onPolicyUpdated 回调事件;
// 闭环关键: checkpoint 写完后通知决策层重置缓存, 下次 POLICY_QUERY
// 由 server.py 用新 policy.pt 响应)
type PolicyUpdatedEvent struct {
	AgentID           string             `json:"agentId"`
	Accepted          int                `json:"accepted,omitempty"`
	Trained           bool               `json:"trained,omitempty"`
	CheckpointWritten bool               `json:"checkpointWritten"`
	Loss              map[string]float64 `json:"loss,omitempty"`
}

// PolicyCheckpoint 策略 checkpoint 记账 (Go 扩展: TS 仅日志, Go 侧可查询)
type PolicyCheckpoint struct {
	AgentID   string             `json:"agentId"`
	WrittenAt int64              `json:"writtenAt"` // 毫秒时间戳
	Accepted  int                `json:"accepted"`
	Trained   bool               `json:"trained"`
	Loss      map[string]float64 `json:"loss,omitempty"`
	Sequence  int                `json:"sequence"` // 管线内单调递增
}

// ════════════════════════════════════════════════════════════════
// EvolutionClient 注入接口 (与 next/internal/marl 对接)
// ════════════════════════════════════════════════════════════════

// EvolutionClient 进化管线对外依赖 (MARL 训练提交 + 策略查询)。
// 由 MARLEvolutionClient 提供 marl.Client 适配实现, 测试可注入 stub。
type EvolutionClient interface {
	// SubmitTraining 提交训练数据并同步等待 AGENT_TRAINING_ACK (5s 超时)。
	// 失败不返回 error, 统一以 OK=false + Error 表达 (对齐 TS Promise resolve {ok, error})。
	SubmitTraining(ctx context.Context, agentID, reason string, samples []TrainingSample) *TrainingAck
	// QueryPolicy 查询训练好的策略决策 (1s 超时回退 action=0); 永不失败,
	// 失败语义折叠进 Source (fallback/fallback_error/no_trainer)。
	QueryPolicy(ctx context.Context, observation []float64) PolicyDecision
}

// MARLEvolutionClient EvolutionClient 的 MARL 适配实现:
//   - 策略查询 → marl.Client.Query (§4 ShadowGovernorClient 协议, id 关联)
//   - 训练提交 → 8765 裸 TCP §3 帧 (AGENT_TRAINING_DATA → AGENT_TRAINING_ACK)
type MARLEvolutionClient struct {
	policy *marl.Client // 策略查询 (§4); nil 时查询返回 no_trainer
	addr   string       // 训练帧目标地址 (§3, 默认 127.0.0.1:8765)
}

// 编译期断言: 适配实现满足注入接口
var _ EvolutionClient = (*MARLEvolutionClient)(nil)

// NewMARLEvolutionClient 构造 MARL 适配客户端。
// policy 为 marl.New(addr) 创建的策略客户端 (与 decision.SetPolicy 共用同一实例);
// addr 为空时使用默认 127.0.0.1:8765。
func NewMARLEvolutionClient(policy *marl.Client, addr string) *MARLEvolutionClient {
	if addr == "" {
		addr = defaultMARLAddr
	}
	return &MARLEvolutionClient{policy: policy, addr: addr}
}

// QueryPolicy 经 marl.Client 查询策略 (外层 1s 守卫对齐 TS POLICY_QUERY 超时;
// marl.Client 内部读超时 2s, 守卫到点即回退, 在途查询随后自行终止)。
func (c *MARLEvolutionClient) QueryPolicy(ctx context.Context, observation []float64) PolicyDecision {
	if c.policy == nil {
		return PolicyDecision{Action: 0, Confidence: 0, Source: PolicySourceNoTrainer}
	}
	qctx, cancel := context.WithTimeout(ctx, policyQueryTimeout)
	defer cancel()
	resp, err := c.policy.Query(qctx, observation)
	if err != nil {
		// 连接失败 (ECONNREFUSED)/超时 → 启发式回退 (对齐 TS client.on('error'))
		return PolicyDecision{Action: 0, Confidence: 0, Source: PolicySourceFallback}
	}
	return PolicyDecision{
		Action:     resp.Action,
		Confidence: resp.Confidence, // §4 响应的 confidence 与 §3 POLICY_ANSWER 语义一致
		Source:     PolicySourceTrained,
	}
}

// SubmitTraining 发送 AGENT_TRAINING_DATA 帧并同步等待首个 AGENT_TRAINING_ACK 行。
// 5s 总超时 (拨号 + 读写 SetDeadline), 消息语义与 TS training-scheduler.ts:234-301 一致。
func (c *MARLEvolutionClient) SubmitTraining(ctx context.Context, agentID, reason string, samples []TrainingSample) *TrainingAck {
	ack := &TrainingAck{}

	dialer := net.Dialer{Timeout: trainingAckTimeout}
	conn, err := dialer.DialContext(ctx, "tcp", c.addr)
	if err != nil {
		ack.Error = fmt.Sprintf("MARL 服务不可用 (%s): %v", c.addr, err)
		return ack
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(trainingAckTimeout))

	frame := map[string]any{
		"frameId":   fmt.Sprintf("train-%s-%d", agentID, time.Now().UnixMilli()),
		"type":      FrameTypeTrainingData,
		"agentId":   agentID,
		"reason":    reason,
		"payload":   map[string]any{"trainingData": samples},
		"timestamp": time.Now().UnixMilli(),
	}
	line, err := json.Marshal(frame)
	if err != nil {
		ack.Error = "训练帧序列化失败: " + err.Error()
		return ack
	}
	if _, err := conn.Write(append(line, '\n')); err != nil {
		ack.Error = fmt.Sprintf("marl 训练帧写入失败: %v", err)
		return ack
	}

	// 服务器用 \n 分隔, 收到一行就当作 ACK (对齐 TS)
	scanner := bufio.NewScanner(conn)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		var resp struct {
			Type    string `json:"type"`
			Payload struct {
				Accepted          int                `json:"accepted"`
				TrainedThisCall   bool               `json:"trained_this_call"`
				Loss              map[string]float64 `json:"loss"`
				CheckpointWritten bool               `json:"checkpoint_written"`
			} `json:"payload"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &resp); err != nil {
			ack.Error = fmt.Sprintf("invalid ack json: %v", err)
			return ack
		}
		if resp.Type != FrameTypeTrainingAck {
			ack.Error = "unexpected ack type: " + resp.Type
			return ack
		}
		ack.OK = true
		ack.Accepted = resp.Payload.Accepted
		ack.Trained = resp.Payload.TrainedThisCall
		ack.Loss = resp.Payload.Loss
		ack.CheckpointWritten = resp.Payload.CheckpointWritten
		return ack
	}
	if err := scanner.Err(); err != nil {
		ack.Error = err.Error()
		return ack
	}
	ack.Error = fmt.Sprintf("timeout(%v) waiting MARL ACK", trainingAckTimeout)
	return ack
}

// ════════════════════════════════════════════════════════════════
// SkillLibrary — 技能库 (对齐 TS skill-library.ts 全量语义)
// ════════════════════════════════════════════════════════════════

// SkillEntry 单条技能 (从执行轨迹中提炼, 供 Agent 下次执行参考)
type SkillEntry struct {
	ID          string  `json:"id"`
	Domain      string  `json:"domain"`      // 领域 (agentId 前缀)
	Pattern     string  `json:"pattern"`     // 经验描述
	Confidence  float64 `json:"confidence"`  // 0-1 置信度
	UsageCount  int     `json:"usageCount"`  // 被引用次数
	SuccessRate float64 `json:"successRate"` // 使用成功率
	CreatedAt   int64   `json:"createdAt"`
	LastUsedAt  int64   `json:"lastUsedAt"`
}

// SkillLibrary 技能库 (进程内; 数量无上限, 由调用方按领域/置信度裁剪查询)
type SkillLibrary struct {
	mu     sync.RWMutex
	skills map[string]SkillEntry
}

// NewSkillLibrary 构造技能库
func NewSkillLibrary() *SkillLibrary {
	return &SkillLibrary{skills: make(map[string]SkillEntry)}
}

// AddSkill 添加一条技能 (同 ID 覆盖, 对齐 TS Map.set)
func (l *SkillLibrary) AddSkill(skill SkillEntry) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.skills[skill.ID] = skill
}

// QueryByDomain 按领域查询技能, 按置信度排序 (limit ≤0 时取 10)
func (l *SkillLibrary) QueryByDomain(domain string, limit int) []SkillEntry {
	l.mu.RLock()
	out := make([]SkillEntry, 0, len(l.skills))
	for _, s := range l.skills {
		if s.Domain == domain {
			out = append(out, s)
		}
	}
	l.mu.RUnlock()
	sort.SliceStable(out, func(i, j int) bool { return out[i].Confidence > out[j].Confidence })
	if limit <= 0 {
		limit = 10
	}
	if len(out) > limit {
		out = out[:limit]
	}
	return out
}

// QueryAll 查询所有技能, 按置信度排序 (limit ≤0 时取 20)
func (l *SkillLibrary) QueryAll(limit int) []SkillEntry {
	l.mu.RLock()
	out := make([]SkillEntry, 0, len(l.skills))
	for _, s := range l.skills {
		out = append(out, s)
	}
	l.mu.RUnlock()
	sort.SliceStable(out, func(i, j int) bool { return out[i].Confidence > out[j].Confidence })
	if limit <= 0 {
		limit = 20
	}
	if len(out) > limit {
		out = out[:limit]
	}
	return out
}

// RecordUsage 记录技能被使用 (滑动窗口更新成功率, 对齐 TS ×0.9 + success×0.1)
func (l *SkillLibrary) RecordUsage(skillID string, success bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	skill, ok := l.skills[skillID]
	if !ok {
		return
	}
	skill.UsageCount++
	skill.LastUsedAt = time.Now().UnixMilli()
	delta := 0.0
	if success {
		delta = 0.1
	}
	skill.SuccessRate = skill.SuccessRate*0.9 + delta
	l.skills[skillID] = skill
}

// Size 技能库大小
func (l *SkillLibrary) Size() int {
	l.mu.RLock()
	defer l.mu.RUnlock()
	return len(l.skills)
}

// ════════════════════════════════════════════════════════════════
// ExperienceCache — 经验缓存 (对齐 TS experience-cache.ts)
//
// "这次的agent解决了问题, 下次就不请求那么多次了, 直接把经验翻出来
// 让llm照着做就行了": 精确/模糊指纹匹配 → 经验路径复用。
// Go 侧进程内存储 (重启清零, 对齐 store 包决策); TS 的 JSONL 落盘不做。
// ════════════════════════════════════════════════════════════════

// 经验来源类型 (对齐 TS sourceType)
const (
	ExperienceSourceRacerLoop = "racer_agent_loop" // RACER 多轮
	ExperienceSourceDirectQA  = "direct_llm_qa"    // 简单问答缓存 (qa_ 前缀指纹)
)

// 匹配/淘汰参数 (对齐 TS: 前缀 64 模糊, Jaccard ≥0.6, successRate <0.3 淘汰,
// 复用衰减 ×0.85+0.15, 差评步长 ±0.25, 短问答 2..200 字符, 答案截断 1500)
const (
	experienceQAPrefix              = "qa_"
	experienceFuzzyPrefixLen        = 64
	experienceMinPrefixLen          = 10
	experienceMinSimilarity         = 0.6
	experienceInvalidationThreshold = 0.3
	experienceReuseDecay            = 0.85
	experienceReuseStep             = 0.15
	experienceRateStep              = 0.25
	experienceQADefaultRate         = 0.8
	experienceAnswerMaxRunes        = 2000
	experienceQAAnswerMaxRunes      = 1500
	experiencePromptMaxRunes        = 200
)

// ExperienceToolStep 成功的工具调用步骤摘要
type ExperienceToolStep struct {
	Tool          string `json:"tool"`
	Args          string `json:"args"`
	ResultSummary string `json:"resultSummary"`
}

// ExperienceRecord 单条经验记录
type ExperienceRecord struct {
	Fingerprint      string               `json:"fingerprint"`      // 归一化后 sha256 前 16 字符
	NormalizedPrompt string               `json:"normalizedPrompt"` // 归一化后的问题文本 (模糊匹配用)
	OriginalPrompt   string               `json:"originalPrompt"`   // 原始问题 (截断 200 字符)
	SourceType       string               `json:"sourceType"`       // racer_agent_loop | direct_llm_qa
	ToolSteps        []ExperienceToolStep `json:"toolSteps"`        // 成功的工具调用序列
	FinalAnswer      string               `json:"finalAnswer"`      // 最终答案 (截断 2000 字符)
	TokenCost        int                  `json:"tokenCost"`        // 当时消耗的 token
	DurationMs       int64                `json:"durationMs"`
	ReuseCount       int                  `json:"reuseCount"`  // 被复用次数
	SuccessRate      float64              `json:"successRate"` // 0-1, 每次复用后更新
	CreatedAt        int64                `json:"createdAt"`
	LastUsedAt       int64                `json:"lastUsedAt"`
}

// ExperienceLookup 经验查询结果
type ExperienceLookup struct {
	Record     ExperienceRecord `json:"record"`
	MatchType  string           `json:"matchType"`  // exact | similar
	Similarity float64          `json:"similarity"` // 0-1
}

// 归一化正则 (对齐 TS normalize 的替换链; 注: TS 去标点先于版本号归一化,
// '.' 已被移除, 版本号规则实际不生效 — 保留以对齐行为)
var (
	reExperienceWhitespace = regexp.MustCompile(`\s+`)             // 合并空白
	reExperiencePunct      = regexp.MustCompile(`[^\w\s\p{Han}]`)  // 去标点 (保留字母数字下划线中文)
	reExperienceVersion    = regexp.MustCompile(`\b\d+(\.\d+)+\b`) // 版本号 v1.2.3 → V (见上注)
	reExperienceBareNum    = regexp.MustCompile(`\b\d+\b`)         // 行号/数字 → N
)

// ExperienceCache 经验缓存 (进程内)
type ExperienceCache struct {
	mu    sync.RWMutex
	cache map[string]*ExperienceRecord
}

// NewExperienceCache 构造经验缓存
func NewExperienceCache() *ExperienceCache {
	return &ExperienceCache{cache: make(map[string]*ExperienceRecord)}
}

// NormalizePrompt 归一化问题文本: 小写 → 合并空白 → 去标点(保留字母数字中文)
// → 版本号/数字归一化 → trim (对齐 TS ExperienceCache.normalize)
func NormalizePrompt(prompt string) string {
	s := strings.ToLower(prompt)
	s = reExperienceWhitespace.ReplaceAllString(s, " ")
	s = reExperiencePunct.ReplaceAllString(s, "")
	s = reExperienceVersion.ReplaceAllString(s, "V")
	s = reExperienceBareNum.ReplaceAllString(s, "N")
	return strings.TrimSpace(s)
}

// PromptFingerprint 计算指纹: sha256 前 16 字符 (对齐 TS ExperienceCache.fingerprint)
func PromptFingerprint(normalized string) string {
	sum := sha256.Sum256([]byte(normalized))
	return hex.EncodeToString(sum[:])[:16]
}

// jaccardSimilarity 词级 Jaccard 相似度 (对齐 TS)
func jaccardSimilarity(a, b string) float64 {
	wordsA := strings.Split(a, " ")
	wordsB := strings.Split(b, " ")
	setB := make(map[string]struct{}, len(wordsB))
	for _, w := range wordsB {
		setB[w] = struct{}{}
	}
	inter := 0
	setA := make(map[string]struct{}, len(wordsA))
	for _, w := range wordsA {
		if _, dup := setA[w]; dup {
			continue
		}
		setA[w] = struct{}{}
		if _, hit := setB[w]; hit {
			inter++
		}
	}
	union := len(setA) + len(setB) - inter
	if union == 0 {
		return 0
	}
	return float64(inter) / float64(union)
}

// Lookup 查询经验: 优先精确匹配 (RACER 与 DirectLLM QA 两种指纹),
// 其次模糊匹配 (归一化前 64 字符相同 + Jaccard ≥0.6) — 对齐 TS lookup
func (c *ExperienceCache) Lookup(prompt string) *ExperienceLookup {
	normalized := NormalizePrompt(prompt)
	fp := PromptFingerprint(normalized)

	c.mu.RLock()
	defer c.mu.RUnlock()

	// 1) 精确匹配: RACER 经验 (无前缀)
	if rec, ok := c.cache[fp]; ok {
		return &ExperienceLookup{Record: *rec, MatchType: "exact", Similarity: 1.0}
	}
	// 1b) 精确匹配: DirectLLM QA 经验 (qa_ 前缀)
	if rec, ok := c.cache[experienceQAPrefix+fp]; ok {
		return &ExperienceLookup{Record: *rec, MatchType: "exact", Similarity: 1.0}
	}

	// 2) 模糊匹配: 归一化后前 64 字符相同 (相似问题复用); 太短不模糊匹配
	prefix := truncateRunes(normalized, experienceFuzzyPrefixLen)
	if len([]rune(prefix)) < experienceMinPrefixLen {
		return nil
	}
	var best *ExperienceRecord
	bestSim := 0.0
	for _, rec := range c.cache {
		if truncateRunes(rec.NormalizedPrompt, experienceFuzzyPrefixLen) != prefix {
			continue
		}
		sim := jaccardSimilarity(normalized, rec.NormalizedPrompt)
		if sim > bestSim && sim >= experienceMinSimilarity {
			bestSim = sim
			best = rec
		}
	}
	if best != nil {
		return &ExperienceLookup{Record: *best, MatchType: "similar", Similarity: bestSim}
	}
	return nil
}

// Record 保存经验 (Agent Loop 成功后调用)。
// 已存在相同指纹时, 只在新答案 token 更省或答案更详尽时更新 (对齐 TS)。
// 返回 true 表示新建 (首次入库, 供事件广播)。
func (c *ExperienceCache) Record(prompt string, toolSteps []ExperienceToolStep, finalAnswer string, tokenCost int, durationMs int64) bool {
	normalized := NormalizePrompt(prompt)
	fp := PromptFingerprint(normalized)
	now := time.Now().UnixMilli()

	c.mu.Lock()
	defer c.mu.Unlock()
	if existing, ok := c.cache[fp]; ok {
		if float64(tokenCost) < float64(existing.TokenCost)*0.8 ||
			float64(len([]rune(finalAnswer))) > float64(len([]rune(existing.FinalAnswer)))*1.2 {
			existing.ToolSteps = toolSteps
			existing.FinalAnswer = truncateRunes(finalAnswer, experienceAnswerMaxRunes)
			existing.TokenCost = tokenCost
			existing.DurationMs = durationMs
			existing.LastUsedAt = now
		}
		return false
	}
	c.cache[fp] = &ExperienceRecord{
		Fingerprint:      fp,
		NormalizedPrompt: normalized,
		OriginalPrompt:   truncateRunes(prompt, experiencePromptMaxRunes),
		SourceType:       ExperienceSourceRacerLoop,
		ToolSteps:        toolSteps,
		FinalAnswer:      truncateRunes(finalAnswer, experienceAnswerMaxRunes),
		TokenCost:        tokenCost,
		DurationMs:       durationMs,
		ReuseCount:       0,
		SuccessRate:      1.0, // 新经验默认成功
		CreatedAt:        now,
		LastUsedAt:       now,
	}
	return true
}

// SaveDirectLLMQA 保存 DirectLLM 简单问答到轻量级 QA 缓存 (qa_ 前缀指纹)。
// 只缓存归一化后 2..200 字符的短问答, 默认置信度 0.8 (低于 RACER 的 1.0)。
// 返回 true 表示新建。
func (c *ExperienceCache) SaveDirectLLMQA(prompt, answer string, tokenCost int, durationMs int64) bool {
	normalized := NormalizePrompt(prompt)
	n := len([]rune(normalized))
	if n > 200 || n < 2 {
		return false // 过滤: 只缓存短问答, 避免复杂任务误入
	}
	fp := experienceQAPrefix + PromptFingerprint(normalized)
	now := time.Now().UnixMilli()

	c.mu.Lock()
	defer c.mu.Unlock()
	if existing, ok := c.cache[fp]; ok {
		existing.FinalAnswer = truncateRunes(answer, experienceQAAnswerMaxRunes)
		existing.ReuseCount++
		existing.LastUsedAt = now
		return false
	}
	c.cache[fp] = &ExperienceRecord{
		Fingerprint:      fp,
		NormalizedPrompt: normalized,
		OriginalPrompt:   truncateRunes(prompt, experiencePromptMaxRunes),
		SourceType:       ExperienceSourceDirectQA,
		ToolSteps:        []ExperienceToolStep{},
		FinalAnswer:      truncateRunes(answer, experienceQAAnswerMaxRunes),
		TokenCost:        tokenCost,
		DurationMs:       durationMs,
		ReuseCount:       0,
		SuccessRate:      experienceQADefaultRate,
		CreatedAt:        now,
		LastUsedAt:       now,
	}
	return true
}

// RecordReuse 记录经验被复用 (滑动窗口: 差评显著拉低, 好评缓慢提升)。
// successRate < 0.3 自动删除 (降级失效: 避免 "LLM 回答错误仍保存记忆, 越做越错")。
// 返回 false 表示经验已失效删除。
func (c *ExperienceCache) RecordReuse(fingerprint string, success bool) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	rec, ok := c.cache[fingerprint]
	if !ok {
		return true
	}
	rec.ReuseCount++
	rec.LastUsedAt = time.Now().UnixMilli()
	step := 0.0
	if success {
		step = experienceReuseStep
	}
	rec.SuccessRate = rec.SuccessRate*experienceReuseDecay + step
	if rec.SuccessRate < experienceInvalidationThreshold {
		delete(c.cache, fingerprint)
		return false
	}
	return true
}

// RateExperience 直接对经验打分 (不增加 reuseCount; 👍 +0.25 / 👎 -0.25,
// 3-4 次 👎 即淘汰)。返回 false 表示经验已失效删除。
func (c *ExperienceCache) RateExperience(fingerprint string, positive bool) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	rec, ok := c.cache[fingerprint]
	if !ok {
		return false
	}
	delta := -experienceRateStep
	if positive {
		delta = experienceRateStep
	}
	rec.SuccessRate = clamp(rec.SuccessRate+delta, 0, 1)
	rec.LastUsedAt = time.Now().UnixMilli()
	if rec.SuccessRate < experienceInvalidationThreshold {
		delete(c.cache, fingerprint)
		return false
	}
	return true
}

// FindFingerprint 根据问题文本查找指纹 (精确 → qa_ 前缀 → 模糊), 供反馈定位
func (c *ExperienceCache) FindFingerprint(prompt string) string {
	normalized := NormalizePrompt(prompt)
	fp := PromptFingerprint(normalized)
	c.mu.RLock()
	defer c.mu.RUnlock()
	if _, ok := c.cache[fp]; ok {
		return fp
	}
	if _, ok := c.cache[experienceQAPrefix+fp]; ok {
		return experienceQAPrefix + fp
	}
	return ""
}

// Size 缓存大小
func (c *ExperienceCache) Size() int {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return len(c.cache)
}

// GetAll 所有经验 (按最近使用倒序, 统计/调试用)
func (c *ExperienceCache) GetAll() []ExperienceRecord {
	c.mu.RLock()
	out := make([]ExperienceRecord, 0, len(c.cache))
	for _, rec := range c.cache {
		out = append(out, *rec)
	}
	c.mu.RUnlock()
	sort.SliceStable(out, func(i, j int) bool { return out[i].LastUsedAt > out[j].LastUsedAt })
	return out
}

// ════════════════════════════════════════════════════════════════
// AutoTrainingTrigger — 每 Agent 自动训练触发器 (对齐 TS auto-training-trigger.ts)
//
// 触发条件:
//   - 轨迹数 ≥ batch_size (默认 20) 且冷却已过 (默认 5 分钟) → batch_ready
//   - 紧急: 缓冲 ≥10 且前后半段成功率下降 > 15% 且冷却已过 → emergency
//   - 训练后台进行, 不阻塞 Agent 工作 (调度器 pump goroutine 承接)
// ════════════════════════════════════════════════════════════════

// TriggerConfig 训练触发器配置 (字段对齐 TS TriggerConfig, 时间为毫秒)
type TriggerConfig struct {
	BatchSize          int     // 积累多少条轨迹后触发训练
	CooldownMs         int64   // 训练冷却时间 (毫秒)
	EmergencyThreshold float64 // 成功率下降多少触发紧急训练
	MaxBufferSize      int     // 最大缓冲区大小
}

// 默认触发参数 (对齐 TS DEFAULT_TRIGGER_CONFIG)
const (
	defaultBatchSize          = 20
	defaultCooldownMs         = 5 * 60 * 1000
	defaultEmergencyThreshold = 0.15
	defaultMaxBufferSize      = 200

	emergencyMinBuffer = 10 // 紧急触发最小缓冲 (TS: traceBuffer.length >= 10)
	slidingWindowLen   = 50 // 滑动窗口成功率窗口 (TS: slice(-50))
)

// TrainingTriggeredEvent 训练触发事件 (对齐 TS 'training_triggered' 事件载荷)
type TrainingTriggeredEvent struct {
	AgentID       string           `json:"agentId"`
	Reason        string           `json:"reason"` // batch_ready | emergency | reputation_drop
	Traces        []ExecutionTrace `json:"-"`
	SuccessRate   float64          `json:"successRate"`
	Timestamp     int64            `json:"timestamp"`
	KernelVersion int64            `json:"kernelVersion"` // 透传训练样本 kernel_version (默认 0)
}

// TriggerStatus 触发器状态快照 (对齐 TS getStatus)
type TriggerStatus struct {
	AgentID                 string  `json:"agentId"`
	BufferSize              int     `json:"bufferSize"`
	RecentSuccessRate       float64 `json:"recentSuccessRate"`
	TotalTracesRecorded     int     `json:"totalTracesRecorded"`
	TotalTrainingsTriggered int     `json:"totalTrainingsTriggered"`
	LastTrainingTime        int64   `json:"lastTrainingTime"`
	NextTrainingEstimate    int     `json:"nextTrainingEstimate"` // 预计还需多少条轨迹
}

// TrainingHandler 训练触发回调 (调度器在注册时注入; 对齐 TS EventEmitter)
type TrainingHandler func(ctx context.Context, ev TrainingTriggeredEvent)

// AutoTrainingTrigger 每 Agent 的自动训练触发器
type AutoTrainingTrigger struct {
	agentID string
	config  TriggerConfig
	handler TrainingHandler // 训练触发出口 (注册后只读)

	mu                      sync.Mutex
	traceBuffer             []ExecutionTrace
	lastTrainingTime        int64   // 毫秒时间戳
	recentSuccessRate       float64 // 滑动窗口成功率 (最近 50 条)
	totalTracesRecorded     int
	totalTrainingsTriggered int
}

// NewAutoTrainingTrigger 构造触发器 (cfg 为 nil 时用默认参数)
func NewAutoTrainingTrigger(agentID string, cfg *TriggerConfig) *AutoTrainingTrigger {
	config := TriggerConfig{
		BatchSize:          defaultBatchSize,
		CooldownMs:         defaultCooldownMs,
		EmergencyThreshold: defaultEmergencyThreshold,
		MaxBufferSize:      defaultMaxBufferSize,
	}
	if cfg != nil {
		if cfg.BatchSize > 0 {
			config.BatchSize = cfg.BatchSize
		}
		if cfg.CooldownMs > 0 {
			config.CooldownMs = cfg.CooldownMs
		}
		if cfg.EmergencyThreshold > 0 {
			config.EmergencyThreshold = cfg.EmergencyThreshold
		}
		if cfg.MaxBufferSize > 0 {
			config.MaxBufferSize = cfg.MaxBufferSize
		}
	}
	return &AutoTrainingTrigger{
		agentID:           agentID,
		config:            config,
		recentSuccessRate: 0.5, // 对齐 TS 初值
	}
}

// SetHandler 注入训练触发回调 (调度器注册时调用)
func (t *AutoTrainingTrigger) SetHandler(h TrainingHandler) {
	t.mu.Lock()
	t.handler = h
	t.mu.Unlock()
}

// RecordTrace 记录一条执行轨迹 (每次 Agent 执行完任务后自动调用)。
// 更新滑动窗口成功率 → 限制缓冲区 → 检查触发条件 → 触发训练。
func (t *AutoTrainingTrigger) RecordTrace(ctx context.Context, trace ExecutionTrace) {
	var (
		batch  []ExecutionTrace
		reason string
		rate   float64
	)
	t.mu.Lock()
	t.traceBuffer = append(t.traceBuffer, trace)
	t.totalTracesRecorded++

	// 滑动窗口成功率 (最近 50 条)
	recent := t.traceBuffer
	if len(recent) > slidingWindowLen {
		recent = recent[len(recent)-slidingWindowLen:]
	}
	rate = successRateOf(recent)
	t.recentSuccessRate = rate

	// 限制缓冲区大小 (对齐 TS slice(-maxBufferSize))
	if len(t.traceBuffer) > t.config.MaxBufferSize {
		trimmed := make([]ExecutionTrace, t.config.MaxBufferSize)
		copy(trimmed, t.traceBuffer[len(t.traceBuffer)-t.config.MaxBufferSize:])
		t.traceBuffer = trimmed
	}

	batch, reason = t.checkAndTriggerLocked()
	handler := t.handler
	t.mu.Unlock()

	// 触发训练 (锁外回调, 对齐 TS emit 同步语义; 调度器内部有自身锁序)
	if len(batch) > 0 && handler != nil {
		handler(ctx, TrainingTriggeredEvent{
			AgentID:     t.agentID,
			Reason:      reason,
			Traces:      batch,
			SuccessRate: rate,
			Timestamp:   time.Now().UnixMilli(),
		})
	}
}

// InjectTraces 手动注入轨迹 (用于从持久化存储恢复; 对齐 TS: 不更新滑动
// 窗口成功率, 仅追加后检查触发)
func (t *AutoTrainingTrigger) InjectTraces(ctx context.Context, traces []ExecutionTrace) {
	t.mu.Lock()
	t.traceBuffer = append(t.traceBuffer, traces...)
	batch, reason := t.checkAndTriggerLocked()
	handler := t.handler
	t.mu.Unlock()
	if len(batch) > 0 && handler != nil {
		handler(ctx, TrainingTriggeredEvent{
			AgentID:     t.agentID,
			Reason:      reason,
			Traces:      batch,
			SuccessRate: t.SuccessRate(),
			Timestamp:   time.Now().UnixMilli(),
		})
	}
}

// DrainTraces 排空全部缓冲轨迹 (Go 扩展: 信誉阈值触发训练用)。
// 排空视同一次训练触发 (重置冷却 + 计数), 保证 batch_ready 路径冷却一致。
func (t *AutoTrainingTrigger) DrainTraces() []ExecutionTrace {
	t.mu.Lock()
	out := t.traceBuffer
	t.traceBuffer = nil
	t.lastTrainingTime = time.Now().UnixMilli()
	t.totalTrainingsTriggered++
	t.mu.Unlock()
	return out
}

// ExportTraces 导出所有缓冲轨迹副本 (用于持久化/关闭时 flush)
func (t *AutoTrainingTrigger) ExportTraces() []ExecutionTrace {
	t.mu.Lock()
	defer t.mu.Unlock()
	out := make([]ExecutionTrace, len(t.traceBuffer))
	copy(out, t.traceBuffer)
	return out
}

// SuccessRate 当前滑动窗口成功率
func (t *AutoTrainingTrigger) SuccessRate() float64 {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.recentSuccessRate
}

// Status 触发器状态快照
func (t *AutoTrainingTrigger) Status() TriggerStatus {
	t.mu.Lock()
	defer t.mu.Unlock()
	estimate := t.config.BatchSize - len(t.traceBuffer)
	if estimate < 0 {
		estimate = 0
	}
	return TriggerStatus{
		AgentID:                 t.agentID,
		BufferSize:              len(t.traceBuffer),
		RecentSuccessRate:       t.recentSuccessRate,
		TotalTracesRecorded:     t.totalTracesRecorded,
		TotalTrainingsTriggered: t.totalTrainingsTriggered,
		LastTrainingTime:        t.lastTrainingTime,
		NextTrainingEstimate:    estimate,
	}
}

// checkAndTriggerLocked 检查触发条件并取批 (须持 t.mu)。
// 条件 1: 轨迹够了 + 冷却过了 → batch_ready;
// 条件 2: 缓冲 ≥10 且前后半段成功率骤降 > 阈值 → emergency (对齐 TS)。
// 返回 (批次, 原因); 无触发返回 (nil, "")。
func (t *AutoTrainingTrigger) checkAndTriggerLocked() ([]ExecutionTrace, string) {
	now := time.Now().UnixMilli()
	cooldownPassed := now-t.lastTrainingTime >= t.config.CooldownMs

	// 条件 1: 正常触发 — 轨迹够了 + 冷却过了
	if len(t.traceBuffer) >= t.config.BatchSize && cooldownPassed {
		return t.spliceBatchLocked(), TrainingReasonBatchReady
	}

	// 条件 2: 紧急触发 — 成功率骤降
	if len(t.traceBuffer) >= emergencyMinBuffer && cooldownPassed {
		mid := len(t.traceBuffer) / 2
		olderRate := successRateOf(t.traceBuffer[:mid])
		newerRate := successRateOf(t.traceBuffer[mid:])
		if olderRate-newerRate > t.config.EmergencyThreshold {
			return t.spliceBatchLocked(), TrainingReasonEmergency
		}
	}
	return nil, ""
}

// spliceBatchLocked 取出前 batch_size 条轨迹并重置冷却 (须持 t.mu; 对齐 TS splice(0, batchSize))
func (t *AutoTrainingTrigger) spliceBatchLocked() []ExecutionTrace {
	n := t.config.BatchSize
	if n > len(t.traceBuffer) {
		n = len(t.traceBuffer)
	}
	batch := make([]ExecutionTrace, n)
	copy(batch, t.traceBuffer[:n])
	rest := make([]ExecutionTrace, len(t.traceBuffer)-n)
	copy(rest, t.traceBuffer[n:])
	t.traceBuffer = rest
	t.lastTrainingTime = time.Now().UnixMilli()
	t.totalTrainingsTriggered++
	return batch
}

// successRateOf 轨迹切片的成功率 (空切片返回 0, 对齐 TS 除零语义)
func successRateOf(traces []ExecutionTrace) float64 {
	if len(traces) == 0 {
		return 0
	}
	ok := 0
	for i := range traces {
		if traces[i].Success {
			ok++
		}
	}
	return float64(ok) / float64(len(traces))
}

// ════════════════════════════════════════════════════════════════
// TrainingScheduler — 全局训练调度器 (对齐 TS training-scheduler.ts)
//
// 职责:
//   1. 管理所有 Agent 的 AutoTrainingTrigger
//   2. 监听训练触发事件 → 入训练队列 (单飞, 防并发训练冲突)
//   3. 调度训练任务到 MARL 服务 (AGENT_TRAINING_DATA, 5s ACK 超时)
//   4. 将训练后的策略 checkpoint 通知决策层 (onPolicyUpdated 闭环)
//   5. 从轨迹提炼技能写入技能库 (MARL 失败时的兜底)
// ════════════════════════════════════════════════════════════════

// PendingTrainingJob 训练队列任务
type PendingTrainingJob struct {
	AgentID       string           `json:"agentId"`
	Reason        string           `json:"reason"`
	Traces        []ExecutionTrace `json:"-"`
	SuccessRate   float64          `json:"successRate"`
	EnqueuedAt    int64            `json:"enqueuedAt"`
	KernelVersion int64            `json:"kernelVersion"`
}

// TrainingSchedulerStatus 全局调度器状态 (对齐 TS getGlobalStatus)
type TrainingSchedulerStatus struct {
	RegisteredAgents      int             `json:"registeredAgents"`
	QueueLength           int             `json:"queueLength"`
	IsTraining            bool            `json:"isTraining"`
	TotalJobsProcessed    int             `json:"totalJobsProcessed"`
	TotalTracesProcessed  int             `json:"totalTracesProcessed"`
	TotalTrainingFailures int             `json:"totalTrainingFailures"`
	AgentStatuses         []TriggerStatus `json:"agentStatuses"`
}

// TrainingScheduler 全局训练调度器 (Go 侧无全局单例, 由 EvolutionPipeline 构造装配)
type TrainingScheduler struct {
	client EvolutionClient // MARL 训练/查询客户端 (注入)
	skills *SkillLibrary   // 技能库 (兜底技能提炼目标)

	mu          sync.Mutex
	triggers    map[string]*AutoTrainingTrigger
	queue       []PendingTrainingJob
	pumpRunning bool
	training    bool // isTraining: 同一时间只有一个训练在运行
	closed      bool
	done        chan struct{} // Shutdown 唤醒 pump 间隔等待

	// 统计 (对齐 TS)
	totalJobsProcessed    int
	totalTracesProcessed  int
	totalTrainingFailures int

	// OnPolicyUpdated 策略更新回调 (可选): 训练完一次后通知决策层重置缓存。
	// 须在首次 RecordTrace/入队前设置 (与 TS 公开字段语义一致)。
	OnPolicyUpdated func(PolicyUpdatedEvent)

	store *store.Store
	bus   *bus.EventBus
}

// NewTrainingScheduler 构造调度器 (client 注入 MARL 适配; skills 可为 nil = 不提炼技能;
// store/bus 为空时仅队列不广播)
func NewTrainingScheduler(client EvolutionClient, skills *SkillLibrary, st *store.Store, b *bus.EventBus) *TrainingScheduler {
	return &TrainingScheduler{
		client:   client,
		skills:   skills,
		triggers: make(map[string]*AutoTrainingTrigger),
		done:     make(chan struct{}),
		store:    st,
		bus:      b,
	}
}

// SetSkillLibrary 设置技能库引用 (对齐 TS setSkillLibrary)
func (s *TrainingScheduler) SetSkillLibrary(library *SkillLibrary) {
	s.mu.Lock()
	s.skills = library
	s.mu.Unlock()
}

// skillLib 读取当前技能库引用 (锁内快照, 供 EvolutionPipeline.Skills 访问)
func (s *TrainingScheduler) skillLib() *SkillLibrary {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.skills
}

// RegisterAgent 为 Agent 注册训练触发器 (Agent 创建时自动调用; 幂等返回已有触发器)
func (s *TrainingScheduler) RegisterAgent(agentID, domain string) *AutoTrainingTrigger {
	s.mu.Lock()
	if t, ok := s.triggers[agentID]; ok {
		s.mu.Unlock()
		return t
	}
	t := NewAutoTrainingTrigger(agentID, nil)
	t.SetHandler(s.enqueueTrainingJob)
	s.triggers[agentID] = t
	s.mu.Unlock()
	return t
}

// UnregisterAgent 注销 Agent 的训练触发器 (对齐 TS removeAllListeners + delete)
func (s *TrainingScheduler) UnregisterAgent(agentID string) {
	s.mu.Lock()
	delete(s.triggers, agentID)
	s.mu.Unlock()
}

// Trigger 获取 Agent 的触发器 (对齐 TS getTrigger)
func (s *TrainingScheduler) Trigger(agentID string) (*AutoTrainingTrigger, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.triggers[agentID]
	return t, ok
}

// RecordTrace 记录执行轨迹 (未注册 Agent 惰性建户 — TS 语义为显式注册,
// Go 侧放宽为自动注册, domain 留空)
func (s *TrainingScheduler) RecordTrace(ctx context.Context, trace ExecutionTrace) {
	if trace.AgentID == "" {
		return
	}
	s.mu.Lock()
	t, ok := s.triggers[trace.AgentID]
	s.mu.Unlock()
	if !ok {
		t = s.RegisterAgent(trace.AgentID, "")
	}
	t.RecordTrace(ctx, trace)
}

// TriggerReputationTraining 信誉阈值触发训练 (Go 扩展入口, EvolutionPipeline 调用):
// 排空该 Agent 触发器缓冲作为紧急训练批次; 无触发器或无轨迹时跳过。
// reputation 为 0..100 刻度, 事件 successRate 折算为 0..1 (对齐 TS 刻度)。
func (s *TrainingScheduler) TriggerReputationTraining(ctx context.Context, agentID string, reputation float64) bool {
	s.mu.Lock()
	t, ok := s.triggers[agentID]
	s.mu.Unlock()
	if !ok {
		return false
	}
	traces := t.DrainTraces()
	if len(traces) == 0 {
		return false
	}
	s.enqueueTrainingJob(ctx, TrainingTriggeredEvent{
		AgentID:     agentID,
		Reason:      TrainingReasonReputation,
		Traces:      traces,
		SuccessRate: reputation / 100,
		Timestamp:   time.Now().UnixMilli(),
	})
	return true
}

// enqueueTrainingJob 训练任务入队 (触发回调入口): 追加队列 → 广播事件 →
// 确保 pump goroutine 在跑 (对齐 TS push + processQueue)
func (s *TrainingScheduler) enqueueTrainingJob(ctx context.Context, ev TrainingTriggeredEvent) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	job := PendingTrainingJob{
		AgentID:       ev.AgentID,
		Reason:        ev.Reason,
		Traces:        ev.Traces,
		SuccessRate:   ev.SuccessRate,
		EnqueuedAt:    time.Now().UnixMilli(),
		KernelVersion: ev.KernelVersion,
	}
	s.queue = append(s.queue, job)
	queueLen := len(s.queue)
	if !s.pumpRunning {
		s.pumpRunning = true
		go s.pump()
	}
	s.mu.Unlock()

	s.emit(ctx, EventTrainingTriggered, map[string]any{
		"agentId":     ev.AgentID,
		"reason":      ev.Reason,
		"traceCount":  len(ev.Traces),
		"successRate": ev.SuccessRate,
		"queueLength": queueLen,
		"timestamp":   time.Now().UnixMilli(),
	})
}

// pump 训练队列泵: 保证同一时间只有一个训练在运行 (对齐 TS processQueue 单飞);
// 队列非空时相邻任务间隔 1s (对齐 TS setTimeout(processQueue, 1000))。
func (s *TrainingScheduler) pump() {
	for {
		s.mu.Lock()
		if s.closed || len(s.queue) == 0 {
			s.pumpRunning = false
			s.mu.Unlock()
			return
		}
		job := s.queue[0]
		s.queue = s.queue[1:]
		s.training = true
		s.mu.Unlock()

		s.processJob(job)

		s.mu.Lock()
		s.training = false
		more := !s.closed && len(s.queue) > 0
		s.mu.Unlock()

		if !more {
			continue // 回到循环头; 队列空则退出
		}
		select {
		case <-time.After(trainingJobInterval):
		case <-s.done:
			return
		}
	}
}

// processJob 处理单个训练任务:
//  1. 发送轨迹到 MARL 服务训练 (同步等待 ACK, 失败不再静默)
//  2. checkpoint 写完后经 OnPolicyUpdated 通知决策层 (闭环)
//  3. 从轨迹提炼技能写入技能库 (MARL 失败时作为兜底技能提取)
func (s *TrainingScheduler) processJob(job PendingTrainingJob) {
	// 训练提交独立于调用方请求生命周期 (见头部差异说明)
	ctx := context.Background()
	traceCount := len(job.Traces)

	ack := &TrainingAck{OK: false, Error: "训练客户端未注入 (EvolutionClient == nil)"}
	if s.client != nil {
		ack = s.client.SubmitTraining(ctx, job.AgentID, job.Reason, buildTrainingData(job.Traces, job.KernelVersion))
	}

	s.mu.Lock()
	if ack.OK {
		s.totalJobsProcessed++
		s.totalTracesProcessed += traceCount
	} else {
		s.totalTrainingFailures++
	}
	s.mu.Unlock()

	if ack.OK && ack.CheckpointWritten && s.OnPolicyUpdated != nil {
		// 闭环关键: checkpoint 写完后通知决策层重置缓存;
		// 训练好的策略已经通过 8765 持久化为 policy.pt,
		// 下次 POLICY_QUERY 帧会被 server.py 用新策略响应 (对齐 TS)
		s.OnPolicyUpdated(PolicyUpdatedEvent{
			AgentID:           job.AgentID,
			Accepted:          ack.Accepted,
			Trained:           ack.Trained,
			CheckpointWritten: ack.CheckpointWritten,
			Loss:              ack.Loss,
		})
	}

	// 从轨迹中提炼技能写入技能库 (兜底, 对齐 TS extractSkills 无条件执行)
	s.extractSkills(job.AgentID, job.Traces)

	payload := map[string]any{
		"agentId":              job.AgentID,
		"reason":               job.Reason,
		"traceCount":           traceCount,
		"ok":                   ack.OK,
		"accepted":             ack.Accepted,
		"trained":              ack.Trained,
		"checkpointWritten":    ack.CheckpointWritten,
		"totalJobsProcessed":   s.totalJobsProcessed,
		"totalTracesProcessed": s.totalTracesProcessed,
		"timestamp":            time.Now().UnixMilli(),
	}
	if ack.Error != "" {
		payload["error"] = ack.Error
	}
	if len(ack.Loss) > 0 {
		payload["loss"] = ack.Loss
	}
	s.emit(ctx, EventTrainingCompleted, payload)
}

// QueryTrainedPolicy 向 8765 查询当前训练好的策略决策 (供决策引擎调用,
// 获取基于历史训练数据的 action; 失败时回退启发式, 对齐 TS queryTrainedPolicy)
func (s *TrainingScheduler) QueryTrainedPolicy(ctx context.Context, observation []float64) PolicyDecision {
	if s.client == nil {
		return PolicyDecision{Action: 0, Confidence: 0, Source: PolicySourceNoTrainer}
	}
	return s.client.QueryPolicy(ctx, observation)
}

// buildTrainingData 将轨迹转换为 MARL 训练格式 (对齐 TS trainingData 构造:
// 10 维观测 + inferAction + reward/value/done/kernel_version)
func buildTrainingData(traces []ExecutionTrace, kernelVersion int64) []TrainingSample {
	out := make([]TrainingSample, 0, len(traces))
	for i := range traces {
		t := &traces[i]
		value := 0.0 // 简化: 成功轨迹价值=1, 失败=0 (对齐 TS)
		if t.Success {
			value = 1.0
		}
		out = append(out, TrainingSample{
			Observation:   t.Observation.Array(),
			Action:        inferAction(t),
			LogProb:       0.0, // 由 trainer 内部 rollout 时记录; 此处占位 (对齐 TS)
			Reward:        t.Reward,
			Value:         value,
			Done:          true, // 每个 trace 是独立 episode 末尾 (对齐 TS)
			KernelVersion: kernelVersion,
			ToolsUsed:     t.ToolsUsed,
			Strategy:      t.StrategyUsed,
			Success:       t.Success,
		})
	}
	return out
}

// inferAction 从 trace 反推 action index (对 AgentAction 离散空间, 对齐 TS):
// 成功 → 1 (PERFORMANCE_MODE), 失败无工具 → 0 (NO_OP), 失败工具 ≥3 → 2
// (CIRCUIT_BREAKER), 否则 1。真实环境会用 policy(state) 采样,
// 这里仅用于回放训练 trace 的 action 标签。
func inferAction(trace *ExecutionTrace) int {
	if trace.Success {
		return 1
	}
	if len(trace.ToolsUsed) == 0 {
		return 0
	}
	if len(trace.ToolsUsed) >= 3 {
		return 2
	}
	return 1
}

// extractSkills 从轨迹中提炼技能写入技能库 (对齐 TS extractSkills):
// 成功轨迹的工具组合模式 (top 3) + 策略偏好 (top 1)。
func (s *TrainingScheduler) extractSkills(agentID string, traces []ExecutionTrace) {
	s.mu.Lock()
	skills := s.skills
	s.mu.Unlock()
	if skills == nil {
		return
	}

	// 找出成功的轨迹
	successful := make([]ExecutionTrace, 0, len(traces))
	for i := range traces {
		if traces[i].Success {
			successful = append(successful, traces[i])
		}
	}
	if len(successful) == 0 {
		return
	}
	now := time.Now().UnixMilli()

	// 提炼工具使用模式 (保序计数 → 频次倒排 → top 3, 对齐 TS Map 语义)
	type patternCount struct {
		pattern string
		count   int
	}
	counts := make(map[string]int)
	order := make([]string, 0, len(successful))
	for i := range successful {
		key := strings.Join(successful[i].ToolsUsed, " → ")
		if _, seen := counts[key]; !seen {
			order = append(order, key)
		}
		counts[key]++
	}
	entries := make([]patternCount, 0, len(order))
	for _, k := range order {
		entries = append(entries, patternCount{pattern: k, count: counts[k]})
	}
	sort.SliceStable(entries, func(i, j int) bool { return entries[i].count > entries[j].count })
	if len(entries) > 3 {
		entries = entries[:3]
	}
	for i, e := range entries {
		skills.AddSkill(SkillEntry{
			ID:          fmt.Sprintf("auto-%s-%d-%d", agentID, now, i), // TS 为随机后缀, Go 用序号 (见头部差异)
			Domain:      strings.Split(agentID, "-")[0],
			Pattern:     fmt.Sprintf("有效的工具组合: %s (成功 %d 次)", e.pattern, e.count),
			Confidence:  clamp(float64(e.count)/5, 0, 1),
			UsageCount:  e.count,
			SuccessRate: 1.0,
			CreatedAt:   now,
			LastUsedAt:  now,
		})
	}

	// 提炼策略偏好 (最常用策略, 对齐 TS)
	stratCounts := make(map[string]int)
	stratOrder := make([]string, 0, len(successful))
	for i := range successful {
		key := successful[i].StrategyUsed
		if _, seen := stratCounts[key]; !seen {
			stratOrder = append(stratOrder, key)
		}
		stratCounts[key]++
	}
	var best patternCount
	hasBest := false
	for _, k := range stratOrder {
		if !hasBest || stratCounts[k] > best.count {
			best = patternCount{pattern: k, count: stratCounts[k]}
			hasBest = true
		}
	}
	if hasBest {
		skills.AddSkill(SkillEntry{
			ID:          fmt.Sprintf("auto-strategy-%s-%d", agentID, now),
			Domain:      strings.Split(agentID, "-")[0],
			Pattern:     fmt.Sprintf("推荐策略: %s (成功 %d 次)", best.pattern, best.count),
			Confidence:  clamp(float64(best.count)/5, 0, 1),
			UsageCount:  best.count,
			SuccessRate: 1.0,
			CreatedAt:   now,
			LastUsedAt:  now,
		})
	}
}

// Status 获取全局状态 (对齐 TS getGlobalStatus; agentStatuses 按 agentID 排序保证稳定输出)
func (s *TrainingScheduler) Status() TrainingSchedulerStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := TrainingSchedulerStatus{
		RegisteredAgents:      len(s.triggers),
		QueueLength:           len(s.queue),
		IsTraining:            s.training,
		TotalJobsProcessed:    s.totalJobsProcessed,
		TotalTracesProcessed:  s.totalTracesProcessed,
		TotalTrainingFailures: s.totalTrainingFailures,
	}
	ids := make([]string, 0, len(s.triggers))
	for id := range s.triggers {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		st.AgentStatuses = append(st.AgentStatuses, s.triggers[id].Status())
	}
	return st
}

// Shutdown 关闭时 flush 所有缓冲区 (对齐 TS shutdown):
// 各触发器缓冲轨迹提炼进技能库 → 清空触发器 → 停泵。
// 在途训练任务不等待 (与 TS 一致, 提交自带 5s 超时自然终止)。
func (s *TrainingScheduler) Shutdown() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	type flushJob struct {
		agentID string
		traces  []ExecutionTrace
	}
	var flushes []flushJob
	for id, t := range s.triggers {
		traces := t.ExportTraces()
		if len(traces) > 0 {
			flushes = append(flushes, flushJob{agentID: id, traces: traces})
		}
	}
	s.triggers = make(map[string]*AutoTrainingTrigger)
	done := s.done
	s.mu.Unlock()

	close(done) // 唤醒 pump 的间隔等待
	for _, f := range flushes {
		s.extractSkills(f.agentID, f.traces)
	}
}

// emit 事件出口: 先落库后广播 (对齐 court.go emit 纪律; source=agents.evolution)
func (s *TrainingScheduler) emit(ctx context.Context, typ string, payload map[string]any) {
	if s.store == nil || s.bus == nil {
		return
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return
	}
	if ev, err := s.store.AppendEvent(ctx, typ, "agents.evolution", raw); err == nil {
		s.bus.Publish(ev)
	}
}

// ════════════════════════════════════════════════════════════════
// EvolutionPipeline — Agent 进化管线门面
//
//   - 信誉阈值触发训练: 订阅 agent.reputation.updated, 聚合分 < 阈值
//     (默认 40/100) 且冷却已过 → 排空触发器缓冲送训 (reason=reputation_drop)
//   - 经验积累: ExperienceCache 门面 (指纹精确/模糊匹配 + 复用衰减 + 差评淘汰)
//   - checkpoint: 消费调度器 onPolicyUpdated 回调, 记账 + 广播 agent.policy.updated
//     + 透传决策层回调
// ════════════════════════════════════════════════════════════════

// EvolutionStatus 进化管线全局状态
type EvolutionStatus struct {
	Scheduler           TrainingSchedulerStatus     `json:"scheduler"`
	ExperienceCount     int                         `json:"experienceCount"`
	SkillCount          int                         `json:"skillCount"`
	Checkpoints         map[string]PolicyCheckpoint `json:"checkpoints"`
	ReputationThreshold float64                     `json:"reputationThreshold"`
}

// EvolutionPipeline Agent 进化管线 (组合训练调度器 + 经验缓存 + 技能库 + 信誉观察)
type EvolutionPipeline struct {
	scheduler  *TrainingScheduler
	experience *ExperienceCache

	mu             sync.Mutex
	checkpoints    map[string]PolicyCheckpoint
	ckptSeq        int
	repThreshold   float64
	lastRepTrigger map[string]int64 // agentID → 最近信誉触发毫秒时间戳 (冷却)

	// OnPolicyUpdated 决策层回调 (外部注入, 训练 checkpoint 后通知重置缓存;
	// 对齐 TS agent-decision-orchestrator 注入的 onPolicyUpdated)
	OnPolicyUpdated func(PolicyUpdatedEvent)

	store    *store.Store
	bus      *bus.EventBus
	busSubID int64
	stop     chan struct{}
	stopOnce sync.Once
}

// NewEvolutionPipeline 构造进化管线: 内部装配训练调度器 + 技能库 + 经验缓存,
// 并订阅事件总线监听信誉变更 (信誉阈值触发训练的自动入口)。
func NewEvolutionPipeline(client EvolutionClient, st *store.Store, b *bus.EventBus) *EvolutionPipeline {
	skills := NewSkillLibrary()
	sched := NewTrainingScheduler(client, skills, st, b)
	p := &EvolutionPipeline{
		scheduler:      sched,
		experience:     NewExperienceCache(),
		checkpoints:    make(map[string]PolicyCheckpoint),
		repThreshold:   evolutionReputationThreshold,
		lastRepTrigger: make(map[string]int64),
		store:          st,
		bus:            b,
		stop:           make(chan struct{}),
	}
	// checkpoint 记账挂到调度器回调 (先于外部 hook, 保证账先落)
	sched.OnPolicyUpdated = p.handlePolicyUpdated

	// 信誉观察: 订阅先于启动, 慢消费者丢帧由总线计数 (对齐总线纪律)
	subID, ch := b.Subscribe()
	p.busSubID = subID
	go p.watchReputation(ch)
	return p
}

// Scheduler 暴露训练调度器 (路由/决策引擎接线用)
func (p *EvolutionPipeline) Scheduler() *TrainingScheduler { return p.scheduler }

// Experience 暴露经验缓存 (复用查询/反馈路由用)
func (p *EvolutionPipeline) Experience() *ExperienceCache { return p.experience }

// Skills 暴露技能库
func (p *EvolutionPipeline) Skills() *SkillLibrary { return p.schedulerSkills() }

// schedulerSkills 读取调度器持有的技能库 (供 Skills() 访问器)
func (p *EvolutionPipeline) schedulerSkills() *SkillLibrary {
	return p.scheduler.skillLib()
}

// RegisterAgent 注册 Agent 训练触发器 (Agent 创建时调用; 对齐 TS registerAgent)
func (p *EvolutionPipeline) RegisterAgent(agentID, domain string) *AutoTrainingTrigger {
	return p.scheduler.RegisterAgent(agentID, domain)
}

// UnregisterAgent 注销 Agent 训练触发器
func (p *EvolutionPipeline) UnregisterAgent(agentID string) {
	p.scheduler.UnregisterAgent(agentID)
}

// RecordTrace 记录执行轨迹 (触发器路径: 批量满/成功率骤降 → 训练)
func (p *EvolutionPipeline) RecordTrace(ctx context.Context, trace ExecutionTrace) {
	p.scheduler.RecordTrace(ctx, trace)
}

// InjectTraces 手动注入轨迹 (从持久化存储恢复用)
func (p *EvolutionPipeline) InjectTraces(ctx context.Context, agentID string, traces []ExecutionTrace) {
	if t, ok := p.scheduler.Trigger(agentID); ok {
		t.InjectTraces(ctx, traces)
	}
}

// QueryTrainedPolicy 查询训练好的策略 (转发调度器; 1s 超时回退 action=0)
func (p *EvolutionPipeline) QueryTrainedPolicy(ctx context.Context, observation []float64) PolicyDecision {
	return p.scheduler.QueryTrainedPolicy(ctx, observation)
}

// ── 信誉阈值触发训练 (Go 扩展) ──────────────────────────────────

// OnReputationUpdated 信誉变更入口 (总线订阅自动调用; 也可手动直调):
// 聚合分低于阈值且冷却已过 → 排空触发器缓冲触发紧急训练。
func (p *EvolutionPipeline) OnReputationUpdated(ctx context.Context, agentID string, newScore float64) {
	p.mu.Lock()
	threshold := p.repThreshold
	if newScore >= threshold {
		p.mu.Unlock()
		return
	}
	now := time.Now().UnixMilli()
	if now-p.lastRepTrigger[agentID] < evolutionRepCooldownMs {
		p.mu.Unlock()
		return
	}
	p.lastRepTrigger[agentID] = now
	p.mu.Unlock()

	p.scheduler.TriggerReputationTraining(ctx, agentID, newScore)
}

// SetReputationThreshold 调整信誉触发阈值 (0..100 刻度)
func (p *EvolutionPipeline) SetReputationThreshold(threshold float64) {
	p.mu.Lock()
	p.repThreshold = threshold
	p.mu.Unlock()
}

// watchReputation 信誉事件观察循环: agent.reputation.updated → 阈值检查。
// (Shut down 时经 stop 退出并退订)
func (p *EvolutionPipeline) watchReputation(ch <-chan bus.Event) {
	for {
		select {
		case <-p.stop:
			return
		case ev, ok := <-ch:
			if !ok {
				return
			}
			if ev.Type != reputationEventName {
				continue
			}
			var pl struct {
				AgentID  string   `json:"agentId"`
				NewScore *float64 `json:"newScore"` // 指针区分 "缺失" 与 0 分
			}
			if json.Unmarshal(ev.Payload, &pl) != nil || pl.AgentID == "" || pl.NewScore == nil {
				continue
			}
			p.OnReputationUpdated(context.Background(), pl.AgentID, *pl.NewScore)
		}
	}
}

// ── 经验积累 (ExperienceCache 门面) ─────────────────────────────

// RecordExperience 保存经验 (Agent Loop 成功后调用; 首次入库广播事件)
func (p *EvolutionPipeline) RecordExperience(ctx context.Context, prompt string, toolSteps []ExperienceToolStep, finalAnswer string, tokenCost int, durationMs int64) bool {
	created := p.experience.Record(prompt, toolSteps, finalAnswer, tokenCost, durationMs)
	if created {
		p.emit(ctx, EventExperienceRecorded, map[string]any{
			"fingerprint": p.experience.FindFingerprint(prompt),
			"sourceType":  ExperienceSourceRacerLoop,
			"tokenCost":   tokenCost,
			"timestamp":   time.Now().UnixMilli(),
		})
	}
	return created
}

// SaveDirectLLMQA 保存简单问答经验 (短问答轻量缓存)
func (p *EvolutionPipeline) SaveDirectLLMQA(ctx context.Context, prompt, answer string, tokenCost int, durationMs int64) bool {
	created := p.experience.SaveDirectLLMQA(prompt, answer, tokenCost, durationMs)
	if created {
		p.emit(ctx, EventExperienceRecorded, map[string]any{
			"fingerprint": p.experience.FindFingerprint(prompt),
			"sourceType":  ExperienceSourceDirectQA,
			"tokenCost":   tokenCost,
			"timestamp":   time.Now().UnixMilli(),
		})
	}
	return created
}

// LookupExperience 查询经验 (精确/模糊指纹匹配)
func (p *EvolutionPipeline) LookupExperience(prompt string) *ExperienceLookup {
	return p.experience.Lookup(prompt)
}

// RecordExperienceReuse 记录经验被复用; 失效删除时广播事件
func (p *EvolutionPipeline) RecordExperienceReuse(ctx context.Context, fingerprint string, success bool) bool {
	valid := p.experience.RecordReuse(fingerprint, success)
	if !valid {
		p.emitExperienceInvalidated(ctx, fingerprint)
	}
	return valid
}

// RateExperience 经验打分 (👍/👎); 失效删除时广播事件
func (p *EvolutionPipeline) RateExperience(ctx context.Context, fingerprint string, positive bool) bool {
	valid := p.experience.RateExperience(fingerprint, positive)
	if !valid {
		p.emitExperienceInvalidated(ctx, fingerprint)
	}
	return valid
}

// FindExperienceFingerprint 根据问题文本定位经验指纹
func (p *EvolutionPipeline) FindExperienceFingerprint(prompt string) string {
	return p.experience.FindFingerprint(prompt)
}

// emitExperienceInvalidated 经验失效事件 (降级淘汰审计)
func (p *EvolutionPipeline) emitExperienceInvalidated(ctx context.Context, fingerprint string) {
	p.emit(ctx, EventExperienceInvalidated, map[string]any{
		"fingerprint": fingerprint,
		"reason":      "success_rate_below_threshold",
		"timestamp":   time.Now().UnixMilli(),
	})
}

// ── checkpoint 记账 (对齐 TS onPolicyUpdated 闭环) ──────────────

// handlePolicyUpdated 调度器回调入口: checkpoint 落账 → 广播 → 透传决策层回调
func (p *EvolutionPipeline) handlePolicyUpdated(ev PolicyUpdatedEvent) {
	p.mu.Lock()
	p.ckptSeq++
	ckpt := PolicyCheckpoint{
		AgentID:   ev.AgentID,
		WrittenAt: time.Now().UnixMilli(),
		Accepted:  ev.Accepted,
		Trained:   ev.Trained,
		Loss:      ev.Loss,
		Sequence:  p.ckptSeq,
	}
	p.checkpoints[ev.AgentID] = ckpt
	p.mu.Unlock()

	p.emit(context.Background(), EventPolicyUpdated, map[string]any{
		"agentId":           ev.AgentID,
		"accepted":          ev.Accepted,
		"trained":           ev.Trained,
		"checkpointWritten": ev.CheckpointWritten,
		"sequence":          ckpt.Sequence,
		"timestamp":         ckpt.WrittenAt,
	})

	// 决策层缓存重置钩子 (对齐 TS agent-decision-orchestrator 注入; 锁内快照,
	// 允许外部在管线启动后安全注入)
	p.mu.Lock()
	hook := p.OnPolicyUpdated
	p.mu.Unlock()
	if hook != nil {
		hook(ev)
	}
}

// Checkpoint 查询 Agent 最近一次策略 checkpoint
func (p *EvolutionPipeline) Checkpoint(agentID string) (PolicyCheckpoint, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	ckpt, ok := p.checkpoints[agentID]
	return ckpt, ok
}

// ── 状态 / 关闭 ────────────────────────────────────────────────

// Status 进化管线全局状态
func (p *EvolutionPipeline) Status() EvolutionStatus {
	p.mu.Lock()
	checkpoints := make(map[string]PolicyCheckpoint, len(p.checkpoints))
	for id, ckpt := range p.checkpoints {
		checkpoints[id] = ckpt
	}
	threshold := p.repThreshold
	p.mu.Unlock()
	return EvolutionStatus{
		Scheduler:           p.scheduler.Status(),
		ExperienceCount:     p.experience.Size(),
		SkillCount:          p.Skills().Size(),
		Checkpoints:         checkpoints,
		ReputationThreshold: threshold,
	}
}

// Shutdown 关闭管线: 退订信誉观察 → 调度器 flush 所有触发器缓冲进技能库。
func (p *EvolutionPipeline) Shutdown() {
	p.stopOnce.Do(func() {
		close(p.stop)
		if p.bus != nil {
			p.bus.Unsubscribe(p.busSubID)
		}
	})
	p.scheduler.Shutdown()
}

// emit 事件出口: 先落库后广播 (对齐 court.go emit 纪律; source=agents.evolution)
func (p *EvolutionPipeline) emit(ctx context.Context, typ string, payload map[string]any) {
	if p.store == nil || p.bus == nil {
		return
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return
	}
	if ev, err := p.store.AppendEvent(ctx, typ, "agents.evolution", raw); err == nil {
		p.bus.Publish(ev)
	}
}
