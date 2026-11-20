// ─────────────────────────────────────────────────────────────────
// kernel — 配置中心 (从 TS src/kernel/config-center.ts 迁移)
//
// 语义对齐:
//   - 三级回退: 用户配置 config → 内置默认表 defaults → 调用方默认值
//   - DEFAULT_CONFIG 字段级对齐 TS (governor.clock.tick_rate_ms=50,
//     society.governance.tax_equilibrium_coefficient=0.15 等)
//   - 分节: key 以点号分层 (governor.* / society.* ...), Section(prefix)
//     返回该节合并快照
//   - Set 只写用户配置层, 永不污染默认表 (对齐 TS)
//   - 线程安全: RWMutex (TS 单线程事件循环无此需求, Go 显式加锁)
//
// ─────────────────────────────────────────────────────────────────
package kernel

import (
	"sort"
	"sync"
)

// DEFAULT_CONFIG 内置默认表 (字段级对齐 TS config-center.ts DEFAULT_CONFIG)
var DEFAULT_CONFIG = map[string]any{
	// Governor 时钟
	"governor.clock.tick_rate_ms":      50,
	"governor.observability.http_port": 9090,

	// IPC 网络设置
	"governor.ipc.host":                   "127.0.0.1",
	"governor.ipc.port":                   8765,
	"governor.ipc.max_reconnect_attempts": 10,
	"governor.ipc.reconnect_backoff_base": 1000,

	// Society 配置
	"society.law.default_active_wal":             true,
	"society.law.emergency_lockdown_cooldown":    5000,
	"society.reputation.weight_error":            0.3,
	"society.reputation.decay_rate":              0.95,
	"society.governance.effectiveness_threshold": 0.85,

	// 政府干预参数
	"society.governance.tax_equilibrium_coefficient": 0.15, // 税收均衡系数
	"society.governance.reputation_decay_operator":   0.05, // 声望衰减算子
	"society.governance.privilege_threshold":         20,   // 特权阈值
	"society.governance.auto_intervention_enabled":   true, // 自动干预开关

	// 沙箱配置
	"society.sandbox.cpu_critical_bar":      0.90,
	"society.sandbox.heavyweight_byte_line": 10485760,
	"society.sandbox.fallback_safe_slot_id": "isolated_failover_slot_omega",

	// 联盟 Shapley 值容差
	"society.coalition.shapley_tolerance":       0.001,
	"society.coalition.min_formation_threshold": 0.1,

	// 制度信任阈值
	"society.institution.trust_threshold_min": 0.6,
	"society.institution.trust_threshold_max": 0.95,

	// 角色演化
	"society.evolution.role_cooldown_ticks": 100,
	"society.evolution.promotion_threshold": 0.8,
	"society.evolution.demotion_threshold":  0.3,

	// 社会记忆
	"society.memory.forgetting_curve_base":        0.05,
	"society.memory.consolidation_interval_ticks": 50,

	// Shadow Governor
	"governor.shadow.enabled":    false,
	"governor.shadow.server_url": "http://127.0.0.1:8080",

	// Phase 7: 分布式 Raft 共识集群
	"governor.cluster.local_node_id": "node_alpha_master",
	"governor.cluster.peers_nodes":   []string{"node_beta_slave_1", "node_gamma_slave_2"},
	"society.economy.precision":      4,
}

// ConfigCenter 集中配置注册表 — 全系统配置的统一类型化访问入口
type ConfigCenter struct {
	mu       sync.RWMutex
	config   map[string]any // 用户配置层 (Set 写入)
	defaults map[string]any // 内置默认层 (只读)
}

// NewConfigCenter 构造配置中心; initial 为用户配置初始层 (可 nil)
func NewConfigCenter(initial map[string]any) *ConfigCenter {
	cc := &ConfigCenter{
		config:   make(map[string]any, len(initial)),
		defaults: make(map[string]any, len(DEFAULT_CONFIG)),
	}
	for k, v := range DEFAULT_CONFIG {
		cc.defaults[k] = v
	}
	for k, v := range initial {
		cc.config[k] = v
	}
	return cc
}

// Get 取配置值, 三级回退: 用户配置 → 内置默认 → 调用方默认值
func (cc *ConfigCenter) Get(key string, def any) any {
	cc.mu.RLock()
	defer cc.mu.RUnlock()
	if v, ok := cc.config[key]; ok {
		return v
	}
	if v, ok := cc.defaults[key]; ok {
		return v
	}
	return def
}

// GetInt 取整数值 (int/int64/float64 数值统一收敛; 缺失或类型不符返回 def)
func (cc *ConfigCenter) GetInt(key string, def int) int {
	switch v := cc.Get(key, nil).(type) {
	case int:
		return v
	case int64:
		return int(v)
	case float64:
		return int(v)
	default:
		return def
	}
}

// GetFloat 取浮点值 (int 数值提升为 float64)
func (cc *ConfigCenter) GetFloat(key string, def float64) float64 {
	switch v := cc.Get(key, nil).(type) {
	case float64:
		return v
	case int:
		return float64(v)
	case int64:
		return float64(v)
	default:
		return def
	}
}

// GetBool 取布尔值
func (cc *ConfigCenter) GetBool(key string, def bool) bool {
	if v, ok := cc.Get(key, nil).(bool); ok {
		return v
	}
	return def
}

// GetString 取字符串值
func (cc *ConfigCenter) GetString(key string, def string) string {
	if v, ok := cc.Get(key, nil).(string); ok {
		return v
	}
	return def
}

// Set 写入用户配置层 (覆盖同名默认值; 不修改默认表)
func (cc *ConfigCenter) Set(key string, value any) {
	cc.mu.Lock()
	defer cc.mu.Unlock()
	cc.config[key] = value
}

// Has 键是否在任一层存在
func (cc *ConfigCenter) Has(key string) bool {
	cc.mu.RLock()
	defer cc.mu.RUnlock()
	_, inConfig := cc.config[key]
	_, inDefaults := cc.defaults[key]
	return inConfig || inDefaults
}

// Keys 全部键 (两层并集, 排序稳定)
func (cc *ConfigCenter) Keys() []string {
	cc.mu.RLock()
	defer cc.mu.RUnlock()
	seen := make(map[string]bool, len(cc.config)+len(cc.defaults))
	out := make([]string, 0, len(cc.config)+len(cc.defaults))
	for k := range cc.config {
		if !seen[k] {
			seen[k] = true
			out = append(out, k)
		}
	}
	for k := range cc.defaults {
		if !seen[k] {
			seen[k] = true
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out
}

// Section 取分节快照: 所有以 prefix 开头的键 (如 "governor.ipc.") 的
// 合并视图 (用户层覆盖默认层), 返回副本, 调用方修改不影响原配置
func (cc *ConfigCenter) Section(prefix string) map[string]any {
	cc.mu.RLock()
	defer cc.mu.RUnlock()
	out := make(map[string]any)
	for k, v := range cc.defaults {
		if len(k) >= len(prefix) && k[:len(prefix)] == prefix {
			out[k] = v
		}
	}
	for k, v := range cc.config {
		if len(k) >= len(prefix) && k[:len(prefix)] == prefix {
			out[k] = v // 用户层覆盖
		}
	}
	return out
}
