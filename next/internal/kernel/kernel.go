// ─────────────────────────────────────────────────────────────────
// kernel — 微内核运行时核心 (从 TS src/kernel/runtime-kernel.ts 迁移)
//
// 语义对齐:
//   - 状态机: BOOTING→INITIALIZING→READY→SHUTTING_DOWN→STOPPED,
//     异常路径 DEGRADED (降级) / PANIC (启动失败), 迁移受合法迁移表约束
//   - 运行时模式: NORMAL / RECOVERY (对齐 RuntimeMode)
//   - ExecuteCommand: 信封 {id?, type, domain, caller, payload}
//     (对齐 docs/protocol.md §5), 路由到命令总线; 命令总线未挂载时返回
//     {accepted:false, error:'CommandBus not initialized'} (对齐 TS);
//     执行失败转 {accepted:false, error} 不上抛 (对齐 TS catch 分支)
//   - 生命周期事件: kernel.initialized / runtime.shutdown /
//     runtime.mode.changed / runtime.recovery / command.accepted /
//     command.rejected (对齐 docs/protocol.md §6 RuntimeEvent)
//   - 组件注册表: Register 重复注册报错, Start 正序启动, Shutdown 逆序停止
//   - 预置域所有权 (state.go) 与配置中心 (config.go) 由构造器挂载
// Go 增强 (TS 无): 状态迁移合法性校验、ExecuteCommand 就绪态守卫
// 事件纪律对齐 internal/court/court.go: 先 store.AppendEvent 落库后
// bus.Publish 广播
// ─────────────────────────────────────────────────────────────────
package kernel

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"soloforge/next/internal/bus"
	"soloforge/next/internal/store"
)

// ── 状态机枚举 (对齐 TS RuntimeState / RuntimeMode) ─────────────

// RuntimeState 内核运行状态
type RuntimeState string

const (
	StateBooting      RuntimeState = "BOOTING"       // 冷启动中
	StateInitializing RuntimeState = "INITIALIZING"  // 组件初始化中
	StateReady        RuntimeState = "READY"         // 就绪, 接受命令
	StateDegraded     RuntimeState = "DEGRADED"      // 降级运行
	StateShuttingDown RuntimeState = "SHUTTING_DOWN" // 关闭中
	StateStopped      RuntimeState = "STOPPED"       // 已停止 (终态)
	StatePanic        RuntimeState = "PANIC"         // 启动失败
)

// RuntimeMode 运行时模式
type RuntimeMode string

const (
	ModeNormal   RuntimeMode = "NORMAL"   // 正常模式
	ModeRecovery RuntimeMode = "RECOVERY" // 恢复模式
)

// 生命周期/命令事件名 (对齐 docs/protocol.md §6 RuntimeEvent)
const (
	EventKernelInitialized  = "kernel.initialized"
	EventRuntimeShutdown    = "runtime.shutdown"
	EventRuntimeModeChanged = "runtime.mode.changed"
	EventRuntimeRecovery    = "runtime.recovery"
	EventCommandAccepted    = "command.accepted"
	EventCommandRejected    = "command.rejected"
)

// allowedTransitions 状态迁移合法性表 (Go 增强; TS transition 无条件)
var allowedTransitions = map[RuntimeState][]RuntimeState{
	StateBooting:      {StateInitializing},
	StateInitializing: {StateReady, StatePanic},
	StateReady:        {StateDegraded, StateShuttingDown, StatePanic},
	StateDegraded:     {StateReady, StateShuttingDown, StatePanic},
	StatePanic:        {StateShuttingDown},
	StateShuttingDown: {StateStopped},
	StateStopped:      {}, // 终态
}

// ── 组件与命令 ──────────────────────────────────────────────────

// Component 内核组件 (对齐 TS RuntimeComponent: name/start/stop/healthCheck)
type Component interface {
	Name() string
	Start(ctx context.Context) error
	Stop(ctx context.Context) error
	HealthCheck(ctx context.Context) bool
}

// Command 命令信封 (对齐 docs/protocol.md §5: {id?, type, domain, caller, payload})
type Command struct {
	ID      string          `json:"id,omitempty"`   // 命令 ID (可选)
	Type    string          `json:"type"`           // 命令名 (如 SYS_HEARTBEAT)
	Domain  string          `json:"domain"`         // 执行域
	Caller  string          `json:"caller"`         // 调用方
	Payload json.RawMessage `json:"payload,omitempty"` // 任意 JSON 载荷
}

// ── 内核 ────────────────────────────────────────────────────────

// RuntimeKernel 统一真相内核
type RuntimeKernel struct {
	store *store.Store // 事件先落"库"
	bus   *bus.EventBus // 后广播

	ID        string `json:"id"`        // 固定 kernel_sovereign_core (对齐 TS)
	StartedAt int64  `json:"startedAt"` // 启动时间 (unix ms)

	Config         *ConfigCenter          // 配置中心 (对齐 TS public configCenter)
	StateOwnership *StateOwnership        // 状态所有权注册表 (对齐 TS stateOwnership)

	mu         sync.RWMutex
	state      RuntimeState
	mode       RuntimeMode
	version    int64                   // 内核版本 (事务乐观锁基准)
	components map[string]Component    // 组件注册表
	order      []string                // 注册顺序 (Shutdown 逆序停止)
	cmdBus     *bus.CommandBus         // 命令总线 (bootstrap 挂载, 可为 nil)
	txMgr      *TransactionManager     // 事务管理器 (构造时创建)
}

// New 构造内核: 预置域所有权 (对齐 TS initializeDomainOwnership)、
// 挂载配置中心与事务管理器, 初始状态 BOOTING
func New(st *store.Store, b *bus.EventBus) *RuntimeKernel {
	k := &RuntimeKernel{
		store:          st,
		bus:            b,
		ID:             "kernel_sovereign_core",
		StartedAt:      time.Now().UnixMilli(),
		Config:         NewConfigCenter(nil),
		StateOwnership: NewStateOwnership(),
		state:          StateBooting,
		mode:           ModeNormal,
		components:     make(map[string]Component),
	}
	k.txMgr = NewTransactionManager(k)
	return k
}

// ── 组件生命周期 ────────────────────────────────────────────────

// Register 注册组件; 同名重复注册报错 (对齐 TS Component already registered)
func (k *RuntimeKernel) Register(c Component) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	if _, exists := k.components[c.Name()]; exists {
		return fmt.Errorf("[RuntimeKernel] Component already registered: %s", c.Name())
	}
	k.components[c.Name()] = c
	k.order = append(k.order, c.Name())
	return nil
}

// Start 启动全部组件: BOOTING→INITIALIZING→(正序 Start)→READY,
// 任一组件启动失败 → PANIC (对齐 TS startup failure 路径)
func (k *RuntimeKernel) Start(ctx context.Context) error {
	k.mu.Lock()
	if err := transition(k.state, StateInitializing); err != nil {
		k.mu.Unlock()
		return err
	}
	k.state = StateInitializing
	names := append([]string(nil), k.order...)
	k.mu.Unlock()

	for _, name := range names {
		k.mu.RLock()
		c := k.components[name]
		k.mu.RUnlock()
		if err := c.Start(ctx); err != nil {
			_ = k.transitionTo(StatePanic)
			return fmt.Errorf("[RuntimeKernel] Startup failure (%s): %w", name, err)
		}
	}

	if err := k.transitionTo(StateReady); err != nil {
		return err
	}
	k.emit(ctx, EventKernelInitialized, map[string]any{
		"kernelId":   k.ID,
		"components": names,
		"version":    k.Version(),
	})
	return nil
}

// Shutdown 优雅关闭: →SHUTTING_DOWN→(逆序 Stop)→STOPPED;
// 单个组件停止失败不中断其余组件 (对齐 TS 吞错继续), 错误汇总返回
func (k *RuntimeKernel) Shutdown(ctx context.Context) error {
	k.mu.Lock()
	if err := transition(k.state, StateShuttingDown); err != nil {
		k.mu.Unlock()
		return err
	}
	k.state = StateShuttingDown
	names := make([]string, 0, len(k.order))
	for i := len(k.order) - 1; i >= 0; i-- { // 逆序
		names = append(names, k.order[i])
	}
	k.mu.Unlock()

	var errs []error
	for _, name := range names {
		k.mu.RLock()
		c := k.components[name]
		k.mu.RUnlock()
		if err := c.Stop(ctx); err != nil {
			errs = append(errs, fmt.Errorf("stop %s: %w", name, err))
		}
	}

	if err := k.transitionTo(StateStopped); err != nil {
		return err
	}
	k.emit(ctx, EventRuntimeShutdown, map[string]any{
		"kernelId": k.ID,
		"errs":     len(errs),
	})
	if len(errs) > 0 {
		return fmt.Errorf("[RuntimeKernel] shutdown completed with errors: %v", errs)
	}
	return nil
}

// HealthCheck 全局健康检查: PANIC 直接 false, 其余为全部组件 AND
func (k *RuntimeKernel) HealthCheck(ctx context.Context) bool {
	k.mu.RLock()
	if k.state == StatePanic {
		k.mu.RUnlock()
		return false
	}
	components := make([]Component, 0, len(k.order))
	for _, name := range k.order {
		components = append(components, k.components[name])
	}
	k.mu.RUnlock()

	for _, c := range components {
		if !c.HealthCheck(ctx) {
			return false
		}
	}
	return true
}

// Components 组件名列表 (注册顺序)
func (k *RuntimeKernel) Components() []string {
	k.mu.RLock()
	defer k.mu.RUnlock()
	return append([]string(nil), k.order...)
}

// ── 状态与模式 ──────────────────────────────────────────────────

// State 当前状态
func (k *RuntimeKernel) State() RuntimeState {
	k.mu.RLock()
	defer k.mu.RUnlock()
	return k.state
}

// Mode 当前运行时模式
func (k *RuntimeKernel) Mode() RuntimeMode {
	k.mu.RLock()
	defer k.mu.RUnlock()
	return k.mode
}

// SetMode 切换运行时模式并广播 runtime.mode.changed (对齐 TS setMode)
func (k *RuntimeKernel) SetMode(ctx context.Context, mode RuntimeMode) {
	k.mu.Lock()
	k.mode = mode
	k.mu.Unlock()
	k.emit(ctx, EventRuntimeModeChanged, map[string]any{"mode": string(mode)})
}

// MarkDegraded 进入降级态 (READY→DEGRADED)
func (k *RuntimeKernel) MarkDegraded(ctx context.Context) error {
	if err := k.transitionTo(StateDegraded); err != nil {
		return err
	}
	k.emit(ctx, EventRuntimeModeChanged, map[string]any{
		"mode": string(k.Mode()), "state": string(StateDegraded),
	})
	return nil
}

// Recover 从降级态恢复 (DEGRADED→READY), 广播 runtime.recovery
func (k *RuntimeKernel) Recover(ctx context.Context) error {
	if err := k.transitionTo(StateReady); err != nil {
		return err
	}
	k.emit(ctx, EventRuntimeRecovery, map[string]any{"state": string(StateReady)})
	return nil
}

// transitionTo 状态迁移 (带合法性校验, 迁移失败返回错误)
func (k *RuntimeKernel) transitionTo(next RuntimeState) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	if err := transition(k.state, next); err != nil {
		return err
	}
	k.state = next
	return nil
}

// transition 纯函数: 校验 from→next 是否为合法迁移
func transition(from, next RuntimeState) error {
	for _, legal := range allowedTransitions[from] {
		if legal == next {
			return nil
		}
	}
	return fmt.Errorf("[RuntimeKernel] illegal state transition: %s -> %s", from, next)
}

// ── 版本 (事务乐观锁基准) ────────────────────────────────────────

// Version 当前内核版本 (每次事务提交 +1)
func (k *RuntimeKernel) Version() int64 {
	return k.currentVersion()
}

// currentVersion 内部读取版本号
func (k *RuntimeKernel) currentVersion() int64 {
	k.mu.RLock()
	defer k.mu.RUnlock()
	return k.version
}

// bumpVersion 版本推进 (仅 TransactionManager.Commit 成功路径调用)
func (k *RuntimeKernel) bumpVersion() int64 {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.version++
	return k.version
}

// ── 命令路由 ────────────────────────────────────────────────────

// SetCommandBus 挂载命令总线 (对齐 TS bootstrapCoreLinkages 的 commandBus 注入)
func (k *RuntimeKernel) SetCommandBus(cb *bus.CommandBus) {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.cmdBus = cb
}

// CommandBus 已挂载的命令总线 (未挂载返回 nil)
func (k *RuntimeKernel) CommandBus() *bus.CommandBus {
	k.mu.RLock()
	defer k.mu.RUnlock()
	return k.cmdBus
}

// TransactionManager 事务管理器 (构造时创建, 对齐 TS kernel.transactionManager)
func (k *RuntimeKernel) TransactionManager() *TransactionManager {
	return k.txMgr
}

// SetTransactionManager 替换事务管理器 (对齐 TS bootstrapCoreLinkages 注入)
func (k *RuntimeKernel) SetTransactionManager(tm *TransactionManager) {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.txMgr = tm
}

// ExecuteCommand 命令路由 (对齐 TS executeCommand):
//   - 内核须处于 READY/DEGRADED 才接受命令 (Go 增强守卫)
//   - 命令总线未挂载 → 返回 {accepted:false, error:'CommandBus not initialized'}
//   - 派发成功 → command.accepted, 返回 handler 结果
//   - 派发失败 → command.rejected, 返回 {accepted:false, error} 不上抛
//     (对齐 TS catch 分支; 返回值 error 恒为 nil, 调用方检查 accepted 字段)
func (k *RuntimeKernel) ExecuteCommand(ctx context.Context, cmd Command) (any, error) {
	state := k.State()
	if state != StateReady && state != StateDegraded {
		reason := fmt.Sprintf("kernel not ready (state=%s)", state)
		k.emit(ctx, EventCommandRejected, map[string]any{
			"type": cmd.Type, "domain": cmd.Domain, "caller": cmd.Caller, "error": reason,
		})
		return map[string]any{"accepted": false, "type": cmd.Type, "error": reason}, nil
	}

	cb := k.CommandBus()
	if cb == nil {
		// 对齐 TS: CommandBus not initialized, 命令丢弃
		k.emit(ctx, EventCommandRejected, map[string]any{
			"type": cmd.Type, "domain": cmd.Domain, "caller": cmd.Caller,
			"error": "CommandBus not initialized",
		})
		return map[string]any{"accepted": false, "type": cmd.Type, "error": "CommandBus not initialized"}, nil
	}

	res, err := cb.Dispatch(ctx, bus.Command{Type: cmd.Type, Payload: cmd.Payload})
	if err != nil {
		// 对齐 TS catch: 失败转结果对象, 不上抛
		k.emit(ctx, EventCommandRejected, map[string]any{
			"type": cmd.Type, "domain": cmd.Domain, "caller": cmd.Caller, "error": err.Error(),
		})
		return map[string]any{"accepted": false, "type": cmd.Type, "error": err.Error()}, nil
	}

	k.emit(ctx, EventCommandAccepted, map[string]any{
		"id": cmd.ID, "type": cmd.Type, "domain": cmd.Domain, "caller": cmd.Caller,
	})
	return res, nil
}

// ── 状态所有权访问器 (对齐 TS verifyOwnership / registerOwnership) ──

// VerifyOwnership 校验域是否拥有 key 的所有权 (通配符匹配)
func (k *RuntimeKernel) VerifyOwnership(domain, key string) bool {
	return k.StateOwnership.Resolve(domain, key)
}

// RegisterOwnership 注册域的状态所有权模式
func (k *RuntimeKernel) RegisterOwnership(domain, keyPattern string) {
	k.StateOwnership.Register(domain, keyPattern)
}

// ── 事件广播 (先落库后广播, 对齐 court.go emit 纪律) ───────────────

// emit 事件发射: store.AppendEvent 落库成功后才 bus.Publish 广播
func (k *RuntimeKernel) emit(ctx context.Context, typ string, payload map[string]any) {
	if k.store == nil || k.bus == nil {
		return // 无存储/总线环境 (如纯单测) 静默跳过
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		raw = json.RawMessage("{}")
	}
	if ev, err := k.store.AppendEvent(ctx, typ, "kernel", raw); err == nil {
		k.bus.Publish(ev)
	}
}
