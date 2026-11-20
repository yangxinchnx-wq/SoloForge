// ─────────────────────────────────────────────────────────────────
// llm_test.go — internal/llm 自测
//
// 覆盖: 配置读取/注入、模型能力匹配 (手动覆盖 > 探针 > 精确 >
// 前缀 > 默认)、能力学习持久化、熔断器 OPEN/HALF_OPEN 超时回退。
// ─────────────────────────────────────────────────────────────────
package llm

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestConfigEnvAndOverride(t *testing.T) {
	ResetConfig()
	t.Setenv("SOLOFORGE_LLM_API_KEY", "sk-env-test")
	t.Setenv("SOLOFORGE_LLM_BASE_URL", "https://example.com/v1")
	t.Setenv("SOLOFORGE_LLM_TIMEOUT_MS", "1234")
	RefreshConfig()
	c := GetConfig()
	if c.APIKey != "sk-env-test" || c.BaseURL != "https://example.com/v1" || c.TimeoutMs != 1234 {
		t.Fatalf("env 配置读取错误: %+v", c)
	}
	if !IsReady() {
		t.Fatalf("IsReady 应为 true")
	}
	SetConfig(&Config{APIKey: "sk-override"})
	if GetConfig().APIKey != "sk-override" || GetConfig().BaseURL != "https://example.com/v1" {
		t.Fatalf("注入覆盖错误: %+v", GetConfig())
	}
	ResetConfig()
}

func TestCapabilityMatching(t *testing.T) {
	SetCapabilitiesPath(filepath.Join(t.TempDir(), "caps.json"))

	// 精确匹配
	if st := SupportsTools("gpt-4o"); st == nil || !*st {
		t.Fatalf("gpt-4o 应支持 tools")
	}
	// 前缀匹配 (deepseek-r1 不支持 tools)
	if st := SupportsTools("deepseek-r1-distill-7b"); st == nil || *st {
		t.Fatalf("deepseek-r1* 前缀应不支持 tools")
	}
	// 未知模型 → 全 null (调用方保守处理)
	if st := SupportsTools("totally-unknown-model"); st != nil {
		t.Fatalf("未知模型应为 nil")
	}
	// 大小写/空白归一
	if st := SupportsTools("  GLM-4 "); st == nil || !*st {
		t.Fatalf("归一化匹配失败")
	}
	// 手动覆盖最高优先级
	SetManualOverride("gpt-4o", Capability{SupportsTools: boolPtr(false)})
	if st := SupportsTools("gpt-4o"); st == nil || *st {
		t.Fatalf("手动覆盖应生效")
	}
}

func TestLearnCapabilityPersists(t *testing.T) {
	path := filepath.Join(t.TempDir(), "caps.json")
	SetCapabilitiesPath(path)
	model := "learn-model-abc"
	LearnCapability(model, FeatureTools, false)
	if st := SupportsTools(model); st == nil || *st {
		t.Fatalf("学习后应不支持 tools")
	}
	// 重载文件验证持久化
	SetCapabilitiesPath(path)
	if st := SupportsTools(model); st == nil || *st {
		t.Fatalf("持久化后应保持不支持 tools")
	}
	_ = os.Remove(path)
	SetCapabilitiesPath("")
}

func TestBreakerHalfOpenTimeout(t *testing.T) {
	b := NewBreaker()
	key := "k|half-open"

	// 触发 OPEN
	for i := 0; i < FailureThreshold; i++ {
		b.RecordFailure(key, 503)
	}
	if d := b.Evaluate(key); d.Action != Reject {
		t.Fatalf("应 OPEN 拒绝: %+v", d)
	}
	// 直接操纵 openedAt 模拟冷却期已过 → HALF_OPEN 放行
	b.mu.Lock()
	b.circuits[key].openedAt = time.Now().Add(-CooldownMs - time.Second)
	b.mu.Unlock()
	if d := b.Evaluate(key); d.Action != Proceed || d.State != StateHalfOpen {
		t.Fatalf("冷却后应 HALF_OPEN 放行: %+v", d)
	}
	// 探测成功 → CLOSED
	b.RecordSuccess(key, 5)
	if d := b.Evaluate(key); d.State != StateClosed {
		t.Fatalf("探测成功后应 CLOSED: %+v", d)
	}
	// HALF_OPEN 超时回退 OPEN: 重新触发 OPEN → 过冷却期进 HALF_OPEN →
	// 把 openedAt 拨到超过 half-open 超时 (TS 同用 openedAt 字段)
	for i := 0; i < FailureThreshold; i++ {
		b.RecordFailure(key, 503)
	}
	b.mu.Lock()
	b.circuits[key].openedAt = time.Now().Add(-CooldownMs - time.Second)
	b.mu.Unlock()
	if d := b.Evaluate(key); d.Action != Proceed || d.State != StateHalfOpen {
		t.Fatalf("应进入 HALF_OPEN: %+v", d)
	}
	b.mu.Lock()
	b.circuits[key].openedAt = time.Now().Add(-HalfOpenTimeoutMs - time.Second)
	b.mu.Unlock()
	if d := b.Evaluate(key); d.Action != Reject || d.Reason != "half-open probe timeout" {
		t.Fatalf("HALF_OPEN 超时应回退 OPEN: %+v", d)
	}
}

func TestExtractStatusCode(t *testing.T) {
	if got := ExtractStatusCode(fmtErr("LLM HTTP 429: too many")); got != 429 {
		t.Fatalf("应提取 429, 实际 %d", got)
	}
	if got := ExtractStatusCode(fmtErr("connection refused")); got != 0 {
		t.Fatalf("网络错误应记 0, 实际 %d", got)
	}
	if got := ExtractStatusCode(nil); got != 0 {
		t.Fatalf("nil 应记 0")
	}
}

type strErr string

func (s strErr) Error() string { return string(s) }

func fmtErr(s string) error { return strErr(s) }
