// ─────────────────────────────────────────────────────────────────
// judge — 实时裁判喊停 (从 TS kernel/realtime-judge-stop-component.ts 迁移)
//
// 语义对齐:
//   - 监听 worker 输出累积, 每积累到 CHUNK_THRESHOLD=600 字符触发一次
//     "明显跑偏"检测 (轻量 LLM 判定 off_track)
//   - 判定跑偏 → STOP 语义: 标记该 worker 停止 + 广播 worker_stopped_by_judge
//     {dispatchId, workerIdx, reason} (protocol.md §6 事件名) + 可选停止回调
//   - 同一 worker 最多检测 2 次, 检测用最近 1200 字符, taskHint 截断 400 字符
//   - worker done/failed → 停止监控该 worker; dispatch 结束 → 清理缓冲
//
// 与 TS 版差异:
//   - TS 由 worker_chunk 流式事件异步触发 (fire-and-forget); Go 侧 Worker.Execute
//     为一次性返回, 编排器在 phase1_worker_done 后把整段输出作为单个 chunk 喂入,
//     检测同步执行, 结果直接参与 phase2 胜者筛选 (被喊停 worker 的输出不参与评审)
//   - 因单 chunk 喂入, "两次检测间最少间隔 3 个 chunk" 仅约束第二次及以后的检测
//   - STOP 下发: TS 经 Java TCP (action='STOP'); Go 侧为可选 StopHook 回调
//     (进程内模型默认无外部执行器, 喊停语义 = 排除输出 + 事件广播)
//
// ─────────────────────────────────────────────────────────────────
package agents

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// 实时裁判参数 (对齐 TS CHUNK_THRESHOLD=600 / MIN_CHUNKS_BETWEEN_CHECKS=3 /
// MAX_CHECKS_PER_WORKER=2, recentContent slice(-1200), taskHint slice(0,400))
const (
	judgeChunkThreshold     = 600
	judgeMinChunksBetween   = 3
	judgeMaxChecksPerWorker = 2
	judgeRecentWindow       = 1200
	judgeTaskHintMax        = 400
	judgeCheckTimeout       = 30 * time.Second
)

// OffTrackJudge 跑偏检测裁判接口 (轻量 LLM 实现)
type OffTrackJudge interface {
	// EvaluateOffTrack 判断 worker 输出是否明显跑偏/严重幻觉/产出垃圾。
	// 返回 offTrack=true 表示应该喊停。
	EvaluateOffTrack(ctx context.Context, taskHint, recentOutput string) (offTrack bool, reason string, err error)
}

// StopHook STOP 下发回调 (Go 侧对 JavaAgentTcpIntegration.sendStopCommand 的承接位)
type StopHook func(ctx context.Context, dispatchID string, workerIdx int)

// workerBuffer 单 worker 输出累积缓冲 (对齐 TS WorkerBuffer)
type workerBuffer struct {
	content              string
	chunkCount           int
	checksRun            int
	chunksSinceLastCheck int
	stopped              bool
}

// dispatchTracker 单次派发的监控上下文 (对齐 TS DispatchTracker)
type dispatchTracker struct {
	taskHint string
	buffers  map[int]*workerBuffer
}

func (t *dispatchTracker) getOrCreate(workerIdx int) *workerBuffer {
	buf, ok := t.buffers[workerIdx]
	if !ok {
		buf = &workerBuffer{}
		t.buffers[workerIdx] = buf
	}
	return buf
}

// RealtimeJudgeStop 实时裁判喊停器
//
// 这是"防御性喊停", 不是每次 dispatch 都跑的常规裁判; 常规多 worker 输出的
// LLM-as-judge 胜者选择在编排器 phase2 处做。
type RealtimeJudgeStop struct {
	mu         sync.Mutex
	dispatches map[string]*dispatchTracker
	judge      OffTrackJudge
	stopHook   StopHook // 可空
	emit       func(ctx context.Context, typ string, payload map[string]any)
}

// NewRealtimeJudgeStop 构造 (judge 为跑偏检测裁判; emit 为先落库后广播的事件出口)
func NewRealtimeJudgeStop(judge OffTrackJudge, emit func(ctx context.Context, typ string, payload map[string]any)) *RealtimeJudgeStop {
	return &RealtimeJudgeStop{
		dispatches: make(map[string]*dispatchTracker),
		judge:      judge,
		emit:       emit,
	}
}

// SetStopHook 注入 STOP 下发回调 (对齐 TS tcp.sendStopCommand(dispatchId, workerIdx))
func (j *RealtimeJudgeStop) SetStopHook(h StopHook) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.stopHook = h
}

// RegisterDispatch 注册派发监控 (taskHint 为空时不监控, 对齐 TS)
func (j *RealtimeJudgeStop) RegisterDispatch(dispatchID, taskHint string) {
	if taskHint == "" {
		return
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	j.dispatches[dispatchID] = &dispatchTracker{
		taskHint: taskHint,
		buffers:  make(map[int]*workerBuffer),
	}
}

// UnregisterDispatch 注销派发 (提前终止时)
func (j *RealtimeJudgeStop) UnregisterDispatch(dispatchID string) {
	j.mu.Lock()
	defer j.mu.Unlock()
	delete(j.dispatches, dispatchID)
}

// DispatchDone 派发收尾: 清理该 dispatch 的所有累积缓冲 (对齐 TS onDispatchDone)
func (j *RealtimeJudgeStop) DispatchDone(dispatchID string) {
	j.UnregisterDispatch(dispatchID)
}

// MarkWorkerDone / MarkWorkerFailed worker 收尾: 停止对该 worker 的监控
func (j *RealtimeJudgeStop) MarkWorkerDone(dispatchID string, workerIdx int) {
	j.markStopped(dispatchID, workerIdx)
}

// MarkWorkerFailed 同 MarkWorkerDone (TS onWorkerFailed 语义: 失败即停止监控)
func (j *RealtimeJudgeStop) MarkWorkerFailed(dispatchID string, workerIdx int) {
	j.markStopped(dispatchID, workerIdx)
}

// HasStopped 查询某 worker 是否被裁判喊停 (编排器 phase2 筛选用)
func (j *RealtimeJudgeStop) HasStopped(dispatchID string, workerIdx int) bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	tracker := j.dispatches[dispatchID]
	if tracker == nil {
		return false
	}
	buf, ok := tracker.buffers[workerIdx]
	return ok && buf.stopped
}

// FeedChunk 喂入 worker 输出片段 (对齐 TS onWorkerChunk → runOffTrackCheck):
//   - 累积内容达到 600 字符 → 触发跑偏检测 (同步, 结果参与 phase2 筛选)
//   - 判定跑偏 → 标记停止 + STOP 回调 + 广播 worker_stopped_by_judge
//
// 返回 (是否被喊停, 喊停原因)
func (j *RealtimeJudgeStop) FeedChunk(ctx context.Context, dispatchID string, workerIdx int, content string) (bool, string) {
	j.mu.Lock()
	tracker := j.dispatches[dispatchID]
	if tracker == nil || j.judge == nil {
		j.mu.Unlock()
		return false, "" // 未注册 taskHint 的 dispatch 不做实时判断 (对齐 TS)
	}
	buf := tracker.getOrCreate(workerIdx)
	if buf.stopped {
		j.mu.Unlock()
		return true, "stopped"
	}
	taskHint := tracker.taskHint
	judge := j.judge
	buf.content += content
	buf.chunkCount++
	buf.chunksSinceLastCheck++

	// 阈值闸门 (对齐 TS): 累积 < 600 字符不检测; 非首次检测需间隔 ≥3 个 chunk;
	// 同一 worker 最多检测 2 次
	if utf8.RuneCountInString(buf.content) < judgeChunkThreshold {
		j.mu.Unlock()
		return false, ""
	}
	if buf.checksRun > 0 && buf.chunksSinceLastCheck < judgeMinChunksBetween {
		j.mu.Unlock()
		return false, ""
	}
	if buf.checksRun >= judgeMaxChecksPerWorker {
		j.mu.Unlock()
		return false, ""
	}
	buf.chunksSinceLastCheck = 0
	buf.checksRun++
	recent := lastRunes(buf.content, judgeRecentWindow)
	j.mu.Unlock()

	// 跑偏检测 (TS 为异步 fire-and-forget; Go 侧同步, 超时 30s 防管线阻塞)
	checkCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), judgeCheckTimeout)
	defer cancel()
	offTrack, reason, err := judge.EvaluateOffTrack(checkCtx, taskHint, recent)
	if err != nil {
		// 检测失败按在轨处理 (对齐 TS), 但广播 phase2_judge_error 供审计
		if j.emit != nil {
			j.emit(ctx, "phase2_judge_error", map[string]any{
				"dispatchId": dispatchID, "workerIdx": workerIdx,
				"stage": "realtime_judge", "error": err.Error(),
			})
		}
		return false, ""
	}

	if !offTrack {
		return false, ""
	}

	// ── STOP 语义 ──
	j.mu.Lock()
	buf.stopped = true
	hook := j.stopHook
	j.mu.Unlock()
	if hook != nil {
		hook(ctx, dispatchID, workerIdx)
	}
	if j.emit != nil {
		j.emit(ctx, "worker_stopped_by_judge", map[string]any{
			"dispatchId": dispatchID,
			"workerIdx":  workerIdx,
			"reason":     reason,
		})
	}
	return true, reason
}

func (j *RealtimeJudgeStop) markStopped(dispatchID string, workerIdx int) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if tracker := j.dispatches[dispatchID]; tracker != nil {
		if buf, ok := tracker.buffers[workerIdx]; ok {
			buf.stopped = true
		}
	}
}

// lastRunes 取字符串末尾 n 个字符 (对齐 TS slice(-1200))
func lastRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[len(r)-n:])
}

// ── 轻量 LLM 跑偏裁判 (对齐 TS runOffTrackCheck 的提示词与 JSON 约定) ──

// LLMOffTrackJudge 用通用 LLM Worker 实现跑偏检测
type LLMOffTrackJudge struct {
	worker Worker
}

// NewLLMOffTrackJudge 构造 (worker 为任意 OpenAI 兼容执行后端)
func NewLLMOffTrackJudge(w Worker) *LLMOffTrackJudge {
	return &LLMOffTrackJudge{worker: w}
}

// EvaluateOffTrack 判断是否跑偏。响应约定为严格 JSON {"off_track":bool,"reason":str};
// 无 JSON / 解析失败 / 调用失败 → 视为在轨 (对齐 TS 保守策略)
func (l *LLMOffTrackJudge) EvaluateOffTrack(ctx context.Context, taskHint, recentOutput string) (bool, string, error) {
	prompt := fmt.Sprintf(
		`You are a real-time quality monitor for an AI assistant worker.
Given the task and a snippet of the worker's ongoing output, decide if the worker is clearly off-track, hallucinating badly, or producing garbage.
Respond in EXACTLY this JSON format:
{"off_track": true/false, "reason": "<brief>"}

Only mark off_track=true if the output is clearly useless. Minor imperfections should be false.

Task: %s

Worker output so far:
%s`, truncateRunes(taskHint, judgeTaskHintMax), recentOutput)

	raw, err := l.worker.Execute(ctx, prompt)
	if err != nil {
		return false, "", err
	}
	// 提取首个 {...} JSON 片段 (对齐 TS /\{[\s\S]*?\}/)
	start := strings.Index(raw, "{")
	end := strings.LastIndex(raw, "}")
	if start < 0 || end <= start {
		return false, "no-json(assume on-track)", nil
	}
	var parsed struct {
		OffTrack bool   `json:"off_track"`
		Reason   string `json:"reason"`
	}
	if json.Unmarshal([]byte(raw[start:end+1]), &parsed) != nil {
		return false, "parse-fail(assume on-track)", nil
	}
	return parsed.OffTrack, parsed.Reason, nil
}

// truncateRunes 截断前 n 个字符 (对齐 TS slice(0, 400))
func truncateRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}
