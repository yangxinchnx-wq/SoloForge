// ─────────────────────────────────────────────────────────────────
// surreal — SurrealDB 持久层客户端 (HTTP /sql 通道, 零第三方依赖)
//
// 用户决策: SurrealDB 是项目的数据库, 不许换。
// 职责:
//   - 事件镜像: 总线上的每条事件写进 SurrealDB event 表 (ns=soloforge_core)
//   - 启动重放: 从 event 表恢复事件日志与 seq 游标 (崩溃恢复)
//   - 离线缓冲: SurrealDB 不可达时内存缓冲 (上限 5000), 溢出部分
//     落盘 JSONL (data/surreal-spill/, SOLOFORGE_SURREAL_SPILL=off 关闭)
//     — 修复已知问题: 原实现溢出直接丢最旧; 恢复后自动补写 (含落盘事件)
//
// 通道: POST /sql (SurrealQL), basic auth, surreal-ns/surreal-db 头
// ─────────────────────────────────────────────────────────────────
package surreal

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"soloforge/next/internal/bus"
	"soloforge/next/internal/store"
)

type Config struct {
	URL  string // http://127.0.0.1:8400
	NS   string // soloforge_core
	DB   string // autonomous_network
	User string
	Pass string
}

// 缓冲上限 (对齐原实现) 与溢出落盘目录
const (
	bufCap             = 5000
	defaultSpillDir    = "data/surreal-spill"
	envSurrealSpill    = "SOLOFORGE_SURREAL_SPILL"
	envSurrealSpillDir = "SOLOFORGE_SURREAL_SPILL_DIR"
)

type Client struct {
	cfg       Config
	client    *http.Client
	mu        sync.Mutex
	buf       []store.Event // SurrealDB 离线时的事件缓冲 (SyncLoop 与 Buffered 共用)
	connected atomic.Bool

	spillMu     sync.Mutex
	spillPath   string // 溢出落盘 JSONL 路径 (空 = 不落盘)
	spillLoaded bool   // 启动回收是否已执行 (只做一次)
}

func New(cfg Config) *Client {
	c := &Client{
		cfg:    cfg,
		client: &http.Client{Timeout: 10 * time.Second},
	}
	c.initSpill()
	return c
}

// initSpill 溢出落盘路径 (SOLOFORGE_SURREAL_SPILL=off 关闭;
// SOLOFORGE_SURREAL_SPILL_DIR 自定义目录, 默认 data/surreal-spill)
func (c *Client) initSpill() {
	if os.Getenv(envSurrealSpill) == "off" {
		return
	}
	dir := os.Getenv(envSurrealSpillDir)
	if dir == "" {
		dir = defaultSpillDir
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		fmt.Printf("[surreal] 溢出落盘目录创建失败 (降级为丢弃模式): %v\n", err)
		return
	}
	c.spillPath = filepath.Join(dir, "offline-events.jsonl")
}

// ── 底层 SQL 通道 ────────────────────────────────────────────────

type sqlResult struct {
	Result json.RawMessage `json:"result"`
	Status string          `json:"status"`
	Time   string          `json:"time"`
}

// sqlExec 执行 SurrealQL, 返回每个语句的原始 result (宽容解析:
// 标量/数组/对象都接受 — RETURN 1 的 result 是标量 1)
func (c *Client) sqlExec(ctx context.Context, query string) ([]sqlResult, error) {
	req, err := http.NewRequestWithContext(ctx, "POST", c.cfg.URL+"/sql", strings.NewReader(query))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("surreal-ns", c.cfg.NS)
	req.Header.Set("surreal-db", c.cfg.DB)
	req.SetBasicAuth(c.cfg.User, c.cfg.Pass)

	resp, err := c.client.Do(req)
	if err != nil {
		fmt.Printf("[surreal] 请求失败: %v (url=%s)\n", err, truncate(req.URL.String(), 80))
		return nil, fmt.Errorf("surreal 请求失败: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		fmt.Printf("[surreal] HTTP %d: %s\n", resp.StatusCode, truncate(string(body), 150))
		return nil, fmt.Errorf("surreal HTTP %d: %s", resp.StatusCode, truncate(string(body), 200))
	}
	var results []sqlResult
	if err := json.Unmarshal(body, &results); err != nil {
		fmt.Printf("[surreal] 响应解析失败: %v (body: %s)\n", err, truncate(string(body), 200))
		return nil, fmt.Errorf("surreal 响应解析失败: %w (body: %s)", err, truncate(string(body), 200))
	}
	if len(results) > 0 && results[0].Status != "OK" {
		return nil, fmt.Errorf("surreal 查询失败: %s", truncate(string(results[0].Result), 200))
	}
	return results, nil
}

// sqlRows 执行查询, 返回首个语句的 result 对象行数组
func (c *Client) sqlRows(ctx context.Context, query string) ([]map[string]any, error) {
	results, err := c.sqlExec(ctx, query)
	if err != nil {
		return nil, err
	}
	if len(results) == 0 {
		return nil, nil
	}
	var rows []map[string]any
	json.Unmarshal(results[0].Result, &rows)
	return rows, nil
}

// Healthy 连通性检查
func (c *Client) Healthy(ctx context.Context) bool {
	_, err := c.sqlExec(ctx, "RETURN 1")
	return err == nil
}

// EnsureSchema 定义事件表 (幂等)
func (c *Client) EnsureSchema(ctx context.Context) error {
	_, err := c.sqlRows(ctx, "DEFINE TABLE IF NOT EXISTS event SCHEMALESS CHANGEFEED 1h")
	return err
}

// ── 事件写入 ────────────────────────────────────────────────────

// SaveEvent 写入单条事件 (seq/type/source/payload 全量)
func (c *Client) SaveEvent(ctx context.Context, ev store.Event) error {
	payload := "{}"
	if len(ev.Payload) > 0 {
		payload = string(ev.Payload)
	}
	q := fmt.Sprintf("CREATE event SET seq=%d, ts=%d, type=%s, source=%s, payload=%s",
		ev.Seq, ev.TS, qStr(ev.Type), qStr(ev.Source), payload)
	_, err := c.sqlRows(ctx, q)
	return err
}

// ── 启动重放 ────────────────────────────────────────────────────

// LoadEvents 从 SurrealDB 恢复事件 (seq > after, 升序, 最多 10000 条)
func (c *Client) LoadEvents(ctx context.Context, after int64) ([]store.Event, error) {
	rows, err := c.sqlRows(ctx, fmt.Sprintf(
		"SELECT seq, ts, type, source, payload FROM event WHERE seq > %d ORDER BY seq ASC LIMIT 10000", after))
	if err != nil {
		return nil, err
	}
	out := make([]store.Event, 0, len(rows))
	for _, row := range rows {
		ev := store.Event{}
		if v, ok := row["seq"].(float64); ok {
			ev.Seq = int64(v)
		}
		if v, ok := row["ts"].(float64); ok {
			ev.TS = int64(v)
		}
		if v, ok := row["type"].(string); ok {
			ev.Type = v
		}
		if v, ok := row["source"].(string); ok {
			ev.Source = v
		}
		if p, ok := row["payload"]; ok {
			if raw, err := json.Marshal(p); err == nil {
				ev.Payload = raw
			}
		}
		out = append(out, ev)
	}
	return out, nil
}

// ── 总线同步 (订阅 → 缓冲 → 补写) ───────────────────────────────

// SyncLoop 消费事件通道, 缓冲后写入 SurrealDB。
// 订阅由调用方完成 (传入通道), 保证不漏启动期事件。
// SurrealDB 离线: 缓冲 (上限 5000); 溢出不再丢最旧 — 逐出部分落盘
// JSONL (修复已知问题), 恢复后自动补写 (先内存缓冲后落盘事件) 并
// EnsureSchema。SOLOFORGE_SURREAL_SPILL=off 时退回丢弃模式。
// ctx 取消时退出。
func (c *Client) SyncLoop(ctx context.Context, events <-chan bus.Event) {

	// 启动回收: 上次离线溢出的落盘事件先回灌缓冲 (先于新事件补写)
	c.recoverSpill()

	flush := func() bool {
		c.mu.Lock()
		pending := make([]store.Event, len(c.buf))
		copy(pending, c.buf)
		c.mu.Unlock()
		if len(pending) == 0 {
			return true
		}
		if !c.Healthy(ctx) {
			fmt.Printf("[surreal-sync] flush: Healthy=false\n")
			return false
		}
		if err := c.EnsureSchema(ctx); err != nil {
			fmt.Printf("[surreal-sync] flush: EnsureSchema 失败: %v\n", err)
			return false
		}
		for _, ev := range pending {
			if err := c.SaveEvent(ctx, ev); err != nil {
				fmt.Printf("[surreal-sync] flush: SaveEvent 失败 (seq=%d type=%s): %v\n", ev.Seq, ev.Type, err)
				return false
			}
		}
		return true
	}

	// drainSpill flush 成功后补写溢出落盘事件 (部分失败 → 剩余重写回盘)
	drainSpill := func() {
		events, err := c.spillLoadAndClear()
		if err != nil || len(events) == 0 {
			return
		}
		fmt.Printf("[surreal-sync] 补写溢出落盘事件 %d 条\n", len(events))
		for i, ev := range events {
			if err := c.SaveEvent(ctx, ev); err != nil {
				fmt.Printf("[surreal-sync] 补写失败 (seq=%d): %v, 剩余 %d 条回盘\n", ev.Seq, err, len(events)-i)
				_ = c.spillRewrite(events[i:])
				return
			}
		}
	}

	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case ev := <-events:
			c.mu.Lock()
			c.buf = append(c.buf, ev)
			overflowed := false
			if len(c.buf) > bufCap {
				// 溢出: 逐出部分落盘 (不再丢最旧); 落盘失败才降级丢弃
				evicted := c.buf[:len(c.buf)-bufCap]
				if err := c.spillAppendLocked(evicted); err != nil {
					fmt.Printf("[surreal-sync] 溢出落盘失败 (丢弃 %d 条最旧): %v\n", len(evicted), err)
				} else {
					fmt.Printf("[surreal-sync] 缓冲溢出, %d 条逐出落盘 (%s)\n", len(evicted), c.spillPath)
				}
				c.buf = append([]store.Event(nil), c.buf[len(c.buf)-bufCap:]...)
				overflowed = true
			}
			n := len(c.buf)
			c.mu.Unlock()
			// 缓冲少量时立即尝试直写 (溢出周期性补写即可, 不强冲)
			if n == 1 || overflowed {
				if flush() {
					c.mu.Lock()
					c.buf = c.buf[:0]
					c.mu.Unlock()
					c.connected.Store(true)
					drainSpill()
				} else {
					c.connected.Store(false)
					fmt.Printf("[surreal-sync] flush 失败 (buffered=%d)\n", n)
				}
			}
		case <-ticker.C:
			c.mu.Lock()
			pending := len(c.buf)
			c.mu.Unlock()
			if pending > 0 {
				if flush() {
					c.mu.Lock()
					c.buf = c.buf[:0]
					c.mu.Unlock()
					c.connected.Store(true)
					drainSpill()
				} else {
					c.connected.Store(false)
					fmt.Printf("[surreal-sync] 定时 flush 失败 (buffered=%d)\n", pending)
				}
			} else {
				// 空闲周期也清落盘积压 (恢复后首补)
				drainSpill()
			}
		}
	}
}

// Connected 当前连接状态 (观测用)
func (c *Client) Connected() bool { return c.connected.Load() }

// Buffered 当前缓冲的未写入事件数 (修复已知问题: 原实现读的是从未
// 写入的 c.buf 字段, SyncLoop 用局部变量导致恒 0)
func (c *Client) Buffered() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.buf)
}

// ── 溢出落盘 (JSONL; 修复已知问题: 原实现溢出直接丢最旧) ─────────

// recoverSpill 启动回收: 落盘事件回灌缓冲 (只做一次; 超出上限的部分
// 重新落盘, 保证不丢)
func (c *Client) recoverSpill() {
	c.spillMu.Lock()
	if c.spillLoaded || c.spillPath == "" {
		c.spillLoaded = true
		c.spillMu.Unlock()
		return
	}
	c.spillLoaded = true
	c.spillMu.Unlock()

	events, err := c.spillLoadAndClear()
	if err != nil || len(events) == 0 {
		return
	}
	fmt.Printf("[surreal-sync] 启动回收溢出落盘事件 %d 条\n", len(events))
	c.mu.Lock()
	c.buf = append(events, c.buf...)
	if len(c.buf) > bufCap {
		// 回溢: 超出部分重新落盘 (保留最新在内存)
		extra := c.buf[:len(c.buf)-bufCap]
		if werr := c.spillAppendLocked(extra); werr != nil {
			fmt.Printf("[surreal-sync] 启动回收回溢失败 (丢弃 %d 条): %v\n", len(extra), werr)
		}
		c.buf = append([]store.Event(nil), c.buf[len(c.buf)-bufCap:]...)
	}
	c.mu.Unlock()
}

// spillAppendLocked 追加事件到落盘 JSONL (须持 c.mu; 调用方负责降级语义)
func (c *Client) spillAppendLocked(events []store.Event) error {
	if c.spillPath == "" || len(events) == 0 {
		return fmt.Errorf("spill disabled")
	}
	c.spillMu.Lock()
	defer c.spillMu.Unlock()
	f, err := os.OpenFile(c.spillPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	w := bufio.NewWriter(f)
	enc := json.NewEncoder(w)
	for _, ev := range events {
		if err := enc.Encode(ev); err != nil {
			return err
		}
	}
	return w.Flush()
}

// spillRewrite 全量重写落盘 JSONL (补写部分失败时回存剩余)
func (c *Client) spillRewrite(events []store.Event) error {
	if c.spillPath == "" {
		return fmt.Errorf("spill disabled")
	}
	if len(events) == 0 {
		return c.spillClear()
	}
	c.spillMu.Lock()
	defer c.spillMu.Unlock()
	f, err := os.OpenFile(c.spillPath, os.O_TRUNC|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	w := bufio.NewWriter(f)
	enc := json.NewEncoder(w)
	for _, ev := range events {
		if err := enc.Encode(ev); err != nil {
			return err
		}
	}
	return w.Flush()
}

// spillLoadAndClear 读取并清空落盘 JSONL (文件不存在返回 nil)
func (c *Client) spillLoadAndClear() ([]store.Event, error) {
	if c.spillPath == "" {
		return nil, nil
	}
	c.spillMu.Lock()
	defer c.spillMu.Unlock()
	f, err := os.Open(c.spillPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var events []store.Event
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var ev store.Event
		if err := json.Unmarshal([]byte(line), &ev); err == nil {
			events = append(events, ev)
		}
	}
	_ = f.Close()
	if err := os.Remove(c.spillPath); err != nil && !os.IsNotExist(err) {
		return events, err
	}
	return events, nil
}

// spillClear 删除落盘文件
func (c *Client) spillClear() error {
	if c.spillPath == "" {
		return nil
	}
	err := os.Remove(c.spillPath)
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

// ── 工具 ────────────────────────────────────────────────────────

// qStr SurrealQL 字符串字面量转义 (单引号内: \ ' 之外原样)
func qStr(s string) string {
	r := strings.NewReplacer("\\", "\\\\", "'", "\\'")
	return "'" + r.Replace(s) + "'"
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n] + "..."
	}
	return s
}
