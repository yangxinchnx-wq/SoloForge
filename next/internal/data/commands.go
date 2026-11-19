// ─────────────────────────────────────────────────────────────────
// data — 数据层总装 + 命令注册
//
// Service 一次组装: 投影仓 + outbox worker + 12 消费者注册表 + 删除保护。
// RegisterCommands 把数据层查询/运维能力挂到 bus.CommandBus
// (命令清单见 registerCommands)。
// ─────────────────────────────────────────────────────────────────
package data

import (
	"context"
	"encoding/json"

	"soloforge/next/internal/bus"
	"soloforge/next/internal/store"
)

// Service 数据层总装 (持有所属组件, main 只需构造 + Start/Stop)
type Service struct {
	Store       *store.Store
	Bus         *bus.EventBus
	Projections *Projections      // 12 消费者的投影仓
	Outbox      *Outbox           // outbox worker (pending→dead 状态机)
	Protection  *DeleteProtection // 删除保护 (软删/恢复/清除)
	registry    *Registry
}

// New 构造数据层 (deliver 为 outbox 投递回调注入; 传 nil 时记录滞留
// pending, 不投递 — 纯进程内部署)
func New(st *store.Store, b *bus.EventBus, deliver DeliverFunc) *Service {
	p := NewProjections()
	return &Service{
		Store:       st,
		Bus:         b,
		Projections: p,
		Outbox:      NewOutbox(st, b, deliver, DefaultOutboxConfig()),
		Protection:  NewDeleteProtection(st, b),
		registry:    NewRegistry(st, b, DefaultConsumers(p)...),
	}
}

// Start 启动消费者分发与 outbox 轮询 (ctx 取消或 Stop 结束)
func (s *Service) Start(ctx context.Context) {
	s.registry.Start(ctx)
	s.Outbox.Start(ctx)
}

// Stop 停止全部后台协程
func (s *Service) Stop() {
	s.Outbox.Stop()
	s.registry.Stop()
}

// ConsumerStats 消费者统计透出
func (s *Service) ConsumerStats() []ConsumerStat { return s.registry.Stats() }

// Registry 消费者注册表句柄 (供 main 接线 RegisterCommands)
func (s *Service) Registry() *Registry { return s.registry }

// ── 命令注册 ─────────────────────────────────────────────────────

// RegisterCommands 把数据层命令挂到命令总线 (组件可传 nil 跳过对应命令;
// 命令 handler 返回 map/slice, 对齐 bus.CommandBus 的 any 约定)。
func RegisterCommands(cb *bus.CommandBus, st *store.Store, ob *Outbox, reg *Registry, dp *DeleteProtection, p *Projections) {
	if cb == nil {
		return
	}
	// data.events.list — 事件查询 (对齐 GET /api/events/list, 增 type 过滤)
	// payload: {after, limit, type}
	if st != nil {
		cb.Register("data.events.list", func(ctx context.Context, payload json.RawMessage) (any, error) {
			var q ListQuery
			if len(payload) > 0 {
				if err := json.Unmarshal(payload, &q); err != nil {
					return nil, err
				}
			}
			return ListEvents(ctx, st, q)
		})
	}
	// data.outbox.stats / data.outbox.pending / data.outbox.dead /
	// data.outbox.append {kind, payload} / data.outbox.requeue {id}
	if ob != nil {
		cb.Register("data.outbox.stats", func(_ context.Context, _ json.RawMessage) (any, error) {
			return ob.Stats(), nil
		})
		cb.Register("data.outbox.pending", func(_ context.Context, _ json.RawMessage) (any, error) {
			return ob.Pending(), nil
		})
		cb.Register("data.outbox.dead", func(_ context.Context, _ json.RawMessage) (any, error) {
			return ob.Dead(), nil
		})
		cb.Register("data.outbox.append", func(_ context.Context, payload json.RawMessage) (any, error) {
			var req struct {
				Kind    string          `json:"kind"`
				Payload json.RawMessage `json:"payload"`
			}
			if err := json.Unmarshal(payload, &req); err != nil || req.Kind == "" {
				return nil, errBadPayload("data.outbox.append", "kind")
			}
			rec, err := ob.Append(req.Kind, req.Payload)
			if err != nil {
				return nil, err
			}
			return rec, nil
		})
		cb.Register("data.outbox.requeue", func(_ context.Context, payload json.RawMessage) (any, error) {
			var req struct {
				ID string `json:"id"`
			}
			if err := json.Unmarshal(payload, &req); err != nil || req.ID == "" {
				return nil, errBadPayload("data.outbox.requeue", "id")
			}
			return map[string]any{"requeued": ob.RequeueDead(req.ID), "id": req.ID}, nil
		})
	}
	// data.projections.table {name, limit} / data.projections.metrics /
	// data.consumers.stats
	if p != nil {
		cb.Register("data.projections.table", func(_ context.Context, payload json.RawMessage) (any, error) {
			var req struct {
				Name  string `json:"name"`
				Limit int    `json:"limit"`
			}
			if err := json.Unmarshal(payload, &req); err != nil || req.Name == "" {
				return nil, errBadPayload("data.projections.table", "name")
			}
			return map[string]any{
				"name":  req.Name,
				"rows":  p.Table(req.Name, req.Limit),
				"count": p.Count(req.Name),
			}, nil
		})
		cb.Register("data.projections.metrics", func(_ context.Context, _ json.RawMessage) (any, error) {
			counters, entropy := p.Metrics()
			return map[string]any{"counters": counters, "entropy": entropy}, nil
		})
		cb.Register("data.projections.tables", func(_ context.Context, _ json.RawMessage) (any, error) {
			return p.Tables(), nil
		})
	}
	if reg != nil {
		cb.Register("data.consumers.stats", func(_ context.Context, _ json.RawMessage) (any, error) {
			return reg.Stats(), nil
		})
	}
	// data.trash.list / data.trash.restore {targetId} / data.trash.purge {targetId}
	if dp != nil {
		cb.Register("data.trash.list", func(_ context.Context, _ json.RawMessage) (any, error) {
			return dp.TrashManifest(), nil
		})
		cb.Register("data.trash.restore", func(ctx context.Context, payload json.RawMessage) (any, error) {
			var req struct {
				TargetID string `json:"targetId"`
			}
			if err := json.Unmarshal(payload, &req); err != nil || req.TargetID == "" {
				return nil, errBadPayload("data.trash.restore", "targetId")
			}
			entry, err := dp.Restore(ctx, req.TargetID)
			if err != nil {
				return nil, err
			}
			return entry, nil
		})
		cb.Register("data.trash.purge", func(ctx context.Context, payload json.RawMessage) (any, error) {
			var req struct {
				TargetID string `json:"targetId"`
			}
			if err := json.Unmarshal(payload, &req); err != nil || req.TargetID == "" {
				return nil, errBadPayload("data.trash.purge", "targetId")
			}
			ok, err := dp.Purge(ctx, req.TargetID)
			return map[string]any{"purged": ok}, err
		})
	}
}

// RegisterCommands 自有组件注册 (便捷入口)
func (s *Service) RegisterCommands(cb *bus.CommandBus) {
	if s == nil {
		return
	}
	RegisterCommands(cb, s.Store, s.Outbox, s.registry, s.Protection, s.Projections)
}

// errBadPayload 命令载荷缺失字段错误
func errBadPayload(cmd, field string) error {
	return &badPayloadError{cmd: cmd, field: field}
}

type badPayloadError struct{ cmd, field string }

func (e *badPayloadError) Error() string {
	return "命令 " + e.cmd + " 载荷需含字段: " + e.field
}
