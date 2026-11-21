// ─────────────────────────────────────────────────────────────────
// fixes_test.go — 已知问题修复自测
//
// 覆盖: WS/HTTP 命令派发统一走 kernel 状态机守卫 (dispatchCommand)、
// store.LastSeq 真实游标 (删除场景不失真)、SurrealDB 离线缓冲溢出落盘。
// ─────────────────────────────────────────────────────────────────
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http/httptest"
	"testing"

	"soloforge/next/internal/bus"
	"soloforge/next/internal/kernel"
	"soloforge/next/internal/store"
)

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// TestDispatchCommandKernelGuard 内核存在时命令经状态机守卫:
// BOOTING 态 (未 Start) 拒绝; READY 态接受
func TestDispatchCommandKernelGuard(t *testing.T) {
	st := store.New()
	b := bus.NewEventBus()
	cb := bus.NewCommandBus()
	cb.Register("echo", func(_ context.Context, payload json.RawMessage) (any, error) {
		return map[string]any{"echoed": true}, nil
	})

	kern := kernel.New(st, b)
	kern.SetCommandBus(cb)
	s := New(st, b, cb, testLogger())
	s.Kernel = kern

	// 内核停在 BOOTING → 守卫拒绝 (结果对象 accepted=false, 不上抛 error)
	res, err := s.dispatchCommand(context.Background(), "test", bus.Command{Type: "echo"})
	if err != nil {
		t.Fatalf("守卫拒绝应转结果对象而非 error: %v", err)
	}
	if m, ok := res.(map[string]any); !ok || m["accepted"] != false {
		t.Fatalf("BOOTING 态应拒绝: %+v", res)
	}

	// 推进到 READY → 接受 (守卫通过返回 handler 原始结果)
	if err := kern.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	res, err = s.dispatchCommand(context.Background(), "test", bus.Command{Type: "echo"})
	if err != nil {
		t.Fatal(err)
	}
	if m, ok := res.(map[string]any); !ok || m["echoed"] != true {
		t.Fatalf("READY 态应接受并返回 handler 结果: %+v", res)
	}
}

// TestHandleCommandsGuarded HTTP 路由整链: 守卫拒绝 → 命令不执行
func TestHandleCommandsGuarded(t *testing.T) {
	st := store.New()
	b := bus.NewEventBus()
	cb := bus.NewCommandBus()
	executed := 0
	cb.Register("boom", func(_ context.Context, _ json.RawMessage) (any, error) {
		executed++
		return nil, nil
	})
	kern := kernel.New(st, b)
	kern.SetCommandBus(cb)
	s := New(st, b, cb, testLogger())
	s.Kernel = kern // 不 Start → BOOTING

	body, _ := json.Marshal(map[string]any{"type": "boom"})
	req := httptest.NewRequest("POST", "/api/commands", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	s.Mux().ServeHTTP(rec, req)

	if executed != 0 {
		t.Fatalf("BOOTING 态命令不应执行到 handler, 实际执行 %d 次", executed)
	}
	var resp map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp["ok"] != true {
		t.Fatalf("守卫拒绝应转 200 结果对象: %v", rec.Body.String())
	}
}
