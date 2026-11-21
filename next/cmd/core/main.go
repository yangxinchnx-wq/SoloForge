// ─────────────────────────────────────────────────────────────────
// soloforge-core — 唯一必选组件 (Go 单二进制)
//
// 职责: HTTP+WS API / 事件总线 / 命令总线 / SQLite 存储
// 纪律: 崩溃即重启 (WAL 恢复) / 端口占用立即失败并报告占用者
// ─────────────────────────────────────────────────────────────────
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"soloforge/next/internal/agents"
	"soloforge/next/internal/api"
	"soloforge/next/internal/compat"
	"soloforge/next/internal/bus"
	"soloforge/next/internal/court"
	"soloforge/next/internal/data"
	"soloforge/next/internal/decision"
	"soloforge/next/internal/economy"
	githandler "soloforge/next/internal/gitsvc/handler"
	"soloforge/next/internal/law"
	"soloforge/next/internal/kernel"
	"soloforge/next/internal/marl"
	"soloforge/next/internal/metrics"
	"soloforge/next/internal/security"
	"soloforge/next/internal/society"
	"soloforge/next/internal/store"
	"soloforge/next/internal/surreal"
	"soloforge/next/internal/toolsrelay"
	"soloforge/next/internal/uiapi"
)

func main() {
	port := flag.Int("port", 7300, "HTTP/WS 监听端口")
	repoPath := flag.String("repo", "..", "被管理的 Git 仓库路径 (默认: 上级目录)")
	flag.Parse()

	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	// ── 存储 (进程内) + SurrealDB 持久化 (用户指定的数据库) ──
	st := store.New()

	// ── 总线 ──
	evBus := bus.NewEventBus()
	cmdBus := bus.NewCommandBus()
	registerCommands(st, evBus, cmdBus, logger)

	// ── RuntimeKernel (深度迁移: 状态机/事务/配置/所有权) ──
	kern := kernel.New(st, evBus)
	kern.SetCommandBus(cmdBus)
	txnMgr := kernel.NewTransactionManager(kern)
	kern.SetTransactionManager(txnMgr)
	defer kern.Shutdown(context.Background())

	// SurrealDB 事件持久化: 启动重放 + 总线同步 (离线自动缓冲补写)
	if url := os.Getenv("SOLOFORGE_SURREAL_URL"); url != "" {
		sdb := surreal.New(surreal.Config{
			URL:  url,
			NS:   envOr("SOLOFORGE_SURREAL_NS", "soloforge_core"),
			DB:   envOr("SOLOFORGE_SURREAL_DB", "autonomous_network"),
			User: envOr("SOLOFORGE_SURREAL_USER", "root"),
			Pass: envOr("SOLOFORGE_SURREAL_PASS", "root"),
		})
		if evs, err := sdb.LoadEvents(context.Background(), 0); err == nil {
			for _, ev := range evs {
				st.Restore(ev)
			}
			logger.Info("SurrealDB 事件重放完成", "restored", len(evs))
		} else {
			logger.Warn("SurrealDB 事件重放失败 (启动后自动补写缓冲)", "err", err)
		}
		subID, events := evBus.Subscribe() // 订阅先于启动事件, 保证不漏
		_ = subID
		go sdb.SyncLoop(context.Background(), events)
		logger.Info("SurrealDB 持久化已接线", "url", url)
	} else {
		logger.Info("未设置 SOLOFORGE_SURREAL_URL, 纯内存存储 (重启清零)")
	}

	// ── 启动事件 (落库即审计) ──
	payload, _ := json.Marshal(map[string]any{"port": *port, "pid": os.Getpid()})
	if ev, err := st.AppendEvent(context.Background(), "kernel.initialized", "core", payload); err == nil {
		evBus.Publish(ev)
	}

	// ── HTTP/WS ──
	srv := api.New(st, evBus, cmdBus, logger)
	srv.Kernel = kern // 内核状态机守卫命令派发 (深度迁移)

	// git 服务并入 (原独立进程 3002 → 进程内路由): 先挂路由再包装中间件
	gsHandler := githandler.New(*repoPath)
	gsHandler.RegisterRoutes(srv.Mux())

	// ── 安全层 (vault/auth/audit + token 轮换族 v2, 阶段 2 迁入) ──
	secSvc := security.New(st, evBus)
	secSvc.Register(srv.Mux())
	tokenStore := security.NewTokenStore(secSvc.Vault())
	tokenStore.Init()
	secSvc.SetTokens(tokenStore)
	tokenRotation := secSvc.StartTokenRotation()
	// 关机时停轮换 worker (逆序: 先于 shutdownFns 的组件停止)
	defer tokenRotation.Stop()
	logger.Info("安全层就绪 (vault/auth/audit/token-rotation)")

	// ── 工具路由 + 指标 (阶段 2 迁入) ──
	relay := toolsrelay.NewWithBuiltins()
	relay.RegisterCommands(cmdBus)
	metricsCollector := metrics.New()
	srv.Mux().Handle("GET /metrics-prom", metricsCollector.Handler())

	// ── UI 第二后端 (uiapi, 阶段 2 迁入; BaseDir = 仓库根/UI) ──
	uiapiSvc := uiapi.New(filepath.Join(*repoPath, "UI"), st, logger)
	uiapiSvc.SetBus(evBus)
	uiapiSvc.SetTokenProvider(func() string { return secSvc.BootstrapToken() })
	uiapiSvc.SetVault(secSvc.Vault()) // LLM 代理 providerId 分支取 key (旧核退役前置)
	uiapiSvc.Register(srv.Mux())
	logger.Info("UI 第二后端就绪 (providers/skills/resources/system-metrics/SSE/llm-proxy)")

	addr := fmt.Sprintf("127.0.0.1:%d", *port)

	// ── Agent 运行时 (阶段 2 迁入) ──
	pool := agents.NewPool()
	seedAgents := []struct{ id, strategy, model string }{
		{"agent_architect", "architect", ""},
		{"agent_coder", "coder", ""},
		{"agent_reviewer", "reviewer", ""},
	}
	for _, sa := range seedAgents {
		pool.Register(sa.id, sa.strategy, sa.model)
	}
	var workers []agents.Worker
	if llmURL := os.Getenv("SOLOFORGE_LLM_URL"); llmURL != "" {
		llmModel := os.Getenv("SOLOFORGE_LLM_MODEL")
		if llmModel == "" {
			llmModel = "local-model"
		}
		workers = append(workers, agents.NewHTTPWorker("llm", llmURL, llmModel, os.Getenv("SOLOFORGE_LLM_KEY")))
		logger.Info("LLM worker 已启用 (OpenAI 兼容)", "url", llmURL, "model", llmModel)
	}
	if advisorURL := os.Getenv("SOLOFORGE_ADVISOR_URL"); advisorURL != "" {
		workers = append(workers, agents.NewSSEWorker("advisor", advisorURL, os.Getenv("SOLOFORGE_ADVISOR_TOKEN")))
		logger.Info("Advisor SSE worker 已启用", "url", advisorURL)
	}
	if len(workers) == 0 {
		workers = append(workers, agents.NewMockWorker("mock-1"), agents.NewMockWorker("mock-2"))
		logger.Info("未配置 LLM/Advisor, 使用 MockWorker (骨架自测)")
	}
	orch := agents.NewOrchestrator(pool, st, evBus, workers)
	agents.RegisterRoutes(srv.Mux(), pool, orch)
	logger.Info("Agent 运行时就绪", "agents", pool.Count(), "workers", len(workers))

	// ── 旧代理路径兼容层 (browser-use/feedback/names/training/llm-stream/test) ──
	compat.Register(srv.Mux(), compat.Deps{
		Pool:  pool,
		Relay: relay,
		Store: st,
		Bus:   evBus,
	})
	logger.Info("兼容层就绪 (browser-use/feedback/names/training/test)")

	// ── 社会域 (society, 阶段 2 迁入; 信誉级联目标 = agent 池) ──
	socSvc := society.New(st, evBus, pool)
	society.RegisterCommands(cmdBus, socSvc)
	logger.Info("社会域就绪 (institutions/memory/culture/coalitions/governance/drift)")

	// ── data 层 (outbox/12 消费者/删除保护, 深度迁移) ──
	dataSvc := data.New(st, evBus, nil) // nil deliver = 纯进程内部署 (外部 sink 接入后替换)
	dataSvc.Start(context.Background())
	data.RegisterCommands(cmdBus, st, dataSvc.Outbox, dataSvc.Registry(), dataSvc.Protection, dataSvc.Projections)
	defer dataSvc.Stop()
	logger.Info("data 层就绪 (outbox/12 消费者/删除保护)")

	// ── court / decision / law (阶段 2 迁入) ──
	var judge court.Judge
	if len(workers) > 0 {
		judge = llmJudge{w: workers[0]}
	}
	courtSvc := court.New(st, evBus, judge)
	decSvc := decision.New(st, evBus)
	lawSvc := law.New(st, evBus, pool)

	// ── MARL 策略注入 (SOLOFORGE_MARL_ADDR=127.0.0.1:8765 时激活) ──
	var marlClient *marl.Client
	if marlAddr := os.Getenv("SOLOFORGE_MARL_ADDR"); marlAddr != "" {
		marlClient = marl.New(marlAddr)
		decSvc.SetPolicy(func(ctx context.Context, obs []float64) (float64, error) {
			return marlClient.Bonus(ctx, obs)
		})
		logger.Info("MARL 策略已注入", "addr", marlAddr)
	}

	// ── 深度迁移模块装配 (批次 1-9): 经济/沙箱/共识/编排器/进化管线 ──
	// 经 kernel.Component 生命周期注册, kern.Start 统一拉起 → 状态机
	// BOOTING→INITIALIZING→READY (HTTP 命令派发的状态机守卫自此生效)
	// (占位: 组件在下方逐个 Register; 见 wiringDeepModules)
	shutdownFns := wiringDeepModules(kern, st, evBus, cmdBus, metricsCollector, marlClient, logger)
	defer func() {
		for i := len(shutdownFns) - 1; i >= 0; i-- {
			shutdownFns[i]()
		}
	}()
	if err := kern.Start(context.Background()); err != nil {
		logger.Error("内核启动失败", "err", err)
		os.Exit(4)
	}
	logger.Info("内核 READY (深度迁移模块已装配)", "components", kern.Components())

	// CommandBus 注册 (语义对齐旧 src/kernel/command-bus.ts 命令名)
	cmdBus.Register("EXECUTE_EVIDENTIARY_ARBITRATION", func(ctx context.Context, payload json.RawMessage) (any, error) {
		var p struct {
			TraceID   string                `json:"traceId"`
			Claim     string                `json:"claim"`
			Arguments []court.ArgumentClaim `json:"arguments"`
		}
		if err := json.Unmarshal(payload, &p); err != nil {
			return nil, err
		}
		c, _ := courtSvc.SubmitClaim(ctx, p.TraceID, p.Claim)
		return courtSvc.Arbitrate(ctx, c.CaseID, p.Arguments)
	})
	cmdBus.Register("RECORD_VIOLATION_FACT", func(ctx context.Context, payload json.RawMessage) (any, error) {
		var p struct {
			TraceID     string  `json:"traceId"`
			EntityID    string  `json:"entityId"`
			LawID       string  `json:"lawId"`
			Description string  `json:"description"`
			Penalty     float64 `json:"penalty"`
		}
		if err := json.Unmarshal(payload, &p); err != nil {
			return nil, err
		}
		return lawSvc.RecordViolation(ctx, p.TraceID, p.EntityID, p.LawID, p.Description, p.Penalty)
	})
	cmdBus.Register("EXECUTE_VIOLATION_PENALTY", func(ctx context.Context, payload json.RawMessage) (any, error) {
		var p struct {
			ViolationID string  `json:"violationId"`
			Executor    string  `json:"executor"`
			Penalty     float64 `json:"penalty"`
		}
		if err := json.Unmarshal(payload, &p); err != nil {
			return nil, err
		}
		return lawSvc.ExecutePenalty(ctx, p.ViolationID, p.Executor, p.Penalty)
	})
	cmdBus.Register("LODGE_LAW_APPEAL", func(ctx context.Context, payload json.RawMessage) (any, error) {
		var p struct {
			ViolationID string  `json:"violationId"`
			Appellant   string  `json:"appellant"`
			Reason      string  `json:"reason"`
			Restore     float64 `json:"restore"`
		}
		if err := json.Unmarshal(payload, &p); err != nil {
			return nil, err
		}
		return lawSvc.LodgeAppeal(ctx, p.ViolationID, p.Appellant, p.Reason, p.Restore)
	})
	// DECISION_COMMIT_REQUEST 保持 passthrough (对齐旧系统语义)
	logger.Info("court/decision/law 就绪", "judge", judge != nil)

	// court/decision/law HTTP 路由 (新架构新增, 供测试与 UI)
	srv.Mux().HandleFunc("POST /api/court/arbitrate", func(w http.ResponseWriter, r *http.Request) {
		var p struct {
			TraceID   string                `json:"traceId"`
			Claim     string                `json:"claim"`
			Arguments []court.ArgumentClaim `json:"arguments"`
		}
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		c, _ := courtSvc.SubmitClaim(r.Context(), p.TraceID, p.Claim)
		v, err := courtSvc.Arbitrate(r.Context(), c.CaseID, p.Arguments)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(v)
	})
	srv.Mux().HandleFunc("GET /api/court/cases", func(w http.ResponseWriter, r *http.Request) {
		cases := courtSvc.Cases()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"cases": cases})
	})
	srv.Mux().HandleFunc("POST /api/decisions/route", func(w http.ResponseWriter, r *http.Request) {
		var req decision.RouteRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		res, err := decSvc.Route(r.Context(), req)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(res)
	})
	srv.Mux().HandleFunc("GET /api/decisions/history", func(w http.ResponseWriter, r *http.Request) {
		limit := 20
		if l, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && l > 0 && l <= 100 {
			limit = l
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"routes": decSvc.Routes(limit)})
	})
	srv.Mux().HandleFunc("GET /api/law/violations", func(w http.ResponseWriter, r *http.Request) {
		v := lawSvc.Violations()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"violations": v})
	})

	httpSrv := &http.Server{Addr: addr, Handler: srv.Handler(), ReadHeaderTimeout: 5 * time.Second}

	ln, err := net.Listen("tcp", addr)
	if err != nil {
		owner := portOwner(*port)
		logger.Error("端口被占用", "port", *port, "owner", owner, "hint", "改 config.toml 或结束占用进程")
		os.Exit(3) // 明确退出码: supervisor 据此停止重启 (配置错误 ≠ 崩溃)
	}

	// ── 优雅关机 (supervisor 强杀时依赖 WAL, 这里是开发便利) ──
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		logger.Info("收到退出信号, 优雅关机...")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		httpSrv.Shutdown(shutdownCtx)
	}()

	logger.Info("soloforge-core READY", "addr", addr)
	if err := httpSrv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logger.Error("HTTP 服务异常", "err", err)
		os.Exit(1)
	}
	logger.Info("core 已退出")
}

// registerCommands 骨架内置命令 (echo/kv 证明总线与存储贯通)
func registerCommands(st *store.Store, evBus *bus.EventBus, cmdBus *bus.CommandBus, logger *slog.Logger) {
	cmdBus.Register("echo", func(_ context.Context, payload json.RawMessage) (any, error) {
		var p any
		if len(payload) > 0 {
			json.Unmarshal(payload, &p)
		}
		return map[string]any{"echo": p}, nil
	})

	cmdBus.Register("kv.set", func(ctx context.Context, payload json.RawMessage) (any, error) {
		var p struct{ K, V string }
		if err := json.Unmarshal(payload, &p); err != nil || p.K == "" {
			return nil, fmt.Errorf("payload 需为 {k, v}")
		}
		if err := st.KVSet(ctx, p.K, p.V); err != nil {
			return nil, err
		}
		return map[string]any{"k": p.K, "v": p.V}, nil
	})

	cmdBus.Register("kv.get", func(ctx context.Context, payload json.RawMessage) (any, error) {
		var p struct{ K string }
		if err := json.Unmarshal(payload, &p); err != nil || p.K == "" {
			return nil, fmt.Errorf("payload 需为 {k}")
		}
		v, err := st.KVGet(ctx, p.K)
		if err != nil {
			return nil, err
		}
		return map[string]any{"k": p.K, "v": v}, nil
	})

	cmdBus.Register("events.count", func(ctx context.Context, _ json.RawMessage) (any, error) {
		n, err := st.EventCount(ctx)
		return map[string]any{"count": n}, err
	})

	logger.Info("命令总线就绪", "commands", "echo, kv.set, kv.get, events.count")
}

// portOwner 查询占用端口的进程 (Windows: netstat -ano + tasklist)
func portOwner(port int) string {
	out, err := exec.Command("netstat", "-ano").CombinedOutput()
	if err != nil {
		return "未知 (netstat 失败)"
	}
	var pid string
	for _, line := range strings.Split(string(out), "\n") {
		if strings.Contains(line, fmt.Sprintf(":%d ", port)) && strings.Contains(line, "LISTENING") {
			fields := strings.Fields(line)
			if len(fields) > 0 {
				pid = fields[len(fields)-1]
			}
			break
		}
	}
	if pid == "" {
		return "未知"
	}
	name := pid
	if tOut, err := exec.Command("tasklist", "/FI", fmt.Sprintf("PID eq %s", pid), "/FO", "CSV", "/NH").CombinedOutput(); err == nil {
		if parts := strings.Split(string(tOut), "\",\""); len(parts) > 0 {
			cleaned := strings.Trim(parts[0], "\" \r\n")
			if cleaned != "" && !strings.Contains(cleaned, "INFO:") {
				name = cleaned
			}
		}
	}
	return fmt.Sprintf("PID %s (%s)", pid, name)
}

// llmJudge 把通用 LLM worker 适配为 court.Judge
// (ESCAPE_ROUTING_TO_LLM / CONSERVATIVE_DEADLOCK_TRIGGER 时收尾)
type llmJudge struct{ w agents.Worker }

func (l llmJudge) Arbitrate(ctx context.Context, c *court.Case, args []court.ArgumentClaim) (string, string, error) {
	var sb strings.Builder
	sb.WriteString("你是 SoloForge 最高法庭。请裁决以下仲裁案例，只回复获胜者的 agentId。\n")
	if c != nil {
		sb.WriteString("案例: " + c.Claim + "\n")
	}
	sb.WriteString("论点:\n")
	for _, a := range args {
		sb.WriteString(fmt.Sprintf("- %s: %s (证据 %d 条)\n", a.OriginatingAgentID, a.DisputedClaimStatement, len(a.LinkedEvidenceRegistry)))
	}
	out, err := l.w.Execute(ctx, sb.String())
	if err != nil {
		return "", "", err
	}
	return strings.TrimSpace(out), out, nil
}

// envOr 环境变量缺省值
func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// ── 深度迁移模块装配 (批次 1-9 接线) ─────────────────────────────
//
// wiringDeepModules 把批次 1-9 迁入的模块挂进内核生命周期:
//
//	经济引擎     economy.TokenEconomyEngine (DISTRIBUTE_ROLE_ALLOCATION_REWARD)
//	沙箱引擎     kernel.SandboxMigrationEngine (MIGRATE_SANDBOX_CONTEXT)
//	Raft 共识     kernel.RaftConsensusNode (单节点自动晋升 / SOLOFORGE_RAFT_PEERS 多节点)
//	IPC broker    kernel.DistributedProtocolBroker (SOLOFORGE_MARL_ADDR 时连接)
//	时钟编排器    kernel.ClusterRuntimeOrchestrator (50ms tick + 遥测推流 + 沙箱钩子)
//	进化管线      agents.EvolutionPipeline (训练调度/经验/技能/信誉触发)
//
// 返回逆序关机函数列表 (defer 消费)。
func wiringDeepModules(kern *kernel.RuntimeKernel, st *store.Store, evBus *bus.EventBus,
	cmdBus *bus.CommandBus, mc *metrics.Collector, marlClient *marl.Client, logger *slog.Logger) []func() {

	var shutdowns []func()
	ctx := context.Background()

	// ── 经济引擎 (批次 8) ──
	eco, err := economy.NewTokenEconomyEngine(kern)
	if err == nil {
		eco.Metrics = mc
		if err := eco.Start(ctx); err != nil {
			logger.Warn("经济引擎启动失败 (继续运行)", "err", err)
		} else {
			shutdowns = append(shutdowns, func() { _ = eco.Stop(ctx) })
			logger.Info("经济引擎就绪 (DISTRIBUTE_ROLE_ALLOCATION_REWARD)")
		}
	}

	// ── 沙箱隔离与热迁移 (批次 6) ──
	sandboxEng, err := kernel.NewSandboxMigrationEngine(kern)
	if err == nil {
		sandboxEng.Metrics = mc
		if err := sandboxEng.Start(ctx); err != nil {
			logger.Warn("沙箱引擎启动失败 (继续运行)", "err", err)
		} else {
			shutdowns = append(shutdowns, func() { sandboxEng.ClearSandboxRegistry() })
			logger.Info("沙箱引擎就绪 (MIGRATE_SANDBOX_CONTEXT)")
		}
	}

	// ── Raft 共识节点 (批次 5; 单节点自动晋升 LEADER) ──
	raftNode, err := kernel.NewRaftConsensusNode(kern, "node-local")
	if err == nil {
		raftNode.Metrics = mc
		if peers := os.Getenv("SOLOFORGE_RAFT_PEERS"); peers != "" {
			kern.Config.Set("governor.cluster.peers_nodes", splitCSV(peers))
		}
		if err := raftNode.Boot(ctx); err != nil {
			logger.Warn("Raft 共识启动失败 (继续运行)", "err", err)
		} else {
			shutdowns = append(shutdowns, raftNode.Evict)
			logger.Info("Raft 共识节点就绪", "role", raftNode.Role(), "term", raftNode.Term())
		}
	}

	// ── IPC broker + 时钟编排器 (批次 5; 依赖 MARL 服务) ──
	var sandboxHook kernel.SandboxHook
	if sandboxEng != nil {
		sandboxHook = func(c context.Context, tick int64, traceID string, cpu float64) {
			sandboxEng.UpdateHostLoadFactorTelemetry(c, traceID, cpu)
		}
	}
	if marlClient != nil {
		broker, err := kernel.NewDistributedProtocolBroker(kern)
		if err == nil {
			broker.Metrics = mc
			// 非阻塞连接 (MARL 离线时指数退避重连, 超限 → 分裂脑兜底事件)
			go func() {
				if err := broker.ConnectMARLServiceGateway(ctx); err != nil {
					logger.Warn("MARL IPC 首连失败 (后台自动重连)", "err", err)
				}
			}()
			shutdowns = append(shutdowns, broker.ShutdownBroker)

			orch, err := kernel.NewClusterRuntimeOrchestrator(kern, broker)
			if err == nil {
				orch.Metrics = mc
				orch.SetSandboxHook(sandboxHook) // TS 子防线 2: 沙箱压力遥测
				if err := orch.Start(ctx); err != nil {
					logger.Warn("时钟编排器启动失败 (继续运行)", "err", err)
				} else {
					shutdowns = append(shutdowns, func() { _ = orch.Stop(ctx) })
					logger.Info("时钟编排器就绪 (50ms tick + 遥测推流 + /metrics-prom)")
				}
			}
		}
	} else {
		logger.Info("未配置 SOLOFORGE_MARL_ADDR, IPC broker/时钟编排器未启用")
	}

	// ── 进化管线 (批次 3; 训练调度/经验缓存/技能库/信誉触发) ──
	var evoClient agents.EvolutionClient
	if marlClient != nil {
		evoClient = agents.NewMARLEvolutionClient(marlClient, envOr("SOLOFORGE_MARL_ADDR", "127.0.0.1:8765"))
	}
	evoPipeline := agents.NewEvolutionPipeline(evoClient, st, evBus)
	shutdowns = append(shutdowns, func() { evoPipeline.Shutdown() })
	// 种子 Agent 注册训练触发器 (与上方 agent 池种子一致)
	for _, id := range []string{"agent_architect", "agent_coder", "agent_reviewer"} {
		evoPipeline.RegisterAgent(id, strings.TrimPrefix(id, "agent_"))
	}
	logger.Info("进化管线就绪 (训练调度/经验缓存/技能库/信誉阈值触发)")

	return shutdowns
}

// splitCSV 逗号分隔 → 字符串切片
func splitCSV(s string) []string {
	var out []string
	for _, part := range strings.Split(s, ",") {
		if p := strings.TrimSpace(part); p != "" {
			out = append(out, p)
		}
	}
	return out
}
