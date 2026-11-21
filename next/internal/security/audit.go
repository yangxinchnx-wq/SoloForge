// ─────────────────────────────────────────────────────────────────
// audit — 审计事件完整结构 + 外部 sink 扇出 (stdout / file / http / noop)
//
// 迁移自 TS src/security/:
//
//	AuditEvent        ← auth.ts AuditEvent (含 [key:string]:any 扩展签名)
//	Sink              ← auditSinkBase.ts AuditSinkV2 契约
//	sinkBase          ← AbstractAuditSink (队列/统计/AUDIT_FALLBACK 兜底)
//	SinkStdout        ← auditSinkConcrete.ts StdoutAuditSink (tag=AUDIT)
//	SinkFile          ← FileAuditSink (JSONL 追加 + rotateBytes 轮转)
//	SinkHTTP          ← HttpAuditSink (POST + 指数退避重试)
//	SinkNoop          ← NoopAuditSink
//	NewSinkFromConfig ← auditSinkFactory.ts buildSinkFromConfig
//
// 对齐 docs/protocol.md:
//
//	§2 Kafka 审计链路 — 发送失败降级 stdout JSON 行 (AUDIT_FALLBACK)。
//	   Kafka sink 本体不迁移: kafkajs 是外部依赖, 且 §13 已定
//	   "events 表即审计 (Kafka 移除)"; 远端转发 (SIEM webhook) 需求
//	   由 SinkHTTP 覆盖。auditChangeFeed.ts 的 SurrealDB 轮询同样不迁移
//	   (无 SurrealDB): emit 落 store 后经 bus 广播即变更流。
//	§12.1 routes-vault — 审计事件字段 action/route/method/status/tenantId
//
// 关键不变量 (对齐 auditSinkBase.ts 头注释, 跨所有 sink):
//  1. Deliver 永不阻塞/panic — 队列满 FIFO 丢最旧 (上限 10000, 不 OOM)
//  2. 写失败 → stdout tag=AUDIT_FALLBACK 兜底行 (_sink + _fallbackReason)
//  3. Close 尽力排空队列, 超时 (5s) 即放弃
//  4. 每个 sink 独立 goroutine 消费有界队列, 任一 sink 故障不影响其他
//
// 与 security.go emit 的关系: emit 先落 store (memory sink) 后广播 bus,
// 末尾经 dispatchExternal 把同一事件扇出给本文件挂载的外部 sink —
// "先写后发" 纪律保持不变。
// ─────────────────────────────────────────────────────────────────
package security

import (
	"bytes"
	"compress/gzip"
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
)

// ── 常量 ────────────────────────────────────────────────────────

const (
	// auditTagMirror stdout 正常镜像行 tag (对齐 TS MIRROR_TAG)
	auditTagMirror = "AUDIT"
	// auditTagFallback 降级兜底行 tag (对齐 TS FALLBACK_TAG / protocol.md §2)
	auditTagFallback = "AUDIT_FALLBACK"

	// sinkQueueCap sink 投递队列上限 (对齐 TS KafkaAuditSink maxQueue=10000)
	sinkQueueCap = 10_000
	// sinkCloseTimeout Close 排空等待上限 (对齐 TS closeTimeoutMs=5000)
	sinkCloseTimeout = 5 * time.Second

	// sink 名称 (对齐 TS 各 sink 的 readonly name)
	sinkNameStdout = "stdout"
	sinkNameFile   = "file"
	sinkNameHTTP   = "http"
	sinkNameNoop   = "noop"
)

// ── AuditEvent 审计事件 ─────────────────────────────────────────

// AuditEvent 审计事件完整结构 (对齐 TS auth.ts AuditEvent)。
// extra 字段 (providerId / sensitive / deleted 等) 经 Extra 平铺到顶层 JSON,
// 对齐 TS 索引签名 [key: string]: any 与 {...ev} 展开语义。
type AuditEvent struct {
	ID         string     `json:"id"`                      // aud_<UnixNano>
	Timestamp  int64      `json:"timestamp"`               // 毫秒时间戳
	Action     string     `json:"action"`                  // vault.key.created / auth.denied ...
	Route      string     `json:"route,omitempty"`         // 请求路径
	Method     string     `json:"method,omitempty"`        // HTTP 方法
	Status     int        `json:"status,omitempty"`        // 响应状态码
	RemoteAddr string     `json:"remoteAddress,omitempty"` // 建议传 hashPii 脱敏值
	UserAgent  string     `json:"userAgent,omitempty"`
	Reason     string     `json:"reason,omitempty"`    // 拒绝/失败原因
	Principal  *Principal `json:"principal,omitempty"` // 请求主体 (token.go)
	TenantID   string     `json:"tenantId,omitempty"`  // 租户 (protocol.md §2 Kafka key)
	// Extra 扩展字段 — Marshal 时平铺到顶层, 可覆盖同名字段 (对齐 TS 展开后键覆盖语义)
	Extra map[string]any `json:"-"`
}

// MarshalJSON 结构体字段 + Extra 平铺输出 (Extra 覆盖同名基础字段)
func (e AuditEvent) MarshalJSON() ([]byte, error) {
	type auditEventShadow AuditEvent // 规避 MarshalJSON 递归
	base, err := json.Marshal(auditEventShadow(e))
	if err != nil {
		return nil, err
	}
	if len(e.Extra) == 0 {
		return base, nil
	}
	m := map[string]any{}
	if err := json.Unmarshal(base, &m); err != nil {
		return nil, err
	}
	for k, v := range e.Extra {
		m[k] = v
	}
	return json.Marshal(m)
}

// UnmarshalJSON 未知键收入 Extra, 已知键还原字段 (与 MarshalJSON 对称)
func (e *AuditEvent) UnmarshalJSON(b []byte) error {
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		return err
	}
	*e = auditEventFromMap(m)
	return nil
}

// auditEventFromMap map → AuditEvent (emit payload 的动态 map 转结构体)
func auditEventFromMap(m map[string]any) AuditEvent {
	ev := AuditEvent{Extra: map[string]any{}}
	for k, v := range m {
		switch k {
		case "id":
			ev.ID = auditToString(v)
		case "timestamp":
			ev.Timestamp = auditToInt64(v)
		case "action":
			ev.Action = auditToString(v)
		case "route":
			ev.Route = auditToString(v)
		case "method":
			ev.Method = auditToString(v)
		case "status":
			ev.Status = int(auditToInt64(v))
		case "remoteAddress":
			ev.RemoteAddr = auditToString(v)
		case "userAgent":
			ev.UserAgent = auditToString(v)
		case "reason":
			ev.Reason = auditToString(v)
		case "tenantId":
			ev.TenantID = auditToString(v)
		case "principal":
			if pr, ok := v.(map[string]any); ok {
				ev.Principal = &Principal{
					ID:     auditToString(pr["id"]),
					Role:   Role(auditToString(pr["role"])),
					Source: auditToString(pr["source"]),
					Kid:    auditToString(pr["kid"]),
				}
			} else {
				ev.Extra[k] = v
			}
		default:
			ev.Extra[k] = v
		}
	}
	return ev
}

// auditToString / auditToInt64 — emit payload 直传 (非 json 反序列化) 时的
// 类型自适应: int64/int 直断言, float64 兼容 json 反序列化路径
func auditToString(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case nil:
		return ""
	default:
		b, _ := json.Marshal(t)
		return string(b)
	}
}

func auditToInt64(v any) int64 {
	switch t := v.(type) {
	case int64:
		return t
	case int:
		return int64(t)
	case int32:
		return int64(t)
	case uint64:
		return int64(t)
	case float64:
		return int64(t)
	case json.Number:
		n, _ := t.Int64()
		return n
	default:
		return 0
	}
}

// ── 行序列化 (对齐 TS: JSON.stringify({tag, ...ev, _sink, _fallbackReason?})) ──

// auditLine 生成一行 JSON (不含换行)。tag 为空省略 (file sink 行无 tag, 对齐 TS);
// fallbackReason 非空时写 _fallbackReason (降级可见)。
func auditLine(tag, sinkName string, ev AuditEvent, fallbackReason string) []byte {
	m := make(map[string]any, 16)
	if tag != "" {
		m["tag"] = tag
	}
	if raw, err := json.Marshal(ev); err == nil {
		_ = json.Unmarshal(raw, &m) // 事件字段平铺 (对齐 TS {...ev})
	}
	m["_sink"] = sinkName
	if fallbackReason != "" {
		m["_fallbackReason"] = fallbackReason
	}
	out, err := json.Marshal(m)
	if err != nil {
		out = []byte(`{"tag":"` + auditTagFallback + `","_sink":"` + sinkName + `","_fallbackReason":"marshal_failed"}`)
	}
	return out
}

// stdoutFallbackLine 最终兜底: 写 AUDIT_FALLBACK JSON 行到 stdout (对齐 TS
// AbstractAuditSink.fallbackToStdout / KafkaAuditSink.fallbackToStdout)。
// stdout 自身写失败只能忽略 — 它就是降级链的最后一环。
func stdoutFallbackLine(sinkName string, ev AuditEvent, reason string) {
	line := auditLine(auditTagFallback, sinkName, ev, reason)
	_, _ = os.Stdout.Write(append(line, '\n'))
}

// ── Sink 契约 ───────────────────────────────────────────────────

// Sink 审计 sink 接口 (对齐 TS AuditSinkV2: invoke + 可选 close/getStats)。
// security.go 的 memory/bus 两个内置 sink 走 store/bus 直通, 不实现本接口;
// 本接口面向经 AttachSink 挂载的外部 sink。
type Sink interface {
	// Name sink 名 (stdout/file/http/noop, 对齐 TS readonly name)
	Name() string
	// Deliver 非阻塞投递 (内部入队, 永不 panic/阻塞 — 对齐 invoke 永不抛错)
	Deliver(ev AuditEvent)
	// Stats 运行统计 (对齐 getStats)
	Stats() map[string]any
	// Close 停止接收并尽力排空队列 (超时即放弃, 对齐 TS close)
	Close()
}

// sinkBase 公共骨架: 有界队列 + 独立消费 goroutine + 统计 + stdout 兜底。
// 子类只需提供 writeOne (写单条, 失败返回 error)。
type sinkBase struct {
	name     string
	queue    chan AuditEvent
	stop     chan struct{}
	stopOnce sync.Once
	stopping atomic.Bool
	wg       sync.WaitGroup

	writeFn func(AuditEvent) error // 子类写单条实现
	onClose func()                 // 排空后的资源回收 (如关文件句柄); 可为 nil

	received     atomic.Uint64
	written      atomic.Uint64
	dropped      atomic.Uint64
	failedWrites atomic.Uint64
	fallback     atomic.Uint64
}

// start 初始化并启动消费 goroutine (必须在子类字段就绪后调用)
func (b *sinkBase) start(name string, writeFn func(AuditEvent) error, onClose func()) {
	b.name = name
	b.writeFn = writeFn
	b.onClose = onClose
	b.queue = make(chan AuditEvent, sinkQueueCap)
	b.stop = make(chan struct{})
	b.wg.Add(1)
	go b.drain()
}

// Name sink 名
func (b *sinkBase) Name() string { return b.name }

// Deliver 非阻塞投递: 队列满 → FIFO 丢最旧保新事件 (对齐 TS queue.shift 语义)
func (b *sinkBase) Deliver(ev AuditEvent) {
	if b.stopping.Load() {
		return
	}
	b.received.Add(1)
	select {
	case b.queue <- ev:
	default:
		select { // 挤出最旧一条
		case <-b.queue:
			b.dropped.Add(1)
		default:
		}
		select {
		case b.queue <- ev:
		default:
			b.dropped.Add(1)
		}
	}
}

// Stats 运行统计 (对齐 TS getStats 字段)
func (b *sinkBase) Stats() map[string]any {
	return map[string]any{
		"name":         b.name,
		"received":     b.received.Load(),
		"written":      b.written.Load(),
		"dropped":      b.dropped.Load(),
		"failedWrites": b.failedWrites.Load(),
		"fallback":     b.fallback.Load(),
		"queueSize":    len(b.queue),
	}
}

// Close 停止接收 → 尽力排空 (超时 5s 放弃) → 资源回收。
// Close 后 Deliver 一律丢弃 (对齐 TS stopped 检查)。
func (b *sinkBase) Close() {
	b.stopping.Store(true)
	b.stopOnce.Do(func() { close(b.stop) })
	done := make(chan struct{})
	go func() {
		b.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		if b.onClose != nil {
			b.onClose()
		}
	case <-time.After(sinkCloseTimeout):
		// 排空超时: 放弃 (对齐 TS close 超时语义); 句柄留给 runtime 回收
	}
}

// drain 消费循环: 正常取队列写单条; stop 关闭后排空剩余再退出
func (b *sinkBase) drain() {
	defer b.wg.Done()
	for {
		select {
		case ev := <-b.queue:
			b.write(ev)
		case <-b.stop:
			for { // 尽力排空 (Close flush 语义)
				select {
				case ev := <-b.queue:
					b.write(ev)
				default:
					return
				}
			}
		}
	}
}

// write 写单条; 失败 → failedWrites + AUDIT_FALLBACK 兜底 (对齐 TS writeBatch)
func (b *sinkBase) write(ev AuditEvent) {
	if err := b.writeFn(ev); err != nil {
		b.failedWrites.Add(1)
		b.fallback.Add(1)
		stdoutFallbackLine(b.name, ev, err.Error())
		return
	}
	b.written.Add(1)
}

// ── SinkStdout ──────────────────────────────────────────────────

// SinkStdout stdout JSON 行 sink (对齐 TS StdoutAuditSink, tag=AUDIT)。
// mirror=false 时与 TS 一致: 无任何输出 (write 为 noop)。
type SinkStdout struct {
	sinkBase
	mirror bool
}

// NewSinkStdout 创建 stdout sink (mirror 默认 true, 调试友好)
func NewSinkStdout(mirror bool) *SinkStdout {
	so := &SinkStdout{mirror: mirror}
	so.start(sinkNameStdout, so.writeOne, nil)
	return so
}

func (so *SinkStdout) writeOne(ev AuditEvent) error {
	if !so.mirror {
		return nil // 对齐 TS: mirror=false 的 StdoutAuditSink 零输出
	}
	line := auditLine(auditTagMirror, sinkNameStdout, ev, "")
	_, err := os.Stdout.Write(append(line, '\n'))
	return err
}

// ── SinkFile ────────────────────────────────────────────────────

// SinkFileOptions file sink 配置 (对齐 TS FileAuditSinkOptions)
type SinkFileOptions struct {
	Path            string // JSONL 文件路径
	RotateBytes     int64  // 轮转阈值, 默认 50MB
	MaxRotatedFiles int    // 保留轮转份数, 默认 10
	CompressRotated bool   // 轮转 gzip 压缩, 默认 true
}

// SinkFile JSONL 追加文件 sink (对齐 TS FileAuditSink):
// 追加写一行一个 JSON; 超 rotateBytes 轮转 foo.jsonl → foo.jsonl.1.gz …。
// 消费 goroutine 单线程写文件, 天然串行 (对齐 TS writeQueue Promise 链)。
type SinkFile struct {
	sinkBase
	path            string
	rotateBytes     int64
	maxRotatedFiles int
	compressRotated bool
	f               *os.File
	bytesWritten    int64
}

// NewSinkFile 创建 file sink (目录不存在自动创建)
func NewSinkFile(opts SinkFileOptions) (*SinkFile, error) {
	if opts.Path == "" {
		return nil, fmt.Errorf("file sink 需要 path")
	}
	if opts.RotateBytes <= 0 {
		opts.RotateBytes = 50 * 1024 * 1024 // 对齐 TS 默认 50MB
	}
	if opts.MaxRotatedFiles <= 0 {
		opts.MaxRotatedFiles = 10
	}
	sf := &SinkFile{
		path:            opts.Path,
		rotateBytes:     opts.RotateBytes,
		maxRotatedFiles: opts.MaxRotatedFiles,
		compressRotated: opts.CompressRotated,
	}
	sf.start(sinkNameFile, sf.writeOne, sf.closeFile)
	return sf, nil
}

// writeOne 追加一行 JSONL; 超阈值触发轮转 (对齐 TS doWrite)
func (sf *SinkFile) writeOne(ev AuditEvent) error {
	if err := sf.ensureOpen(); err != nil {
		return err
	}
	// TS file 行格式 {...e, _sink:'file'} (无 tag)
	line := auditLine("", sinkNameFile, ev, "")
	n, err := sf.f.Write(append(line, '\n'))
	if err != nil {
		return err
	}
	sf.bytesWritten += int64(n)
	if sf.bytesWritten >= sf.rotateBytes {
		sf.rotate()
	}
	return nil
}

// ensureOpen 惰性打开 (含续写大小估算, 对齐 TS 构造函数 statSync)
func (sf *SinkFile) ensureOpen() error {
	if sf.f != nil {
		return nil
	}
	if dir := filepath.Dir(sf.path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	f, err := os.OpenFile(sf.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	if st, err := f.Stat(); err == nil {
		sf.bytesWritten = st.Size()
	}
	sf.f = f
	return nil
}

// rotate 轮转: 关句柄 → rename 备份 → 平移旧份 (.i.gz → .i+1.gz) → 压缩新 .1 → 重开。
// 修正 TS rotate() 的"先全删后平移"缺陷 (那实际只保留 .1 一份),
// 此处只删最旧一份再逐级平移, 保留完整 maxRotatedFiles 历史。
func (sf *SinkFile) rotate() {
	if sf.f != nil {
		_ = sf.f.Close()
		sf.f = nil
	}
	tmp := sf.path + ".rotating"
	if _, err := os.Stat(sf.path); err == nil {
		if err := os.Rename(sf.path, tmp); err != nil {
			// rename 失败退化成 read+write+unlink (对齐 TS 注释)
			if data, rerr := os.ReadFile(sf.path); rerr == nil {
				_ = os.WriteFile(tmp, data, 0o600)
				_ = os.Remove(sf.path)
			}
		}
	}
	ext := ""
	if sf.compressRotated {
		ext = ".gz"
	}
	// 只删最旧一份 (TS 版此处误删全部, 见函数注释)
	_ = os.Remove(fmt.Sprintf("%s.%d%s", sf.path, sf.maxRotatedFiles, ext))
	for i := sf.maxRotatedFiles - 1; i >= 1; i-- {
		_ = os.Rename(
			fmt.Sprintf("%s.%d%s", sf.path, i, ext),
			fmt.Sprintf("%s.%d%s", sf.path, i+1, ext),
		)
	}
	// 当前内容 → .1 (可 gzip)
	if data, err := os.ReadFile(tmp); err == nil {
		dst := fmt.Sprintf("%s.1%s", sf.path, ext)
		if sf.compressRotated {
			if f2, err := os.Create(dst); err == nil {
				gz := gzip.NewWriter(f2)
				_, werr := gz.Write(data)
				cerr := gz.Close()
				_ = f2.Close()
				if werr == nil && cerr == nil {
					_ = os.Remove(tmp)
				}
			}
		} else if os.WriteFile(dst, data, 0o600) == nil {
			_ = os.Remove(tmp)
		}
	}
	sf.bytesWritten = 0 // 下次 writeOne 重新 ensureOpen
}

// closeFile 排空后关句柄 (sinkBase.onClose)
func (sf *SinkFile) closeFile() {
	if sf.f != nil {
		_ = sf.f.Close()
		sf.f = nil
	}
}

// ── SinkHTTP ────────────────────────────────────────────────────

// SinkHTTPOptions http sink 配置 (对齐 TS HttpAuditSinkOptions)
type SinkHTTPOptions struct {
	URL        string            // POST 端点 (SIEM webhook)
	Headers    map[string]string // 附加请求头
	TimeoutMs  int               // 单次尝试超时, 默认 5000
	MaxRetries int               // 最大尝试次数, 默认 3
}

// SinkHTTP HTTP POST sink (对齐 TS HttpAuditSink):
// 单条 POST JSON; 失败重试 (100ms 指数退避); 最终失败 → stdout 兜底。
type SinkHTTP struct {
	sinkBase
	url        string
	headers    map[string]string
	client     *http.Client
	timeout    time.Duration
	maxRetries int
}

// NewSinkHTTP 创建 http sink
func NewSinkHTTP(opts SinkHTTPOptions) (*SinkHTTP, error) {
	if opts.URL == "" {
		return nil, fmt.Errorf("http sink 需要 url")
	}
	if opts.TimeoutMs <= 0 {
		opts.TimeoutMs = 5000
	}
	if opts.MaxRetries <= 0 {
		opts.MaxRetries = 3
	}
	sh := &SinkHTTP{
		url:        opts.URL,
		headers:    opts.Headers,
		client:     &http.Client{},
		timeout:    time.Duration(opts.TimeoutMs) * time.Millisecond,
		maxRetries: opts.MaxRetries,
	}
	sh.start(sinkNameHTTP, sh.writeOne, nil)
	return sh, nil
}

// writeOne 单条 POST (对齐 TS sendOne: body 为事件原始 JSON, 不注入 _sink)
func (sh *SinkHTTP) writeOne(ev AuditEvent) error {
	body, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	var lastErr error
	for attempt := 0; attempt < sh.maxRetries; attempt++ {
		if attempt > 0 {
			time.Sleep(time.Duration(100*(1<<(attempt-1))) * time.Millisecond) // 100/200/400ms
		}
		if err := sh.postOne(body); err != nil {
			lastErr = err
			continue
		}
		return nil
	}
	return lastErr
}

func (sh *SinkHTTP) postOne(body []byte) error {
	ctx, cancel := context.WithTimeout(context.Background(), sh.timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, sh.url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range sh.headers {
		req.Header.Set(k, v)
	}
	resp, err := sh.client.Do(req)
	if err != nil {
		return err
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	_ = resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return nil
}

// ── SinkNoop ────────────────────────────────────────────────────

// SinkNoop 空 sink (测试 / 显式关闭某路投递, 对齐 TS NoopAuditSink)
type SinkNoop struct{ sinkBase }

// NewSinkNoop 创建空 sink
func NewSinkNoop() *SinkNoop {
	sn := &SinkNoop{}
	sn.start(sinkNameNoop, sn.writeOne, nil)
	return sn
}

func (sn *SinkNoop) writeOne(AuditEvent) error { return nil }

// ── Sink 工厂 (对齐 auditSinkFactory.ts buildSinkFromConfig) ────

// SinkConfigEntry sink 配置项 (对齐 TS SinkConfigEntry 联合类型的公共字段)。
// kafka / surreal 需外部依赖, 不迁移 (见文件头差异说明)。
type SinkConfigEntry struct {
	Type        string            `json:"type"`                  // stdout | file | http | noop
	Mirror      *bool             `json:"mirror,omitempty"`      // stdout: 是否镜像输出 (默认 true)
	Path        string            `json:"path,omitempty"`        // file
	RotateBytes int64             `json:"rotateBytes,omitempty"` // file
	URL         string            `json:"url,omitempty"`         // http
	Headers     map[string]string `json:"headers,omitempty"`     // http
}

// NewSinkFromConfig 从配置构建 sink (对齐 TS buildSinkFromConfig;
// kafka/surreal 返回错误 — 外部依赖不迁移, 由 SinkHTTP 承担远端转发)
func NewSinkFromConfig(e SinkConfigEntry) (Sink, error) {
	switch strings.ToLower(strings.TrimSpace(e.Type)) {
	case "stdout":
		mirror := true
		if e.Mirror != nil {
			mirror = *e.Mirror
		}
		return NewSinkStdout(mirror), nil
	case "file":
		return NewSinkFile(SinkFileOptions{
			Path:            e.Path,
			RotateBytes:     e.RotateBytes,
			CompressRotated: true,
		})
	case "http":
		return NewSinkHTTP(SinkHTTPOptions{
			URL:     e.URL,
			Headers: e.Headers,
		})
	case "noop":
		return NewSinkNoop(), nil
	case "kafka", "surreal":
		return nil, fmt.Errorf("sink type %q 依赖外部存储/中间件, 新架构不迁移 (远端转发用 http)", e.Type)
	default:
		return nil, fmt.Errorf("unknown sink type: %s", e.Type)
	}
}

// ── Service 外部 sink 注册表 ─────────────────────────────────────

// registeredSink 外部 sink + 共享状态 (state 与 security.go s.sinks 同一指针,
// GET /api/audit/stats、POST /api/audit/sinks/config 开关均联动生效)
type registeredSink struct {
	sink  Sink
	state *SinkState
}

// sinkRegistry 按 sink 名登记 (同名重复挂载 → 关旧换新)
type sinkRegistry struct {
	m map[string]*registeredSink
}

// serviceExternalSinks *Service → *sinkRegistry (不改 security.go Service 结构体;
// 进程内单例使用模式, 生命周期与 Service 一致)
var serviceExternalSinks sync.Map

func (s *Service) externalSinks() *sinkRegistry {
	if v, ok := serviceExternalSinks.Load(s); ok {
		return v.(*sinkRegistry)
	}
	reg := &sinkRegistry{m: map[string]*registeredSink{}}
	actual, _ := serviceExternalSinks.LoadOrStore(s, reg)
	return actual.(*sinkRegistry)
}

// AttachSink 构建并挂载外部审计 sink (stdout/file/http/noop)。
// 同时写入 s.sinks 注册表: GET /api/audit/sinks 可见,
// POST /api/audit/sinks/config 按 name 开关 Enabled (停用后不再投递)。
func (s *Service) AttachSink(entry SinkConfigEntry) (Sink, error) {
	sk, err := NewSinkFromConfig(entry)
	if err != nil {
		return nil, err
	}
	reg := s.externalSinks()
	s.mu.Lock()
	old := reg.m[sk.Name()]
	st := &SinkState{Name: sk.Name(), Type: strings.ToLower(strings.TrimSpace(entry.Type)), Enabled: true}
	reg.m[sk.Name()] = &registeredSink{sink: sk, state: st}
	s.sinks[sk.Name()] = st
	s.mu.Unlock()
	if old != nil {
		old.sink.Close() // 换新: 旧 sink 排空后停止 (放锁外, Close 最长等 5s)
	}
	return sk, nil
}

// DetachSink 卸载外部 sink (排空停止并从两张注册表摘除)
func (s *Service) DetachSink(name string) bool {
	reg := s.externalSinks()
	s.mu.Lock()
	old, ok := reg.m[name]
	if ok {
		delete(reg.m, name)
		delete(s.sinks, name)
	}
	s.mu.Unlock()
	if ok && old != nil {
		old.sink.Close()
	}
	return ok
}

// dispatchExternal emit 的扩展钩子 (security.go emit 末尾调用):
// 把已落库的事件扇出给全部启用中的外部 sink。
// storeOK=false 时事件带 _storeAppendFailed 标记 — 落库失败也保证
// stdout/file 链路可见 (对齐 TS 写失败 → AUDIT_FALLBACK 的兜底精神)。
func (s *Service) dispatchExternal(payload map[string]any, storeOK bool) {
	reg := s.externalSinks()
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(reg.m) == 0 {
		return
	}
	ev := auditEventFromMap(payload)
	if !storeOK {
		ev.Extra["_storeAppendFailed"] = true
	}
	for name, rs := range reg.m {
		st := s.sinks[name]
		if st == nil || !st.Enabled {
			continue
		}
		st.Received++
		rs.sink.Deliver(ev) // 非阻塞, 持锁安全
	}
}
