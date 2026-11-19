// ─────────────────────────────────────────────────────────────────
// orchestrator — 多 worker 决策编排器 (阶段 2 骨架 + 深度语义扩展)
//
// 事件语义对齐旧 agent-decision-orchestrator.ts (protocol.md §1/§6):
//
//	agent.task.dispatched → phase0_subtask → phase1_worker_start/done
//	→ phase2_judge → phase3_deliver_start/done
//
// 扩展语义 (从 TS 迁移):
//   - 实时裁判喊停 (realtime-judge-stop-component.ts): worker 输出累积 ≥600 字符
//     触发轻量 LLM 跑偏检测 → STOP: 广播 worker_stopped_by_judge, 被喊停 worker
//     的输出不参与 phase2 评审
//   - agent.task.executed / 信誉直接交互更新 (agent-registry.ts executeOnAgent)
//   - GOSSIP ACL 消息 → 间接信誉更新 (RepuNet)
//
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

	// ── 深度语义扩展组件 (构造即装配, 对齐 TS AgentRegistry 挂载方式) ──
	acl   *ACLBus            // FIPA-ACL 通信总线
	rep   *ReputationEngine  // 多维信誉引擎
	tasks *TaskLedger        // 任务台账
	judge *RealtimeJudgeStop // 实时裁判喊停器 (workers[0] 作为轻量裁判 LLM)
}

func NewOrchestrator(pool *Pool, st *store.Store, b *bus.EventBus, workers []Worker) *Orchestrator {
	o := &Orchestrator{pool: pool, store: st, bus: b, workers: workers}

	// 信誉引擎: 以池内组件为初值注册全部 agent
	o.rep = NewReputationEngine(pool, st, b)
	for _, a := range pool.Snapshot() {
		comp := a.ReputationComponents
		o.rep.Register(a.AgentID, &comp)
	}

	// FIPA-ACL 总线: 注册池内 agent; GOSSIP 消息 → 间接信誉更新 (RepuNet)
	o.acl = NewACLBus(st, b)
	for _, a := range pool.Snapshot() {
		o.acl.Register(a.AgentID)
	}
	o.acl.OnGossip(func(msg ACLMessage) {
		o.rep.HandleACLMessage(msg)
	})

	// 实时裁判: 有可用 worker 时以 workers[0] 作轻量跑偏检测 LLM (对齐 TS 默认代理配置)
	if len(workers) > 0 {
		o.judge = NewRealtimeJudgeStop(NewLLMOffTrackJudge(workers[0]), o.emitJudge)
	}

	// 任务台账: agent.task.dispatched / agent.task.executed 事件出口
	o.tasks = NewTaskLedger(st, b)
	return o
}

// ACL 暴露 FIPA-ACL 通信总线 (跨进程 relay 入口/HTTP 路由用)
func (o *Orchestrator) ACL() *ACLBus { return o.acl }

// Reputation 暴露信誉引擎 (惩罚/奖励/台账路由用)
func (o *Orchestrator) Reputation() *ReputationEngine { return o.rep }

// Tasks 暴露任务台账 (审计查询路由用)
func (o *Orchestrator) Tasks() *TaskLedger { return o.tasks }

// Judge 暴露实时裁判 (外部注入 StopHook 用)
func (o *Orchestrator) Judge() *RealtimeJudgeStop { return o.judge }

// emit 先落库后广播 (先写后发纪律)
func (o *Orchestrator) emit(ctx context.Context, typ, source string, payload any) {
	raw, _ := json.Marshal(payload)
	if ev, err := o.store.AppendEvent(ctx, typ, source, raw); err == nil {
		o.bus.Publish(ev)
	}
}

// emitJudge 实时裁判事件出口 (先落库后广播)
func (o *Orchestrator) emitJudge(ctx context.Context, typ string, payload map[string]any) {
	o.emit(ctx, typ, "agents.judge", payload)
}

// DispatchRequest 一次派发的输入
type DispatchRequest struct {
	ChatID  string   `json:"chatId"`
	Prompt  string   `json:"prompt"`
	Workers []string `json:"workers,omitempty"` // worker 名单, 空=全部
}

// DispatchResult 派发终态
type DispatchResult struct {
	DispatchID string         `json:"dispatchId"`
	ChatID     string         `json:"chatId"`
	Outputs    []WorkerOutput `json:"outputs"`
	Summary    string         `json:"summary"`
	Done       bool           `json:"done"`
	JudgeStops map[int]string `json:"judgeStops,omitempty"` // 被实时裁判喊停的 worker → 原因
}

type WorkerOutput struct {
	Worker  string `json:"worker"`
	Content string `json:"content"`
}

// Dispatch 执行完整管线 (同步骨架; 后续阶段改为异步 + WS 进度流)
// 管线: dispatched → phase0(拆分) → phase1(并行执行 + 实时裁判喊停)
//
//	→ phase2(汇总评审, 排除被喊停输出) → phase3(交付)
func (o *Orchestrator) Dispatch(ctx context.Context, req DispatchRequest) (*DispatchResult, error) {
	o.mu.Lock()
	o.seq++
	dispatchID := fmt.Sprintf("dispatch_%d_%d", time.Now().UnixMilli(), o.seq)
	o.mu.Unlock()

	src := "orchestrator"

	// ── 派发事件 + 台账建档 (agent.task.dispatched 由台账广播) ──
	workers := o.selectWorkers(req.Workers)
	o.tasks.Dispatched(ctx, dispatchID, req.ChatID, req.Prompt, len(workers))

	// ── 注册实时裁判监控 (taskHint = 用户 prompt, 对齐 TS registerDispatch) ──
	if o.judge != nil {
		o.judge.RegisterDispatch(dispatchID, req.Prompt)
	}

	// ── phase0: 子任务拆分 (骨架: 单提示直接作为唯一子任务) ──
	subtasks := []string{req.Prompt}
	o.emit(ctx, "phase0_subtask", src, map[string]any{
		"dispatchId": dispatchID, "chatId": req.ChatID, "subtasks": subtasks,
	})

	// ── phase1: 并行执行 (+ 实时裁判喊停) ──
	if len(workers) == 0 {
		o.tasks.Delivered(dispatchID, "无可用 worker", false) // 台账闭环: failed
		return nil, fmt.Errorf("无可用 worker (注册 worker 数: %d)", len(o.workers))
	}
	type result struct {
		idx        int
		worker     string
		content    string
		err        error
		stopped    bool   // 被实时裁判喊停 (输出不参与 phase2 评审)
		stopReason string // 喊停原因 (judge 评估返回)
	}
	results := make([]result, len(workers))
	var wg sync.WaitGroup
	for i, w := range workers {
		wg.Add(1)
		go func(idx int, w Worker) {
			defer wg.Done()
			// assignment 语义: 台账记录 workerIdx → worker
			o.tasks.Assigned(dispatchID, idx, w.Name())
			o.emit(ctx, "phase1_worker_start", src, map[string]any{
				"dispatchId": dispatchID, "workerIdx": idx, "worker": w.Name(),
			})
			ctxTimeout, cancel := context.WithTimeout(ctx, 120*time.Second)
			t0 := time.Now()
			content, err := w.Execute(ctxTimeout, subtasks[0])
			elapsedMs := time.Since(t0).Milliseconds()
			cancel()

			if err != nil {
				// worker 失败: 台账 + executed 事件 + 执行计数 (对齐 TS m.executions++)
				o.judgeMarkFailed(dispatchID, idx)
				_ = o.pool.RecordExecution(w.Name())
				o.tasks.Executed(ctx, dispatchID, idx, w.Name(), false, 0, elapsedMs, err.Error())
				o.emit(ctx, "phase1_worker_error", src, map[string]any{
					"dispatchId": dispatchID, "workerIdx": idx, "worker": w.Name(), "error": err.Error(),
				})
				results[idx] = result{idx: idx, worker: w.Name(), err: err}
				return
			}

			// ── 实时裁判: 输出作为单 chunk 喂入, ≥600 字符触发跑偏检测 ──
			o.emit(ctx, "worker_chunk", src, map[string]any{
				"dispatchId": dispatchID, "workerIdx": idx, "worker": w.Name(), "content": content,
			})
			stopped, stopReason := false, ""
			if o.judge != nil {
				stopped, stopReason = o.judge.FeedChunk(ctx, dispatchID, idx, content)
				if stopped {
					o.tasks.JudgeStopped(dispatchID, idx, stopReason)
				}
			}
			o.judgeMarkDone(dispatchID, idx)

			// 台账 + 执行计数 + 直接交互信誉更新 (对齐 TS executeOnAgent:
			// 成功后 reliability +0.01 / competence +0.005, 0..1 刻度 → ×100 点数)
			_ = o.pool.RecordExecution(w.Name())
			o.rep.UpdateFromDirectInteraction(w.Name(), ReputationReliability, 1.0, 0)
			o.rep.UpdateFromDirectInteraction(w.Name(), ReputationQuality, 0.5, 0)
			o.tasks.Executed(ctx, dispatchID, idx, w.Name(), true, len([]rune(content)), elapsedMs, "")

			o.emit(ctx, "phase1_worker_done", src, map[string]any{
				"dispatchId": dispatchID, "workerIdx": idx, "worker": w.Name(), "output": content,
			})
			results[idx] = result{idx: idx, worker: w.Name(), content: content, stopped: stopped, stopReason: stopReason}
		}(i, w)
	}
	wg.Wait()

	// ── phase2: 汇总评审 (骨架: 选第一个成功且未被喊停的输出作为结论) ──
	var best *result
	for i := range results {
		if results[i].err == nil && !results[i].stopped {
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
		summary = "所有 worker 执行失败或被实时裁判喊停"
		o.emit(ctx, "phase2_judge", src, map[string]any{
			"dispatchId": dispatchID, "error": summary,
		})
	}

	// ── phase3: 交付 (start/done 事件名对齐 protocol.md §6) ──
	outputs := make([]WorkerOutput, 0, len(results))
	judgeStops := map[int]string{}
	for _, r := range results {
		if r.err == nil && !r.stopped {
			outputs = append(outputs, WorkerOutput{Worker: r.worker, Content: r.content})
		}
		if r.stopped {
			reason := r.stopReason
			if reason == "" {
				reason = "off-track"
			}
			judgeStops[r.idx] = reason
		}
	}
	o.emit(ctx, "phase3_deliver_start", src, map[string]any{
		"dispatchId": dispatchID, "chatId": req.ChatID,
	})
	o.tasks.Delivered(dispatchID, summary, best != nil)
	res := &DispatchResult{
		DispatchID: dispatchID,
		ChatID:     req.ChatID,
		Outputs:    outputs,
		Summary:    summary,
		Done:       true,
		JudgeStops: judgeStops,
	}
	o.emit(ctx, "phase3_deliver_done", src, map[string]any{
		"dispatchId": dispatchID, "chatId": req.ChatID, "summary": summary,
	})

	// 派发收尾: 清理实时裁判缓冲 (对齐 TS dispatch_done → buffers 清理)
	if o.judge != nil {
		o.judge.DispatchDone(dispatchID)
	}
	return res, nil
}

// judgeMarkDone / judgeMarkFailed worker 收尾标记 (judge 未装配时空操作)
func (o *Orchestrator) judgeMarkDone(dispatchID string, idx int) {
	if o.judge != nil {
		o.judge.MarkWorkerDone(dispatchID, idx)
	}
}

func (o *Orchestrator) judgeMarkFailed(dispatchID string, idx int) {
	if o.judge != nil {
		o.judge.MarkWorkerFailed(dispatchID, idx)
	}
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
