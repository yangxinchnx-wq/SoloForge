// ─────────────────────────────────────────────────────────────────
// kernel — 状态所有权注册表 (从 TS src/kernel/state-ownership.ts 迁移)
//
// 语义对齐 (TS 两套实现合并为一张注册表):
//   - runtime-kernel.ts 的 StateOwnershipRegistry:
//     register(domain, keyPattern) + hasOwnership(domain, key) 通配符匹配
//     ('*' → '.*' 正则, 与 TS replace(/\*/g,'.*') 行为一致)
//   - state-ownership.ts 的 StateOwnerRegistry:
//     registerDomain(domain) + verifyCommandOwnership(command) 宪法校验
//     错误码 ERR_SF_OWNERSHIP: 域未注册 / 匿名调用者拒绝
//     系统级调用者 (SYSTEM_MASTER_DAEMON/SYSTEM/BOOTSTRAP/SUPERVISOR) 放行
//   - 预置域所有权对齐 TS RuntimeKernel.initializeDomainOwnership
//     (JudicialCourt/AIRuntime/Governor/ShadowGovernor/DecisionEngine)
//
// ─────────────────────────────────────────────────────────────────
package kernel

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
	"sync"
)

// ownershipPattern 所有权模式: 原始串 + 预编译通配符正则
type ownershipPattern struct {
	raw string
	re  *regexp.Regexp // nil = 精确匹配
}

// StateOwnership 状态所有权注册表 (域 → key 模式集合)
type StateOwnership struct {
	mu            sync.RWMutex
	ownerships    map[string][]ownershipPattern // domain → 模式列表
	domains       map[string]bool               // 已注册域 (对齐 TS StateOwnerRegistry.domains)
	systemCallers map[string]bool               // 系统级调用者白名单
}

// NewStateOwnership 构造注册表并预置域所有权
// (对齐 TS RuntimeKernel.initializeDomainOwnership 预注册)
func NewStateOwnership() *StateOwnership {
	so := &StateOwnership{
		ownerships:    make(map[string][]ownershipPattern),
		domains:       make(map[string]bool),
		systemCallers: make(map[string]bool),
	}
	// 司法法庭域: 可访问 court_case_registry* 前缀的状态
	so.Register("JudicialCourt", "court_case_registry*")
	// AI 运行时域: 可访问 AIRuntime_* / core_scheduler* 前缀的状态
	so.Register("AIRuntime", "AIRuntime*")
	so.Register("AIRuntime", "core_scheduler*")
	// 资源总调度域: 可访问 governor_* 前缀的状态
	so.Register("Governor", "governor*")
	// Shadow Governor 域: 可访问 governor_shadow_* 前缀的状态
	so.Register("ShadowGovernor", "governor_shadow*")
	// 决策引擎域: 可访问 decision_* 前缀的状态
	so.Register("DecisionEngine", "decision*")

	// 系统级调用者白名单 (对齐 TS StateOwnerRegistry 构造器): 心跳/Bootstrap 等放行
	for _, c := range []string{"SYSTEM_MASTER_DAEMON", "SYSTEM", "BOOTSTRAP", "SUPERVISOR"} {
		so.systemCallers[c] = true
	}
	return so
}

// Register 注册域对某 key 模式的所有权 (幂等; 含 '*' 视为通配符)
func (so *StateOwnership) Register(domain, keyPattern string) {
	so.mu.Lock()
	defer so.mu.Unlock()
	so.domains[domain] = true
	// 去重: 同域同模式只保留一份
	for _, p := range so.ownerships[domain] {
		if p.raw == keyPattern {
			return
		}
	}
	so.ownerships[domain] = append(so.ownerships[domain], ownershipPattern{
		raw: keyPattern,
		re:  compilePattern(keyPattern),
	})
}

// RegisterDomain 仅注册域 (无 key 模式): 宪法校验通过, 但 Resolve 不放行任何 key
// (对齐 TS StateOwnerRegistry.registerDomain)
func (so *StateOwnership) RegisterDomain(domain string) {
	so.mu.Lock()
	defer so.mu.Unlock()
	so.domains[domain] = true
	if so.ownerships[domain] == nil {
		so.ownerships[domain] = nil // 占位: 域已注册但无模式
	}
}

// Resolve 校验域是否拥有 key 的所有权 (对齐 TS hasOwnership, 支持通配符)
func (so *StateOwnership) Resolve(domain, key string) bool {
	so.mu.RLock()
	defer so.mu.RUnlock()
	for _, p := range so.ownerships[domain] {
		if p.re != nil {
			if p.re.MatchString(key) {
				return true
			}
		} else if p.raw == key {
			return true
		}
	}
	return false
}

// Owners 返回拥有该 key 的所有域 (诊断/审计用)
func (so *StateOwnership) Owners(key string) []string {
	so.mu.RLock()
	defer so.mu.RUnlock()
	var out []string
	for domain, patterns := range so.ownerships {
		for _, p := range patterns {
			if p.re != nil && p.re.MatchString(key) || p.re == nil && p.raw == key {
				out = append(out, domain)
				break
			}
		}
	}
	sort.Strings(out)
	return out
}

// Patterns 返回域的全部所有权模式 (对齐 TS getOwnershipPatterns, 排序稳定)
func (so *StateOwnership) Patterns(domain string) []string {
	so.mu.RLock()
	defer so.mu.RUnlock()
	out := make([]string, 0, len(so.ownerships[domain]))
	for _, p := range so.ownerships[domain] {
		out = append(out, p.raw)
	}
	sort.Strings(out)
	return out
}

// VerifyCommandOwnership 核心宪法校验 (对齐 TS verifyCommandOwnership):
//  1. 域未注册 → ERR_SF_OWNERSHIP
//  2. 系统级调用者 → 放行
//  3. 匿名/空调用者 → ERR_SF_OWNERSHIP
func (so *StateOwnership) VerifyCommandOwnership(domain, caller string) error {
	so.mu.RLock()
	defer so.mu.RUnlock()
	if domain == "" || !so.domains[domain] {
		return fmt.Errorf("ERR_SF_OWNERSHIP: Domain [%s] not registered", domain)
	}
	if so.systemCallers[caller] {
		return nil // 系统级调用放行 (心跳、Bootstrap 等)
	}
	if caller == "" || caller == "ANONYMOUS" {
		return fmt.Errorf("ERR_SF_OWNERSHIP: Anonymous caller rejected on domain [%s]", domain)
	}
	return nil
}

// compilePattern 通配符编译: '*' → '.*' (对齐 TS replace(/\*/g,'.*') 全段跨切匹配)
func compilePattern(pattern string) *regexp.Regexp {
	if !strings.Contains(pattern, "*") {
		return nil // 精确匹配无需正则
	}
	var sb strings.Builder
	sb.WriteString("^")
	for i, part := range strings.Split(pattern, "*") {
		if i > 0 {
			sb.WriteString(".*")
		}
		sb.WriteString(regexp.QuoteMeta(part))
	}
	sb.WriteString("$")
	re, err := regexp.Compile(sb.String())
	if err != nil {
		return nil // 理论不可达: QuoteMeta 后必为合法正则
	}
	return re
}
