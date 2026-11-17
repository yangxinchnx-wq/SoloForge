// ─────────────────────────────────────────────────────────────────
// sse — SSEWorker: 通过 HTTP SSE 消费 Java Agent Advisor
//
// Advisor 自身已移除 TCP 8771, 改为 SSE 直出 (ChatStreamController):
//   POST /api/chat/stream → text/event-stream
//     event:phase  data:{"phase":"phase0_subtask",...}
//     event:text   data:{"content":"..."}
//     event:phase  data:{"phase":"phase3_deliver_done",...}
//
// SSEWorker 逐行解析 SSE, 聚合内容, 返回最终文本。
// 编排器的 phase 事件由 Orchestrator 自行广播 (避免双发)。
// ─────────────────────────────────────────────────────────────────
package agents

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// SSEWorker 通过 SSE 消费 advisor 聊天流
type SSEWorker struct {
	name   string
	url    string
	token  string
	client *http.Client
}

func NewSSEWorker(name, url, token string) *SSEWorker {
	return &SSEWorker{
		name:   name,
		url:    url,
		token:  token,
		client: &http.Client{Timeout: 180 * time.Second},
	}
}

func (w *SSEWorker) Name() string { return w.name }

// Execute POST prompt → 解析 SSE 流 → 返回聚合内容
// 请求体对齐 advisor 的 ChatRequest DTO: {message, sessionId, provider?, subProviders?}
// 错误事件: event:error data:{"error": "..."} — 作为 error 返回
func (w *SSEWorker) Execute(ctx context.Context, prompt string) (string, error) {
	body, err := json.Marshal(map[string]any{
		"message":   prompt,
		"sessionId": fmt.Sprintf("core_%d", time.Now().UnixMilli()),
	})
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", w.url, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	if w.token != "" {
		req.Header.Set("Authorization", "Bearer "+w.token)
	}
	resp, err := w.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("advisor 请求失败: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("advisor HTTP %d", resp.StatusCode)
	}

	var final strings.Builder
	var eventName, data string
	var streamErr error

	// 单个 SSE 事件的处理
	process := func() {
		if data == "" {
			return
		}
		var payload map[string]any
		if json.Unmarshal([]byte(data), &payload) == nil {
			if errMsg, ok := payload["error"].(string); ok && errMsg != "" {
				streamErr = fmt.Errorf("advisor: %s", errMsg)
				return
			}
			for _, key := range []string{"content", "output", "summary"} {
				if v, ok := payload[key].(string); ok && v != "" {
					final.WriteString(v)
					break
				}
			}
		} else if eventName == "text" || eventName == "" {
			final.WriteString(data) // 纯文本 data
		}
	}

	reader := bufio.NewReader(resp.Body)
	for {
		line, rerr := reader.ReadString('\n')
		line = strings.TrimRight(line, "\r\n")
		switch {
		case strings.HasPrefix(line, "event:"):
			eventName = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		case strings.HasPrefix(line, "data:"):
			data = strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		case line == "":
			process() // 空行 = 事件块结束
			eventName, data = "", ""
		}
		if rerr != nil {
			break // EOF
		}
	}
	process() // 流末尾未以空行终结的最后事件

	if streamErr != nil {
		return "", streamErr
	}
	if final.Len() == 0 {
		return "", fmt.Errorf("advisor SSE 流无内容")
	}
	return final.String(), nil
}
