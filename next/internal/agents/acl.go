// ─────────────────────────────────────────────────────────────────
// acl — FIPA-ACL Agent 通信总线 (从 TS communication/agent-communication-bus.ts 迁移)
//
// 语义对齐:
//   - FIPA-ACL 标准消息格式 (protocol.md §1: FIPAACLMessage,
//     sender/receiver/performative/content/ontology?/protocol?/messageId/replyWith?/timestamp)
//     注: protocol.md 契约写 replyWith?, TS 源码字段名是 replyTo — 以协议文档为准
//   - 9 种述行语: INFORM/REQUEST/PROPOSE/ACCEPT/REJECT/QUERY/DELEGATE/CHALLENGE/GOSSIP
//   - Inbox: TTL 30s, 上限 100 (FIFO 淘汰), messageId 去重 (上限 5000, 过半清除)
//   - GOSSIP 特殊载荷 {aboutAgentId, evaluation}, protocol='gossip-reputation',
//     排除 receiver==sender 与 receiver==aboutAgentId (RepuNet 间接声誉传播)
//   - fiaacl.relay 信封: 跨进程中继入口, 按 messageId 去重防回环 (一次性消费)
//
// 与 TS 版差异: 无 WebSocket 传输层 — Go 侧为进程内总线, 跨进程语义由
// IngestRelay (fiaacl.relay 信封入口) 承接; 每条消息经 store 落库后广播
// (事件名 agent.acl.message, protocol.md 未定义 ACL 消息事件名, 为 Go 侧扩展)。
// ─────────────────────────────────────────────────────────────────
package agents

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"soloforge/next/internal/bus"
	"soloforge/next/internal/store"
)

// ACLPerformative FIPA-ACL 述行语 (消息意图) — 对齐 TS ACLPerformative
type ACLPerformative string

const (
	PerfInform    ACLPerformative = "INFORM"    // 通知信息
	PerfRequest   ACLPerformative = "REQUEST"   // 请求执行
	PerfPropose   ACLPerformative = "PROPOSE"   // 提议合作
	PerfAccept    ACLPerformative = "ACCEPT"    // 接受提议
	PerfReject    ACLPerformative = "REJECT"    // 拒绝提议
	PerfQuery     ACLPerformative = "QUERY"     // 查询信息
	PerfDelegate  ACLPerformative = "DELEGATE"  // 委托任务
	PerfChallenge ACLPerformative = "CHALLENGE" // 挑战/质疑
	PerfGossip    ACLPerformative = "GOSSIP"    // 闲谈传播声誉
)

// 协议名 (GOSSIP 消息固定携带, 对齐 TS 'gossip-reputation')
const ACLProtocolGossip = "gossip-reputation"

// ACLGossipPayload GOSSIP 消息的特殊载荷 (对齐 TS gossip content)
type ACLGossipPayload struct {
	AboutAgentID string `json:"aboutAgentId"` // 被评价的 Agent
	Evaluation   any    `json:"evaluation"`   // 评价 (信誉引擎侧解析: {dimension, score, confidence})
}

// RelayEnvelope fiaacl.relay 跨进程中继信封 (protocol.md §1)
type RelayEnvelope struct {
	Type    string     `json:"type"`    // 固定 'fiaacl.relay'
	Payload ACLMessage `json:"payload"` // 完整 FIPA-ACL 消息
}

// ACLMessage FIPA-ACL 标准消息 (字段名对齐 protocol.md §1)
type ACLMessage struct {
	Sender       string          `json:"sender"`              // 发送者 Agent ID
	Receiver     string          `json:"receiver"`            // 接收者 Agent ID
	Performative ACLPerformative `json:"performative"`        // 述行语 (消息意图)
	Content      any             `json:"content"`             // 消息内容
	Ontology     string          `json:"ontology,omitempty"`  // 本体论 (语义上下文)
	Protocol     string          `json:"protocol,omitempty"`  // 所属协议
	MessageID    string          `json:"messageId"`           // 消息 ID
	ReplyWith    string          `json:"replyWith,omitempty"` // 回复目标 ID (TS 源码叫 replyTo)
	Timestamp    int64           `json:"timestamp"`           // 毫秒时间戳
}

// Inbox / 去重参数 (对齐 TS maxInboxSize=100, messageTTLms=30000, dedupeSetMaxSize=5000)
const (
	aclInboxMaxSize  = 100
	aclMessageTTL    = 30 * time.Second
	aclDedupeMaxSize = 5000
	aclEventName     = "agent.acl.message" // Go 侧扩展事件名 (protocol.md 未定义)
)

// ACLBus Agent 通信总线
//
// 设计原则 (对齐 TS):
//  1. 基于 FIPA-ACL 标准消息格式
//  2. 支持点对点 (Send) 与广播 (Broadcast)
//  3. 支持 Gossip 协议传播间接声誉 (RepuNet)
//  4. 消息有 TTL, 防止无限堆积
type ACLBus struct {
	mu        sync.RWMutex
	inboxes   map[string][]ACLMessage
	seenIDs   map[string]struct{} // 已发出/已接收的 messageId — 去重防回环
	seenOrder []string            // 去重集合的插入序 (过半清除旧的一半)
	msgSeq    atomic.Uint64       // messageId 序列源
	store     *store.Store
	bus       *bus.EventBus
	// gossipObserver GOSSIP 观察钩子 (编排器接入信誉引擎, 间接声誉 → UpdateFromGossip)
	gossipObserver func(msg ACLMessage)
}

// NewACLBus 构造通信总线 (store/bus 为构造注入, 事件先落库后广播)
func NewACLBus(st *store.Store, b *bus.EventBus) *ACLBus {
	return &ACLBus{
		inboxes: make(map[string][]ACLMessage),
		seenIDs: make(map[string]struct{}),
		store:   st,
		bus:     b,
	}
}

// OnGossip 注册 GOSSIP 观察钩子 (仅一个, 后注册覆盖)
func (c *ACLBus) OnGossip(fn func(msg ACLMessage)) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.gossipObserver = fn
}

// Register 注册 Agent 收件箱 (幂等)
func (c *ACLBus) Register(agentID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := c.inboxes[agentID]; !ok {
		c.inboxes[agentID] = nil // 惰性创建切片, 占位即视为已注册
	}
}

// Unregister 注销 Agent
func (c *ACLBus) Unregister(agentID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.inboxes, agentID)
}

// RegisteredAgents 已注册 Agent 列表
func (c *ACLBus) RegisteredAgents() []string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	out := make([]string, 0, len(c.inboxes))
	for id := range c.inboxes {
		out = append(out, id)
	}
	return out
}

// Send 发送点对点消息 (补全 messageId/timestamp → 写 receiver inbox → 去重登记 → 落库广播)
func (c *ACLBus) Send(ctx context.Context, msg ACLMessage) ACLMessage {
	full := msg
	full.MessageID = c.newMessageID()
	full.Timestamp = time.Now().UnixMilli()

	c.mu.Lock()
	// 1. 写入本地 inbox (上限 100, FIFO 淘汰最旧)
	inbox := c.inboxes[full.Receiver]
	if len(inbox) >= aclInboxMaxSize {
		inbox = inbox[1:]
	}
	inbox = append(inbox, full)
	c.inboxes[full.Receiver] = inbox
	// 2. 登记 messageId (去重集合, 防跨进程回环)
	c.trackSeenLocked(full.MessageID)
	observer := c.gossipObserver
	c.mu.Unlock()

	if full.Performative == PerfGossip && observer != nil {
		observer(full)
	}

	// 3. 事件: 先落库后广播
	c.emit(ctx, full)
	return full
}

// Broadcast 广播消息给指定接收者列表 (排除发送者自身, 对齐 TS)
func (c *ACLBus) Broadcast(ctx context.Context, sender string, perf ACLPerformative, content any, receivers []string) {
	for _, receiver := range receivers {
		if receiver != sender {
			c.Send(ctx, ACLMessage{Sender: sender, Receiver: receiver, Performative: perf, Content: content})
		}
	}
}

// Gossip 发送 GOSSIP 消息 — 间接声誉传播 (RepuNet)
// 排除 receiver==sender 与 receiver==aboutAgentId; 载荷 {aboutAgentId, evaluation}
func (c *ACLBus) Gossip(ctx context.Context, sender, aboutAgentID string, evaluation any, receivers []string) {
	for _, receiver := range receivers {
		if receiver != sender && receiver != aboutAgentID {
			c.Send(ctx, ACLMessage{
				Sender:       sender,
				Receiver:     receiver,
				Performative: PerfGossip,
				Content: ACLGossipPayload{
					AboutAgentID: aboutAgentID,
					Evaluation:   evaluation,
				},
				Protocol: ACLProtocolGossip,
			})
		}
	}
}

// Poll 轮询接收消息 (Agent 主循环调用): 取空 inbox 并过滤过期消息 (TTL 30s)
func (c *ACLBus) Poll(agentID string) []ACLMessage {
	c.mu.Lock()
	messages := c.inboxes[agentID]
	c.inboxes[agentID] = nil // TS 语义: 无论是否注册, poll 即清空
	c.mu.Unlock()

	now := time.Now()
	out := make([]ACLMessage, 0, len(messages))
	for _, m := range messages {
		if now.Sub(time.UnixMilli(m.Timestamp)) < aclMessageTTL {
			out = append(out, m)
		}
	}
	return out
}

// IngestRelay 处理 fiaacl.relay 跨进程中继信封 (WebSocket 桥接层调用)
// 去重: messageId 已在本地发出集合 → 回环消息, 一次性消费后跳过 (对齐 TS)
func (c *ACLBus) IngestRelay(ctx context.Context, env RelayEnvelope) (delivered bool) {
	if env.Type != "fiaacl.relay" {
		return false
	}
	msg := env.Payload
	if msg.MessageID == "" || msg.Receiver == "" {
		return false
	}

	c.mu.Lock()
	if _, loop := c.seenIDs[msg.MessageID]; loop {
		c.forgetSeenLocked(msg.MessageID) // 一次性消费
		c.mu.Unlock()
		return false
	}
	inbox := c.inboxes[msg.Receiver]
	if len(inbox) >= aclInboxMaxSize {
		inbox = inbox[1:]
	}
	inbox = append(inbox, msg)
	c.inboxes[msg.Receiver] = inbox
	c.mu.Unlock()

	c.emit(ctx, msg)
	return true
}

// ── 内部 ────────────────────────────────────────────────────────

// newMessageID 生成 msg_<ms>_<seq> 形式的唯一 ID (TS 为时间戳+随机 6 位)
func (c *ACLBus) newMessageID() string {
	return fmt.Sprintf("msg_%d_%06d", time.Now().UnixMilli(), c.msgSeq.Add(1))
}

// trackSeenLocked 登记已发出 messageId (须持 mu 写锁)
// 防止无限增长: 超过阈值时清除最旧的一半 (对齐 TS)
func (c *ACLBus) trackSeenLocked(id string) {
	c.seenIDs[id] = struct{}{}
	c.seenOrder = append(c.seenOrder, id)
	if len(c.seenOrder) > aclDedupeMaxSize {
		half := aclDedupeMaxSize / 2
		for _, old := range c.seenOrder[:half] {
			delete(c.seenIDs, old)
		}
		c.seenOrder = append([]string(nil), c.seenOrder[half:]...)
	}
}

// forgetSeenLocked 一次性消费去重 ID (须持 mu 写锁)
func (c *ACLBus) forgetSeenLocked(id string) {
	delete(c.seenIDs, id)
	for i, s := range c.seenOrder {
		if s == id {
			c.seenOrder = append(c.seenOrder[:i], c.seenOrder[i+1:]...)
			break
		}
	}
}

// emit ACL 消息事件: 先 store 落库后 bus 广播 (先写后发纪律)
func (c *ACLBus) emit(ctx context.Context, msg ACLMessage) {
	if c.store == nil || c.bus == nil {
		return
	}
	raw, err := json.Marshal(msg)
	if err != nil {
		return
	}
	if ev, err := c.store.AppendEvent(ctx, aclEventName, "agents.acl", raw); err == nil {
		c.bus.Publish(ev)
	}
}
