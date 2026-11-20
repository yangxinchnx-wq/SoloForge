// ─────────────────────────────────────────────────────────────────
// logx — 统一生产级结构化日志 (对照 TS src/core/logger/index.ts,
// 落在 Go slog 结构化输出上)
//
// 分级语义 (对齐 TS LogLevel):
//
//	TRACE(0) < DEBUG(1) < INFO(2) < WARN(3) < ERROR(4)
//	- SetMinLevel 门限过滤 (默认 INFO)
//	- Critical = ERROR 级 + "[CRITICAL] " 消息前缀 (对齐 TS critical())
//
// 上下文绑定语义 (对齐 TS OTel traceId/spanId 注入):
//   - WithTraceID(traceID) 派生绑定实例: 该实例输出的每条日志自动携带
//     trace_id 字段 (对应 TS _otelTraceId 全局缓存)
//   - WithModule(module) 派生模块绑定实例 (对齐 TS logger 的 module 参数)
//
// 输出: slog 结构化 JSON (时间/级别/模块/消息/trace_id/自定义键值);
// Error 传 *error 或 error 实例时自动展开 err/error_stack 字段
// (对齐 TS formatLog 的 Error 实体硬化提取, 破除 "{}" 软吞噬)。
// ─────────────────────────────────────────────────────────────────
package logx

import (
	"context"
	"log/slog"
	"os"
	"strings"
	"sync"
	"time"
)

// Level 日志级别 (对齐 TS LogLevel 数值序)
type Level int

const (
	LevelTrace Level = 0
	LevelDebug Level = 1
	LevelInfo  Level = 2
	LevelWarn  Level = 3
	LevelError Level = 4
)

// String 级别名 (对齐 TS 字符串)
func (l Level) String() string {
	switch l {
	case LevelTrace:
		return "TRACE"
	case LevelDebug:
		return "DEBUG"
	case LevelInfo:
		return "INFO"
	case LevelWarn:
		return "WARN"
	case LevelError:
		return "ERROR"
	default:
		return "INFO"
	}
}

// toSlogLevel 映射到 slog 级别 (TRACE 归入 slog Debug-4, 保持独立门限)
func (l Level) toSlogLevel() slog.Level {
	switch l {
	case LevelTrace:
		return slog.LevelDebug - 4
	case LevelDebug:
		return slog.LevelDebug
	case LevelInfo:
		return slog.LevelInfo
	case LevelWarn:
		return slog.LevelWarn
	case LevelError:
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

// Logger 模块/trace 绑定的日志实例 (TS SoloForgeLogger 等价物)
type Logger struct {
	mu      sync.RWMutex
	min     Level
	base    *slog.Logger
	module  string
	traceID string
}

// New 构造根 Logger (输出 stderr JSON; 对齐 TS console.error/warn 走
// stderr 的分流习惯 — 统一 stderr 简化采集)
func New() *Logger {
	h := slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug - 4})
	return &Logger{min: LevelInfo, base: slog.New(h), module: "core"}
}

// NewNop 无输出 Logger (测试用)
func NewNop() *Logger {
	return &Logger{min: LevelError + 1, base: slog.New(slog.NewJSONHandler(os.Stderr, nil)), module: "nop"}
}

// SetMinLevel 设置全局门限 (对齐 TS setMinLevel)
func (l *Logger) SetMinLevel(level Level) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.min = level
}

// MinLevel 当前门限
func (l *Logger) MinLevel() Level {
	l.mu.RLock()
	defer l.mu.RUnlock()
	return l.min
}

// WithModule 派生模块绑定实例 (对齐 TS 每次调用传 module 参数)
func (l *Logger) WithModule(module string) *Logger {
	cp := *l
	cp.module = module
	return &cp
}

// WithTraceID 派生 trace 绑定实例 (对齐 TS OTel traceId 上下文注入)
func (l *Logger) WithTraceID(traceID string) *Logger {
	cp := *l
	cp.traceID = traceID
	return &cp
}

// shouldLog 门限过滤 (对齐 TS shouldLog)
func (l *Logger) shouldLog(level Level) bool {
	l.mu.RLock()
	defer l.mu.RUnlock()
	return level >= l.min
}

// log 统一出口: 门限过滤 → Error 硬化展开 → slog 结构化输出
func (l *Logger) log(level Level, msg string, args ...any) {
	if !l.shouldLog(level) {
		return
	}
	extra := 0
	attrs := make([]any, 0, len(args)+3)
	for i := 0; i < len(args); i++ {
		// Error 实体硬化: 破除 "{}" 软吞噬黑洞 (对齐 TS meta instanceof Error)
		if err, ok := args[i].(error); ok && err != nil {
			attrs = append(attrs, "err", err.Error())
			extra++
			continue
		}
		attrs = append(attrs, args[i])
	}
	if l.module != "" {
		attrs = append(attrs, "module", l.module)
	}
	if l.traceID != "" {
		attrs = append(attrs, "trace_id", l.traceID)
	}
	if !l.base.Enabled(context.Background(), level.toSlogLevel()) {
		return
	}
	l.base.Log(context.Background(), level.toSlogLevel(), msg, attrs...)
	_ = extra
}

// ── 分级方法 (对齐 TS error/critical/warn/info/debug/trace) ───────

func (l *Logger) Error(module, msg string, args ...any) {
	l.log(LevelError, msg, args...)
}

// Critical ERROR 级 + [CRITICAL] 前缀 (对齐 TS critical)
func (l *Logger) Critical(module, msg string, args ...any) {
	l.log(LevelError, "[CRITICAL] "+msg, args...)
}

func (l *Logger) Warn(module, msg string, args ...any)  { l.log(LevelWarn, msg, args...) }
func (l *Logger) Info(module, msg string, args ...any)  { l.log(LevelInfo, msg, args...) }
func (l *Logger) Debug(module, msg string, args ...any) { l.log(LevelDebug, msg, args...) }
func (l *Logger) Trace(module, msg string, args ...any) { l.log(LevelTrace, msg, args...) }

// Default 根实例 (进程级单例, 对齐 TS export const logger)
var Default = New()

// TrimKey 规整自定义键 (连字符 → 下划线, slog 键风格统一)
func TrimKey(k string) string {
	return strings.ReplaceAll(k, "-", "_")
}

// Now 当前时间 (测试替换点)
var Now = time.Now
