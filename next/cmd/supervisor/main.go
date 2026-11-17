// ─────────────────────────────────────────────────────────────────
// soloforge-supervisor — 生命周期管理器
//
// 纪律 (rewrite-plan.md §六):
//   - 端口预检: 启动前试绑定, 失败报告占用者 PID/进程名 (不靠 sleep 猜)
//   - 健康探针: /health 通过才算 READY, 失败指数退避重启 (1s..30s, 5 次封顶)
//   - 子进程所有权: core + 全部 worker 由本进程 spawn, 退出时按树强杀
//   - worker 探活: 退出后退避重启 (稳定运行 60s 重置计数), 端口被占视为外部运行
// ─────────────────────────────────────────────────────────────────
package main

import (
	"context"
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
	"sync"
	"syscall"
	"time"

	"github.com/BurntSushi/toml"
)

type CoreConfig struct {
	Bin  string `toml:"bin"`
	Port int    `toml:"port"`
	Repo string `toml:"repo"` // 被管理的 Git 仓库路径 (git 服务并入核心后)
}

type WorkerConfig struct {
	Name    string `toml:"name"`
	Command string `toml:"command"`
	Port    int    `toml:"port"`
	Health  string `toml:"health"`
}

type Config struct {
	Core    CoreConfig     `toml:"core"`
	Workers []WorkerConfig `toml:"workers"`
}

func loadConfig(path string) Config {
	cfg := Config{
		Core: CoreConfig{Bin: "./bin/soloforge-core.exe", Port: 7300, Repo: ".."},
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return cfg // 无配置文件时使用默认值
	}
	if err := toml.Unmarshal(data, &cfg); err != nil {
		fmt.Fprintf(os.Stderr, "config.toml 解析失败: %v\n使用默认配置继续\n", err)
	}
	return cfg
}

var logger = slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

func main() {
	cfgPath := "config.toml"
	for i, arg := range os.Args {
		if arg == "-config" && i+1 < len(os.Args) {
			cfgPath = os.Args[i+1]
		}
	}
	cfg := loadConfig(cfgPath)
	slog.SetDefault(logger)
	os.MkdirAll("logs", 0o755)

	// ── 端口预检 (核心 + 各 worker) ──
	checked := 0
	if owner := probePortBusy(cfg.Core.Port); owner != "" {
		logger.Error("端口被占用, 无法启动", "component", "core", "port", cfg.Core.Port, "owner", owner,
			"hint", "结束占用进程或修改 config.toml")
		os.Exit(3)
	}
	checked++
	for _, w := range cfg.Workers {
		if w.Port > 0 && w.Command != "" {
			checked++
		}
	}
	logger.Info("端口预检通过", "checked", checked)

	// ── 拉起可选 workers (各自独立重启协程) ──
	var workerWG sync.WaitGroup
	stopWorkers := make(chan struct{})
	for _, w := range cfg.Workers {
		if w.Command == "" || w.Port <= 0 {
			continue
		}
		workerWG.Add(1)
		go runWorker(w, &workerWG, stopWorkers)
	}

	// ── 拉起核心 (崩溃退避重启) ──
	backoff := time.Second
	consecutiveFails := 0
	var coreCmd *exec.Cmd
	for {
		coreLog, _ := os.OpenFile(filepath.Join("logs", "core.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
		coreCmd = exec.Command(cfg.Core.Bin, "-port", strconv.Itoa(cfg.Core.Port), "-repo", cfg.Core.Repo)
		// 将 advisor 的 SSE 端点传给 core (SSEWorker 消费)
		for _, w := range cfg.Workers {
			if w.Name == "advisor" && w.Port > 0 {
				coreCmd.Env = append(os.Environ(),
					"SOLOFORGE_ADVISOR_URL=http://127.0.0.1:"+strconv.Itoa(w.Port)+"/api/chat/stream")
			}
		}
		coreCmd.Stdout = coreLog
		coreCmd.Stderr = coreLog
		if err := coreCmd.Start(); err != nil {
			logger.Error("核心进程启动失败", "err", err)
			consecutiveFails++
		} else {
			consecutiveFails = 0
			logger.Info("核心进程已拉起", "pid", coreCmd.Process.Pid)
			if waitReady(cfg.Core.Port, 15*time.Second) {
				logger.Info("READY — core 健康探针通过")
			} else {
				logger.Warn("core 健康探针超时 (15s), 继续观察")
			}
		}

		childDone := make(chan error, 1)
		go func() { childDone <- coreCmd.Wait() }()
		sigCtx, stopSig := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		select {
		case <-sigCtx.Done():
			logger.Info("收到退出信号, 按树强杀全部子进程...")
			stopSig()
			close(stopWorkers)
			killTree(coreCmd.Process.Pid)
			time.Sleep(500 * time.Millisecond) // 等端口释放
			logger.Info("supervisor 退出")
			os.Exit(0)
		case waitErr := <-childDone:
			stopSig()
			logger.Warn("core 退出", "err", fmt.Sprint(waitErr))
		}

		// 崩溃重启 (指数退避, 连续 5 次放弃)
		consecutiveFails++
		if consecutiveFails >= 5 {
			logger.Error("core 连续 5 次异常退出, 放弃重启 (检查 logs/core.log)")
			os.Exit(1)
		}
		logger.Info("退避后重启 core", "backoff", backoff.String(), "consecutive", consecutiveFails)
		time.Sleep(backoff)
		backoff = min(backoff*2, 30*time.Second)
	}
}

// runWorker 单个 worker 的拉起/探活/重启循环 (独立协程)
func runWorker(w WorkerConfig, wg *sync.WaitGroup, stop <-chan struct{}) {
	defer wg.Done()
	backoff := time.Second
	consecutiveFails := 0
	for {
		select {
		case <-stop:
			return
		default:
		}
		// 端口已被占用 → 视为已在外部运行, 跳过本次拉起
		if probePortBusy(w.Port) != "" {
			logger.Info("worker 端口已占用, 视为已在运行", "worker", w.Name, "port", w.Port)
			time.Sleep(10 * time.Second)
			continue
		}
		logFile, _ := os.OpenFile(filepath.Join("logs", "w-"+w.Name+".log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
		cmd := exec.Command("cmd", "/c", w.Command)
		cmd.Stdout = logFile
		cmd.Stderr = logFile
		started := time.Now()
		startErr := cmd.Start()
		if startErr != nil {
			logger.Error("worker 启动失败", "worker", w.Name, "err", startErr)
		} else {
			logger.Info("worker 已拉起", "worker", w.Name, "pid", cmd.Process.Pid)
		}
		waitErr := cmd.Wait()
		logFile.Close()

		// 稳定运行超过 60s 重置失败计数
		if time.Since(started) > 60*time.Second {
			consecutiveFails = 0
		}
		consecutiveFails++
		if consecutiveFails >= 5 {
			logger.Error("worker 连续 5 次异常退出, 停止重启", "worker", w.Name)
			return
		}
		logger.Warn("worker 退出, 退避后重启", "worker", w.Name,
			"err", fmt.Sprint(waitErr), "backoff", backoff.String())
		select {
		case <-stop:
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, 60*time.Second)
	}
}

// waitReady 健康探针: /health 200 即 READY
func waitReady(port int, timeout time.Duration) bool {
	client := &http.Client{Timeout: 2 * time.Second}
	url := fmt.Sprintf("http://127.0.0.1:%d/health", port)
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		resp, err := client.Get(url)
		if err == nil {
			resp.Body.Close()
			return true
		}
		time.Sleep(500 * time.Millisecond)
	}
	return false
}

// probePortBusy 端口预检: 返回占用者描述, 空串 = 空闲
func probePortBusy(port int) string {
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err == nil {
		ln.Close()
		return ""
	}
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

// killTree Windows 按树强杀
func killTree(pid int) {
	exec.Command("taskkill", "/PID", strconv.Itoa(pid), "/T", "/F").Run()
}
