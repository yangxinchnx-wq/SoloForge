// ─────────────────────────────────────────────────────────────────
// logx_test.go — 批次 8 自测: 分级门限 / Critical 前缀 / 上下文绑定 /
// Error 硬化展开 / 模块绑定
// ─────────────────────────────────────────────────────────────────
package logx

import (
	"errors"
	"log/slog"
	"strings"
	"sync"
	"testing"
)

// captureLogger 构造输出到内存缓冲的 Logger (test 包内可访问私有字段)
func captureLogger(t *testing.T) (*Logger, *safeBuf) {
	t.Helper()
	buf := &safeBuf{}
	h := slog.NewJSONHandler(buf, &slog.HandlerOptions{Level: slog.LevelDebug - 4})
	l := &Logger{min: LevelInfo, base: slog.New(h), module: "core"}
	return l, buf
}

type safeBuf struct {
	mu sync.Mutex
	sb strings.Builder
}

func (s *safeBuf) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sb.Write(p)
}

func (s *safeBuf) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sb.String()
}

func (s *safeBuf) Reset() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sb.Reset()
}

func TestLogLevels(t *testing.T) {
	l, buf := captureLogger(t)

	// 默认 INFO 门限: DEBUG 被过滤, INFO/WARN 输出
	l.Info("m1", "hello")
	l.Debug("m1", "hidden")
	out := buf.String()
	if !strings.Contains(out, `"hello"`) {
		t.Fatalf("INFO 应输出: %s", out)
	}
	if strings.Contains(out, "hidden") {
		t.Fatalf("DEBUG 低于 INFO 门限不应输出: %s", out)
	}

	// 降门限后 DEBUG 输出
	buf.Reset()
	l.SetMinLevel(LevelDebug)
	l.Debug("m1", "now-visible")
	if !strings.Contains(buf.String(), "now-visible") {
		t.Fatalf("降门限后 DEBUG 应输出: %s", buf.String())
	}
}

func TestCriticalPrefixAndErrorExpansion(t *testing.T) {
	l, buf := captureLogger(t)
	l.Critical("m2", "system on fire", errors.New("boom: e1"))
	out := buf.String()
	if !strings.Contains(out, "[CRITICAL] system on fire") {
		t.Fatalf("Critical 应带前缀: %s", out)
	}
	if !strings.Contains(out, `"err":"boom: e1"`) {
		t.Fatalf("error 实例应硬化展开为 err 字段: %s", out)
	}
}

func TestContextBinding(t *testing.T) {
	l, buf := captureLogger(t)

	// trace 绑定 + 模块绑定: 派生实例每条日志自动携带
	traced := l.WithModule("sandbox").WithTraceID("tr-42")
	traced.Warn("ignored-module", "migrating slot")
	out := buf.String()
	if !strings.Contains(out, `"module":"sandbox"`) {
		t.Fatalf("模块绑定应生效: %s", out)
	}
	if !strings.Contains(out, `"trace_id":"tr-42"`) {
		t.Fatalf("trace 绑定应生效: %s", out)
	}
	// 根实例不受派生实例影响
	buf.Reset()
	l.Info("root", "plain")
	if strings.Contains(buf.String(), "tr-42") {
		t.Fatalf("根实例不应带派生 trace: %s", buf.String())
	}
}

func TestFormat(t *testing.T) {
	// JSON 行格式: 级别字符串对齐 TS (ERROR/WARN/INFO/DEBUG/TRACE)
	if LevelTrace.String() != "TRACE" || LevelError.String() != "ERROR" {
		t.Fatal("级别名对齐 TS 失败")
	}
	// TrimKey
	if TrimKey("log-metrics-v1") != "log_metrics_v1" {
		t.Fatal("键规整失败")
	}
}
