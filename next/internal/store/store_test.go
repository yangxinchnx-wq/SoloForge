// ─────────────────────────────────────────────────────────────────
// store_test.go — 已知问题 2 自测: LastSeq 真实游标
// ─────────────────────────────────────────────────────────────────
package store

import (
	"context"
	"testing"
)

func TestLastSeqVsEventCount(t *testing.T) {
	s := New()
	ctx := context.Background()

	for i := 0; i < 3; i++ {
		if _, err := s.AppendEvent(ctx, "t", "test", nil); err != nil {
			t.Fatal(err)
		}
	}
	if got := s.LastSeq(); got != 3 {
		t.Fatalf("3 条追加后 LastSeq 应为 3, 实际 %d", got)
	}
	count, _ := s.EventCount(ctx)
	if count != 3 {
		t.Fatalf("EventCount 应为 3, 实际 %d", count)
	}

	// Restore 跳跃游标 (崩溃恢复场景): LastSeq 跟随游标而非行数
	s.Restore(Event{Seq: 100, Type: "restored", TS: 1})
	if got := s.LastSeq(); got != 100 {
		t.Fatalf("Restore 后 LastSeq 应为 100, 实际 %d", got)
	}
	count, _ = s.EventCount(ctx)
	if count != 4 {
		t.Fatalf("EventCount 应为 4 (行数), 实际 %d", count)
	}
	// 关键差异: 行数(4) ≠ 游标(100) — 旧实现拿行数当 seq 会失真
}

func TestLastSeqAfterAppendFollowsCursor(t *testing.T) {
	s := New()
	ctx := context.Background()
	s.Restore(Event{Seq: 50, Type: "boot", TS: 1})
	if _, err := s.AppendEvent(ctx, "t", "test", nil); err != nil {
		t.Fatal(err)
	}
	// AppendEvent 在游标 50 上 +1 → 51 (行数为 2)
	if got := s.LastSeq(); got != 51 {
		t.Fatalf("追加后 LastSeq 应为 51, 实际 %d", got)
	}
}
