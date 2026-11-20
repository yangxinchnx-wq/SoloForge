// ─────────────────────────────────────────────────────────────────
// bumcp.go — Browser-Use MCP stdio 会话层 (批次 9)
// (从 TS src/core/browser-use/{mcp-client,orchestrator,task-store,
//
//	event-bus,obscura-config}.ts 迁移)
//
// 会话复用策略 (对齐 TS mcp-client.ts):
//   - 持久 stdio 子进程会话: 首次调用 lazy 启动 python
//     -m browser_use_service.server, 跨调用复用同一进程
//   - JSON-RPC 2.0 over LSP/MCP Content-Length 分帧
//     (Content-Length: <len>\r\n\r\n<body>, 多帧可拼接/跨片)
//   - initialize 握手 (protocol 2024-11-05) + notifications/initialized
//   - 请求 30s 超时; stdout EOF/进程退出 → 失败所有 pending
//   - 异常退出自动重启 (最多 3 次, 间隔 2s); stop() 失败 pending
//   - Windows: cwd 反斜杠归一化 (libuv/Go exec 兼容)
//
// 任务镜像 (对齐 TS task-store.ts): Python 端是权威, 本地内存镜像
// 供列表/调试; 终态 (success/error/cancelled) 自动盖 finishedAt。
//
// ReAct 步进事件 (对齐 TS event-bus.ts): MCP notification
// notifications/progress (progressToken=taskId, data=step) → 按 taskId
// 路由订阅者; kind=final → success / kind=error → error 结算任务。
//
// 截图/等待语义 (补齐, TS 由 Python 端承载):
//   - 截图载荷为 base64 PNG, 超 8MB 视为异常帧拒绝 (防内存放大)
//   - WaitForStep / WaitForIdle: 步进流的轮询等待语义 (deadline+tick)
//
// 元素定位回退链 (补齐): 元素类工具参数按 CSS 选择器 → 可见文本 →
// aria/role → xpath 顺序生成回退候选, 前一策略命中失败自动顺延。
// ─────────────────────────────────────────────────────────────────
package toolsrelay

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ── 常量 (对齐 TS) ──────────────────────────────────────────────

const (
	mcpProtocolVersion = "2024-11-05"
	mcpRequestTimeout  = 30 * time.Second // TS: 30s
	mcpMaxRestarts     = 3                // TS: maxRestarts
	mcpRestartDelay    = 2 * time.Second  // TS: setTimeout 2000

	buTaskPruneAge       = 7 * 24 * time.Hour     // TS: pruneTasks 默认 7 天
	buStepMax            = 100                    // 每任务保留步进上限
	buScreenshotMaxBytes = 8 * 1024 * 1024        // 截图 b64 上限 8MB (补齐)
	buIdleWaitInterval   = 250 * time.Millisecond // 等待轮询间隔 (补齐)
)

// ReactStep ReAct 步进 (对齐 TS ReactStepEvent.step)
type ReactStep struct {
	TaskID       string `json:"task_id"`
	StepIndex    int    `json:"step_index"`
	Kind         string `json:"kind"` // thought | action | observation | error | final
	Content      string `json:"content"`
	URL          string `json:"url"`
	Title        string `json:"title"`
	Screenshot64 string `json:"screenshot_b64"`
	DurationMs   int64  `json:"duration_ms"`
	TimestampMs  int64  `json:"timestamp_ms"`
}

// validScreenshot 校验截图载荷 (等待/截图语义补齐: base64 PNG 上限 8MB)
func validScreenshot(b64 string) bool {
	if b64 == "" {
		return true // 无截图合法
	}
	return len(b64) <= buScreenshotMaxBytes
}

// ── 任务镜像 (对齐 TS task-store.ts) ────────────────────────────

// TaskStatus 任务状态
type TaskStatus string

const (
	TaskQueued    TaskStatus = "queued"
	TaskRunning   TaskStatus = "running"
	TaskPaused    TaskStatus = "paused"
	TaskSuccess   TaskStatus = "success"
	TaskError     TaskStatus = "error"
	TaskCancelled TaskStatus = "cancelled"
)

// isTerminalStatus 终态判定
func isTerminalStatus(s TaskStatus) bool {
	return s == TaskSuccess || s == TaskError || s == TaskCancelled
}

// TaskRecord 任务镜像记录
type TaskRecord struct {
	TaskID      string     `json:"taskId"`
	Task        string     `json:"task"`
	Status      TaskStatus `json:"status"`
	CurrentStep int        `json:"currentStep"`
	Result      string     `json:"result"`
	Error       string     `json:"error"`
	StartedAt   int64      `json:"startedAt"`
	FinishedAt  *int64     `json:"finishedAt"`
}

// BUTaskStore 内存级任务注册表 (Python 端为权威; 并发安全)
type BUTaskStore struct {
	mu    sync.RWMutex
	tasks map[string]*TaskRecord
}

// NewBUTaskStore 构造任务镜像
func NewBUTaskStore() *BUTaskStore {
	return &BUTaskStore{tasks: make(map[string]*TaskRecord)}
}

// DefaultBUTaskStore 进程级单例 (对齐 TS 模块级 tasks Map)
var DefaultBUTaskStore = NewBUTaskStore()

// UpsertTask 建/合并任务 (对齐 TS upsertTask 的逐字段 merge)
func (s *BUTaskStore) UpsertTask(record TaskRecord) TaskRecord {
	s.mu.Lock()
	defer s.mu.Unlock()
	existing := s.tasks[record.TaskID]
	merged := TaskRecord{
		TaskID:      record.TaskID,
		Task:        firstNonEmpty(record.Task, existingTask(existing)),
		Status:      record.Status,
		CurrentStep: record.CurrentStep,
		Result:      firstNonEmpty(record.Result, existingResult(existing)),
		Error:       firstNonEmpty(record.Error, existingError(existing)),
		StartedAt:   nowMs(),
		FinishedAt:  record.FinishedAt,
	}
	if existing != nil {
		if merged.Status == "" {
			merged.Status = existing.Status
		}
		if merged.CurrentStep == 0 {
			merged.CurrentStep = existing.CurrentStep
		}
		merged.StartedAt = existing.StartedAt
		if merged.FinishedAt == nil {
			merged.FinishedAt = existing.FinishedAt
		}
	}
	if merged.Status == "" {
		merged.Status = TaskQueued
	}
	s.tasks[record.TaskID] = &merged
	return merged
}

// PatchTask 增量更新 (对齐 TS patchTask: 终态自动盖 finishedAt)
func (s *BUTaskStore) PatchTask(taskID string, patch TaskRecord) (TaskRecord, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	existing := s.tasks[taskID]
	if existing == nil {
		return TaskRecord{}, false
	}
	next := *existing
	if patch.Status != "" {
		next.Status = patch.Status
	}
	if patch.CurrentStep != 0 {
		next.CurrentStep = patch.CurrentStep
	}
	if patch.Result != "" {
		next.Result = patch.Result
	}
	if patch.Error != "" {
		next.Error = patch.Error
	}
	if patch.FinishedAt != nil {
		next.FinishedAt = patch.FinishedAt
	}
	if isTerminalStatus(next.Status) && existing.FinishedAt == nil {
		now := nowMs()
		next.FinishedAt = &now
	}
	s.tasks[taskID] = &next
	return next, true
}

// GetTask 查询单个
func (s *BUTaskStore) GetTask(taskID string) (TaskRecord, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	t, ok := s.tasks[taskID]
	if !ok {
		return TaskRecord{}, false
	}
	return *t, true
}

// ListTasks 全量列表 (按 startedAt 倒序, 对齐 TS listTasks)
func (s *BUTaskStore) ListTasks() []TaskRecord {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]TaskRecord, 0, len(s.tasks))
	for _, t := range s.tasks {
		out = append(out, *t)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].StartedAt > out[j].StartedAt })
	return out
}

// PruneTasks 清理过期任务 (finishedAt 超 maxAge; 对齐 TS pruneTasks)
func (s *BUTaskStore) PruneTasks(maxAge time.Duration) int {
	cutoff := nowMs() - maxAge.Milliseconds()
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for id, t := range s.tasks {
		if t.FinishedAt != nil && *t.FinishedAt < cutoff {
			delete(s.tasks, id)
			n++
		}
	}
	return n
}

func existingTask(t *TaskRecord) string {
	if t == nil {
		return ""
	}
	return t.Task
}
func existingResult(t *TaskRecord) string {
	if t == nil {
		return ""
	}
	return t.Result
}
func existingError(t *TaskRecord) string {
	if t == nil {
		return ""
	}
	return t.Error
}
func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func nowMs() int64 { return time.Now().UnixMilli() }

// ── 步进事件总线 (对齐 TS event-bus.ts) ─────────────────────────

// stepListener 订阅者包装 (函数值不可比较, 以指针身份退订)
type stepListener struct {
	fn func(ReactStep)
}

// BUStepBus ReAct 步进路由 (taskId → 订阅者; 并发安全, 对齐 TS EventEmitter)
type BUStepBus struct {
	mu   sync.RWMutex
	subs map[string][]*stepListener
	all  []*stepListener // 'step' 频道 (对齐 TS emit('step', ev))
}

// NewBUStepBus 构造步进总线
func NewBUStepBus() *BUStepBus {
	return &BUStepBus{subs: make(map[string][]*stepListener)}
}

// DefaultBUStepBus 进程级单例
var DefaultBUStepBus = NewBUStepBus()

// SubscribeTask 订阅某任务的事件, 返回退订函数
func (b *BUStepBus) SubscribeTask(taskID string, fn func(ReactStep)) func() {
	b.mu.Lock()
	defer b.mu.Unlock()
	w := &stepListener{fn: fn}
	b.subs[taskID] = append(b.subs[taskID], w)
	return func() {
		b.mu.Lock()
		defer b.mu.Unlock()
		list := b.subs[taskID]
		for i, f := range list {
			if f == w {
				b.subs[taskID] = append(list[:i], list[i+1:]...)
				break
			}
		}
	}
}

// PublishStep 发布 step 事件 (对齐 TS publishStep: 'step' + 'task:<id>')
func (b *BUStepBus) PublishStep(ev ReactStep) {
	b.mu.RLock()
	taskSubs := append([]*stepListener(nil), b.subs[ev.TaskID]...)
	all := append([]*stepListener(nil), b.all...)
	b.mu.RUnlock()
	for _, w := range all {
		w.fn(ev)
	}
	for _, w := range taskSubs {
		w.fn(ev)
	}
}

// WaitForStep 等待语义 (补齐): 阻塞等待 taskId 的下一个步进事件
// (含 final/error), deadline 到期返回超时错误。
func (b *BUStepBus) WaitForStep(ctx context.Context, taskID string, timeout time.Duration) (ReactStep, error) {
	ch := make(chan ReactStep, 1)
	unsub := b.SubscribeTask(taskID, func(step ReactStep) {
		select {
		case ch <- step:
		default:
		}
	})
	defer unsub()
	select {
	case step := <-ch:
		return step, nil
	case <-ctx.Done():
		return ReactStep{}, ctx.Err()
	case <-time.After(timeout):
		return ReactStep{}, fmt.Errorf("等待任务 %s 步进超时 (%v)", taskID, timeout)
	}
}

// WaitForIdle 等待语义 (补齐): 轮询等待任务到达终态 (success/error/cancelled),
// poll 间隔 250ms; deadline 到期返回最近快照与超时错误。
func (s *BUTaskStore) WaitForIdle(ctx context.Context, taskID string, timeout time.Duration) (TaskRecord, error) {
	deadline := time.Now().Add(timeout)
	for {
		t, ok := s.GetTask(taskID)
		if ok && isTerminalStatus(t.Status) {
			return t, nil
		}
		if ctx.Err() != nil {
			return t, ctx.Err()
		}
		if time.Now().After(deadline) {
			return t, fmt.Errorf("等待任务 %s 终态超时 (%v)", taskID, timeout)
		}
		time.Sleep(buIdleWaitInterval)
	}
}

// ── MCP stdio 会话 (对齐 TS mcp-client.ts) ──────────────────────

// buProcess 抽象子进程句柄 (测试可注入桩)
type buProcess interface {
	StdinWrite(p []byte) error
	// ReadFrames 循环读取 stdout 并按帧回调 (阻塞直至 EOF/出错)
	Stdout() <-chan string
	Wait() error
	Kill()
}

// buStartFunc 启动子进程 (可注入桩; 签名返回进程句柄)
type buStartFunc func(cwd string, cmd []string) (buProcess, error)

// BUMcpSession Browser-Use MCP stdio 会话 (会话复用策略)
type BUMcpSession struct {
	mu sync.Mutex
	// 锁协议: mu 保护 proc/started/restarts/tools; pending 登记表由独立 pendMu
	// 保护 (readLoop 解析响应只短暂取 pendMu, 防与持 mu 等待的请求方互等)
	pendMu   sync.Mutex
	proc     buProcess
	nextID   int
	pending  map[int]chan json.RawMessage // pending 登记表 (pendMu 保护)
	pendErr  map[int]error
	started  bool
	restarts int
	tools    []MCPToolInfo

	// PythonPath 优先使用的解释器 (SOLOFORGE_PYTHON_BIN); 空则走候选链
	PythonPath string
	// Cwd browser_use_service 模块的父目录 (仓库 python/)
	Cwd string
	// OnStep MCP progress 通知回调 (orchestrator 接 StepBus)
	OnStep func(taskID string, step ReactStep)

	start buStartFunc // 可注入启动器 (nil = 真实 exec)

	stopOnce sync.Once
	stopped  chan struct{}
}

// MCPToolInfo MCP 工具描述 (对齐 TS McpToolInfo)
type MCPToolInfo struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
}

// NewBUMcpSession 构造 MCP 会话 (Cwd 为空时按 cwd=python/ 推导)
func NewBUMcpSession(pythonPath, cwd string) *BUMcpSession {
	if cwd != "" && runtime.GOOS == "windows" {
		cwd = strings.ReplaceAll(cwd, "\\", "/") // 对齐 TS: 反斜杠归一化 (ENOENT)
	}
	return &BUMcpSession{
		PythonPath: pythonPath,
		Cwd:        cwd,
		pending:    make(map[int]chan json.RawMessage),
		pendErr:    make(map[int]error),
		nextID:     1,
		stopped:    make(chan struct{}),
	}
}

// DefaultBUMcpSession 进程级单例 (对齐 TS getOrchestrator 单例语义)
var DefaultBUMcpSession = NewBUMcpSession(os.Getenv("SOLOFORGE_PYTHON_BIN"), "")

// ensureStarted 会话复用入口 (对齐 TS start: 幂等 + 单飞)。
// 单飞语义 = 持锁完成整个启动+握手; readLoop 的响应投递发生在锁外
// (见 requestLocked 等待协议), 不会与该锁死锁。
func (s *BUMcpSession) ensureStarted(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.started {
		return nil
	}
	if err := s.bootLocked(ctx); err != nil {
		return err
	}
	s.started = true
	return nil
}

// bootLocked 启动子进程 + initialize 握手 (须持锁)
func (s *BUMcpSession) bootLocked(ctx context.Context) error {
	cmd := s.buildCommand()
	slog.Info("[bu-mcp] starting", "cmd", strings.Join(cmd, " "))

	start := s.start
	if start == nil {
		start = startRealProcess
	}
	proc, err := start(s.Cwd, cmd)
	if err != nil {
		return fmt.Errorf("MCP 子进程启动失败: %w", err)
	}
	s.proc = proc

	// 帧读取循环: 解析 response/notification
	go s.readLoop(proc)

	// initialize 握手 + initialized 通知 (对齐 TS _start)
	if _, err := s.requestLocked(ctx, "initialize", map[string]any{
		"protocolVersion": mcpProtocolVersion,
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]any{"name": "soloforge-core", "version": "1.0.0"},
	}); err != nil {
		s.failAllPending("MCP initialize failed: " + err.Error())
		proc.Kill()
		s.proc = nil
		return err
	}
	s.notifyLocked("notifications/initialized", map[string]any{})
	return nil
}

// buildCommand 解释器候选链 (对齐 TS _buildCommand):
// 仓库内 python-3.13 → SOLOFORGE_PYTHON_BIN → python → python3
func (s *BUMcpSession) buildCommand() []string {
	var candidates []string
	// 仓库内便携 python (相对 Cwd=python/ 上溯两级 = 仓库根)
	if s.Cwd != "" {
		repoRoot := filepath.Clean(filepath.Join(s.Cwd, "..", ".."))
		candidates = append(candidates, filepath.Join(repoRoot, "bin", "python-3.13", "python.exe"))
	}
	if s.PythonPath != "" {
		candidates = append(candidates, s.PythonPath)
	}
	candidates = append(candidates, "python", "python3")

	python := "python"
	for _, c := range candidates {
		if c == "python" || c == "python3" {
			python = c
			break
		}
		if _, err := os.Stat(c); err == nil {
			python = c
			break
		}
	}
	return []string{python, "-m", "browser_use_service.server"}
}

// startRealProcess 真实子进程启动 (Content-Length 帧经 stdin/stdout)
func startRealProcess(cwd string, cmd []string) (buProcess, error) {
	c := exec.Command(cmd[0], cmd[1:]...)
	if cwd != "" {
		c.Dir = cwd
	}
	c.Env = append(os.Environ(), "PYTHONUNBUFFERED=1")
	stdin, err := c.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := c.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := c.Start(); err != nil {
		return nil, err
	}
	frames := make(chan string, 16)
	proc := &realBUProcess{cmd: c, stdin: stdin, frames: frames}
	go proc.pump(stdout)
	return proc, nil
}

type realBUProcess struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	frames chan string
	once   sync.Once
}

func (p *realBUProcess) pump(stdout io.Reader) {
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 0, 256*1024), 16*1024*1024)
	// 按 \n 行读, 累积还原 Content-Length 帧
	var buf []byte
	for sc.Scan() {
		buf = append(buf, sc.Bytes()...)
		buf = append(buf, '\n')
		frame, rest, ok := splitCLFrame(buf)
		if !ok {
			continue
		}
		buf = rest
		select {
		case p.frames <- frame:
		default:
		}
	}
	close(p.frames)
}

func (p *realBUProcess) StdinWrite(b []byte) error {
	_, err := p.stdin.Write(b)
	return err
}

func (p *realBUProcess) Stdout() <-chan string { return p.frames }
func (p *realBUProcess) Wait() error           { return p.cmd.Wait() }
func (p *realBUProcess) Kill() {
	p.once.Do(func() {
		_ = p.stdin.Close()
		_ = p.cmd.Process.Kill()
	})
}

// splitCLFrame 从缓冲提取一个完整 Content-Length 帧。
// 返回 (body, 剩余, 是否完整)。
var clHeaderRe = regexp.MustCompile(`(?i)content-length:\s*(\d+)`)

func splitCLFrame(buf []byte) (string, []byte, bool) {
	s := string(buf)
	headerEnd := strings.Index(s, "\r\n\r\n")
	if headerEnd == -1 {
		return "", buf, false
	}
	m := clHeaderRe.FindStringSubmatch(s[:headerEnd])
	if m == nil {
		// 非法头部: 丢弃到下一个换行后重试 (对齐 TS)
		nextNl := strings.Index(s, "\n")
		if nextNl == -1 {
			return "", nil, false
		}
		return "", []byte(s[nextNl+1:]), false
	}
	length, _ := strconv.Atoi(m[1])
	frameStart := headerEnd + 4
	if len(s) < frameStart+length {
		return "", buf, false
	}
	body := s[frameStart : frameStart+length]
	return body, []byte(s[frameStart+length:]), true
}

// readLoop 帧分发循环: response → pending; notification → OnStep
func (s *BUMcpSession) readLoop(proc buProcess) {
	for raw := range proc.Stdout() {
		var msg struct {
			ID     *int            `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  *struct {
				Message string `json:"message"`
			} `json:"error"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if err := json.Unmarshal([]byte(raw), &msg); err != nil {
			slog.Info("[bu-mcp] bad json frame", "err", err)
			continue
		}

		if msg.ID != nil {
			// pending 表由 pendMu 保护 (与 s.mu 分离): 响应解析不得
			// 阻塞在 s.mu 上 — 请求方持 s.mu 等待, 此处只短暂取 pendMu
			s.resolvePending(*msg.ID, msg.Result, msgErrText(msg.Error))
			continue
		}

		// notification (对齐 TS notifications/progress → progressToken=taskId)
		if msg.Method == "notifications/progress" && s.OnStep != nil {
			var p struct {
				ProgressToken string    `json:"progressToken"`
				Data          ReactStep `json:"data"`
			}
			if json.Unmarshal(msg.Params, &p) == nil && p.ProgressToken != "" {
				step := p.Data
				if !validScreenshot(step.Screenshot64) {
					step.Screenshot64 = "" // 异常帧: 截图载荷超限拒绝
					step.Kind = "error"
					step.Content = "截图载荷超限 (8MB), 已剥离"
				}
				s.OnStep(p.ProgressToken, step)
			}
		}
	}

	// stdout EOF: 失败所有 pending + 自动重启 (对齐 TS _onExit)
	s.handleExit()
}

// handleExit 进程退出处理: 失败 pending + 重启 (最多 3 次)。
// 先失败 pending (解锁等待中的请求方) 再取 s.mu 更新会话状态,
// 避免与持锁等待的请求方互等。
func (s *BUMcpSession) handleExit() {
	s.failAllPending("MCP process exited")

	s.mu.Lock()
	s.proc = nil
	restart := s.started && s.restarts < mcpMaxRestarts && !s.isStopped()
	if restart {
		s.restarts++
		attempt := s.restarts
		slog.Info("[bu-mcp] restarting", "attempt", fmt.Sprintf("%d/%d", attempt, mcpMaxRestarts))
	}
	s.mu.Unlock()

	if !restart {
		return
	}
	select {
	case <-s.stopped:
		return
	case <-time.After(mcpRestartDelay):
	}
	ctx, cancel := context.WithTimeout(context.Background(), mcpRequestTimeout)
	defer cancel()
	s.mu.Lock()
	s.started = false
	s.mu.Unlock()
	if err := s.ensureStarted(ctx); err != nil {
		slog.Error("[bu-mcp] restart failed", "err", err)
	}
}

func (s *BUMcpSession) isStopped() bool {
	select {
	case <-s.stopped:
		return true
	default:
		return false
	}
}

// requestLocked 发送 JSON-RPC 请求并等待响应 (须持 s.mu, 且整个等待期间
// 持锁; 30s 超时)。等待协议: pending 登记表由独立的 pendMu 保护,
// readLoop 解析响应只短暂取 pendMu 并在锁外向通道投递结果 (缓冲 1),
// 故持 s.mu 等待不会与响应方互等。
func (s *BUMcpSession) requestLocked(ctx context.Context, method string, params any) (json.RawMessage, error) {
	if s.proc == nil {
		return nil, fmt.Errorf("MCP process not running")
	}
	id := s.nextID
	s.nextID++
	ch := s.registerPending(id)

	if err := s.writeFrameLocked(map[string]any{
		"jsonrpc": "2.0", "id": id, "method": method, "params": params,
	}); err != nil {
		s.removePending(id)
		return nil, err
	}

	timeout := time.NewTimer(mcpRequestTimeout)
	defer timeout.Stop()
	select {
	case result := <-ch:
		if err := s.popPendingErr(id); err != nil {
			return nil, err
		}
		return result, nil
	case <-ctx.Done():
		s.removePending(id)
		return nil, ctx.Err()
	case <-timeout.C:
		s.removePending(id)
		return nil, fmt.Errorf("MCP request %s timed out after %v", method, mcpRequestTimeout)
	}
}

// CallTool 调用 MCP 工具 (对齐 TS callTool: 解析 text content / isError)
func (s *BUMcpSession) CallTool(ctx context.Context, name string, args map[string]any) (json.RawMessage, error) {
	if err := s.ensureStarted(ctx); err != nil {
		return nil, err
	}
	result, err := s.request(ctx, "tools/call", map[string]any{"name": name, "arguments": args})
	if err != nil {
		return nil, err
	}
	if len(result) == 0 {
		return nil, nil
	}
	var r struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		IsError bool `json:"isError"`
	}
	if json.Unmarshal(result, &r) == nil {
		for _, c := range r.Content {
			if c.Type == "text" {
				return json.RawMessage(c.Text), nil
			}
		}
		if r.IsError {
			text := "unknown error"
			if len(r.Content) > 0 {
				text = r.Content[0].Text
			}
			return nil, fmt.Errorf("MCP tool error: %s", text)
		}
	}
	return result, nil
}

// request 包锁调用 requestLocked (锁协议: requestLocked 全程持锁不自行
// 解锁, 由本入口 defer 释放)
func (s *BUMcpSession) request(ctx context.Context, method string, params any) (json.RawMessage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.requestLocked(ctx, method, params)
}

// notifyLocked 写通知帧 (须持锁)
func (s *BUMcpSession) notifyLocked(method string, params any) {
	_ = s.writeFrameLocked(map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
}

// writeFrameLocked 以 Content-Length 帧写入 stdin (须持锁)
func (s *BUMcpSession) writeFrameLocked(msg any) error {
	if s.proc == nil {
		return fmt.Errorf("MCP process not running")
	}
	body, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	frame := fmt.Sprintf("Content-Length: %d\r\n\r\n%s", len(body), body)
	return s.proc.StdinWrite([]byte(frame))
}

// ── pending 登记表 (pendMu 保护; 与 s.mu 分离防响应方互等) ───────

// registerPending 登记请求 (返回响应通道)
func (s *BUMcpSession) registerPending(id int) chan json.RawMessage {
	s.pendMu.Lock()
	defer s.pendMu.Unlock()
	ch := make(chan json.RawMessage, 1)
	s.pending[id] = ch
	return ch
}

// removePending 超时/取消时移除 (不投递)
func (s *BUMcpSession) removePending(id int) {
	s.pendMu.Lock()
	defer s.pendMu.Unlock()
	delete(s.pending, id)
	delete(s.pendErr, id)
}

// resolvePending 响应抵达: 登记错误并投递结果 (锁外发送)
func (s *BUMcpSession) resolvePending(id int, result json.RawMessage, errMsg string) {
	s.pendMu.Lock()
	ch, ok := s.pending[id]
	if ok {
		delete(s.pending, id)
		if errMsg != "" {
			s.pendErr[id] = fmt.Errorf("%s", errMsg)
		}
	}
	s.pendMu.Unlock()
	if ok && ch != nil {
		ch <- result
		close(ch)
	}
}

// popPendingErr 取走该请求的错误 (无则 nil)
func (s *BUMcpSession) popPendingErr(id int) error {
	s.pendMu.Lock()
	defer s.pendMu.Unlock()
	err, has := s.pendErr[id]
	if has {
		delete(s.pendErr, id)
	}
	if err == nil {
		return nil
	}
	return err
}

// failAllPending 失败所有 pending (先解锁等待方, 再做会话状态变更)
func (s *BUMcpSession) failAllPending(reason string) {
	s.pendMu.Lock()
	chans := make([]chan json.RawMessage, 0, len(s.pending))
	for id, ch := range s.pending {
		s.pendErr[id] = fmt.Errorf("%s", reason)
		delete(s.pending, id)
		chans = append(chans, ch)
	}
	s.pendMu.Unlock()
	for _, ch := range chans {
		if ch != nil {
			ch <- nil
			close(ch)
		}
	}
}

// msgErrText 提取 RPC error 消息
func msgErrText(e *struct {
	Message string `json:"message"`
}) string {
	if e == nil {
		return ""
	}
	return e.Message
}

// Stop 优雅关闭 (对齐 TS stop: 杀进程 + 失败 pending)
func (s *BUMcpSession) Stop() {
	s.stopOnce.Do(func() { close(s.stopped) })
	s.mu.Lock()
	proc := s.proc
	s.proc = nil
	s.started = false
	s.failAllPending("MCP client stopped")
	s.mu.Unlock()
	if proc != nil {
		proc.Kill()
	}
}

// ListTools 列出 MCP 工具 (对齐 TS listTools: 缓存)
func (s *BUMcpSession) ListTools(ctx context.Context) ([]MCPToolInfo, error) {
	if err := s.ensureStarted(ctx); err != nil {
		return nil, err
	}
	s.mu.Lock()
	if len(s.tools) > 0 {
		out := append([]MCPToolInfo(nil), s.tools...)
		s.mu.Unlock()
		return out, nil
	}
	result, err := s.requestLocked(ctx, "tools/list", map[string]any{})
	if err != nil {
		s.mu.Unlock()
		return nil, err
	}
	var r struct {
		Tools []MCPToolInfo `json:"tools"`
	}
	_ = json.Unmarshal(result, &r)
	s.tools = r.Tools
	s.mu.Unlock()
	return r.Tools, nil
}

// ── 编排器 (对齐 TS orchestrator.ts) ────────────────────────────

// BUOrchestrator 会话 + 任务镜像 + 步进总线的单一入口
type BUOrchestrator struct {
	Session *BUMcpSession
	Tasks   *BUTaskStore
	Steps   *BUStepBus
}

// NewBUOrchestrator 构造编排器并接线 MCP 通知 → StepBus → 任务结算
func NewBUOrchestrator(session *BUMcpSession, tasks *BUTaskStore, steps *BUStepBus) *BUOrchestrator {
	o := &BUOrchestrator{Session: session, Tasks: tasks, Steps: steps}
	session.OnStep = func(taskID string, step ReactStep) {
		// 步进事件路由 (对齐 TS bus.publishStep)
		o.Steps.PublishStep(step)

		// 任务结算: kind=final → success / kind=error → error (对齐 TS)
		switch step.Kind {
		case "final":
			o.Tasks.PatchTask(taskID, TaskRecord{Status: TaskSuccess, Result: step.Content})
		case "error":
			o.Tasks.PatchTask(taskID, TaskRecord{Status: TaskError, Error: step.Content})
		}
		// step index 推进
		if cur, ok := o.Tasks.GetTask(taskID); ok && step.StepIndex > cur.CurrentStep {
			o.Tasks.PatchTask(taskID, TaskRecord{CurrentStep: step.StepIndex})
		}
	}
	return o
}

// RunTask 提交任务 (对齐 TS runTask)
func (o *BUOrchestrator) RunTask(ctx context.Context, task string) (TaskRecord, error) {
	if strings.TrimSpace(task) == "" {
		return TaskRecord{}, fmt.Errorf("task is required")
	}
	raw, err := o.Session.CallTool(ctx, "browser_run_task", map[string]any{"task": strings.TrimSpace(task)})
	if err != nil {
		return TaskRecord{}, err
	}
	var r struct {
		TaskID      string     `json:"taskId"`
		Status      TaskStatus `json:"status"`
		CurrentStep int        `json:"currentStep"`
		Task        string     `json:"task"`
	}
	if json.Unmarshal(raw, &r) != nil || r.TaskID == "" {
		// text content 直接回传, 尝试二次解析失败则镜像 queued
		return o.Tasks.UpsertTask(TaskRecord{Task: task, Status: TaskQueued}), nil
	}
	status := mapMCPStatus(r.Status)
	return o.Tasks.UpsertTask(TaskRecord{
		TaskID: r.TaskID, Task: r.Task, Status: status, CurrentStep: r.CurrentStep,
	}), nil
}

// mapMCPStatus 状态映射 (对齐 TS STATUS_MAP)
func mapMCPStatus(s TaskStatus) TaskStatus {
	switch s {
	case TaskQueued, TaskRunning, TaskPaused, TaskSuccess, TaskError, TaskCancelled:
		return s
	default:
		return TaskQueued
	}
}

// GetTaskState 查询任务 (终态回缓存; 未终态拉远端, MCP 不可用回缓存)
func (o *BUOrchestrator) GetTaskState(ctx context.Context, taskID string) (TaskRecord, bool) {
	if cached, ok := o.Tasks.GetTask(taskID); ok && isTerminalStatus(cached.Status) {
		return cached, true
	}
	raw, err := o.Session.CallTool(ctx, "browser_get_task_state", map[string]any{"taskId": taskID})
	if err == nil && len(raw) > 0 {
		var fresh TaskRecord
		if json.Unmarshal(raw, &fresh) == nil && fresh.TaskID != "" {
			status := fresh.Status
			if status == "" {
				status = TaskQueued
			}
			patched, _ := o.Tasks.PatchTask(taskID, TaskRecord{
				Status: mapMCPStatus(status), CurrentStep: fresh.CurrentStep,
				Result: fresh.Result, Error: fresh.Error,
			})
			return patched, true
		}
	}
	// MCP 不可用: 返回缓存 (对齐 TS fallback to cache)
	return o.Tasks.GetTask(taskID)
}

// PauseTask / ResumeTask / CancelTask (对齐 TS 同名)
func (o *BUOrchestrator) PauseTask(ctx context.Context, taskID string) bool {
	raw, err := o.Session.CallTool(ctx, "browser_pause_task", map[string]any{"taskId": taskID})
	if err != nil {
		return false
	}
	var r struct {
		Paused bool `json:"paused"`
	}
	_ = json.Unmarshal(raw, &r)
	if r.Paused {
		o.Tasks.PatchTask(taskID, TaskRecord{Status: TaskPaused})
	}
	return r.Paused
}

func (o *BUOrchestrator) ResumeTask(ctx context.Context, taskID string) bool {
	raw, err := o.Session.CallTool(ctx, "browser_resume_task", map[string]any{"taskId": taskID})
	if err != nil {
		return false
	}
	var r struct {
		Resumed bool `json:"resumed"`
	}
	_ = json.Unmarshal(raw, &r)
	if r.Resumed {
		o.Tasks.PatchTask(taskID, TaskRecord{Status: TaskRunning})
	}
	return r.Resumed
}

func (o *BUOrchestrator) CancelTask(ctx context.Context, taskID string) bool {
	raw, err := o.Session.CallTool(ctx, "browser_cancel_task", map[string]any{"taskId": taskID})
	if err != nil {
		return false
	}
	var r struct {
		Cancelled bool `json:"cancelled"`
	}
	_ = json.Unmarshal(raw, &r)
	if r.Cancelled {
		now := nowMs()
		o.Tasks.PatchTask(taskID, TaskRecord{Status: TaskCancelled, FinishedAt: &now})
	}
	return r.Cancelled
}

// ── 元素定位回退链 (补齐) ────────────────────────────────────────

// 定位策略序 (补齐: CSS → 可见文本 → aria/role → xpath)
const (
	LocatorCSS   = "css"
	LocatorText  = "text"
	LocatorAria  = "aria"
	LocatorXPath = "xpath"
)

// LocatorCandidate 单个定位候选
type LocatorCandidate struct {
	Strategy string `json:"strategy"`
	Value    string `json:"value"`
}

// LocatorFallbackChain 元素定位回退链: 依序生成候选, 执行方按顺序尝试,
// 前一策略未命中自动顺延下一策略 (TS 由 Python 端承载, Go 侧显式化)。
func LocatorFallbackChain(selector, text, aria, xpath string) []LocatorCandidate {
	var chain []LocatorCandidate
	if selector != "" {
		chain = append(chain, LocatorCandidate{LocatorCSS, selector})
	}
	if text != "" {
		chain = append(chain, LocatorCandidate{LocatorText, text})
	}
	if aria != "" {
		chain = append(chain, LocatorCandidate{LocatorAria, aria})
	}
	if xpath != "" {
		chain = append(chain, LocatorCandidate{LocatorXPath, xpath})
	}
	return chain
}

// ResolveLocatorArgs 从工具参数抽取定位字段并生成回退链,
// 以 JSON 数组写回 args["locator_fallback"] (供 Python 端消费)。
func ResolveLocatorArgs(args map[string]any) []LocatorCandidate {
	chain := LocatorFallbackChain(
		strArg(args, "selector"),
		strArg(args, "text"),
		strArg(args, "aria_label"),
		strArg(args, "xpath"),
	)
	if len(chain) > 0 {
		args["locator_fallback"] = chain
	}
	return chain
}

func strArg(a map[string]any, k string) string {
	s, _ := a[k].(string)
	return s
}
