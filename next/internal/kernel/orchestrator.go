// ─────────────────────────────────────────────────────────────────
// orchestrator.go — 中央多路复用时钟驱动编排器
// (从 TS src/kernel/orchestration/cluster-runtime-orchestrator.ts 迁移)
//
// 职责: 整个操作系统物理运行态的"心脏", 独占接管主时钟 Tick 循环,
// 互锁多进程网络对流 (遥测推流) 与合规治理巡检, 并拉起指标暴露端。
//
// 语义对齐 TS:
//   - 主时钟: 默认 50ms 确定性步长 (governor.clock.tick_rate_ms), 单
//     goroutine 串行因果连续性 (绝不动态多线程分配)
//   - 每 tick: 逻辑时钟步进 → 跨宇宙遥测特征推流 (经 broker)
//   - 每 100 ticks: 派发宏观社会治理评估命令 ASSESS_GOVERNANCE_TARGET
//     (domain=GovernancePolicy, caller=MASTER_ORCHESTRATOR_CHRONO_DAEMON)
//   - 指标暴露: Prometheus HTTP 泄洪温层 (/metrics, 默认 9090)
//   - 时钟崩溃: heartbeat 事件 SYSTEM_TICKER_CRASHED
//   - 模拟遥测: 正弦波动 CPU 指针 (chaos 开关倾斜, 对齐 TS)
//
// 沙箱压力评估钩子 (TS 子防线 2) 经 SandboxHook 接口预留, 批次 6 接入。
// ─────────────────────────────────────────────────────────────────
package kernel

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"net"
	"net/http"
	"sync"
	"time"
)

// 编排器配置键 (对齐 TS configCenter key)
const (
	cfgGovernorClockTickRate = "governor.clock.tick_rate_ms"
	cfgGovernorObsHTTPPort   = "governor.observability.http_port"
	cfgSocietyLawActiveWAL   = "society.law.default_active_wal"
)

// 治理巡检周期 (每 100 ticks 一次全盘审计, 对齐 TS)
const governanceAssessmentEveryTicks = 100

// TelemetryBroadcaster 遥测推流接口 (*DistributedProtocolBroker 适配)
type TelemetryBroadcaster interface {
	BroadcastTelemetryFrame(ctx context.Context, payload json.RawMessage)
}

// SandboxHook 沙箱压力评估钩子 (TS 子防线 2; 批次 6 沙箱引擎接入)
type SandboxHook func(ctx context.Context, tick int64, traceID string, cpuLoad float64)

// ClusterRuntimeOrchestrator 中央编排器 (实现 Component, 随内核启停)
type ClusterRuntimeOrchestrator struct {
	kernel  *RuntimeKernel
	broker  TelemetryBroadcaster
	sandbox SandboxHook

	lock     sync.Mutex // running/srv 状态保护
	stop     chan struct{}
	stopOnce sync.Once
	running  bool
	srv      *http.Server

	// Metrics 可选指标收集器 (TS telemetryExporter)
	Metrics MetricsInserter
}

// NewClusterRuntimeOrchestrator 构造编排器 (kernel/broker 必须非 nil —
// 对齐 TS "Master orchestrator cannot boot with unassigned core workspace")
func NewClusterRuntimeOrchestrator(k *RuntimeKernel, broker TelemetryBroadcaster) (*ClusterRuntimeOrchestrator, error) {
	if k == nil || broker == nil {
		return nil, fmt.Errorf("CRITICAL_SF_CONSTITUTION: Master orchestrator cannot boot with unassigned core workspace matrices")
	}
	return &ClusterRuntimeOrchestrator{kernel: k, broker: broker, stop: make(chan struct{})}, nil
}

// SetSandboxHook 注入沙箱压力评估钩子 (批次 6 接线)
func (o *ClusterRuntimeOrchestrator) SetSandboxHook(h SandboxHook) { o.sandbox = h }

// Name 组件名 (实现 Component)
func (o *ClusterRuntimeOrchestrator) Name() string { return "cluster_orchestrator" }

// Start 激活全系统主时钟脉冲并热加载指标 HTTP 泄洪温层
// (对齐 TS igniteSystemOrchestrationUniverse)
func (o *ClusterRuntimeOrchestrator) Start(ctx context.Context) error {
	o.mu().Lock()
	if o.running {
		o.mu().Unlock()
		return nil
	}
	o.running = true
	o.mu().Unlock()

	// 1. 指标 HTTP scrape 端点 (默认 9090)
	if o.kernel.Config != nil {
		port := o.kernel.Config.GetInt(cfgGovernorObsHTTPPort, 9090)
		if port > 0 {
			mux := http.NewServeMux()
			mux.HandleFunc("/metrics", func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
				if o.Metrics != nil {
					if h, ok := o.Metrics.(interface{ Render() string }); ok {
						_, _ = w.Write([]byte(h.Render()))
						return
					}
				}
				_, _ = w.Write([]byte("# no metrics collector bound\n"))
			})
			srv := &http.Server{Addr: fmt.Sprintf("0.0.0.0:%d", port), Handler: mux, BaseContext: func(net.Listener) context.Context { return ctx }}
			o.srv = srv
			go func() {
				if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
					slog.Warn("指标 HTTP 端点异常", "err", err)
				}
			}()
			slog.Warn("内部遥测 HTTP 端点已开启", "url", fmt.Sprintf("http://localhost:%d/metrics", port))
		}
	}

	// 2. 确定性时钟连续轮询飞轮 (单 goroutine 串行)
	tickMs := int64(50)
	if o.kernel.Config != nil {
		tickMs = int64(o.kernel.Config.GetInt(cfgGovernorClockTickRate, 50))
	}
	go o.clockLoop(ctx, time.Duration(tickMs)*time.Millisecond)

	slog.Warn("系统时钟脉冲飞轮运行中, 基线已锁定", "tickMs", tickMs)
	return nil
}

// Stop 全系统无损安全下线优雅断路器 (对齐 TS shutdownOrchestrationUniverse)
func (o *ClusterRuntimeOrchestrator) Stop(_ context.Context) error {
	o.stopOnce.Do(func() { close(o.stop) })
	o.mu().Lock()
	o.running = false
	srv := o.srv
	o.srv = nil
	o.mu().Unlock()
	if srv != nil {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}
	slog.Warn("中央时钟循环与遥测 HTTP 通道已干净关闭")
	return nil
}

// HealthCheck 心跳健康
func (o *ClusterRuntimeOrchestrator) HealthCheck(_ context.Context) bool {
	o.mu().Lock()
	defer o.mu().Unlock()
	return o.running
}

// clockLoop 时钟飞轮: 每 tick 执行同步时钟步进器 (绝不动态多线程分配)
func (o *ClusterRuntimeOrchestrator) clockLoop(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-o.stop:
			return
		case <-ctx.Done():
			return
		case <-ticker.C:
			o.executeSynchronousClockTickStep(ctx)
		}
	}
}

// executeSynchronousClockTickStep 核心原子级 Tick 驱动步进器
func (o *ClusterRuntimeOrchestrator) executeSynchronousClockTickStep(ctx context.Context) {
	activeTick := o.kernel.AdvanceTick(ctx)
	traceID := fmt.Sprintf("tick_trace_%d_%s", activeTick, shortRandID())

	defer func() {
		if r := recover(); r != nil {
			slog.Error("系统主时钟飞轮在 tick 上发生级联崩溃", "tick", activeTick, "panic", r, "traceId", traceID)
			o.kernel.emit(ctx, EventHeartbeat, map[string]any{
				"status": HeartbeatStatusTickerCrashed, "reason": fmt.Sprint(r),
			})
		}
	}()

	// ─── 子防线 1: 跨宇宙高性能多路复用遥测特征推流 ───
	cpu := o.gatherMockSystemCPULoad()
	telemetry, _ := json.Marshal(map[string]any{
		"traceId":            traceID,
		"cpu_usage":          cpu,
		"memory_pressure":    0.342,
		"queue_depth":        12,
		"starvation_penalty": 0.0,
		"targetClusterId":    "agent_cluster_alpha",
	})
	o.broker.BroadcastTelemetryFrame(ctx, telemetry)

	// ─── 子防线 2: 沙箱运行时硬件压力评估钩子 (批次 6 接入) ───
	if o.sandbox != nil {
		o.sandbox(ctx, activeTick, traceID, cpu)
	}

	// ─── 子防线 3: 定期派发宏观社会治理评估命令 (每 100 ticks 全盘审计) ───
	if activeTick%governanceAssessmentEveryTicks == 0 {
		payload, _ := json.Marshal(map[string]any{
			"traceId":       traceID,
			"targetId":      "agent_cluster_alpha",
			"targetType":    "agent",
			"effectiveness": 0.945,
			"violations":    0,
			"notes":         "Automated periodic heartbeat assessment trace clean.",
		})
		// 失败局限在孤立异步域内 (ExecuteCommand 失败转结果对象不上抛)
		go o.kernel.ExecuteCommand(ctx, Command{
			Type:    "ASSESS_GOVERNANCE_TARGET",
			Domain:  "GovernancePolicy",
			Caller:  "MASTER_ORCHESTRATOR_CHRONO_DAEMON",
			Payload: payload,
		})
	}

	// ─── 子防线 4: 全量可观测性时序计数更新 ───
	o.metricAdd("soloforge_cluster_system_entropy", 0.0215)
}

// gatherMockSystemCPULoad 模拟遥测指针抓取器 (对齐 TS:
// 0.45 + 0.15×sin(t/10s) 平滑正弦波动; chaos 开关倾斜时恒 0.9420)
func (o *ClusterRuntimeOrchestrator) gatherMockSystemCPULoad() float64 {
	chaos := true
	if o.kernel.Config != nil {
		chaos = o.kernel.Config.GetBool(cfgSocietyLawActiveWAL, true)
	}
	timeFactor := float64(time.Now().UnixMilli()) / 10000.0
	baseLoad := 0.45 + 0.15*math.Sin(timeFactor)
	if !chaos {
		return 0.9420
	}
	return math.Round(baseLoad*10000) / 10000
}

func (o *ClusterRuntimeOrchestrator) metricAdd(name string, delta float64) {
	if o.Metrics != nil {
		if h, ok := o.Metrics.(interface{ Add(string, float64) }); ok {
			h.Add(name, delta)
		}
	}
}

func (o *ClusterRuntimeOrchestrator) mu() *sync.Mutex {
	// mu 锁内嵌 stopOnce/running 状态保护 (结构体级互斥)
	return &o.lock
}
