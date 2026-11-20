// ─────────────────────────────────────────────────────────────────
// sandbox.go — 沙箱隔离与热迁移引擎 (从 TS src/kernel/sandbox/isolation-slot.ts 迁移)
//
// 职责: 对多 Agent 脚本运行时实施安全执行边界, 在节点基础设施拥塞时
// 编排零停机微状态热迁移 (隔离槽位重定位)。
//
// 隔离方案适配 (待办清单注意项): 旧实现基于 V8 isolate 单线程隔离;
// Go 侧改为 goroutine 配额 + 内存配额记账的进程内虚拟隔离槽 —
// AgentSandboxProfile 记账字段 IsolateMemoryUsageBytes (内存配额) 与
// Goroutines (活跃 goroutine 配额), 槽间无共享可变状态, 迁移即
// profile 快照冻结 + 槽位重定位 (语义与 V8 isolate 迁移一致)。
//
// 语义对齐 TS:
//   - 隔离槽位管理: activeSlots 注册表 (agentId → profile),
//     GetSlotProfileProxy 返回副本 (防泄漏内部状态)
//   - 内存压力监测: 高频遥测钩子 UpdateHostLoadFactorTelemetry —
//     CPU ≥ 危急线 (society.sandbox.cpu_critical_bar, 默认 0.90) →
//     唤醒疏散: 每轮遥测扫描只疏散一个超重槽 (内存 >
//     society.sandbox.heavyweight_byte_line, 默认 10MB), 防系统性雷群
//   - 两段式版本锁热迁移: Begin (冻结乐观锁版本基线) → 双重版本校验
//     (内核版本漂移即 ERR_SF_SANDBOX_RACE) → 深拷贝冻结状态包 →
//     槽位重定位 → Commit → 广播 snapshot 事件; 失败 Rollback 回滚
//     并恢复基线槽位分配
//   - 降级/回收: 疏散目标 fallback 槽 (society.sandbox.fallback_safe_slot_id,
//     默认 isolated_failover_slot_omega); ClearSandboxRegistry 全量回收
//
// ─────────────────────────────────────────────────────────────────
package kernel

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"time"
)

// 沙箱配置键 (对齐 TS configCenter key)
const (
	cfgSandboxCPUCriticalBar  = "society.sandbox.cpu_critical_bar"
	cfgSandboxHeavyweightLine = "society.sandbox.heavyweight_byte_line"
	cfgSandboxFallbackSlot    = "society.sandbox.fallback_safe_slot_id"
)

// 沙箱默认参数 (对齐 TS)
const (
	defaultSandboxCPUCriticalBar  = 0.90
	defaultSandboxHeavyweightLine = 10485760 // 10MB
	defaultSandboxFallbackSlot    = "isolated_failover_slot_omega"

	// migrationSerializeOverhead 迁移序列化记账开销 (TS: +512 bytes)
	migrationSerializeOverhead = 512
)

// 沙箱命令/事件名 (对齐 TS commandBus handler 注册名)
const (
	CmdMigrateSandboxContext = "MIGRATE_SANDBOX_CONTEXT"
	SandboxCallerWatchdog    = "WATCHDOG_HARDWARE_EVACUATOR_ROUTINE"

	// 疏散原因码 (对齐 TS evictionReasonCode)
	EvictionHardwareExhaustion = "NODE_HARDWARE_RESOURCE_EXHAUSTION_CRITICAL_BYPASS"

	// 沙箱错误 (对齐 TS ERR_SF_SANDBOX_*)
	ErrSandboxMissingCode = "ERR_SF_SANDBOX_MISSING"
	ErrSandboxRaceCode    = "ERR_SF_SANDBOX_RACE"
)

// AgentSandboxProfile 沙箱隔离槽档案 (Go 适配: goroutine/内存配额记账
// 替代 V8 isolate)
type AgentSandboxProfile struct {
	AgentID                 string  `json:"agentId"`
	AssignedSlotID          string  `json:"assignedSlotId"`
	CurrentRoleState        string  `json:"currentRoleState"`
	ReputationScoreSnapshot float64 `json:"reputationScoreSnapshot"`
	EconomicBalanceSnapshot float64 `json:"economicBalanceSnapshot"`
	FactionCoalitionID      string  `json:"factionCoalitionId"`
	MemoryStateChecksum     string  `json:"memoryStateChecksum"`
	// IsolateMemoryUsageBytes 隔离槽内存配额记账 (V8 isolate 字段的 Go 适配)
	IsolateMemoryUsageBytes int64 `json:"isolateMemoryUsageBytes"`
	// Goroutines 活跃 goroutine 配额 (Go 侧隔离单位)
	Goroutines     int   `json:"goroutines"`
	LastActiveTick int64 `json:"lastActiveTick"`
}

// MigrationManifest 热迁移清单 (对齐 TS MigrationManifest)
type MigrationManifest struct {
	MigrationID       string              `json:"migrationId"`
	AgentID           string              `json:"agentId"`
	SourceSlotID      string              `json:"sourceSlotId"`
	TargetSlotID      string              `json:"targetSlotId"`
	FrozenStatePacket AgentSandboxProfile `json:"frozenStatePacket"`
	KernelVersionSeal int64               `json:"kernelVersionSeal"`
	MigratedAtTick    int64               `json:"migratedAtTick"`
	Timestamp         int64               `json:"timestamp"`
}

// SandboxMigrationEngine 沙箱隔离与热迁移引擎 (实现 Component)
type SandboxMigrationEngine struct {
	kernel *RuntimeKernel

	mu          sync.RWMutex
	activeSlots map[string]*AgentSandboxProfile // agentId → profile (内部可变)
	loadFactor  float64                         // 最近一次主机载荷因子

	operational bool
	stop        chan struct{}
	stopOnce    sync.Once

	// Metrics 可选指标收集器 (TS metricsCollector.counter)
	Metrics MetricsInserter
}

// NewSandboxMigrationEngine 构造沙箱引擎 (kernel 必须非 nil — 对齐 TS
// "Core transaction orchestrators and monitoring totalizers must be pre-bound")
func NewSandboxMigrationEngine(k *RuntimeKernel) (*SandboxMigrationEngine, error) {
	if k == nil {
		return nil, fmt.Errorf("CRITICAL_SF_CONSTITUTION: Core transaction orchestrators and monitoring totalizers must be pre-bound")
	}
	return &SandboxMigrationEngine{
		kernel:      k,
		activeSlots: make(map[string]*AgentSandboxProfile),
		stop:        make(chan struct{}),
	}, nil
}

// Name 组件名 (实现 Component)
func (s *SandboxMigrationEngine) Name() string { return "sandbox_migration_engine" }

// Boot 沙箱注册表引导器 (对齐 TS bootSandboxRegistry):
// 注册 MIGRATE_SANDBOX_CONTEXT 命令处理器到内核命令总线
func (s *SandboxMigrationEngine) Boot(ctx context.Context) error {
	s.mu.Lock()
	if s.operational {
		s.mu.Unlock()
		return nil
	}
	s.operational = true
	s.mu.Unlock()

	if cb := s.kernel.CommandBus(); cb != nil {
		cb.Register(CmdMigrateSandboxContext, func(_ context.Context, payload json.RawMessage) (any, error) {
			var p struct {
				TraceID            string `json:"traceId"`
				AgentID            string `json:"agentId"`
				TargetSlotID       string `json:"targetSlotId"`
				EvictionReasonCode string `json:"evictionReasonCode"`
			}
			if err := json.Unmarshal(payload, &p); err != nil {
				return nil, err
			}
			return s.handleLiveMigrationTransaction(context.Background(),
				p.TraceID, p.AgentID, p.TargetSlotID, p.EvictionReasonCode)
		})
	}
	slog.Info("沙箱隔离与热迁移引擎已激活 (Go 虚拟隔离槽方案)")
	return nil
}

// Start 实现 Component (沙箱无需常驻循环, Boot 即完成引导)
func (s *SandboxMigrationEngine) Start(ctx context.Context) error { return s.Boot(ctx) }

// Stop 实现 Component (对齐 TS clearSandboxRegistry 的运行态复位)
func (s *SandboxMigrationEngine) Stop(_ context.Context) error {
	s.mu.Lock()
	s.operational = false
	s.mu.Unlock()
	return nil
}

// HealthCheck 组件健康 (实现 Component)
func (s *SandboxMigrationEngine) HealthCheck(_ context.Context) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.operational
}

// handleLiveMigrationTransaction 两段式版本锁热迁移飞轮
// (对齐 TS handleLiveMigrationTransaction)
func (s *SandboxMigrationEngine) handleLiveMigrationTransaction(ctx context.Context,
	traceID, agentID, targetSlotID, evictionReasonCode string) (*MigrationManifest, error) {

	s.mu.Lock()
	source, ok := s.activeSlots[agentID]
	if !ok {
		s.mu.Unlock()
		return nil, fmt.Errorf("%s: Agent context profile %s absent from active sandbox registry", ErrSandboxMissingCode, agentID)
	}
	// 快照读取 (锁定期间拷贝必要字段, 释放锁后走事务流程)
	sourceSlot := source.AssignedSlotID
	sourceMem := source.IsolateMemoryUsageBytes
	sourceChecksum := source.MemoryStateChecksum
	s.mu.Unlock()

	initialVersion := s.kernel.Version()
	currentTick := s.kernel.Tick()

	// [乐观锁 Phase 1]: 开启事务容器, 冻结当前全局因果版本戳
	commandID := newSandboxID("cmd")
	tx, err := s.kernel.TransactionManager().Begin(commandID, s.Name(), map[string]any{
		"traceId": traceID, "agentId": agentID,
		"sourceSlot": sourceSlot, "targetSlotId": targetSlotID,
		"readVersionStamp": initialVersion,
	})
	if err != nil {
		return nil, err
	}

	defer func() {
		if r := recover(); r != nil {
			s.kernel.TransactionManager().Rollback(ctx, commandID, fmt.Errorf("%v", r))
			panic(r)
		}
	}()

	fail := func(err error) (*MigrationManifest, error) {
		// 刚性事务回滚, 绝对弹性自愈
		s.kernel.TransactionManager().Rollback(ctx, tx.CommandID, err)
		s.metricInc("governor.sandbox.migrations_failed_total")
		slog.Error("沙箱热迁移在竞态碰撞下崩溃, 已恢复基线槽位分配",
			"agentId", agentID, "traceId", traceID, "err", err)
		return nil, err
	}

	// [乐观锁 Phase 2]: 迁移前双重交叉版本锁确认
	if s.kernel.Version() != initialVersion {
		return fail(fmt.Errorf("%s: Macro kernel state changed during asynchronous sandbox context serialization", ErrSandboxRaceCode))
	}

	// Step 1: 不可变深拷贝冻结 Agent 运行时档案 (防突变泄漏)
	frozen := AgentSandboxProfile{
		AgentID:                 agentID,
		AssignedSlotID:          targetSlotID,
		CurrentRoleState:        s.slotRoleState(agentID),
		ReputationScoreSnapshot: s.slotReputation(agentID),
		EconomicBalanceSnapshot: s.slotEconomic(agentID),
		FactionCoalitionID:      s.slotFaction(agentID),
		MemoryStateChecksum:     sourceChecksum,
		IsolateMemoryUsageBytes: sourceMem + migrationSerializeOverhead,
		Goroutines:              s.slotGoroutines(agentID),
		LastActiveTick:          currentTick,
	}

	manifest := &MigrationManifest{
		MigrationID:       newSandboxID("mig_manifest_"),
		AgentID:           agentID,
		SourceSlotID:      sourceSlot,
		TargetSlotID:      targetSlotID,
		FrozenStatePacket: frozen,
		KernelVersionSeal: initialVersion,
		MigratedAtTick:    currentTick,
		Timestamp:         time.Now().UnixMilli(),
	}

	// Step 2: 变更本地记账 — 追踪坐标重定位到目标槽
	s.mu.Lock()
	if src, ok := s.activeSlots[agentID]; ok {
		src.AssignedSlotID = targetSlotID
		src.LastActiveTick = currentTick
		src.IsolateMemoryUsageBytes = frozen.IsolateMemoryUsageBytes
	}
	s.mu.Unlock()

	// 历史迁移指纹打包到事务信封
	s.kernel.TransactionManager().AttachPayload(tx.ID, map[string]any{
		"manifest_id":               manifest.MigrationID,
		"eviction_code":             evictionReasonCode,
		"serialized_state_checksum": frozen.MemoryStateChecksum,
		"relocated_bytes":           frozen.IsolateMemoryUsageBytes,
		"clock_tick_marker":         currentTick,
		"finalized_at":              manifest.Timestamp,
	})

	// 提交所有权迁移事实 (事件总线向最外消费层广播标准完成事实)
	if err := s.kernel.TransactionManager().Commit(ctx, tx.ID); err != nil {
		return fail(err)
	}

	// 级联系统遥测: 运行时快照变更通知
	s.kernel.emit(ctx, EventSnapshotCreated, map[string]any{
		"domain":       s.Name(),
		"checkpointId": manifest.MigrationID,
		"metadata":     manifest,
	})

	s.metricInc("governor.sandbox.migrations_success_total")
	s.metricAdd("governor.sandbox.migrated_bytes_total", float64(frozen.IsolateMemoryUsageBytes))
	return manifest, nil
}

// ── 高频热遥测钩子 ──────────────────────────────────────────────

// UpdateHostLoadFactorTelemetry 主机 CPU 载荷因子评估 (对齐 TS 同名):
// 载荷 ≥ 危急线 → 动态触发自动热迁移, 疏散最高消耗沙箱槽。
// 每轮遥测扫描只疏散一个超重档案, 防系统性雷群。
func (s *SandboxMigrationEngine) UpdateHostLoadFactorTelemetry(ctx context.Context, traceID string, currentCPULoad float64) {
	s.mu.Lock()
	s.loadFactor = currentCPULoad
	s.mu.Unlock()

	cpuBar := defaultSandboxCPUCriticalBar
	heavyLine := int64(defaultSandboxHeavyweightLine)
	fallbackSlot := defaultSandboxFallbackSlot
	if s.kernel.Config != nil {
		cpuBar = s.kernel.Config.GetFloat(cfgSandboxCPUCriticalBar, defaultSandboxCPUCriticalBar)
		heavyLine = int64(s.kernel.Config.GetFloat(cfgSandboxHeavyweightLine, defaultSandboxHeavyweightLine))
		fallbackSlot = s.kernel.Config.GetString(cfgSandboxFallbackSlot, defaultSandboxFallbackSlot)
	}

	if currentCPULoad < cpuBar {
		return
	}

	s.metricInc("governor.sandbox.critical_threshold_tripped")
	slog.Error("硬件耗尽临界! 发起疏散", "load", fmt.Sprintf("%.2f%%", currentCPULoad*100), "bar", fmt.Sprintf("%.2f%%", cpuBar*100))

	// 自动识别最高消耗沙箱槽 (内存超重线的第一个; 每轮一个)
	var victim string
	s.mu.RLock()
	for agentID, profile := range s.activeSlots {
		if profile.IsolateMemoryUsageBytes > heavyLine {
			victim = agentID
			break
		}
	}
	s.mu.RUnlock()
	if victim == "" {
		return
	}

	// 非阻塞级联派发到命令总线, 把超重档案冲刷出拥塞节点槽
	payload, _ := json.Marshal(map[string]any{
		"traceId":            traceID,
		"agentId":            victim,
		"targetSlotID":       fallbackSlot,
		"evictionReasonCode": EvictionHardwareExhaustion,
	})
	// 失败局限在孤立异步事务树内 (ExecuteCommand 失败转结果不上抛)
	go s.kernel.ExecuteCommand(ctx, Command{
		ID:      newSandboxID(""),
		Type:    CmdMigrateSandboxContext,
		Domain:  s.Name(),
		Caller:  SandboxCallerWatchdog,
		Payload: payload,
	})
}

// LoadFactor 最近一次主机载荷因子 (观测用)
func (s *SandboxMigrationEngine) LoadFactor() float64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.loadFactor
}

// ── 槽位管理 ────────────────────────────────────────────────────

// RegisterAgentToSlot 注册 Agent 到隔离槽
func (s *SandboxMigrationEngine) RegisterAgentToSlot(profile AgentSandboxProfile) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := profile
	s.activeSlots[profile.AgentID] = &p
}

// GetSlotProfileProxy 槽档案代理 (返回副本, 防内部状态泄漏)
func (s *SandboxMigrationEngine) GetSlotProfileProxy(agentID string) (AgentSandboxProfile, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	p, ok := s.activeSlots[agentID]
	if !ok {
		return AgentSandboxProfile{}, false
	}
	return *p, true
}

// Slots 已注册槽数量
func (s *SandboxMigrationEngine) Slots() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.activeSlots)
}

// ClearSandboxRegistry 全量回收 (对齐 TS clearSandboxRegistry)
func (s *SandboxMigrationEngine) ClearSandboxRegistry() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.activeSlots = make(map[string]*AgentSandboxProfile)
	s.operational = false
}

// ── 槽档案字段读取 (迁移冻结时填充; 槽不存在返回零值) ────────────

func (s *SandboxMigrationEngine) slotField(agentID string, fn func(*AgentSandboxProfile)) {
	s.mu.RLock()
	p, ok := s.activeSlots[agentID]
	s.mu.RUnlock()
	if ok {
		fn(p)
	}
}

func (s *SandboxMigrationEngine) slotRoleState(agentID string) string {
	out := ""
	s.slotField(agentID, func(p *AgentSandboxProfile) { out = p.CurrentRoleState })
	return out
}

func (s *SandboxMigrationEngine) slotReputation(agentID string) float64 {
	out := 0.0
	s.slotField(agentID, func(p *AgentSandboxProfile) { out = p.ReputationScoreSnapshot })
	return out
}

func (s *SandboxMigrationEngine) slotEconomic(agentID string) float64 {
	out := 0.0
	s.slotField(agentID, func(p *AgentSandboxProfile) { out = p.EconomicBalanceSnapshot })
	return out
}

func (s *SandboxMigrationEngine) slotFaction(agentID string) string {
	out := ""
	s.slotField(agentID, func(p *AgentSandboxProfile) { out = p.FactionCoalitionID })
	return out
}

func (s *SandboxMigrationEngine) slotGoroutines(agentID string) int {
	out := 0
	s.slotField(agentID, func(p *AgentSandboxProfile) { out = p.Goroutines })
	return out
}

// ── 内部工具 ────────────────────────────────────────────────────

func (s *SandboxMigrationEngine) metricInc(name string) {
	if s.Metrics != nil {
		s.Metrics.Inc(name)
	}
}

func (s *SandboxMigrationEngine) metricAdd(name string, delta float64) {
	if h, ok := s.Metrics.(interface{ Add(string, float64) }); ok && s.Metrics != nil {
		h.Add(name, delta)
	}
}

// newSandboxID 沙箱域 ID (mig_manifest_/cmd 前缀 + 16 hex, 对齐 TS)
func newSandboxID(prefix string) string {
	var buf [8]byte
	_, _ = rand.Read(buf[:])
	return prefix + hex.EncodeToString(buf[:])
}
