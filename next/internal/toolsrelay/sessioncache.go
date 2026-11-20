// ─────────────────────────────────────────────────────────────────
// sessioncache.go — 会话级工具结果缓存 (从 TS session-tool-cache.ts 迁移)
//
// P2: 跨 Dispatch 复用工具结果, 减少重复 IO。按 chatId 隔离 (不同对话
// 互不干扰), TTL 默认 10 分钟, 容量上限 500 (超限淘汰最旧条目),
// 每 5 分钟后台清理过期条目。
//
// 缓存层级 (对齐 TS 设计注释):
//
//	L1 In-Dispatch — LLM 循环内去重 (function-calling-client.ts 内 Map, 随
//	                 LLM 循环迁移接入)
//	L2 Cross-Dispatch Session — 本模块 (进程级单例 DefaultSessionToolCache)
//	L3 Persistent Experience — 经验缓存 ( TS experience-cache.ts, 未迁移)
//
// key 生成对齐 TS buildKey: SHA256(chatId:toolName:argsHash16) 前 32 位,
// 其中 argsHash = SHA256(JSON.stringify(args)) 前 16 位; Go 版参数序列化
// 用规范化 JSON (map Marshal 按键排序), 保证同参数同 key。
// ─────────────────────────────────────────────────────────────────
package toolsrelay

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"sync"
	"time"
)

// ─── 常量 (对齐 TS DEFAULT_TTL_MS / MAX_ENTRIES / CLEANUP_INTERVAL_MS) ──

const (
	sessionCacheTTL        = 10 * time.Minute // 默认 TTL
	sessionCacheMaxEntries = 500              // 最大条目数 (防内存无限增长)
	sessionCacheCleanup    = 5 * time.Minute  // 过期清理间隔
)

// SessionCacheEntry 缓存条目
type SessionCacheEntry struct {
	Key       string
	ChatID    string
	ToolName  string
	ArgsHash  string
	Output    string
	Timestamp time.Time
	HitCount  int
	TTL       time.Duration
}

// SessionToolCache 会话级工具结果缓存 (并发安全; TS 版依赖事件循环单线程,
// Go 版加互斥锁)
type SessionToolCache struct {
	mu      sync.Mutex
	cache   map[string]*SessionCacheEntry
	hits    int
	misses  int
	stop    chan struct{}
	stopped sync.Once
}

// NewSessionToolCache 创建缓存并启动定期清理 goroutine
func NewSessionToolCache() *SessionToolCache {
	c := &SessionToolCache{
		cache: make(map[string]*SessionCacheEntry),
		stop:  make(chan struct{}),
	}
	go c.janitor()
	return c
}

// janitor 定期清理过期条目 (对齐 TS setInterval cleanupExpired)
func (c *SessionToolCache) janitor() {
	ticker := time.NewTicker(sessionCacheCleanup)
	defer ticker.Stop()
	for {
		select {
		case <-c.stop:
			return
		case <-ticker.C:
			c.CleanupExpired()
		}
	}
}

// canonicalArgsJSON 参数规范化序列化 (对齐 TS JSON.stringify(args)):
// 解析为 map 再 Marshal — Go 的 map Marshal 按键排序输出, 同参数得到
// 稳定 hash。非对象 (数组/标量) 时原样使用, 空/非法时兜底 "{}"。
func canonicalArgsJSON(args json.RawMessage) string {
	if len(args) == 0 {
		return "{}"
	}
	var m map[string]any
	if err := json.Unmarshal(args, &m); err != nil {
		s := strings.TrimSpace(string(args))
		if s == "" {
			return "{}"
		}
		return s
	}
	b, err := json.Marshal(m)
	if err != nil {
		return string(args)
	}
	return string(b)
}

// buildKey 缓存 key (对齐 TS buildKey)
func (c *SessionToolCache) buildKey(chatID, toolName string, args json.RawMessage) (key, argsHash string) {
	h1 := sha256.Sum256([]byte(canonicalArgsJSON(args)))
	argsHash = hex.EncodeToString(h1[:])[:16]
	h2 := sha256.Sum256([]byte(chatID + ":" + toolName + ":" + argsHash))
	key = hex.EncodeToString(h2[:])[:32]
	return key, argsHash
}

// Lookup 查询缓存: 命中返回输出并更新计数; 过期即清除 (对齐 TS lookup)
func (c *SessionToolCache) Lookup(chatID, toolName string, args json.RawMessage) (string, bool) {
	key, _ := c.buildKey(chatID, toolName, args)
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.cache[key]
	if !ok {
		c.misses++
		return "", false
	}
	if time.Since(e.Timestamp) > e.TTL {
		delete(c.cache, key)
		c.misses++
		return "", false
	}
	e.HitCount++
	c.hits++
	return e.Output, true
}

// Store 存储工具结果 (超容量时淘汰最旧条目; ttl <= 0 用默认 10 分钟)
func (c *SessionToolCache) Store(chatID, toolName string, args json.RawMessage, output string, ttl time.Duration) {
	if ttl <= 0 {
		ttl = sessionCacheTTL
	}
	key, argsHash := c.buildKey(chatID, toolName, args)
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.cache) >= sessionCacheMaxEntries {
		c.evictOldestLocked()
	}
	c.cache[key] = &SessionCacheEntry{
		Key:       key,
		ChatID:    chatID,
		ToolName:  toolName,
		ArgsHash:  argsHash,
		Output:    output,
		Timestamp: time.Now(),
		TTL:       ttl,
	}
}

// ClearByChatId 清理指定会话的全部缓存, 返回清理条数 (对齐 TS clearByChatId)
func (c *SessionToolCache) ClearByChatId(chatID string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	cleared := 0
	for key, e := range c.cache {
		if e.ChatID == chatID {
			delete(c.cache, key)
			cleared++
		}
	}
	return cleared
}

// CleanupExpired 清理全部过期条目, 返回清理条数 (对齐 TS cleanupExpired)
func (c *SessionToolCache) CleanupExpired() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	cleared := 0
	for key, e := range c.cache {
		if time.Since(e.Timestamp) > e.TTL {
			delete(c.cache, key)
			cleared++
		}
	}
	return cleared
}

// evictOldestLocked 淘汰最旧条目 (对齐 TS evictOldest 的简化 LRU;
// 调用方须持锁)
func (c *SessionToolCache) evictOldestLocked() {
	var oldestKey string
	var oldest time.Time
	first := true
	for k, e := range c.cache {
		if first || e.Timestamp.Before(oldest) {
			oldest, oldestKey, first = e.Timestamp, k, false
		}
	}
	if !first {
		delete(c.cache, oldestKey)
	}
}

// Stats 缓存统计 (对齐 TS getStats: size/hitCount/missCount/hitRate)
func (c *SessionToolCache) Stats() (size, hitCount, missCount int, hitRate float64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	total := c.hits + c.misses
	if total > 0 {
		hitRate = float64(c.hits) / float64(total)
	}
	return len(c.cache), c.hits, c.misses, hitRate
}

// Stop 停止后台清理 goroutine (进程退出前调用)
func (c *SessionToolCache) Stop() {
	c.stopped.Do(func() { close(c.stop) })
}

// DefaultSessionToolCache 进程级单例 (对齐 TS sessionToolCache)
var DefaultSessionToolCache = NewSessionToolCache()

// IsCacheableToolResult 工具结果是否可缓存 (对齐 TS 同名函数):
// 错误结果与动态查询结果 (命令执行/截图/任务状态/性能计数器/事件日志/
// 网络请求/控制台日志) 不缓存。
func IsCacheableToolResult(toolName, output string) bool {
	if strings.HasPrefix(output, "Error:") || strings.HasPrefix(output, "Tool error:") {
		return false
	}
	switch toolName {
	case "execute_cmd", // 命令执行有副作用
		"browser_screenshot", // 截图随时间变化
		"bu_screenshot",      // 同上
		"bu_state",           // 状态随时变化
		"win_perfmon",        // 性能计数器实时变化
		"win_event_log",      // 事件日志实时增长
		"browser_network",    // 网络请求实时变化
		"browser_console":    // 控制台日志实时变化
		return false
	}
	return true
}
