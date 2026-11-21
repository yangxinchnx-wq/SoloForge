// ─────────────────────────────────────────────────────────────────
// config.go — 后端 LLM 配置 (从 env 读)
// (从 TS src/llm/llmConfig.ts 迁移)
//
// 设计原则:
//   - API key 永远只在后端进程, 绝不发给前端
//   - 支持任意 OpenAI 兼容服务 (OpenAI / DeepSeek / OpenRouter / 自建)
//   - 启动时打印当前 provider + model + baseUrl (不打印 key)
//
// 必需环境变量 (要调用真实 LLM 时):
//
//	SOLOFORGE_LLM_PROVIDER=openai  (或 deepseek / openai-compatible)
//	SOLOFORGE_LLM_API_KEY=sk-...
//	SOLOFORGE_LLM_BASE_URL=https://api.openai.com/v1   (默认)
//	SOLOFORGE_LLM_MODEL=gpt-4o-mini                    (默认)
//
// 可选:
//
//	SOLOFORGE_LLM_TIMEOUT_MS=60000
//	SOLOFORGE_LLM_API_TOKEN=xxx  ← 前端调用 /api/llm/stream 时需要带的
//	                               简单 token; 留空表示同源即可 (开发模式)
//
// ─────────────────────────────────────────────────────────────────
package llm

import (
	"os"
	"strconv"
	"sync"
)

// Config LLM 代理配置 (对齐 TS LLMProxyConfig)
type Config struct {
	Provider     string
	BaseURL      string
	APIKey       string
	DefaultModel string
	TimeoutMs    int
	// APIToken 前端访问代理所需 token; 空字符串 = 不校验 (仅同源)
	APIToken string
}

const (
	defaultBaseURL = "https://api.openai.com/v1"
	defaultModel   = "gpt-4o-mini"
	defaultTimeout = 60_000
	providerEnv    = "SOLOFORGE_LLM_PROVIDER"
	baseURLEnv     = "SOLOFORGE_LLM_BASE_URL"
	apiKeyEnv      = "SOLOFORGE_LLM_API_KEY"
	modelEnv       = "SOLOFORGE_LLM_MODEL"
	timeoutEnv     = "SOLOFORGE_LLM_TIMEOUT_MS"
	apiTokenEnv    = "SOLOFORGE_LLM_API_TOKEN"
)

var (
	configMu   sync.RWMutex
	configOnce bool
	cachedCfg  *Config
)

// loadFromEnv 从环境变量读取配置
func loadFromEnv() Config {
	cfg := Config{
		Provider:     envOr(providerEnv, "openai"),
		BaseURL:      envOr(baseURLEnv, defaultBaseURL),
		APIKey:       os.Getenv(apiKeyEnv),
		DefaultModel: envOr(modelEnv, defaultModel),
		TimeoutMs:    defaultTimeout,
		APIToken:     os.Getenv(apiTokenEnv),
	}
	if v := os.Getenv(timeoutEnv); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			cfg.TimeoutMs = n
		}
	}
	return cfg
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// GetConfig 读取 LLM 配置 (进程内缓存, 对齐 TS getLLMProxyConfig)
func GetConfig() Config {
	configMu.RLock()
	if cachedCfg != nil {
		cfg := *cachedCfg
		configMu.RUnlock()
		return cfg
	}
	configMu.RUnlock()

	configMu.Lock()
	defer configMu.Unlock()
	if cachedCfg == nil {
		cfg := loadFromEnv()
		cachedCfg = &cfg
	}
	return *cachedCfg
}

// RefreshConfig 强制刷新缓存 (从环境变量重新加载, 对齐 TS refreshLLMProxyConfig)
func RefreshConfig() Config {
	configMu.Lock()
	defer configMu.Unlock()
	cfg := loadFromEnv()
	cachedCfg = &cfg
	return cfg
}

// SetConfig 测试用: 注入新配置 (对齐 TS setLLMProxyConfig)
func SetConfig(overrides *Config) {
	configMu.Lock()
	defer configMu.Unlock()
	cfg := loadFromEnv()
	if overrides != nil {
		if overrides.Provider != "" {
			cfg.Provider = overrides.Provider
		}
		if overrides.BaseURL != "" {
			cfg.BaseURL = overrides.BaseURL
		}
		if overrides.APIKey != "" {
			cfg.APIKey = overrides.APIKey
		}
		if overrides.DefaultModel != "" {
			cfg.DefaultModel = overrides.DefaultModel
		}
		if overrides.TimeoutMs > 0 {
			cfg.TimeoutMs = overrides.TimeoutMs
		}
		if overrides.APIToken != "" {
			cfg.APIToken = overrides.APIToken
		}
	}
	cachedCfg = &cfg
}

// ResetConfig 测试用: 清缓存 (下次 GetConfig 重新读 env)
func ResetConfig() {
	configMu.Lock()
	defer configMu.Unlock()
	cachedCfg = nil
	configOnce = false
}

// IsReady 是否配置齐全 (apiKey 非空, 对齐 TS isLLMProxyReady)
func IsReady() bool {
	c := GetConfig()
	return c.APIKey != "" && c.BaseURL != "" && c.DefaultModel != ""
}

// DescribeConfig 脱敏配置描述 (不含 key, 对齐 TS describeLLMProxyConfig;
// 供 /api/llm/config 与错误响应使用)
func DescribeConfig() map[string]any {
	c := GetConfig()
	return map[string]any{
		"provider":      c.Provider,
		"baseUrl":       c.BaseURL,
		"defaultModel":  c.DefaultModel,
		"ready":         IsReady(),
		"tokenRequired": c.APIToken != "",
	}
}
