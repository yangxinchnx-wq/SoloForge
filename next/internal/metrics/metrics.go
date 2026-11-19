// ─────────────────────────────────────────────────────────────────
// metrics — 线程安全指标收集器 (Prometheus 文本渲染)
//
// 对齐旧 api-server.ts 的指标桥语义: 计数器 + 仪表值,
// /metrics 端点调用 Render() 输出文本格式。
// ─────────────────────────────────────────────────────────────────
package metrics

import (
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
)

type Collector struct {
	mu       sync.Mutex
	counters map[string]float64
	gauges   map[string]float64
}

func New() *Collector {
	return &Collector{
		counters: make(map[string]float64),
		gauges:   make(map[string]float64),
	}
}

func (c *Collector) Inc(name string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.counters[name]++
}

func (c *Collector) Add(name string, delta float64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.counters[name] += delta
}

func (c *Collector) SetGauge(name string, v float64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.gauges[name] = v
}

// Render Prometheus 文本格式 (按名称排序保证确定性)
func (c *Collector) Render() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out strings.Builder
	names := make([]string, 0, len(c.counters)+len(c.gauges))
	seen := make(map[string]bool)
	for n := range c.counters {
		names = append(names, n)
		seen[n] = true
	}
	for n := range c.gauges {
		if !seen[n] {
			names = append(names, n)
		}
	}
	sort.Strings(names)
	for _, n := range names {
		if v, ok := c.counters[n]; ok {
			fmt.Fprintf(&out, "# TYPE %s counter\n%s %v\n", n, n, v)
			continue
		}
		if v, ok := c.gauges[n]; ok {
			fmt.Fprintf(&out, "# TYPE %s gauge\n%s %v\n", n, n, v)
		}
	}
	return out.String()
}

// Handler /metrics HTTP 端点
func (c *Collector) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		fmt.Fprint(w, c.Render())
	})
}
