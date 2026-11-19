// ─────────────────────────────────────────────────────────────────
// toolsrelay — 工具调用分发器 (从 TS tool-result-relay.ts 迁移)
//
// 语义对齐旧 JavaTCP tool_call: 按工具名前缀路由到可插拔执行器。
// 本阶段内置执行器返回占位响应; 真实执行器 (Browser-Use/Windows-MCP/
// DevTools/Obscura) 在 Tauri/后续阶段接入。
// ─────────────────────────────────────────────────────────────────
package toolsrelay

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"

	"soloforge/next/internal/bus"
)

// Executor 工具执行器接口
type Executor interface {
	CanHandle(tool string) bool
	Execute(ctx context.Context, tool string, args json.RawMessage) (any, error)
}

// Relay 工具分发器
type Relay struct {
	mu        sync.RWMutex
	executors []Executor
}

func New() *Relay { return &Relay{} }

// Register 注册执行器 (后注册者优先匹配)
func (r *Relay) Register(e Executor) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.executors = append([]Executor{e}, r.executors...)
}

// Dispatch 按工具名路由执行
func (r *Relay) Dispatch(ctx context.Context, tool string, args json.RawMessage) (any, error) {
	r.mu.RLock()
	for _, e := range r.executors {
		if e.CanHandle(tool) {
			r.mu.RUnlock()
			return e.Execute(ctx, tool, args)
		}
	}
	r.mu.RUnlock()
	return map[string]any{
		"executed": false,
		"tool":     tool,
		"reason":   "执行器未接入 (Browser-Use/Windows-MCP/DevTools/Obscura 待 Tauri 阶段接入)",
	}, nil
}

// RegisterCommands 注册 tool.execute 命令到 CommandBus
func (r *Relay) RegisterCommands(cb *bus.CommandBus) {
	cb.Register("tool.execute", func(ctx context.Context, payload json.RawMessage) (any, error) {
		var p struct {
			Tool string          `json:"tool"`
			Args json.RawMessage `json:"args"`
		}
		if err := json.Unmarshal(payload, &p); err != nil || p.Tool == "" {
			return nil, fmt.Errorf("payload 需为 {tool, args?}")
		}
		return r.Dispatch(ctx, p.Tool, p.Args)
	})
}

// 占位执行器 (默认注册, 返回未接入响应)
type placeholderExecutor struct{ kind string }

func (p placeholderExecutor) CanHandle(tool string) bool { return true }
func (p placeholderExecutor) Execute(ctx context.Context, tool string, args json.RawMessage) (any, error) {
	return map[string]any{"executed": false, "tool": tool, "kind": p.kind, "reason": "占位执行器"}, nil
}

// NewWithPlaceholders 带占位执行器的 Relay (默认构造)
func NewWithPlaceholders() *Relay {
	r := New()
	r.Register(placeholderExecutor{kind: "browser-use"})
	r.Register(placeholderExecutor{kind: "windows-mcp"})
	r.Register(placeholderExecutor{kind: "devtools"})
	r.Register(placeholderExecutor{kind: "obscura"})
	return r
}
