// ─────────────────────────────────────────────────────────────────
// broker.go — 跨语言分布式多路复用高速 IPC 代理
// (从 TS src/kernel/orchestration/distributed-broker.ts 迁移)
//
// 职责: 微内核 (Go) 与算法控制宇宙 (Python MARL) 之间的非阻塞高速
// TCP 套接字持久双向会话。内生高密滑动窗口背压墙 — 链路未就位时
// 保护性断路丢包, 拒绝阻塞内核主循环。
//
// 语义对齐 TS:
//   - 帧信封 NetworkFrameEnvelope {frameId, type, currentTick, payload,
//     kernelVersionSeal, timestamp}; 类型: TELEMETRY_STREAM /
//     ACTION_DECISION_ACK / HEARTBEAT_PULSE / VERSION_ALIGN_SYNC /
//     DRIFT_COMMAND
//   - TCP KeepAlive + NoDelay (消灭 Nagle 抖动)
//   - 流式切包: \n 边界界定, 防跨进程粘包/断包
//   - 遥测倾泄: 链路未就位 → dropped 计数 + 丢弃 (保护性断路);
//     发送成功 → 广播 snapshot 事件 (触发遥测聚合消费者)
//   - 漂移命令: DRIFT_COMMAND 下行超参数漂移实验; 未就位丢弃
//   - 摄入: ACTION_DECISION_ACK → kernelVersionSeal 与本地版本比对,
//     漂移即告警计数 (全链路强版本对齐) → 广播 transaction.committed
//     (domain=AIRuntime); DRIFT_COMMAND → 广播 snapshot 事件
//   - 容错自愈: 指数退避重连 (base 1s × 2^(n-1)), 超过上限 (默认 10)
//     → 心跳事件 CRITICAL_CLUSTER_BRAIN_SPLIT (分裂脑危害兜底)
//
// ─────────────────────────────────────────────────────────────────
package kernel

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"sync"
	"time"
)

// 帧类型 (对齐 TS NetworkFrameEnvelope.type)
const (
	FrameTypeTelemetryStream   = "TELEMETRY_STREAM"
	FrameTypeActionDecisionAck = "ACTION_DECISION_ACK"
	FrameTypeHeartbeatPulse    = "HEARTBEAT_PULSE"
	FrameTypeVersionAlignSync  = "VERSION_ALIGN_SYNC"
	FrameTypeDriftCommand      = "DRIFT_COMMAND"
)

// 心跳/分裂脑事件载荷状态值 (对齐 TS eventBus emit)
const (
	HeartbeatStatusIPCActive     = "IPC_LINK_ACTIVE"
	HeartbeatStatusBrainSplit    = "CRITICAL_CLUSTER_BRAIN_SPLIT"
	HeartbeatStatusTickerCrashed = "SYSTEM_TICKER_CRASHED"
)

// 配置键 (对齐 TS configCenter key)
const (
	cfgGovernorIPCHost         = "governor.ipc.host"
	cfgGovernorIPCPort         = "governor.ipc.port"
	cfgGovernorIPCMaxReconnect = "governor.ipc.max_reconnect_attempts"
	cfgGovernorIPCBackoffBase  = "governor.ipc.reconnect_backoff_base"
)

// NetworkFrameEnvelope 跨进程帧信封 (对齐 TS)
type NetworkFrameEnvelope struct {
	FrameID           string          `json:"frameId"`
	Type              string          `json:"type"`
	CurrentTick       int64           `json:"currentTick"`
	Payload           json.RawMessage `json:"payload"`
	KernelVersionSeal int64           `json:"kernelVersionSeal"`
	Timestamp         int64           `json:"timestamp"`
}

// DistributedProtocolBroker 分布式协议代理
type DistributedProtocolBroker struct {
	kernel *RuntimeKernel

	mu           sync.Mutex
	conn         net.Conn
	connected    bool
	retryCounter int
	buf          string // 粘包累积缓冲 (对齐 TS bufferAccumulator)

	stop     chan struct{}
	stopOnce sync.Once

	// Metrics 可选指标收集器 (TS metricsCollector.counter)
	Metrics MetricsInserter
}

// NewDistributedProtocolBroker 构造代理 (kernel 必须非 nil — 对齐 TS
// "Master distributed broker requires completely initialized core buses")
func NewDistributedProtocolBroker(k *RuntimeKernel) (*DistributedProtocolBroker, error) {
	if k == nil {
		return nil, fmt.Errorf("CRITICAL_SF_CONSTITUTION: Master distributed broker requires completely initialized core buses")
	}
	return &DistributedProtocolBroker{kernel: k, stop: make(chan struct{})}, nil
}

// ConnectMARLServiceGateway 连接并激活异步网络套接字 (对齐 TS connectMarlServiceGateway)。
// 连接成功后启动收帧循环; 断开自动进入指数退避重连。
func (b *DistributedProtocolBroker) ConnectMARLServiceGateway(ctx context.Context) error {
	b.mu.Lock()
	if b.connected {
		b.mu.Unlock()
		return nil
	}
	b.mu.Unlock()

	host := "127.0.0.1"
	port := 8765
	if b.kernel.Config != nil {
		if s := b.kernel.Config.GetString(cfgGovernorIPCHost, ""); s != "" {
			host = s
		}
		port = b.kernel.Config.GetInt(cfgGovernorIPCPort, 8765)
	}

	dialer := net.Dialer{KeepAlive: 1 * time.Second} // TCP KeepAlive 1s (对齐 TS setKeepAlive(true, 1000))
	conn, err := dialer.DialContext(ctx, "tcp", fmt.Sprintf("%s:%d", host, port))
	if err != nil {
		return err
	}
	if tcp, ok := conn.(*net.TCPConn); ok {
		_ = tcp.SetNoDelay(true) // 消灭 Nagle 抖动 (对齐 TS setNoDelay)
	}

	b.mu.Lock()
	b.conn = conn
	b.connected = true
	b.retryCounter = 0
	b.buf = ""
	b.mu.Unlock()

	slog.Warn("分布式 IPC 链路已建立", "peer", fmt.Sprintf("%s:%d", host, port))
	b.kernel.emit(ctx, EventHeartbeat, map[string]any{"status": HeartbeatStatusIPCActive})
	b.metricInc("governor.ipc.connection_state")

	// 收帧循环 (流式切包)
	go b.receiveLoop(conn)

	// 断线监视
	go func() {
		select {
		case <-b.stop:
			return
		default:
		}
		// conn 关闭由 receiveLoop 的扫描错误触发 handleConnectionInterruption
	}()
	return nil
}

// receiveLoop 流式切包拦截: 严格 \n 边界界定, 防跨进程高频粘包/断包碎片
func (b *DistributedProtocolBroker) receiveLoop(conn net.Conn) {
	defer b.handleConnectionInterruption(context.Background())
	scanner := bufio.NewScanner(conn)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}
		select {
		case <-b.stop:
			return
		default:
		}
		b.ingestIncomingStrategyFrame(context.Background(), line)
	}
}

// ingestIncomingStrategyFrame 摄入层: 解析并拦截策略宇宙返回的决策指令
func (b *DistributedProtocolBroker) ingestIncomingStrategyFrame(ctx context.Context, rawJSONLine string) {
	var frame NetworkFrameEnvelope
	if err := json.Unmarshal([]byte(rawJSONLine), &frame); err != nil {
		slog.Error("损坏的线帧解析失败", "err", err)
		return
	}

	switch frame.Type {
	case FrameTypeDriftCommand:
		// 超参数漂移实验响应
		b.kernel.emit(ctx, EventSnapshotCreated, map[string]any{
			"domain": "DriftExperiment", "frameId": frame.FrameID,
			"payload": json.RawMessage(frame.Payload), "timestamp": frame.Timestamp,
		})
		b.metricInc("governor.drift.commands_processed")

	case FrameTypeActionDecisionAck:
		// 全链路强版本对齐: Python 侧版本印章与本地最新版本不符 → 漂移告警
		if frame.KernelVersionSeal != b.kernel.Version() {
			b.metricInc("governor.ipc.version_drift_warnings")
		}
		// 决策动作 Fact 以原子级事件投递给主系统事件总线 (无锁消化)
		traceID := ""
		var payloadMap map[string]any
		if json.Unmarshal(frame.Payload, &payloadMap) == nil {
			if s, ok := payloadMap["traceId"].(string); ok {
				traceID = s
			}
		}
		b.kernel.emit(ctx, EventTransactionCommitted, map[string]any{
			"domain":  "AIRuntime",
			"txId":    fmt.Sprintf("tx_ipc_recv_%s", frame.FrameID),
			"version": frame.KernelVersionSeal,
			"traceId": traceID,
			"data":    payloadMap,
		})
		b.metricInc("governor.ipc.frames_received_count")
	}
}

// BroadcastDriftCommand 向 Python 宇宙发送超参数漂移实验命令
func (b *DistributedProtocolBroker) BroadcastDriftCommand(ctx context.Context, action string, payload json.RawMessage) {
	inner, _ := json.Marshal(map[string]any{"action": action, "payload": json.RawMessage(payload)})
	b.writeFrame(ctx, NetworkFrameEnvelope{
		FrameID:           "drift_" + shortRandID(),
		Type:              FrameTypeDriftCommand,
		CurrentTick:       b.kernel.Tick(),
		Payload:           inner,
		KernelVersionSeal: b.kernel.Version(),
		Timestamp:         time.Now().UnixMilli(),
	}, "governor.drift.dropped_commands", "governor.drift.commands_sent")
}

// BroadcastTelemetryFrame 异步无阻塞向 Python 宇宙倾泄多路复用遥测特征包
func (b *DistributedProtocolBroker) BroadcastTelemetryFrame(ctx context.Context, telemetryPayload json.RawMessage) {
	frame := NetworkFrameEnvelope{
		FrameID:           "frame_" + shortRandID(),
		Type:              FrameTypeTelemetryStream,
		CurrentTick:       b.kernel.Tick(),
		Payload:           telemetryPayload,
		KernelVersionSeal: b.kernel.Version(),
		Timestamp:         time.Now().UnixMilli(),
	}
	b.writeFrame(ctx, frame, "governor.ipc.dropped_frames_total", "governor.ipc.frames_sent_count")

	// 广播 SnapshotCreated 事件, 触发 TelemetryAggregationConsumer 指标更新
	b.kernel.emit(ctx, EventSnapshotCreated, map[string]any{
		"domain": "DistributedBroker", "frameId": frame.FrameID, "timestamp": frame.Timestamp,
	})
}

// writeFrame 帧写出: 链路未就位 → 保护性断路丢包 (拒绝卡死主循环)
func (b *DistributedProtocolBroker) writeFrame(ctx context.Context, frame NetworkFrameEnvelope, droppedMetric, sentMetric string) {
	b.mu.Lock()
	conn := b.conn
	connected := b.connected
	b.mu.Unlock()

	if !connected || conn == nil {
		b.metricInc(droppedMetric)
		return
	}
	raw, err := json.Marshal(frame)
	if err != nil {
		b.metricInc(droppedMetric)
		return
	}
	if _, err := conn.Write(append(raw, '\n')); err != nil {
		b.metricInc(droppedMetric)
		return
	}
	b.metricInc(sentMetric)
}

// handleConnectionInterruption 容错自愈: 多线程指数退避自动重连断路器
// (对齐 TS handleConnectionInterruption): base × 2^(n-1), 超上限 →
// 分裂脑危害兜底事件。
func (b *DistributedProtocolBroker) handleConnectionInterruption(ctx context.Context) {
	b.mu.Lock()
	b.connected = false
	b.conn = nil
	b.retryCounter++
	retry := b.retryCounter
	b.mu.Unlock()
	b.metricInc("governor.ipc.connection_state")

	maxRetry := 10
	backoffBase := 1000
	if b.kernel.Config != nil {
		maxRetry = b.kernel.Config.GetInt(cfgGovernorIPCMaxReconnect, 10)
		backoffBase = b.kernel.Config.GetInt(cfgGovernorIPCBackoffBase, 1000)
	}

	if retry > maxRetry {
		slog.Error("分布式集群分裂脑危害! Python 服务离线超过重试上限, 进入安全兜底", "maxRetries", maxRetry)
		b.kernel.emit(ctx, EventHeartbeat, map[string]any{"status": HeartbeatStatusBrainSplit})
		return
	}

	delay := time.Duration(backoffBase*(1<<(retry-1))) * time.Millisecond
	slog.Warn("IPC 链路意外断开, 启动重连", "attempt", retry, "delayMs", delay.Milliseconds())

	go func() {
		select {
		case <-b.stop:
			return
		case <-time.After(delay):
		}
		if err := b.ConnectMARLServiceGateway(context.Background()); err != nil {
			// 重连失败 → 再次进入断路处理 (递归退避)
			b.handleConnectionInterruption(context.Background())
		}
	}()
}

// ShutdownBroker 关闭代理 (对齐 TS shutdownBroker)
func (b *DistributedProtocolBroker) ShutdownBroker() {
	b.stopOnce.Do(func() { close(b.stop) })
	b.mu.Lock()
	if b.conn != nil {
		_ = b.conn.Close()
	}
	b.connected = false
	b.conn = nil
	b.mu.Unlock()
}

// IsConnected 链路状态
func (b *DistributedProtocolBroker) IsConnected() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.connected
}

func (b *DistributedProtocolBroker) metricInc(name string) {
	if b.Metrics != nil {
		b.Metrics.Inc(name)
	}
}

// shortRandID 8 位随机 ID (对齐 TS randomUUID().substring(0,8))
func shortRandID() string {
	var buf [4]byte
	_, _ = rand.Read(buf[:])
	return hex.EncodeToString(buf[:])
}
