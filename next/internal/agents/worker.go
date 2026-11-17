// ─────────────────────────────────────────────────────────────────
// worker — 任务执行后端接口
//
// 阶段 2: MockWorker (管道自测) + HTTPWorker (OpenAI 兼容接口,
// 可指向 llama-server / 任何 OpenAI 兼容端点)。
// 旧系统的 Java dispatch / 多 worker TCP 流式协议在后续阶段接入。
// ─────────────────────────────────────────────────────────────────
package agents

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// Worker 单个执行后端
type Worker interface {
	Name() string
	Execute(ctx context.Context, prompt string) (string, error)
}

// MockWorker 本地回显执行器 (骨架自测用, 无外部依赖)
type MockWorker struct {
	name string
}

func NewMockWorker(name string) *MockWorker { return &MockWorker{name: name} }

func (m *MockWorker) Name() string { return m.name }

func (m *MockWorker) Execute(ctx context.Context, prompt string) (string, error) {
	return fmt.Sprintf("[%s] 已处理: %s", m.name, prompt), nil
}

// HTTPWorker OpenAI 兼容 /v1/chat/completions 客户端
// (llama-server / vLLM / 任意 OpenAI 兼容端点均可指向)
type HTTPWorker struct {
	name    string
	baseURL string
	model   string
	apiKey  string
	client  *http.Client
}

func NewHTTPWorker(name, baseURL, model, apiKey string) *HTTPWorker {
	return &HTTPWorker{
		name:    name,
		baseURL: baseURL,
		model:   model,
		apiKey:  apiKey,
		client:  &http.Client{Timeout: 120 * time.Second},
	}
}

func (h *HTTPWorker) Name() string { return h.name }

func (h *HTTPWorker) Execute(ctx context.Context, prompt string) (string, error) {
	body, err := json.Marshal(map[string]any{
		"model": h.model,
		"messages": []map[string]string{
			{"role": "user", "content": prompt},
		},
	})
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, "POST",
		h.baseURL+"/v1/chat/completions", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	if h.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+h.apiKey)
	}
	resp, err := h.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("LLM 请求失败: %w", err)
	}
	defer resp.Body.Close()
	var out struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error,omitempty"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", fmt.Errorf("LLM 响应解码失败: %w", err)
	}
	if out.Error != nil {
		return "", fmt.Errorf("LLM 错误: %s", out.Error.Message)
	}
	if len(out.Choices) == 0 {
		return "", fmt.Errorf("LLM 响应无 choices")
	}
	return out.Choices[0].Message.Content, nil
}
