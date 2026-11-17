// ─────────────────────────────────────────────────────────────────
// bus — 进程内事件总线 + 命令总线
//
// 语义对齐 docs/protocol.md:
//   - EventBus: 订阅/发布, 慢消费者丢帧计数 (对齐旧 AgentEventHub 行为)
//   - CommandBus: 注册/派发, 无 handler 时 passthrough 返回 success
//     (对齐旧 src/kernel/command-bus.ts:50-58 的兼容语义)
// ─────────────────────────────────────────────────────────────────
package bus

import (
	"context"
	"encoding/json"
	"sync"
	"sync/atomic"

	"soloforge/next/internal/store"
)

// Event = store.Event (类型别名统一: Publish 携带完整事件含 Seq,
// persist 持久化/重放才能拿到正确游标)
type Event = store.Event

// ── 事件总线 ────────────────────────────────────────────────────

type subscriber struct {
	id int64
	ch chan Event
}

type EventBus struct {
	mu      sync.RWMutex
	subs    map[int64]subscriber
	nextID  int64
	dropped atomic.Uint64
}

func NewEventBus() *EventBus {
	return &EventBus{subs: make(map[int64]subscriber)}
}

// Subscribe 注册订阅者 (缓冲 256, 慢消费者丢帧)
func (b *EventBus) Subscribe() (id int64, ch <-chan Event) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.nextID++
	id = b.nextID
	c := make(chan Event, 256)
	b.subs[id] = subscriber{id: id, ch: c}
	return id, c
}

func (b *EventBus) Unsubscribe(id int64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.subs, id)
}

// Publish 广播完整事件 (含 Seq, 由 store.AppendEvent 返回); 返回入参
func (b *EventBus) Publish(ev Event) Event {
	b.mu.RLock()
	defer b.mu.RUnlock()
	for _, s := range b.subs {
		select {
		case s.ch <- ev:
		default:
			b.dropped.Add(1) // 慢消费者丢帧, /metrics 暴露
		}
	}
	return ev
}

// Dropped 丢帧总数
func (b *EventBus) Dropped() uint64 { return b.dropped.Load() }

// Subscribers 当前订阅者数
func (b *EventBus) Subscribers() int {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return len(b.subs)
}

// ── 命令总线 ────────────────────────────────────────────────────

type Command struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

type Handler func(ctx context.Context, payload json.RawMessage) (any, error)

type CommandBus struct {
	mu       sync.RWMutex
	handlers map[string]Handler
}

func NewCommandBus() *CommandBus {
	return &CommandBus{handlers: make(map[string]Handler)}
}

func (b *CommandBus) Register(typ string, h Handler) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.handlers[typ] = h
}

// Dispatch 派发命令。无 handler 时 passthrough 返回 success (兼容旧语义)
func (b *CommandBus) Dispatch(ctx context.Context, cmd Command) (any, error) {
	b.mu.RLock()
	h, ok := b.handlers[cmd.Type]
	b.mu.RUnlock()
	if !ok {
		return map[string]any{
			"success":  true,
			"mode":     "passthrough",
			"command":  cmd.Type,
		}, nil
	}
	return h(ctx, cmd.Payload)
}