// ─────────────────────────────────────────────────────────────────
// surreal — SurrealDB 持久层客户端 (HTTP /sql 通道, 零第三方依赖)
//
// 用户决策: SurrealDB 是项目的数据库, 不许换。
// 职责:
//   - 事件镜像: 总线上的每条事件写进 SurrealDB event 表 (ns=soloforge_core)
//   - 启动重放: 从 event 表恢复事件日志与 seq 游标 (崩溃恢复)
//   - 离线缓冲: SurrealDB 不可达时内存缓冲 (上限 5000), 恢复后自动补写
//
// 通道: POST /sql (SurrealQL), basic auth, surreal-ns/surreal-db 头
// ─────────────────────────────────────────────────────────────────
package surreal

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
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

type Client struct {
	cfg    Config
	client *http.Client
	mu     sync.Mutex
	buf    []store.Event // SurrealDB 离线时的事件缓冲
	connected atomic.Bool
}

func New(cfg Config) *Client {
	return &Client{
		cfg:    cfg,
		client: &http.Client{Timeout: 10 * time.Second},
	}
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
// SurrealDB 离线: 缓冲 (上限 5000, 溢出丢最旧) + 每 10s 重试;
// 恢复后自动补写并 EnsureSchema。ctx 取消时退出。
func (c *Client) SyncLoop(ctx context.Context, events <-chan bus.Event) {

	buf := make([]store.Event, 0, 4096)
	flush := func() bool {
		c.mu.Lock()
		pending := make([]store.Event, len(buf))
		copy(pending, buf)
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
		ok := true
		for _, ev := range pending {
			if err := c.SaveEvent(ctx, ev); err != nil {
				fmt.Printf("[surreal-sync] flush: SaveEvent 失败 (seq=%d type=%s): %v\n", ev.Seq, ev.Type, err)
				ok = false
				break
			}
		}
		return ok
	}

	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case ev := <-events:
			c.mu.Lock()
			buf = append(buf, ev)
			if len(buf) > 5000 { // 溢出丢最旧 (保内存上限)
				buf = buf[len(buf)-5000:]
			}
			n := len(buf)
			c.mu.Unlock()
			// 缓冲少量时立即尝试直写
			if n == 1 {
				if flush() {
					c.mu.Lock()
					buf = buf[:0]
					c.mu.Unlock()
					c.connected.Store(true)
				} else {
					c.connected.Store(false)
					fmt.Printf("[surreal-sync] flush 失败 (buffered=%d)\n", n)
				}
			}
		case <-ticker.C:
			c.mu.Lock()
			pending := len(buf)
			c.mu.Unlock()
			if pending > 0 {
				if flush() {
					c.mu.Lock()
					buf = buf[:0]
					c.mu.Unlock()
					c.connected.Store(true)
				} else {
					c.connected.Store(false)
					fmt.Printf("[surreal-sync] 定时 flush 失败 (buffered=%d)\n", pending)
				}
			}
		}
	}
}

// Connected 当前连接状态 (观测用)
func (c *Client) Connected() bool { return c.connected.Load() }

// Buffered 当前缓冲的未写入事件数
func (c *Client) Buffered() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.buf)
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
