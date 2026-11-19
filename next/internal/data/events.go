// ─────────────────────────────────────────────────────────────────
// data — 事件查询辅助 (从 TS src/data/repositories/event-log-repository.ts
//
//	与 GET /api/events/list 语义迁移)
//
// 语义对齐:
//   - TxEnvelope: docs/protocol.md §6 TransactionCommitted 载荷
//     {domain, txId, version, traceId, data}
//     (Go 内核 emitCommitted 额外带 commandId/timestamp, 此处一并兼容)
//   - ListQuery/ListResult: 对齐 GET /api/events/list 的 after 游标 + limit
//     分页; type 过滤为 Go 增强 (对应 TS event-log-repository 的
//     findEventsByType 语义)
//
// ─────────────────────────────────────────────────────────────────
package data

import (
	"context"
	"encoding/json"

	"soloforge/next/internal/bus"
	"soloforge/next/internal/store"
)

// TransactionCommitted 事件类型 (对齐 docs/protocol.md §6 RuntimeEvent;
// 与 kernel.EventTransactionCommitted 同名, 此处独立声明避免包耦合)
const EventTypeTransactionCommitted = "transaction.committed"

// ── TransactionCommitted 信封 ───────────────────────────────────

// TxEnvelope TransactionCommitted 载荷信封 (protocol §6:
// {domain, txId, version, traceId, data})
type TxEnvelope struct {
	Domain    string          `json:"domain"`              // 执行域 (e.g. ConsensAgentCourt)
	TxID      string          `json:"txId"`                // 事务 ID (tx_<unixmilli>_<hex8>)
	Version   int64           `json:"version"`             // 提交后内核版本
	TraceID   string          `json:"traceId,omitempty"`   // 全链路追踪 ID (Go 内核暂不携带, 保留兼容)
	CommandID string          `json:"commandId,omitempty"` // 关联命令 (Go 增强)
	Timestamp int64           `json:"timestamp,omitempty"` // 提交时间 (unix ms)
	Data      json.RawMessage `json:"data"`                // 事务业务载荷 (任意 JSON)
}

// ParseTx 从总线事件解析 TransactionCommitted 信封。
// 非该类型事件或载荷非法 → ok=false (消费者据此跳过)。
func ParseTx(ev bus.Event) (tx *TxEnvelope, ok bool) {
	if ev.Type != EventTypeTransactionCommitted || len(ev.Payload) == 0 {
		return nil, false
	}
	var env TxEnvelope
	if err := json.Unmarshal(ev.Payload, &env); err != nil {
		return nil, false
	}
	if env.TxID == "" {
		return nil, false
	}
	return &env, true
}

// DataMap 把信封的 data 字段解析为键值表 (TS 消费者直接点取
// data.xxx 字段, Go 侧统一经此解析)。
func (t *TxEnvelope) DataMap() map[string]any {
	if len(t.Data) == 0 {
		return nil
	}
	var m map[string]any
	if json.Unmarshal(t.Data, &m) != nil {
		return nil
	}
	return m
}

// ── data 字段取值辅助 (JSON 解析后 any 断言, 缺省零值) ───────────

func dstr(m map[string]any, k string) string  { v, _ := m[k].(string); return v }
func dnum(m map[string]any, k string) float64 { v, _ := m[k].(float64); return v }
func dbool(m map[string]any, k string) bool   { v, _ := m[k].(bool); return v }
func dany(m map[string]any, k string) any     { return m[k] }

// ── 事件列表查询 (对齐 GET /api/events/list) ────────────────────

// ListQuery 事件列表查询条件
type ListQuery struct {
	After int64  `json:"after"` // 游标: 返回 seq > After 的事件 (首页传 0)
	Limit int    `json:"limit"` // 每页条数 (默认 200, 上限 1000, 对齐 store 上限)
	Type  string `json:"type"`  // 事件类型过滤 (空 = 全部)
}

// ListResult 事件列表分页结果
type ListResult struct {
	Events     []store.Event `json:"events"`         // 当前页 (升序)
	NextCursor int64         `json:"nextCursor"`     // 下一页游标 (本页最后一条 seq)
	HasMore    bool          `json:"hasMore"`        // 是否还有后续匹配事件
	Type       string        `json:"type,omitempty"` // 回显过滤条件
}

// ListEvents 事件查询辅助: 游标分页 + 可选类型过滤。
// 分页语义与 GET /api/events/list 的 after/limit 完全一致 (升序,
// NextCursor 作为下一次请求的 after); type 过滤时游标仍取自
// 全量事件流, 保证过滤翻页不丢不重。
func ListEvents(ctx context.Context, st *store.Store, q ListQuery) (ListResult, error) {
	if q.Limit <= 0 {
		q.Limit = 200 // 对齐 store.EventsAfter 默认值
	}
	if q.Limit > 1000 {
		q.Limit = 1000
	}
	res := ListResult{
		Events:  make([]store.Event, 0, q.Limit),
		Type:    q.Type,
		HasMore: false,
	}

	cursor := q.After
	for len(res.Events) < q.Limit {
		batch, err := st.EventsAfter(ctx, cursor, 1000)
		if err != nil {
			return res, err
		}
		if len(batch) == 0 {
			break // 源已耗尽
		}
		for _, ev := range batch {
			cursor = ev.Seq // 游标推进基于全量流 (过滤翻页不丢事件)
			if q.Type == "" || ev.Type == q.Type {
				res.Events = append(res.Events, ev)
				if len(res.Events) >= q.Limit {
					break
				}
			}
		}
		if len(batch) < 1000 && len(res.Events) < q.Limit {
			break // 不足一批且页未满 → 已到末尾
		}
	}

	// 游标: 本页最后一条的 seq (空页保持原游标)
	if n := len(res.Events); n > 0 {
		res.NextCursor = res.Events[n-1].Seq
	} else {
		res.NextCursor = q.After
	}
	// 是否还有后续匹配事件 (向前窥探)
	res.HasMore = peekHasMore(ctx, st, res.NextCursor, q.Type)
	return res, nil
}

// peekHasMore 检查 cursor 之后是否还存在匹配类型的事件
// (in-memory store 量级有限, 分批窥探可接受)
func peekHasMore(ctx context.Context, st *store.Store, cursor int64, typ string) bool {
	for {
		batch, err := st.EventsAfter(ctx, cursor, 1000)
		if err != nil || len(batch) == 0 {
			return false
		}
		for _, ev := range batch {
			if typ == "" || ev.Type == typ {
				return true
			}
		}
		if len(batch) < 1000 {
			return false
		}
		cursor = batch[len(batch)-1].Seq
	}
}
