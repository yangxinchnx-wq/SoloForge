// ─────────────────────────────────────────────────────────────────
// client_test.go — 已知问题 3 自测: 离线缓冲溢出落盘 + Buffered 修正
// ─────────────────────────────────────────────────────────────────
package surreal

import (
	"os"
	"path/filepath"
	"testing"

	"soloforge/next/internal/store"
)

// newSpillClient 指定落盘目录的客户端
func newSpillClient(t *testing.T, dir string) *Client {
	t.Helper()
	c := New(Config{URL: "http://127.0.0.1:1"}) // 不可达端口 (离线)
	c.spillPath = filepath.Join(dir, "offline-events.jsonl")
	return c
}

func TestSpillRoundTrip(t *testing.T) {
	dir := t.TempDir()
	c := newSpillClient(t, dir)

	events := []store.Event{
		{Seq: 1, TS: 1, Type: "a", Source: "test"},
		{Seq: 2, TS: 2, Type: "b", Source: "test"},
	}
	if err := c.spillAppendLocked(events); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(c.spillPath); err != nil {
		t.Fatalf("落盘文件应存在: %v", err)
	}

	got, err := c.spillLoadAndClear()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Seq != 1 || got[1].Seq != 2 {
		t.Fatalf("回读错误: %+v", got)
	}
	// 清空后再读为空
	if again, err := c.spillLoadAndClear(); err != nil || len(again) != 0 {
		t.Fatalf("清空后应读不到: %v %v", again, err)
	}
}

func TestSpillRewritePartial(t *testing.T) {
	dir := t.TempDir()
	c := newSpillClient(t, dir)

	if err := c.spillAppendLocked([]store.Event{
		{Seq: 1, TS: 1, Type: "a"},
		{Seq: 2, TS: 2, Type: "b"},
		{Seq: 3, TS: 3, Type: "c"},
	}); err != nil {
		t.Fatal(err)
	}
	// 补写第 1 条失败 → 剩余 2 条回存
	if err := c.spillRewrite([]store.Event{{Seq: 2, TS: 2, Type: "b"}, {Seq: 3, TS: 3, Type: "c"}}); err != nil {
		t.Fatal(err)
	}
	got, _ := c.spillLoadAndClear()
	if len(got) != 2 || got[0].Seq != 2 {
		t.Fatalf("回存后应剩 2 条: %+v", got)
	}
}

func TestRecoverSpillBackfill(t *testing.T) {
	dir := t.TempDir()
	c := newSpillClient(t, dir)

	// 预置 6 条落盘 (超出测试用的临时上限场景不适用 — bufCap=5000,
	// 这里验证回灌与顺序: 落盘事件先于新事件)
	if err := c.spillAppendLocked([]store.Event{
		{Seq: 1, TS: 1, Type: "spill-old"},
		{Seq: 2, TS: 2, Type: "spill-old2"},
	}); err != nil {
		t.Fatal(err)
	}
	c.recoverSpill()
	if got := c.Buffered(); got != 2 {
		t.Fatalf("启动回收后缓冲应为 2, 实际 %d", got)
	}
	// 二次回收是 no-op (spillLoaded)
	c.recoverSpill()
	if got := c.Buffered(); got != 2 {
		t.Fatalf("二次回收不应重复回灌: %d", got)
	}
}

func TestBufferedFix(t *testing.T) {
	dir := t.TempDir()
	c := newSpillClient(t, dir)
	c.mu.Lock()
	c.buf = append(c.buf, store.Event{Seq: 1, Type: "x"})
	c.mu.Unlock()
	if got := c.Buffered(); got != 1 {
		t.Fatalf("Buffered 应读共享缓冲 (原实现恒 0): %d", got)
	}
}

func TestSpillDisabled(t *testing.T) {
	c := New(Config{URL: "http://127.0.0.1:1"})
	// 环境未设置 → 默认落盘路径存在 (data/surreal-spill); 若目录不可写
	// (initSpill 失败) 则 spillPath 为空 — 两种情况都不应 panic
	if err := c.spillAppendLocked([]store.Event{{Seq: 1}}); err != nil && c.spillPath == "" {
		t.Log("spill disabled (目录不可写), 降级丢弃模式生效")
	}
}
