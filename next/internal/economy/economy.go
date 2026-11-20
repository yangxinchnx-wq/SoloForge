// ─────────────────────────────────────────────────────────────────
// economy — 多 Agent 代币化资源再分配经济引擎
// (从 TS src/core/economy/economy.ts 迁移)
//
// 职责: 政体变更时原子级重校准账户余额、流动性权重与税级。
//
// 语义对齐 TS:
//   - 台账: ledgerRegistry (accountId → {balance, frozenFunds,
//     taxTierFactor, lastUpdatedTick})
//   - 命令契约: DISTRIBUTE_ROLE_ALLOCATION_REWARD 注册到命令总线
//   - 角色乘数矩阵: WORKER 基础奖励 (society.economy.base_worker_reward,
//     默认 10.0, 税级 0.05); VALIDATOR ×2.5 (税级 0.12);
//     GOVERNOR ×5.0 (税级 0.20) — 乘数/税级均走配置中心
//   - 精度裁剪: parseClippedPrecision (society.economy.precision, 默认 4 位)
//   - 两阶段乐观锁: Begin (冻结版本基线) → 版本漂移即
//     ERR_SF_ECONOMY_RACE → 台账更新 → AttachPayload → Commit;
//     失败 Rollback + distribution_failed_count
//   - 时间线兜底: tickId 缺省取 kernel.currentTick
//   - 指标: tokens_minted_total / distribution_success_count /
//     distribution_failed_count
//
// 差异说明: TS tx.payload 直接赋值; Go 经 TransactionManager.AttachPayload
// (批次 6 补齐的等价入口)。经 AttachPayload 的事务载荷最终随
// transaction.committed 事件广播, 由 data 的 society-evolution 消费者
// 沉淀到 agent_economic_ledger (域=TokenEconomy) — 台账事实全链路闭环。
// ─────────────────────────────────────────────────────────────────
package economy

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strconv"
	"sync"
	"time"

	"soloforge/next/internal/kernel"
)

// 配置键 (对齐 TS configCenter key)
const (
	cfgEconomyPrecision        = "society.economy.precision"
	cfgEconomyBaseWorkerReward = "society.economy.base_worker_reward"
	cfgEconomyValidatorMult    = "society.economy.validator_mult"
	cfgEconomyGovernorMult     = "society.economy.governor_mult"
	cfgEconomyTaxTierWorker    = "society.economy.tax_tier_worker"
	cfgEconomyTaxTierValidator = "society.economy.tax_tier_validator"
	cfgEconomyTaxTierGovernor  = "society.economy.tax_tier_governor"
)

// 默认参数 (对齐 TS)
const (
	defaultPrecision        = 4
	defaultBaseWorkerReward = 10.0
	defaultValidatorMult    = 2.5
	defaultGovernorMult     = 5.0
	defaultTaxTierWorker    = 0.05
	defaultTaxTierValidator = 0.12
	defaultTaxTierGovernor  = 0.20
)

// 命令契约与错误码 (对齐 TS)
const (
	CmdDistributeRoleAllocationReward = "DISTRIBUTE_ROLE_ALLOCATION_REWARD"
	ErrEconomyRaceCode                = "ERR_SF_ECONOMY_RACE"

	RoleGovernor  = "GOVERNOR"
	RoleValidator = "VALIDATOR"
)

// 指标名 (对齐 TS metricsCollector)
const (
	MetricTokensMinted     = "society.economy.tokens_minted_total"
	MetricDistributionOK   = "society.economy.distribution_success_count"
	MetricDistributionFail = "society.economy.distribution_failed_count"
)

// LedgerEntry 经济台账条目 (对齐 TS EconomicLedgerEntry)
type LedgerEntry struct {
	AccountID       string  `json:"accountId"`
	Balance         float64 `json:"balance"`
	FrozenFunds     float64 `json:"frozenFunds"`
	TaxTierFactor   float64 `json:"taxTierFactor"`
	LastUpdatedTick int64   `json:"lastUpdatedTick"`
}

// MetricsInserter 指标注入接口 (*metrics.Collector 适配)
type MetricsInserter interface {
	Inc(name string)
	Add(name string, delta float64)
}

// TokenEconomyEngine 代币化流动性再分配引擎 (实现 kernel.Component)
type TokenEconomyEngine struct {
	kernel *kernel.RuntimeKernel

	mu     sync.RWMutex
	ledger map[string]LedgerEntry

	operational bool

	// Metrics 可选指标收集器
	Metrics MetricsInserter
}

// NewTokenEconomyEngine 构造经济引擎 (kernel 必须非 nil — 对齐 TS
// "Micro-kernel orchestration infrastructure nodes are absent")
func NewTokenEconomyEngine(k *kernel.RuntimeKernel) (*TokenEconomyEngine, error) {
	if k == nil {
		return nil, fmt.Errorf("CRITICAL_SF_CONSTITUTION: Micro-kernel orchestration infrastructure nodes are absent")
	}
	return &TokenEconomyEngine{kernel: k, ledger: make(map[string]LedgerEntry)}, nil
}

// Name 组件名 (实现 kernel.Component)
func (e *TokenEconomyEngine) Name() string { return "token_economy_engine" }

// InitializeEconomyPool 经济池热引导 (对齐 TS initializeEconomyPool):
// 注册资源分配宏执行管线到命令总线
func (e *TokenEconomyEngine) InitializeEconomyPool(ctx context.Context) error {
	e.mu.Lock()
	if e.operational {
		e.mu.Unlock()
		return nil
	}
	e.operational = true
	e.mu.Unlock()

	if cb := e.kernel.CommandBus(); cb != nil {
		cb.Register(CmdDistributeRoleAllocationReward, func(_ context.Context, payload json.RawMessage) (any, error) {
			var p struct {
				TraceID               string  `json:"traceId"`
				AgentID               string  `json:"agentId"`
				TargetRole            string  `json:"targetRole"`
				AllocationBonusFactor float64 `json:"allocationBonusFactor"`
				TickID                *int64  `json:"tickId"`
			}
			if err := json.Unmarshal(payload, &p); err != nil {
				return nil, err
			}
			return nil, e.executeResourceAllocationTransaction(context.Background(),
				p.TraceID, p.AgentID, p.TargetRole, p.AllocationBonusFactor, p.TickID)
		})
	}
	slog.Info("代币化流动性再分配飞轮已初始化")
	return nil
}

// Start 实现 kernel.Component
func (e *TokenEconomyEngine) Start(ctx context.Context) error { return e.InitializeEconomyPool(ctx) }

// Stop 实现 kernel.Component (对齐 TS shutdownEconomy)
func (e *TokenEconomyEngine) Stop(_ context.Context) error {
	e.ShutdownEconomy()
	return nil
}

// HealthCheck 组件健康 (实现 kernel.Component)
func (e *TokenEconomyEngine) HealthCheck(_ context.Context) bool {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.operational
}

// ShutdownEconomy 安全终止 (对齐 TS shutdownEconomy)
func (e *TokenEconomyEngine) ShutdownEconomy() {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.ledger = make(map[string]LedgerEntry)
	e.operational = false
	slog.Warn("代币化信用分配框架已安全终止")
}

// parseClippedPrecision 自适应小数精度裁剪 (对齐 TS parseClippedPrecision;
// 动态浮点精度解耦到配置中心)
func (e *TokenEconomyEngine) parseClippedPrecision(value float64) float64 {
	precision := defaultPrecision
	if e.kernel.Config != nil {
		precision = e.kernel.Config.GetInt(cfgEconomyPrecision, defaultPrecision)
	}
	if precision < 0 {
		precision = 0
	}
	if precision > 15 {
		precision = 15
	}
	v, _ := strconv.ParseFloat(strconv.FormatFloat(value, 'f', precision, 64), 64)
	return v
}

// executeResourceAllocationTransaction 动态弹性资源再分配原子事务
// (对齐 TS executeResourceAllocationTransaction)
func (e *TokenEconomyEngine) executeResourceAllocationTransaction(ctx context.Context,
	traceID, agentID, targetRole string, allocationBonusFactor float64, tickID *int64) error {

	// 时间线兜底守卫: tickId 缺省取内核逻辑时钟 (防 undefined 漂移)
	clockTick := int64(0)
	if tickID != nil {
		clockTick = *tickID
	} else {
		clockTick = e.kernel.Tick()
	}

	// 角色乘数矩阵
	baseWorkerReward := defaultBaseWorkerReward
	validatorMult := defaultValidatorMult
	governorMult := defaultGovernorMult
	taxTierWorker := defaultTaxTierWorker
	taxTierValidator := defaultTaxTierValidator
	taxTierGovernor := defaultTaxTierGovernor
	if e.kernel.Config != nil {
		baseWorkerReward = e.kernel.Config.GetFloat(cfgEconomyBaseWorkerReward, defaultBaseWorkerReward)
		validatorMult = e.kernel.Config.GetFloat(cfgEconomyValidatorMult, defaultValidatorMult)
		governorMult = e.kernel.Config.GetFloat(cfgEconomyGovernorMult, defaultGovernorMult)
		taxTierWorker = e.kernel.Config.GetFloat(cfgEconomyTaxTierWorker, defaultTaxTierWorker)
		taxTierValidator = e.kernel.Config.GetFloat(cfgEconomyTaxTierValidator, defaultTaxTierValidator)
		taxTierGovernor = e.kernel.Config.GetFloat(cfgEconomyTaxTierGovernor, defaultTaxTierGovernor)
	}

	rawReward := baseWorkerReward
	targetTaxTier := taxTierWorker
	switch targetRole {
	case RoleGovernor:
		rawReward = baseWorkerReward * governorMult
		targetTaxTier = taxTierGovernor
	case RoleValidator:
		rawReward = baseWorkerReward * validatorMult
		targetTaxTier = taxTierValidator
	}

	finalAllocatedCredit := e.parseClippedPrecision(rawReward * (1.0 + allocationBonusFactor))

	// [全链路两阶段乐观锁屏障]: 初始化事务隔离单元并断言版本状态
	initialVersion := e.kernel.Version()
	commandID := fmt.Sprintf("eco_%d", time.Now().UnixNano())
	tx, err := e.kernel.TransactionManager().Begin(commandID, e.Name(), map[string]any{
		"traceId": traceID, "agentId": agentID,
		"readVersionStamp": initialVersion, "executedAt": time.Now().UnixMilli(),
	})
	if err != nil {
		return err
	}

	fail := func(txPanic error) error {
		e.kernel.TransactionManager().Rollback(ctx, tx.CommandID, txPanic)
		e.metricInc(MetricDistributionFail)
		slog.Error("财务再分配计算崩溃, 原子状态已恢复",
			"traceId", traceID, "agentId", agentID, "err", txPanic)
		return txPanic
	}

	// 版本漂移 → 序列化事务不匹配
	if e.kernel.Version() != initialVersion {
		return fail(fmt.Errorf("%s: Serialization transactional mismatch on account balance tracking for id: %s",
			ErrEconomyRaceCode, agentID))
	}

	// 原子账户追踪载荷快照
	e.mu.Lock()
	prev, ok := e.ledger[agentID]
	if !ok {
		prev = LedgerEntry{
			AccountID: agentID, Balance: 0.0, FrozenFunds: 0.0,
			TaxTierFactor: taxTierWorker, LastUpdatedTick: clockTick,
		}
	}
	updated := LedgerEntry{
		AccountID:       agentID,
		Balance:         e.parseClippedPrecision(prev.Balance + finalAllocatedCredit),
		FrozenFunds:     prev.FrozenFunds,
		TaxTierFactor:   targetTaxTier,
		LastUpdatedTick: clockTick,
	}
	e.ledger[agentID] = updated
	e.mu.Unlock()

	// 再分配事实数据谱系打包到事务载荷容器 (提交后由 data 消费者沉淀台账)
	e.kernel.TransactionManager().AttachPayload(tx.ID, map[string]any{
		"agent_id":          agentID,
		"allocated_bonus":   finalAllocatedCredit,
		"new_balance":       updated.Balance,
		"tax_tier_snapshot": targetTaxTier,
		"serialized_at":     time.Now().UnixMilli(),
	})

	// 提交资源事务 (外层消费者截获该事实异步沉淀 SurrealDB/投影)
	if err := e.kernel.TransactionManager().Commit(ctx, tx.ID); err != nil {
		// 提交失败回滚台账变更
		e.mu.Lock()
		if ok {
			e.ledger[agentID] = prev
		} else {
			delete(e.ledger, agentID)
		}
		e.mu.Unlock()
		return fail(err)
	}

	e.metricAdd(MetricTokensMinted, finalAllocatedCredit)
	e.metricInc(MetricDistributionOK)
	return nil
}

// GetAccountSnapshot 账户快照 (返回副本; 不存在返回 false)
func (e *TokenEconomyEngine) GetAccountSnapshot(agentID string) (LedgerEntry, bool) {
	e.mu.RLock()
	defer e.mu.RUnlock()
	entry, ok := e.ledger[agentID]
	return entry, ok
}

func (e *TokenEconomyEngine) metricInc(name string) {
	if e.Metrics != nil {
		e.Metrics.Inc(name)
	}
}

func (e *TokenEconomyEngine) metricAdd(name string, delta float64) {
	if e.Metrics != nil {
		e.Metrics.Add(name, delta)
	}
}
