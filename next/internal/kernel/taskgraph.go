// ─────────────────────────────────────────────────────────────────
// taskgraph.go — 任务依赖图解析 + 故障转移链 (批次 5 补齐)
//
// 对齐待办清单标注的两个缺口 (TS orchestration 4 文件中均未实现):
//  1. 任务依赖图解析  → TaskGraph: 依赖声明/环检测/拓扑排序 (Kahn)/
//     就绪任务判定/阻塞分析
//  2. 故障转移链      → FailoverChain: 有序端点链, 顺序故障转移,
//     失败标记 + 冷却 + 链尾兜底错误
//
// 数值均为补齐推导 (非 TS 逐行移植), 与内核事务/重试语义同风格。
// ─────────────────────────────────────────────────────────────────
package kernel

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

// ─── 任务依赖图 ─────────────────────────────────────────────────

// TaskGraphTask 依赖图节点
type TaskGraphTask struct {
	ID     string   `json:"id"`     // 任务唯一 ID
	Deps   []string `json:"deps"`   // 前置任务 ID 列表
	Weight float64  `json:"weight"` // 权重 (调度优先级参考, 默认 1)
}

// TaskGraph 任务依赖图 (DAG)
type TaskGraph struct {
	tasks []TaskGraphTask
}

// NewTaskGraph 构造依赖图
func NewTaskGraph(tasks []TaskGraphTask) *TaskGraph {
	return &TaskGraph{tasks: append([]TaskGraphTask(nil), tasks...)}
}

// Validate 校验: 未知依赖 / 重复 ID / 环检测 (环即周期性依赖死锁)。
// 返回错误列表 (空表示合法 DAG)。
func (g *TaskGraph) Validate() []string {
	var errs []string
	ids := make(map[string]bool, len(g.tasks))
	for _, t := range g.tasks {
		if ids[t.ID] {
			errs = append(errs, fmt.Sprintf("任务 ID 重复: %s", t.ID))
		}
		ids[t.ID] = true
	}
	for _, t := range g.tasks {
		for _, d := range t.Deps {
			if !ids[d] {
				errs = append(errs, fmt.Sprintf("任务 %s 依赖了未声明的任务 %s", t.ID, d))
			}
		}
	}
	if len(errs) > 0 {
		return errs
	}
	// 环检测: Kahn 拓扑排序后若有剩余节点 → 存在环
	if _, remaining := g.topoSortLocked(); remaining > 0 {
		errs = append(errs, fmt.Sprintf("依赖图存在环 (%d 个任务无法排序)", remaining))
	}
	return errs
}

// TopoOrder 拓扑排序 (Kahn): 同层按权重降序、再按 ID 字典序 (确定性)。
// 有环时返回已完成排序部分 + error。
func (g *TaskGraph) TopoOrder() ([]string, error) {
	order, remaining := g.topoSortLocked()
	if remaining > 0 {
		return order, fmt.Errorf("依赖图存在环 (%d 个任务无法排序)", remaining)
	}
	return order, nil
}

// topoSortLocked Kahn 实现: 返回排序结果与未能排序的节点数
func (g *TaskGraph) topoSortLocked() ([]string, int) {
	indegree := make(map[string]int, len(g.tasks))
	dependents := make(map[string][]string, len(g.tasks))
	byID := make(map[string]TaskGraphTask, len(g.tasks))
	for _, t := range g.tasks {
		indegree[t.ID] = len(t.Deps)
		byID[t.ID] = t
		for _, d := range t.Deps {
			dependents[d] = append(dependents[d], t.ID)
		}
	}

	// 初始就绪层: 入度 0
	var frontier []string
	for _, t := range g.tasks {
		if indegree[t.ID] == 0 {
			frontier = append(frontier, t.ID)
		}
	}

	var order []string
	for len(frontier) > 0 {
		// 同层确定性: 权重降序 → ID 字典序
		sort.Slice(frontier, func(i, j int) bool {
			a, b := byID[frontier[i]], byID[frontier[j]]
			if a.Weight != b.Weight {
				return a.Weight > b.Weight
			}
			return a.ID < b.ID
		})
		var next []string
		for _, id := range frontier {
			order = append(order, id)
			for _, dep := range dependents[id] {
				indegree[dep]--
				if indegree[dep] == 0 {
					next = append(next, dep)
				}
			}
		}
		frontier = next
	}
	return order, len(g.tasks) - len(order)
}

// ReadyTasks 给定已完成任务集合, 返回此刻可派发的任务 ID (所有前置已完成)。
// completed nil/空视为无任务完成。
func (g *TaskGraph) ReadyTasks(completed map[string]bool) []string {
	done := completed
	if done == nil {
		done = map[string]bool{}
	}
	var ready []string
	for _, t := range g.tasks {
		ok := true
		for _, d := range t.Deps {
			if !done[d] {
				ok = false
				break
			}
		}
		if ok && !done[t.ID] {
			ready = append(ready, t.ID)
		}
	}
	return ready
}

// BlockedBy 分析任务被哪些未完成任务阻塞 (含传递闭包)
func (g *TaskGraph) BlockedBy(taskID string) []string {
	byID := make(map[string]TaskGraphTask, len(g.tasks))
	for _, t := range g.tasks {
		byID[t.ID] = t
	}
	t, ok := byID[taskID]
	if !ok {
		return nil
	}
	var out []string
	seen := map[string]bool{taskID: true}
	var walk func(id string)
	walk = func(id string) {
		for _, d := range byID[id].Deps {
			if seen[d] {
				continue
			}
			seen[d] = true
			out = append(out, d)
			walk(d)
		}
	}
	walk(t.ID)
	return out
}

// ─── 故障转移链 ─────────────────────────────────────────────────

// 故障转移参数 (补齐推导)
const (
	failoverCooldownMs = 30 * 1000 // 端点失败后的冷却期 (30s)
)

// FailoverEndpoint 故障转移链端点
type FailoverEndpoint struct {
	ID   string // 端点标识 (如 worker/节点 ID)
	Name string // 展示名
}

// FailoverChain 有序故障转移链: 顺序尝试端点, 失败的端点进入冷却期
// (冷却期内跳过), 全链失败返回链尾兜底错误。
type FailoverChain struct {
	mu        sync.Mutex
	endpoints []FailoverEndpoint
	// failedAt 端点 ID → 最近失败时间 (冷却期内跳过)
	failedAt map[string]time.Time
}

// NewFailoverChain 构造故障转移链 (endpoints 为有序兜底顺序)
func NewFailoverChain(endpoints []FailoverEndpoint) *FailoverChain {
	return &FailoverChain{
		endpoints: append([]FailoverEndpoint(nil), endpoints...),
		failedAt:  make(map[string]time.Time),
	}
}

// MarkFailed 标记端点失败 (进入冷却期)
func (c *FailoverChain) MarkFailed(id string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.failedAt[id] = time.Now()
}

// MarkHealthy 标记端点恢复 (清除冷却)
func (c *FailoverChain) MarkHealthy(id string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.failedAt, id)
}

// Candidates 返回当前可尝试的端点 (剔除冷却期内的; 冷却过期自动恢复)
func (c *FailoverChain) Candidates() []FailoverEndpoint {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	var out []FailoverEndpoint
	for _, e := range c.endpoints {
		if t, failed := c.failedAt[e.ID]; failed {
			if now.Sub(t) < failoverCooldownMs*time.Millisecond {
				continue // 冷却期内跳过
			}
			delete(c.failedAt, e.ID) // 冷却过期自动恢复
		}
		out = append(out, e)
	}
	return out
}

// Execute 顺序故障转移执行: 依次尝试候选端点, exec 返回 nil 即成功;
// 端点失败自动 MarkFailed 并转移下一候选; 全链失败返回聚合错误。
func (c *FailoverChain) Execute(ctx context.Context, exec func(ctx context.Context, endpoint FailoverEndpoint) error) error {
	var errs []string
	for _, e := range c.Candidates() {
		if err := exec(ctx, e); err != nil {
			c.MarkFailed(e.ID)
			errs = append(errs, fmt.Sprintf("%s: %v", e.ID, err))
			continue
		}
		return nil
	}
	if len(errs) == 0 {
		return fmt.Errorf("故障转移链无可用候选端点")
	}
	return fmt.Errorf("故障转移链全部失败: %s", strings.Join(errs, "; "))
}
