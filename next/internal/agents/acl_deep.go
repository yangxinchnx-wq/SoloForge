// ─────────────────────────────────────────────────────────────────
// acl_deep.go — 通信协议深度补齐 (批次 4)
//
// 对齐待办清单标注的三个缺口 (TS communication-bus 中均未实现):
//  1. 消息优先级队列  → ACLPriority 3 级 (低/普通/紧急) + Poll 按优先级
//     降序、同级 FIFO (排序在 acl.go Poll 内联完成)
//  2. 会话上下文管理  → ACLConversation 会话状态机: 消息归属/线程回溯
//     (InReplyTo)、参与者、打开的请求、闲置关闭
//  3. 协议协商握手    → PROPOSE/ACCEPT/REJECT 三步握手: 能力声明 →
//     应答 → 协议落定 (per agent-pair 记忆), 提案
//     30s 未应答自动过期 (FIPA 会话超时语义)
//
// 数值均为补齐推导 (非 TS 逐行移植), 与既有 TTL 30s / Inbox 100 同风格。
// ─────────────────────────────────────────────────────────────────
package agents

import (
	"context"
	"fmt"
	"sync/atomic"
	"time"
)

// ─── 消息优先级队列 ──────────────────────────────────────────────

// ACLPriority 消息优先级 (0=低 1=普通 2=紧急)
type ACLPriority int

const (
	PrioLow    ACLPriority = 0 // 低优先: gossip 转播、统计类
	PrioNormal ACLPriority = 1 // 普通: 默认
	PrioUrgent ACLPriority = 2 // 紧急: 紧急训练协调、超时告警等
)

// SendWithPriority 按优先级发送点对点消息 (Priority 字段随消息入队,
// Poll 取出时按优先级降序; Inbox 溢出仍 FIFO 淘汰最旧, 对齐 TS)
func (c *ACLBus) SendWithPriority(ctx context.Context, msg ACLMessage, prio ACLPriority) ACLMessage {
	msg.Priority = int(prio)
	return c.Send(ctx, msg)
}

// ─── 会话上下文管理 ──────────────────────────────────────────────

// 会话状态机与阈值
const (
	ACLConvOpen   = "open"   // 进行中
	ACLConvAgreed = "agreed" // 协商已达成 (握手完成)
	ACLConvClosed = "closed" // 主动关闭 / 闲置超时
	// aclConvIdleCloseMs 闲置自动关闭 (10 分钟无消息)
	aclConvIdleCloseMs = 10 * 60 * 1000
	// aclConvMaxMessages 每会话保留的消息条数 (环形截断)
	aclConvMaxMessages = 50
)

// ACLConversation 会话上下文 (协议会话的状态快照)
type ACLConversation struct {
	ID             string       `json:"id"`          // conv_<ms>_<seq>
	Protocol       string       `json:"protocol"`    // 会话协议 (协商后更新为落定协议)
	Initiator      string       `json:"initiator"`   // 发起方
	Participant    string       `json:"participant"` // 应答方
	State          string       `json:"state"`       // open | agreed | closed
	StartedAt      int64        `json:"startedAt"`
	LastActiveAt   int64        `json:"lastActiveAt"`
	PendingRequest string       `json:"pendingRequest,omitempty"` // 待决请求的消息 ID (REQUEST/PROPOSE/DELEGATE)
	Messages       []ACLMessage `json:"-"`                        // 最近 50 条 (环形截断, 诊断用)
}

// startConversation 开启一个会话 (调用方持写锁)
func (c *ACLBus) startConversationLocked(protocol, initiator, participant string) *ACLConversation {
	conv := &ACLConversation{
		ID:           fmt.Sprintf("conv_%d_%06d", time.Now().UnixMilli(), aclConvSeq.Add(1)),
		Protocol:     protocol,
		Initiator:    initiator,
		Participant:  participant,
		State:        ACLConvOpen,
		StartedAt:    time.Now().UnixMilli(),
		LastActiveAt: time.Now().UnixMilli(),
		Messages:     []ACLMessage{},
	}
	c.conversations[conv.ID] = conv
	return conv
}

// recordConversationLocked Send 的会话记账 (须持写锁):
//   - ConversationID 已指定 → 归属该会话 (不存在则按消息信息就地建会话)
//   - ConversationID 为空但 InReplyTo 指向已知消息 → 回溯归属原会话
//   - 每条消息登记 convByMsg (InReplyTo 回溯索引), 会话消息环形截断 50 条
func (c *ACLBus) recordConversationLocked(msg ACLMessage) {
	// 无会话关联意向: 无 ConversationID 且无 InReplyTo → 不记账
	if msg.ConversationID == "" && msg.InReplyTo == "" {
		return
	}

	convID := msg.ConversationID
	if convID == "" {
		convID = c.convByMsg[msg.InReplyTo]
		if convID == "" {
			return // 回溯不到原会话 (原消息无会话), 放弃记账
		}
		msg.ConversationID = convID
	}

	conv, ok := c.conversations[convID]
	if !ok {
		// 就地建会话 (外部指定的会话 ID, 例如跨进程同步的场景)
		conv = &ACLConversation{
			ID: convID, Protocol: msg.Protocol,
			Initiator: msg.Sender, Participant: msg.Receiver,
			State: ACLConvOpen, StartedAt: msg.Timestamp,
		}
		c.conversations[convID] = conv
	}
	conv.LastActiveAt = msg.Timestamp
	conv.Messages = append(conv.Messages, msg)
	if len(conv.Messages) > aclConvMaxMessages {
		conv.Messages = conv.Messages[len(conv.Messages)-aclConvMaxMessages:]
	}
	c.convByMsg[msg.MessageID] = convID

	// 请求/委托/提议类述行语登记待决请求; ACCEPT/REJECT/CHALLENGE 结算
	switch msg.Performative {
	case PerfRequest, PerfPropose, PerfDelegate:
		conv.PendingRequest = msg.MessageID
	case PerfAccept, PerfReject, PerfChallenge:
		conv.PendingRequest = ""
		if msg.Performative == PerfAccept && conv.State == ACLConvOpen {
			conv.State = ACLConvAgreed
		}
		if msg.Performative != PerfAccept {
			conv.State = ACLConvClosed
		}
	}
}

// Conversation 查询会话上下文 (消息列表按时间升序副本)
func (c *ACLBus) Conversation(convID string) (ACLConversation, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	conv, ok := c.conversations[convID]
	if !ok {
		return ACLConversation{}, false
	}
	out := *conv
	out.Messages = append([]ACLMessage(nil), conv.Messages...)
	return out, true
}

// CloseConversation 主动关闭会话
func (c *ACLBus) CloseConversation(convID string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	conv, ok := c.conversations[convID]
	if !ok || conv.State == ACLConvClosed {
		return false
	}
	conv.State = ACLConvClosed
	return true
}

// ReplyTo 会话内回复: 自动带上 ConversationID + InReplyTo (线程回溯)。
// repliedTo 为原消息 (通常来自 Poll 的返回)。
func (c *ACLBus) ReplyTo(ctx context.Context, repliedTo ACLMessage, sender string,
	perf ACLPerformative, content any) ACLMessage {

	msg := ACLMessage{
		Sender:         sender,
		Receiver:       repliedTo.Sender,
		Performative:   perf,
		Content:        content,
		Protocol:       repliedTo.Protocol,
		ConversationID: repliedTo.ConversationID,
		InReplyTo:      repliedTo.MessageID,
	}
	return c.Send(ctx, msg)
}

// sweepConversationsLocked 闲置会话/过期索引清扫 (须持写锁; 返回关闭数)。
// 闲置超过 2 倍关闭阈值的会话移除, convByMsg 同步清理。
func (c *ACLBus) sweepConversationsLocked() int {
	now := time.Now().UnixMilli()
	removed := 0
	for id, conv := range c.conversations {
		if conv.State != ACLConvClosed && now-conv.LastActiveAt <= aclConvIdleCloseMs {
			conv.State = ACLConvClosed
		}
		if now-conv.LastActiveAt > 2*aclConvIdleCloseMs {
			for _, m := range conv.Messages {
				delete(c.convByMsg, m.MessageID)
			}
			delete(c.conversations, id)
			removed++
		}
	}
	return removed
}

// ─── 协议协商握手 ────────────────────────────────────────────────

// 协议协商常量
const (
	// ACLProtocolNegotiation 协商握手本身使用的协议名
	ACLProtocolNegotiation = "protocol-negotiation"
	// aclProposalTimeoutMs 提案应答超时 (30s, 对齐消息 TTL 同风格)
	aclProposalTimeoutMs = 30 * 1000
)

// 提案状态
const (
	ACLProposalPending  = "pending"
	ACLProposalAccepted = "accepted"
	ACLProposalRejected = "rejected"
	ACLProposalExpired  = "expired"
)

// ACLProposal 协议协商提案
type ACLProposal struct {
	ID         string         `json:"id"`         // prop_<ms>_<seq>
	From       string         `json:"from"`       // 提案方
	To         string         `json:"to"`         // 应答方
	Protocol   string         `json:"protocol"`   // 想使用的协议
	Capability map[string]any `json:"capability"` // 提案方能力声明
	State      string         `json:"state"`      // pending | accepted | rejected | expired
	ProposedAt int64          `json:"proposedAt"`
	AnsweredAt int64          `json:"answeredAt,omitempty"`
	ConvID     string         `json:"convId,omitempty"` // 握手会话 ID
}

// ProposeProtocol 发起协议协商握手 (三步握手的第 1 步):
// 发送 PROPOSE, 内容 {protocol, capability}, 建立握手会话。
// 返回 (proposalID, conversationID)。
func (c *ACLBus) ProposeProtocol(ctx context.Context, proposer, peer, protocol string,
	capability map[string]any) (string, string) {

	// 惰性清扫过期提案与闲置会话
	c.mu.Lock()
	c.expireProposalsLocked()
	c.sweepConversationsLocked()
	conv := c.startConversationLocked(ACLProtocolNegotiation, proposer, peer)
	proposal := &ACLProposal{
		ID:         fmt.Sprintf("prop_%d_%06d", time.Now().UnixMilli(), aclConvSeq.Add(1)),
		From:       proposer,
		To:         peer,
		Protocol:   protocol,
		Capability: capability,
		State:      ACLProposalPending,
		ProposedAt: time.Now().UnixMilli(),
		ConvID:     conv.ID,
	}
	c.pendingProps[proposal.ID] = proposal
	c.mu.Unlock()

	msg := ACLMessage{
		Sender:         proposer,
		Receiver:       peer,
		Performative:   PerfPropose,
		Protocol:       ACLProtocolNegotiation,
		ConversationID: conv.ID,
		Content: map[string]any{
			"proposalId": proposal.ID,
			"protocol":   protocol,
			"capability": capability,
		},
	}
	c.Send(ctx, msg)
	return proposal.ID, conv.ID
}

// AnswerProposal 应答协议协商 (三步握手的第 2 步):
// accept=true → 发送 ACCEPT, 协议对 (responder→proposer) 落定;
// accept=false → 发送 REJECT, 提案关闭。
// 返回是否成功应答 (提案不存在/已终态返回 false)。
func (c *ACLBus) AnswerProposal(ctx context.Context, responder, proposalID string, accept bool) bool {
	c.mu.Lock()
	c.expireProposalsLocked()
	proposal, ok := c.pendingProps[proposalID]
	if !ok || proposal.State != ACLProposalPending || proposal.To != responder {
		c.mu.Unlock()
		return false
	}
	proposal.AnsweredAt = time.Now().UnixMilli()
	perf := PerfReject
	if accept {
		perf = PerfAccept
		proposal.State = ACLProposalAccepted
	} else {
		proposal.State = ACLProposalRejected
	}
	convID := proposal.ConvID
	// 终态提案移出 pending (留痕经 ACCEPT/REJECT 消息事件落库)
	delete(c.pendingProps, proposalID)
	c.mu.Unlock()

	msg := ACLMessage{
		Sender:         responder,
		Receiver:       proposal.From,
		Performative:   perf,
		Protocol:       ACLProtocolNegotiation,
		ConversationID: convID,
		InReplyTo:      proposalID,
		Content: map[string]any{
			"proposalId": proposalID,
			"protocol":   proposal.Protocol,
			"accepted":   accept,
		},
	}
	c.Send(ctx, msg)

	if accept {
		// 协议落定: 记忆双向 (from→to 与 to→from 都可查)
		c.mu.Lock()
		c.negotiated[proposal.From+"\x00"+proposal.To] = proposal.Protocol
		c.negotiated[proposal.To+"\x00"+proposal.From] = proposal.Protocol
		if conv, ok := c.conversations[convID]; ok {
			conv.Protocol = proposal.Protocol
			conv.State = ACLConvAgreed
		}
		c.mu.Unlock()
	}
	return true
}

// NegotiatedProtocol 查询 (from→to) 方向已协商落定的协议
func (c *ACLBus) NegotiatedProtocol(from, to string) (string, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	p, ok := c.negotiated[from+"\x00"+to]
	return p, ok
}

// expireProposalsLocked 过期未应答提案 → expired 并从 pending 移除 (须持写锁)
func (c *ACLBus) expireProposalsLocked() {
	now := time.Now().UnixMilli()
	for id, p := range c.pendingProps {
		if p.State == ACLProposalPending && now-p.ProposedAt > aclProposalTimeoutMs {
			p.State = ACLProposalExpired
			delete(c.pendingProps, id)
		}
	}
}

// Proposal 查询提案状态 (终态提案保留在 pendingProps 外? 否 — 终态即删,
// 故只查得到 pending; 终态信息经 ACCEPT/REJECT 消息事件落库留痕)
func (c *ACLBus) Proposal(proposalID string) (ACLProposal, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	p, ok := c.pendingProps[proposalID]
	if !ok {
		return ACLProposal{}, false
	}
	return *p, true
}

// ─── 会话/协商序列源 ─────────────────────────────────────────────

var aclConvSeq atomic.Uint64

// ─── 诊断 ────────────────────────────────────────────────────────

// ConversationsSummary 会话状态摘要 (诊断/管理端点用)
func (c *ACLBus) ConversationsSummary() map[string]int {
	c.mu.RLock()
	defer c.mu.RUnlock()
	out := map[string]int{"open": 0, "agreed": 0, "closed": 0}
	for _, conv := range c.conversations {
		out[conv.State]++
	}
	out["pendingProposals"] = len(c.pendingProps)
	out["negotiatedPairs"] = len(c.negotiated)
	return out
}
