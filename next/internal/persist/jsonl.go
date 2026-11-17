// ─────────────────────────────────────────────────────────────────
// persist — JSONL 事件持久化 (无 SQL 的崩溃恢复)
//
// 纪律:
//   - 每条事件一行 JSON, 追加写 events.jsonl
//   - 启动时重放文件恢复事件日志与 seq 游标 (最后一行残缺则跳过)
//   - 订阅总线, 新事件实时追加落盘
//
// 这是 SQLite 移除后找回"崩溃恢复"能力的最小实现:
// store 包的调用方零改动, 持久化与否只取决于是否接线本包。
// ─────────────────────────────────────────────────────────────────
package persist

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"

	"soloforge/next/internal/bus"
	"soloforge/next/internal/store"
)

type Log struct {
	path string
	mu   sync.Mutex
	file *os.File
}

// Load 启动时重放 events.jsonl → 恢复进 store (事件 + seq 游标)。
// 最后一行残缺 (进程被强杀时未写完) 会被跳过。
func Load(path string, st *store.Store) (int, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil // 首次启动无文件
		}
		return 0, err
	}
	restored := 0
	lines := strings.Split(string(data), "\n")
	for i, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		// 最后一行可能被强杀截断: 解析失败且是末行 → 跳过
		var ev store.Event
		if err := json.Unmarshal([]byte(line), &ev); err != nil {
			if i == len(lines)-1 {
				break // 残缺末行
			}
			return restored, fmt.Errorf("events.jsonl 第 %d 行损坏: %w", i+1, err)
		}
		st.Restore(ev)
		restored++
	}
	return restored, nil
}

// Attach 订阅总线, 把每条新事件实时追加到 events.jsonl。
// 返回用于手动 flush 的指针 (通常不需要)。
func Attach(path string, b *bus.EventBus) (*Log, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, err
	}
	l := &Log{path: path, file: f}
	subID, events := b.Subscribe()
	go func() {
		for ev := range events {
			line, err := json.Marshal(ev)
			if err != nil {
				continue
			}
			l.mu.Lock()
			f.Write(append(line, '\n'))
			l.mu.Unlock()
		}
		// 总线关闭/取消订阅时 events 通道会关闭, 这里自然退出
		_ = subID
	}()
	return l, nil
}
