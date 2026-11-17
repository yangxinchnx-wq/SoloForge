// ─────────────────────────────────────────────────────────────────
// store — 进程内事件日志 + KV (无持久化, 重启即清零)
//
// 决策记录: 按用户要求移除 SQLite, 存储全部进程内化。
// 事件仅存活于进程生命周期内; 未来若需落盘, 在此包加 JSONL 追加器即可,
// 不改任何调用方。
// ─────────────────────────────────────────────────────────────────
package store

import (
	"context"
	"encoding/json"
	"sync"
	"time"
)

// Event 事件信封 — 对应 docs/protocol.md 的事件语义
type Event struct {
	Seq     int64           `json:"seq"`               // 进程内单调递增
	TS      int64           `json:"ts"`                // 毫秒时间戳
	Type    string          `json:"type"`              // 事件类型
	Source  string          `json:"source"`            // 来源 (ui/core/worker:<name>)
	Payload json.RawMessage `json:"payload,omitempty"` // 任意 JSON 载荷
}

type Store struct {
	mu     sync.RWMutex
	events []Event
	seq    int64
	kv     map[string]string
}

func New() *Store {
	return &Store{kv: make(map[string]string)}
}

// AppendEvent 追加事件 (先落"库"后广播的"先写后发"纪律)
func (s *Store) AppendEvent(_ context.Context, typ, source string, payload json.RawMessage) (Event, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if payload == nil {
		payload = json.RawMessage("{}")
	}
	s.seq++
	ev := Event{
		Seq:     s.seq,
		TS:      time.Now().UnixMilli(),
		Type:    typ,
		Source:  source,
		Payload: payload,
	}
	s.events = append(s.events, ev)
	return ev, nil
}

// EventsAfter 重放游标: 返回 seq > after 的事件 (升序, 最多 limit 条)
func (s *Store) EventsAfter(_ context.Context, after int64, limit int) ([]Event, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	var out []Event
	for _, ev := range s.events {
		if ev.Seq > after {
			out = append(out, ev)
			if len(out) >= limit {
				break
			}
		}
	}
	return out, nil
}

// EventsByType 按类型取最近 N 条 (倒序)
func (s *Store) EventsByType(typ string, limit int) []Event {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if limit <= 0 || limit > 1000 {
		limit = 20
	}
	var out []Event
	for i := len(s.events) - 1; i >= 0 && len(out) < limit; i-- {
		if s.events[i].Type == typ {
			out = append(out, s.events[i])
		}
	}
	return out
}

// EventCount 事件总数 (观测/对账用)
func (s *Store) EventCount(_ context.Context) (int64, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return int64(len(s.events)), nil
}

// Restore 恢复历史事件 (JSONL 重放用): seq 游标随最大 seq 前进
func (s *Store) Restore(ev Event) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if ev.Seq > s.seq {
		s.seq = ev.Seq
	}
	s.events = append(s.events, ev)
}

// KVSet / KVGet 简单状态键值 (进程内)
func (s *Store) KVSet(_ context.Context, k, v string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.kv[k] = v
	return nil
}

func (s *Store) KVGet(_ context.Context, k string) (string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.kv[k], nil
}
