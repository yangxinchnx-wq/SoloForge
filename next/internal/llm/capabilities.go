// ─────────────────────────────────────────────────────────────────
// capabilities.go — 模型能力范围查询 (本地脚本判断, 零 LLM 消耗)
// (从 TS src/llm/modelCapabilities.ts 迁移)
//
// 设计原则:
//   - 纯本地判断, 不通过 LLM, 不发网络请求
//   - 数据来源: 硬编码已知模型 + 运行时探针结果 + 用户手动覆盖
//   - 匹配策略: 手动覆盖 → 探针结果 → 精确匹配 → 前缀匹配 → 默认值
//   - 用途: Agent 调用前判断模型支持哪些能力, 自动选择最佳路径
//
// 能力项: tools (function calling) / vision / json / streaming / embeddings
// ─────────────────────────────────────────────────────────────────
package llm

import (
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Capability 单个模型的能力档案 (对齐 TS ModelCapability)
type Capability struct {
	SupportsTools     *bool  `json:"supportsTools"`
	SupportsVision    *bool  `json:"supportsVision"`
	SupportsJson      *bool  `json:"supportsJson"`
	SupportsStreaming *bool  `json:"supportsStreaming"`
	ContextWindow     *int64 `json:"contextWindow"`
	MaxOutput         *int64 `json:"maxOutput"`
	Source            string `json:"source"` // 'builtin' | 'probe' | 'manual'
	UpdatedAt         int64  `json:"updatedAt"`
}

// Feature 能力项 (对齐 TS CapabilityFeature)
type Feature string

const (
	FeatureTools     Feature = "tools"
	FeatureVision    Feature = "vision"
	FeatureJSON      Feature = "json"
	FeatureStreaming Feature = "streaming"
)

func boolPtr(b bool) *bool    { return &b }
func int64Ptr(v int64) *int64 { return &v }

func cap(tools, vision, jsonMode, streaming bool, ctxWindow, maxOut int64) Capability {
	return Capability{
		SupportsTools:     boolPtr(tools),
		SupportsVision:    boolPtr(vision),
		SupportsJson:      boolPtr(jsonMode),
		SupportsStreaming: boolPtr(streaming),
		ContextWindow:     int64Ptr(ctxWindow),
		MaxOutput:         int64Ptr(maxOut),
		Source:            "builtin",
	}
}

// builtinDB 硬编码已知模型能力 (对齐 TS BUILTIN_DB)
var builtinDB = map[string]Capability{
	// ── OpenAI ──
	"gpt-4o":        cap(true, true, true, true, 128000, 16384),
	"gpt-4o-mini":   cap(true, true, true, true, 128000, 16384),
	"gpt-4-turbo":   cap(true, true, true, true, 128000, 4096),
	"gpt-4":         cap(true, true, true, true, 8192, 4096),
	"gpt-3.5-turbo": cap(true, false, true, true, 16385, 4096),
	"o1-preview":    cap(false, true, false, false, 128000, 32768),
	"o1-mini":       cap(false, false, false, false, 128000, 65536),
	"o3-mini":       cap(true, true, true, true, 200000, 100000),

	// ── Anthropic Claude ──
	"claude-3-5-sonnet": cap(true, true, true, true, 200000, 8192),
	"claude-3-5-haiku":  cap(true, true, true, true, 200000, 8192),
	"claude-3-opus":     cap(true, true, true, true, 200000, 4096),

	// ── Google Gemini ──
	"gemini-2.0-flash": cap(true, true, true, true, 1048576, 8192),
	"gemini-2.5-pro":   cap(true, true, true, true, 1048576, 8192),

	// ── DeepSeek ──
	"deepseek-chat":     cap(true, false, true, true, 64000, 8192),
	"deepseek-reasoner": cap(false, false, false, true, 64000, 8192),

	// ── Qwen ──
	"qwen-turbo": cap(true, false, true, true, 1000000, 8192),
	"qwen-plus":  cap(true, false, true, true, 131072, 8192),
	"qwen-max":   cap(true, false, true, true, 32768, 8192),

	// ── 智谱 GLM ──
	"glm-4":       cap(true, true, true, true, 128000, 4096),
	"glm-4-flash": cap(true, false, true, true, 128000, 4096),

	// ── 小米 MiMo (2026-07-16 实测: 支持 function calling + reasoning_content) ──
	"mimo-v2.5":     cap(true, false, true, true, 32768, 4096),
	"mimo-v2.5-pro": cap(true, false, true, true, 32768, 4096),

	// ── Moonshot Kimi ──
	"moonshot-v1-8k":  cap(true, false, true, true, 8192, 4096),
	"moonshot-v1-32k": cap(true, false, true, true, 32768, 4096),

	// ── 豆包 Doubao ──
	"doubao-pro-32k":  cap(true, false, true, true, 32000, 4096),
	"doubao-pro-128k": cap(true, false, true, true, 128000, 4096),
}

// prefixRule 前缀匹配规则 (对齐 TS PREFIX_RULES)
type prefixRule struct {
	prefix string
	tools  bool
	vision bool
}

var prefixRules = []prefixRule{
	{"gpt-4o", true, true},
	{"gpt-4", true, true},
	{"gpt-3.5", true, false},
	{"o1", false, true},
	{"o3", true, true},
	{"claude-3", true, true},
	{"gemini", true, true},
	{"deepseek-chat", true, false},
	{"deepseek-coder", true, false},
	{"deepseek-reasoner", false, false},
	{"deepseek-r1", false, false},
	{"qwen", true, false},
	{"glm-4", true, true},
	{"mimo", true, false},
	{"moonshot", true, false},
	{"doubao", true, false},
	{"yi-", true, false},
	{"baichuan", true, false},
	{"step", true, false},
	{"abab", true, false},
	{"mistral", true, false},
	{"mixtral", true, false},
	{"llama", false, false},
	{"codellama", false, false},
}

// registry 运行时注册表 (探针缓存 + 手动覆盖 + 持久化)
type registry struct {
	mu              sync.RWMutex
	probeCache      map[string]Capability
	manualOverrides map[string]Capability
	filePath        string
}

var defaultRegistry = newRegistry("")

func newRegistry(path string) *registry {
	if path == "" {
		// 对齐 TS: process.cwd()/data/model-capabilities.json
		wd, err := os.Getwd()
		if err == nil {
			path = filepath.Join(wd, "data", "model-capabilities.json")
		}
	}
	r := &registry{
		probeCache:      make(map[string]Capability),
		manualOverrides: make(map[string]Capability),
		filePath:        path,
	}
	r.loadFromFile()
	return r
}

// SetCapabilitiesPath 测试用: 指定持久化文件路径并重载
func SetCapabilitiesPath(path string) {
	defaultRegistry.mu.Lock()
	defer defaultRegistry.mu.Unlock()
	defaultRegistry.filePath = path
	defaultRegistry.probeCache = make(map[string]Capability)
	defaultRegistry.manualOverrides = make(map[string]Capability)
	defaultRegistry.loadFromFileLocked()
}

// capabilitiesFile 持久化文件结构
type capabilitiesFile struct {
	Version         string                `json:"version"`
	ProbeResults    map[string]Capability `json:"probeResults"`
	ManualOverrides map[string]Capability `json:"manualOverrides"`
	SavedAt         string                `json:"savedAt"`
}

func (r *registry) loadFromFile() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.loadFromFileLocked()
}

func (r *registry) loadFromFileLocked() {
	if r.filePath == "" {
		return
	}
	raw, err := os.ReadFile(r.filePath)
	if err != nil {
		return // 文件不存在 = 首次启动
	}
	var data capabilitiesFile
	if err := json.Unmarshal(raw, &data); err != nil {
		slog.Warn("模型能力文件解析失败", "path", r.filePath, "err", err)
		return
	}
	nProbe, nManual := 0, 0
	for id, c := range data.ProbeResults {
		c.Source = "probe"
		r.probeCache[id] = c
		nProbe++
	}
	for id, c := range data.ManualOverrides {
		c.Source = "manual"
		r.manualOverrides[id] = c
		nManual++
	}
	slog.Info("已加载模型能力档案", "probeResults", nProbe, "manualOverrides", nManual)
}

func (r *registry) saveToFileLocked() {
	if r.filePath == "" {
		return
	}
	if err := os.MkdirAll(filepath.Dir(r.filePath), 0o755); err != nil {
		slog.Warn("模型能力目录创建失败", "path", r.filePath, "err", err)
		return
	}
	data := capabilitiesFile{
		Version:         "2026-07-09",
		ProbeResults:    r.probeCache,
		ManualOverrides: r.manualOverrides,
		SavedAt:         time.Now().UTC().Format(time.RFC3339),
	}
	raw, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		slog.Warn("模型能力文件序列化失败", "err", err)
		return
	}
	if err := os.WriteFile(r.filePath, raw, 0o644); err != nil {
		slog.Warn("模型能力文件保存失败", "path", r.filePath, "err", err)
	}
}

// GetCapabilities 查询模型能力 (本地判断, 零网络请求, 对齐 TS getModelCapabilities)。
// 优先级: 手动覆盖 > 探针结果 > 精确匹配内置 DB > 前缀匹配 > 默认值 (全 null)。
func GetCapabilities(modelID string) Capability {
	if modelID == "" {
		return Capability{Source: "builtin"}
	}
	normalized := lowerTrim(modelID)

	defaultRegistry.mu.RLock()
	defer defaultRegistry.mu.RUnlock()

	// 1. 手动覆盖 (最高优先级)
	if c, ok := defaultRegistry.manualOverrides[normalized]; ok {
		return c
	}
	// 2. 探针结果
	if c, ok := defaultRegistry.probeCache[normalized]; ok {
		return c
	}
	// 3. 精确匹配内置 DB
	if c, ok := builtinDB[normalized]; ok {
		return c
	}
	// 4. 前缀匹配
	for _, rule := range prefixRules {
		if len(normalized) >= len(rule.prefix) && normalized[:len(rule.prefix)] == rule.prefix {
			return Capability{
				SupportsTools:  boolPtr(rule.tools),
				SupportsVision: boolPtr(rule.vision),
				Source:         "builtin",
			}
		}
	}
	// 5. 默认: 未知模型, 所有能力为 null (调用方应做保守处理)
	return Capability{Source: "builtin"}
}

// SupportsFeature 检查模型是否支持某项能力 (对齐 TS supportsFeature)。
// true=支持, false=不支持, nil=未知。
func SupportsFeature(modelID string, feature Feature) *bool {
	c := GetCapabilities(modelID)
	switch feature {
	case FeatureTools:
		return c.SupportsTools
	case FeatureVision:
		return c.SupportsVision
	case FeatureJSON:
		return c.SupportsJson
	case FeatureStreaming:
		return c.SupportsStreaming
	default:
		return nil
	}
}

// SupportsTools 检查模型是否支持 function calling (最常用查询, 对齐 TS supportsTools)
func SupportsTools(modelID string) *bool {
	return SupportsFeature(modelID, FeatureTools)
}

// ProbeResult 探针结果 (部分字段, 对齐 TS saveProbeResult 入参)
type ProbeResult struct {
	SupportsTools     *bool  `json:"supportsTools"`
	SupportsVision    *bool  `json:"supportsVision"`
	SupportsJson      *bool  `json:"supportsJson"`
	SupportsStreaming *bool  `json:"supportsStreaming"`
	ContextWindow     *int64 `json:"contextWindow"`
	MaxOutput         *int64 `json:"maxOutput"`
}

// SaveProbeResult 保存探针结果到运行时缓存并持久化
// (对齐 TS saveProbeResult; 由前端 /api/providers/model-probe 回调或后端探针触发)
func SaveProbeResult(modelID string, res ProbeResult) {
	if modelID == "" {
		return
	}
	normalized := lowerTrim(modelID)
	defaultRegistry.mu.Lock()
	defer defaultRegistry.mu.Unlock()

	existing, hasExisting := defaultRegistry.probeCache[normalized]
	cap := Capability{
		SupportsTools:     firstOr(res.SupportsTools, existing, hasExisting, func(c Capability) *bool { return c.SupportsTools }),
		SupportsVision:    firstOr(res.SupportsVision, existing, hasExisting, func(c Capability) *bool { return c.SupportsVision }),
		SupportsJson:      firstOr(res.SupportsJson, existing, hasExisting, func(c Capability) *bool { return c.SupportsJson }),
		SupportsStreaming: firstOr(res.SupportsStreaming, existing, hasExisting, func(c Capability) *bool { return c.SupportsStreaming }),
		ContextWindow:     firstOrI64(res.ContextWindow, existing, hasExisting, func(c Capability) *int64 { return c.ContextWindow }),
		MaxOutput:         firstOrI64(res.MaxOutput, existing, hasExisting, func(c Capability) *int64 { return c.MaxOutput }),
		Source:            "probe",
		UpdatedAt:         time.Now().UnixMilli(),
	}
	defaultRegistry.probeCache[normalized] = cap
	defaultRegistry.saveToFileLocked()
	slog.Info("已保存探针结果", "model", normalized, "tools", derefBool(cap.SupportsTools), "vision", derefBool(cap.SupportsVision))
}

// LearnCapability 从 LLM API 响应中学习模型能力 (运行时自适应, 对齐 TS learnCapability)。
// 请求失败时根据错误类型推断模型不支持该能力; 成功时确认支持。
func LearnCapability(modelID string, feature Feature, supported bool) {
	if modelID == "" {
		return
	}
	normalized := lowerTrim(modelID)
	// 先在锁外解析既有档案 (GetCapabilities 内部自取读锁)
	defaultRegistry.mu.RLock()
	existing, ok := defaultRegistry.probeCache[normalized]
	defaultRegistry.mu.RUnlock()
	if !ok {
		existing = GetCapabilities(normalized)
	}
	defaultRegistry.mu.Lock()
	defer defaultRegistry.mu.Unlock()
	updated := existing
	updated.Source = "probe"
	updated.UpdatedAt = time.Now().UnixMilli()
	switch feature {
	case FeatureTools:
		updated.SupportsTools = boolPtr(supported)
	case FeatureVision:
		updated.SupportsVision = boolPtr(supported)
	case FeatureJSON:
		updated.SupportsJson = boolPtr(supported)
	case FeatureStreaming:
		updated.SupportsStreaming = boolPtr(supported)
	}
	defaultRegistry.probeCache[normalized] = updated
	defaultRegistry.saveToFileLocked()
	slog.Info("运行时学习模型能力", "model", normalized, "feature", feature, "supported", supported)
}

// SetManualOverride 设置用户手动覆盖 (最高优先级, 持久化)
func SetManualOverride(modelID string, c Capability) {
	if modelID == "" {
		return
	}
	c.Source = "manual"
	defaultRegistry.mu.Lock()
	defer defaultRegistry.mu.Unlock()
	defaultRegistry.manualOverrides[lowerTrim(modelID)] = c
	defaultRegistry.saveToFileLocked()
}

// AllCapabilities 获取所有已知模型能力 (内置 + 探针 + 手动, 对齐 TS getAllCapabilities)
func AllCapabilities() map[string]Capability {
	result := make(map[string]Capability)
	for id, c := range builtinDB {
		result[id] = c
	}
	defaultRegistry.mu.RLock()
	defer defaultRegistry.mu.RUnlock()
	for id, c := range defaultRegistry.probeCache {
		result[id] = c
	}
	for id, c := range defaultRegistry.manualOverrides {
		result[id] = c
	}
	return result
}

// DescribeCapabilities 获取模型能力摘要 (用于日志/调试, 对齐 TS describeCapabilities)
func DescribeCapabilities(modelID string) string {
	c := GetCapabilities(modelID)
	var parts []string
	if c.SupportsTools != nil {
		if *c.SupportsTools {
			parts = append(parts, "tools")
		} else {
			parts = append(parts, "no-tools")
		}
	}
	if c.SupportsVision != nil && *c.SupportsVision {
		parts = append(parts, "vision")
	}
	if c.SupportsJson != nil && *c.SupportsJson {
		parts = append(parts, "json")
	}
	if c.SupportsStreaming != nil && *c.SupportsStreaming {
		parts = append(parts, "streaming")
	}
	if c.ContextWindow != nil {
		parts = append(parts, "ctx="+itoa(*c.ContextWindow))
	}
	joined := "unknown"
	if len(parts) > 0 {
		joined = ""
		for i, p := range parts {
			if i > 0 {
				joined += ", "
			}
			joined += p
		}
	}
	return "[" + c.Source + "] " + joined
}

// ─── 小工具 ──────────────────────────────────────────────────────

func lowerTrim(s string) string {
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if 'A' <= c && c <= 'Z' {
			c += 'a' - 'A'
		}
		if c == ' ' || c == '\t' || c == '\n' || c == '\r' {
			continue
		}
		out = append(out, c)
	}
	return string(out)
}

func itoa(v int64) string {
	if v == 0 {
		return "0"
	}
	neg := v < 0
	if neg {
		v = -v
	}
	var buf [20]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

func derefBool(p *bool) any {
	if p == nil {
		return nil
	}
	return *p
}

func firstOr(v *bool, existing Capability, has bool, get func(Capability) *bool) *bool {
	if v != nil {
		return v
	}
	if has {
		return get(existing)
	}
	return nil
}

func firstOrI64(v *int64, existing Capability, has bool, get func(Capability) *int64) *int64 {
	if v != nil {
		return v
	}
	if has {
		return get(existing)
	}
	return nil
}
