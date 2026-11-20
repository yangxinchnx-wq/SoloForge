// ─────────────────────────────────────────────────────────────────
// runtime_events.go — 内核运行时事件补充 + 逻辑时钟
//
// EventHeartbeat / EventSnapshotCreated 补齐 TS RuntimeEvent 枚举
// (附录 B 全局事件枚举) 的两个事件名, 供 broker.go / 编排时钟使用。
//
// Tick 为中央多路复用时钟驱动的逻辑时钟序列戳
// (TS kernel.currentTick; 编排器每 tick +1, 见 orchestrator.go)。
// ─────────────────────────────────────────────────────────────────
package kernel

import "context"

// 事件名 (对齐 TS RuntimeEvent.Heartbeat / RuntimeEvent.SnapshotCreated)
const (
	EventHeartbeat       = "runtime.heartbeat" // 心跳/链路状态/分裂脑告警
	EventSnapshotCreated = "snapshot.created"  // 遥测帧快照 (触发聚合消费者)
)

// Tick 当前逻辑时钟 tick
func (k *RuntimeKernel) Tick() int64 {
	k.mu.RLock()
	defer k.mu.RUnlock()
	return k.tick
}

// AdvanceTick 时钟步进 (编排器时钟飞轮调用; 返回新 tick)。
// 单线程串行因果连续性由 mu 串行化保证。
func (k *RuntimeKernel) AdvanceTick(_ context.Context) int64 {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.tick++
	return k.tick
}
