// ─────────────────────────────────────────────────────────────────
// orchestrator — 多 worker 决策编排器 (阶段 2 骨架)
//
// 事件语义对齐旧 agent-decision-orchestrator.ts (protocol.md §1):
//   agent.task.dispatched → phase0_subtask → phase1_worker_start/done
//   → phase2_judge → phase3_deliver_done
// 事件先落库 (store) 后广播 (bus), 崩溃后可从 events 表重放。
// ─────────────────────────────────────────────────────────────────
package agents

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"soloforge/next/internal/bus"
	"soloforge/next/internal/store"
)

type Orchestrator struct {
	pool    *Pool
	store   *store.Store
	bus     *bus.EventBus
	workers []Worker
	mu      sync.Mutex
	seq     int // dispatchId 序列
}

func NewOrchestrator(pool *Pool, st *store.Store, b *bus.EventBus, workers []Worker) *Orchestrator {
	return &Orchestrator{pool: pool, store: st, bus: b, workers: workers}
}

// emit 先落库后广播 (先写后发纪律)
func (o *Orchestrator) emit(ctx context.Context, typ, source string, payload any) {
	raw, _ := json.Marshal(payload)
	if ev, err := o.store.AppendEvent(ctx, typ, source, raw); err == nil {
		o.bus.Publish(ev.Type, ev.Source, ev.Payload)
	}
}

// DispatchRequest 一次派发的输入
type DispatchRequest struct {
	ChatID  string   `json:"chatId"`
	Prompt  string   `json:"prompt"`
	Workers []string `json:"workers,omitempty"` // worker 名单, 空=全部
}

// DispatchResult 派发终态
type DispatchResult struct {
	DispatchID string          `json:"dispatchId"`
	ChatID     string          `json:"chatId"`
	Outputs    []WorkerOutput  `json:"outputs"`
	Summary    string          `json:"summary"`
	Done       bool            `json:"done"`
}

type WorkerOutput struct {
	Worker  string `json:"worker"`
	Content string `json:"content"`
}

// Dispatch 执行完整管线 (同步骨架; 后续阶段改为异步 + WS 进度流)
// 管线: dispatched → phase0(拆分) → phase1(并行执行) → phase2(汇总评审) → phase3(交付)
func (o *Orchestrator) Dispatch(ctx context.Context, req DispatchRequest) (*DispatchResult, error) {
	o.mu.Lock()
	o.seq++
	dispatchID := fmt.Sprintf("dispatch_%d_%d", time.Now().UnixMilli(), o.seq)
	o.mu.Unlock()

	src := "orchestrator"

	// ── 派发事件 ──
	o.emit(ctx, "agent.task.dispatched", src, map[string]any{
		"dispatchId": dispatchID, "chatId": req.ChatID, "prompt": req.Prompt,
	})

	// ── phase0: 子任务拆分 (骨架: 单提示直接作为唯一子任务) ──
	subtasks := []string{req.Prompt}
	o.emit(ctx, "phase0_subtask", src, map[string]any{
		"dispatchId": dispatchID, "chatId": req.ChatID, "subtasks": subtasks,
	})

	// ── phase1: 并行执行 ──
	workers := o.selectWorkers(req.Workers)
	if len(workers) == 0 {
		return nil, fmt.Errorf("无可用 worker (注册 worker 数: %d)", len(o.workers))
	}
	type result struct {
		idx     int
		worker  string
		content string
		err     error
	}
	results := make([]result, len(workers))
	var wg sync.WaitGroup
	for i, w := range workers {
		wg.Add(1)
		go func(idx int, w Worker) {
			defer wg.Done()
			o.emit(ctx, "phase1_worker_start", src, map[string]any{
				"dispatchId": dispatchID, "workerIdx": idx, "worker": w.Name(),
			})
			ctxTimeout, cancel := context.WithTimeout(ctx, 120*time.Second)
			defer cancel()
			content, err := w.Execute(ctxTimeout, subtasks[0])
			results[idx] = result{idx: idx, worker: w.Name(), content: content, err: err}
			evType := "phase1_worker_done"
			payload := map[string]any{"dispatchId": dispatchID, "workerIdx": idx, "worker": w.Name()}
			if err != nil {
				evType = "phase1_worker_error"
				payload["error"] = err.Error()
			} else {
				payload["output"] = content
			}
			o.emit(ctx, evType, src, payload)
		}(i, w)
	}
	wg.Wait()

	// ── phase2: 汇总评审 (骨架: 选第一个成功输出作为结论) ──
	var best *result
	for i := range results {
		if results[i].err == nil {
			best = &results[i]
			break
		}
	}
	summary := ""
	if best != nil {
		summary = best.content
		o.emit(ctx, "phase2_judge", src, map[string]any{
			"dispatchId": dispatchID, "winner": best.worker, "candidates": len(results),
		})
	} else {
		summary = "所有 worker 执行失败"
		o.emit(ctx, "phase2_judge", src, map[string]any{
			"dispatchId": dispatchID, "error": summary,
		})
	}

	// ── phase3: 交付 ──
	outputs := make([]WorkerOutput, 0, len(results))
	for _, r := range results {
		if r.err == nil {
			outputs = append(outputs, WorkerOutput{Worker: r.worker, Content: r.content})
		}
	}
	res := &DispatchResult{
		DispatchID: dispatchID,
		ChatID:     req.ChatID,
		Outputs:    outputs,
		Summary:    summary,
		Done:       true,
	}
	o.emit(ctx, "phase3_deliver_done", src, map[string]any{
		"dispatchId": dispatchID, "chatId": req.ChatID, "summary": summary,
	})
	return res, nil
}

// selectWorkers 按名单筛选 (空名单 = 全部)
func (o *Orchestrator) selectWorkers(names []string) []Worker {
	if len(names) == 0 {
		return o.workers
	}
	var out []Worker
	for _, w := range o.workers {
		for _, n := range names {
			if w.Name() == n {
				out = append(out, w)
				break
			}
		}
	}
	return out
}
