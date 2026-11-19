// ─────────────────────────────────────────────────────────────────
// marl — MARL 策略查询客户端 (TCP JSON 行协议)
//
// 对齐旧 ShadowGovernorClient (端口 8765) 语义:
//   请求: {"id":<int>,"obs":[...],"timestamp":...}
//   响应: {"id":<int>,"action":<int>,"action_name":"...","prob":0..1,...}
//
// 由 decision.SetPolicy 注入为策略偏好 (prob → 候选加成)。
// 未运行 (ECONNREFUSED) 时返回 error, 决策引擎自动回退启发式。
// ─────────────────────────────────────────────────────────────────
package marl

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"sync/atomic"
	"time"
)

type Client struct {
	addr string
	id   atomic.Int64
}

func New(addr string) *Client { return &Client{addr: addr} }

type request struct {
	ID        int64    `json:"id"`
	Obs       []float64 `json:"obs"`
	Timestamp int64    `json:"timestamp"`
}

type response struct {
	ID         int64   `json:"id"`
	Action     int     `json:"action"`
	ActionName string  `json:"action_name"`
	Prob       float64 `json:"prob"`
	Value      float64 `json:"value"`
	Confidence float64 `json:"confidence"`
}

// Query 发送策略查询, 返回响应 (2s 超时, 对齐旧版 POLICY_QUERY 超时语义)
func (c *Client) Query(ctx context.Context, obs []float64) (*response, error) {
	dialer := net.Dialer{Timeout: 2 * time.Second}
	conn, err := dialer.DialContext(ctx, "tcp", c.addr)
	if err != nil {
		return nil, fmt.Errorf("marl 连接失败: %w", err)
	}
	defer conn.Close()

	id := c.id.Add(1)
	req := request{ID: id, Obs: obs, Timestamp: time.Now().UnixMilli()}
	line, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	conn.SetDeadline(time.Now().Add(2 * time.Second))
	if _, err := conn.Write(append(line, '\n')); err != nil {
		return nil, fmt.Errorf("marl 写入失败: %w", err)
	}

	scanner := bufio.NewScanner(conn)
	for scanner.Scan() {
		var resp response
		if err := json.Unmarshal(scanner.Bytes(), &resp); err != nil {
			continue // 跳过非 JSON 行
		}
		if resp.ID == id {
			return &resp, nil
		}
	}
	return nil, fmt.Errorf("marl 响应超时 (id=%d)", id)
}

// Bonus 把 MARL 推理结果映射为决策偏好加成 (0..1):
//   prob × confidence, action=0 (no_op) 时无加成
func (c *Client) Bonus(ctx context.Context, obs []float64) (float64, error) {
	resp, err := c.Query(ctx, obs)
	if err != nil {
		return 0, err
	}
	if resp.Action == 0 {
		return 0, nil
	}
	bonus := resp.Prob * resp.Confidence
	if bonus < 0 {
		bonus = 0
	}
	if bonus > 1 {
		bonus = 1
	}
	return bonus, nil
}
