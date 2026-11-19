// ─────────────────────────────────────────────────────────────────
// task — 任务台账 (从 TS agent-registry.ts / agent-decision-orchestrator.ts 的
// 任务事件语义迁移)
//
// 语义对齐 (protocol.md §1 / §6):
//   - agent.task.dispatched — 派发广播 (TS RuntimeEvent.AgentTaskDispatched 载荷:
//     packetUuid/packetSizeKb/candidateCount/chatId; Go 侧主键为 dispatchId)
//   - agent.task.executed  — 单 worker 执行完成广播 (TS 载荷: agentId/packetUuid/
//     llmExecuted=true/...); 同时累计池 executions
//   - 台账状态机: dispatched → running (assignment) → done | failed
//   - 实时裁判喊停记录 (worker_stopped_by_judge 的台账侧留痕)
//
// 与 TS 版差异: TS 无独立台账对象 (事件即记录); Go 侧补一个进程内台账
// (重启清零), 供 GET /api/agents/tasks 审计查询。事件仍先落库后广播。
// ─────────────────────────────────────────────────────────────────
package agents

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"soloforge/next/internal/bus"
	"soloforge/next/internal/store"
)

// 任务台账状态
const (
	TaskStatusDispatched = "dispatched" // 已派发, 待分配
	TaskStatusRunning    = "running"    // 至少一个 worker 已分配执行中
	TaskStatusDone       = "done"       // 交付完成
	TaskStatusFailed     = "failed"     // 交付失败 (全部 worker 失败/被喊停)
)

// LedgerTask 台账任务条目
type LedgerTask struct {
	TaskID      string         `json:"taskId"` // = dispatchId
	ChatID      string         `json:"chatId"`
	Prompt      string         `json:"prompt"`
	Subtasks    []string       `json:"subtasks,omitempty"`
	Status      string         `json:"status"`
	Assignments map[int]string `json:"assignments,omitempty"` // workerIdx → worker 名 (assignment 留痕)
	JudgeStops  map[int]string `json:"judgeStops,omitempty"`  // workerIdx → 喊停原因
	WorkerCount int            `json:"workerCount"`
	OKCount     int            `json:"okCount"`
	FailCount   int            `json:"failCount"`
	Summary     string         `json:"summary,omitempty"`
	Error       string         `json:"error,omitempty"`
	StartedAt   int64          `json:"startedAt"`
	FinishedAt  int64          `json:"finishedAt,omitempty"`
}

// TaskLedger 任务台账 (进程内; agent.task.* 事件出口)
type TaskLedger struct {
	mu    sync.Mutex
	tasks map[string]*LedgerTask
	order []string // 创建序 (List 稳定输出)
	store *store.Store
	bus   *bus.EventBus
}

// NewTaskLedger 构造台账 (store/bus 构造注入, 事件先落库后广播)
func NewTaskLedger(st *store.Store, b *bus.EventBus) *TaskLedger {
	return &TaskLedger{tasks: make(map[string]*LedgerTask), store: st, bus: b}
}

// Dispatched 记录派发 → 创建台账条目 + 广播 agent.task.dispatched
func (l *TaskLedger) Dispatched(ctx context.Context, taskID, chatID, prompt string, workerCount int) *LedgerTask {
	t := &LedgerTask{
		TaskID:      taskID,
		ChatID:      chatID,
		Prompt:      prompt,
		Status:      TaskStatusDispatched,
		WorkerCount: workerCount,
		StartedAt:   time.Now().UnixMilli(),
	}
	l.mu.Lock()
	l.tasks[taskID] = t
	l.order = append(l.order, taskID)
	l.mu.Unlock()

	l.emit(ctx, "agent.task.dispatched", map[string]any{
		"dispatchId":     taskID,
		"chatId":         chatID,
		"prompt":         prompt,
		"candidateCount": workerCount,
		"timestamp":      t.StartedAt,
	})
	return t
}

// Assigned 记录 worker 分配 (agent.task.dispatched → assignment 语义)
// 首次分配将状态推进为 running
func (l *TaskLedger) Assigned(taskID string, workerIdx int, workerName string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	t := l.tasks[taskID]
	if t == nil {
		return
	}
	if t.Assignments == nil {
		t.Assignments = make(map[int]string)
	}
	t.Assignments[workerIdx] = workerName
	if t.Status == TaskStatusDispatched {
		t.Status = TaskStatusRunning
	}
}

// JudgeStopped 记录实时裁判喊停 (worker_stopped_by_judge 台账留痕)
func (l *TaskLedger) JudgeStopped(taskID string, workerIdx int, reason string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	t := l.tasks[taskID]
	if t == nil {
		return
	}
	if t.JudgeStops == nil {
		t.JudgeStops = make(map[int]string)
	}
	t.JudgeStops[workerIdx] = reason
}

// Executed 记录单 worker 执行终态 → 广播 agent.task.executed
// (载荷对齐 TS executeOnAgent 的 RuntimeEvent.AgentTaskExecuted: agentId/llmExecuted)
func (l *TaskLedger) Executed(ctx context.Context, taskID string, workerIdx int, agentID string, ok bool, outputLen int, durationMs int64, execErr string) {
	l.mu.Lock()
	t := l.tasks[taskID]
	if t != nil {
		if ok {
			t.OKCount++
		} else {
			t.FailCount++
		}
	}
	l.mu.Unlock()

	payload := map[string]any{
		"dispatchId":  taskID,
		"agentId":     agentID,
		"workerIdx":   workerIdx,
		"llmExecuted": ok,
		"ok":          ok,
		"durationMs":  durationMs,
		"timestamp":   time.Now().UnixMilli(),
	}
	if execErr != "" {
		payload["error"] = execErr
	} else {
		payload["outputLength"] = outputLen
	}
	l.emit(ctx, "agent.task.executed", payload)
}

// Delivered 记录交付终态: 全部 worker 成功 ≥1 → done, 否则 failed
func (l *TaskLedger) Delivered(taskID, summary string, ok bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	t := l.tasks[taskID]
	if t == nil {
		return
	}
	t.Summary = summary
	t.Status = TaskStatusDone
	if !ok {
		t.Status = TaskStatusFailed
	}
	t.FinishedAt = time.Now().UnixMilli()
}

// Get 查询单个任务 (副本)
func (l *TaskLedger) Get(taskID string) (LedgerTask, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	t, ok := l.tasks[taskID]
	if !ok {
		return LedgerTask{}, false
	}
	return *t, true
}

// List 任务列表 (按创建时间倒序, limit ≤0 时取 100)
func (l *TaskLedger) List(limit int) []LedgerTask {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]LedgerTask, 0, len(l.tasks))
	for i := len(l.order) - 1; i >= 0; i-- {
		if t, ok := l.tasks[l.order[i]]; ok {
			out = append(out, *t)
		}
	}
	if limit <= 0 {
		limit = 100
	}
	if len(out) > limit {
		out = out[:limit]
	}
	return out
}

// ActiveCount 查询进行中任务数 (dispatched/running)
func (l *TaskLedger) ActiveCount() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	n := 0
	for _, t := range l.tasks {
		if t.Status == TaskStatusDispatched || t.Status == TaskStatusRunning {
			n++
		}
	}
	return n
}

// emit 先落库后广播 (对齐 court.go emit 纪律)
func (l *TaskLedger) emit(ctx context.Context, typ string, payload map[string]any) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return
	}
	if ev, err := l.store.AppendEvent(ctx, typ, "agents.task", raw); err == nil {
		l.bus.Publish(ev)
	}
}
