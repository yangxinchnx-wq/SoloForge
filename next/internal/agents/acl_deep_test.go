// ─────────────────────────────────────────────────────────────────
// acl_deep_test.go — 批次 4 通信协议深度自测
//
// 覆盖: 消息优先级队列 (Poll 排序)、会话上下文管理 (归属/回溯/待决请求/
// 关闭)、ReplyTo 线程回溯、协议协商三步握手 (接受/拒绝/过期)。
// ─────────────────────────────────────────────────────────────────
package agents

import (
	"context"
	"testing"
	"time"
)

func TestACLPriorityQueue(t *testing.T) {
	c := NewACLBus(nil, nil)
	ctx := context.Background()
	c.Register("a")

	// 依次发送 普通 → 紧急 → 低 → 普通
	c.SendWithPriority(ctx, ACLMessage{Sender: "x", Receiver: "a", Performative: PerfInform, Content: "n1"}, PrioNormal)
	c.SendWithPriority(ctx, ACLMessage{Sender: "x", Receiver: "a", Performative: PerfRequest, Content: "u1"}, PrioUrgent)
	c.SendWithPriority(ctx, ACLMessage{Sender: "x", Receiver: "a", Performative: PerfInform, Content: "l1"}, PrioLow)
	c.SendWithPriority(ctx, ACLMessage{Sender: "x", Receiver: "a", Performative: PerfInform, Content: "n2"}, PrioNormal)

	msgs := c.Poll("a")
	if len(msgs) != 4 {
		t.Fatalf("应收到 4 条, 实际 %d", len(msgs))
	}
	// 优先级降序: urgent → n1 → n2 → low (同级 FIFO)
	order := []any{"u1", "n1", "n2", "l1"}
	for i, m := range msgs {
		if m.Content != order[i] {
			t.Fatalf("顺序错误 idx=%d: got %v want %v", i, m.Content, order[i])
		}
	}
}

func TestACLConversationTracking(t *testing.T) {
	c := NewACLBus(nil, nil)
	ctx := context.Background()

	// 发起带 ConversationID 的消息 → 就地建会话
	first := c.Send(ctx, ACLMessage{
		Sender: "a", Receiver: "b", Performative: PerfRequest,
		Content: "do-task", ConversationID: "conv-manual-1", Protocol: "task-exec",
	})
	conv, ok := c.Conversation("conv-manual-1")
	if !ok {
		t.Fatal("会话应被创建")
	}
	if conv.State != ACLConvOpen || conv.PendingRequest != first.MessageID {
		t.Fatalf("REQUEST 应登记待决请求: %+v", conv)
	}

	// ReplyTo 回复: 自动带 ConversationID + InReplyTo; ACCEPT 结算待决请求
	reply := c.ReplyTo(ctx, first, "b", PerfAccept, "ok")
	if reply.ConversationID != "conv-manual-1" || reply.InReplyTo != first.MessageID {
		t.Fatalf("ReplyTo 应回溯会话: %+v", reply)
	}
	conv, _ = c.Conversation("conv-manual-1")
	if conv.State != ACLConvAgreed {
		t.Fatalf("ACCEPT 后会话应 agreed, 实际 %s", conv.State)
	}
	if conv.PendingRequest != "" {
		t.Fatalf("ACCEPT 后待决请求应清空")
	}

	// REJECT 关闭会话
	rej := c.ReplyTo(ctx, first, "b", PerfReject, "no")
	conv, _ = c.Conversation("conv-manual-1")
	if conv.State != ACLConvClosed && rej.MessageID != "" {
		t.Fatalf("REJECT 后会话应 closed, 实际 %s", conv.State)
	}

	// InReplyTo 回溯不到 (原消息无会话) → 不记账
	c.Send(ctx, ACLMessage{Sender: "a", Receiver: "b", Performative: PerfInform, Content: "no-conv"})
	orphan := c.Poll("b")
	if len(orphan) == 0 {
		t.Fatal("无会话消息应正常入 inbox")
	}
}

func TestACLProtocolNegotiationAccept(t *testing.T) {
	c := NewACLBus(nil, nil)
	ctx := context.Background()

	// 第 1 步: PROPOSE (能力声明)
	propID, convID := c.ProposeProtocol(ctx, "a", "b", "task-exec-v2",
		map[string]any{"tools": []string{"read_file", "execute_cmd"}})
	if propID == "" || convID == "" {
		t.Fatal("应返回提案 ID 与会话 ID")
	}
	prop, ok := c.Proposal(propID)
	if !ok || prop.State != ACLProposalPending {
		t.Fatalf("提案应为 pending: %+v", prop)
	}
	// b 的 inbox 应有 PROPOSE 消息
	bMsgs := c.Poll("b")
	if len(bMsgs) != 1 || bMsgs[0].Performative != PerfPropose {
		t.Fatalf("b 应收到 1 条 PROPOSE: %+v", bMsgs)
	}

	// 第 2 步: ACCEPT
	if !c.AnswerProposal(ctx, "b", propID, true) {
		t.Fatal("应答应成功")
	}
	// 协议落定 (双向可查)
	if p, ok := c.NegotiatedProtocol("a", "b"); !ok || p != "task-exec-v2" {
		t.Fatalf("a→b 协议应落定 task-exec-v2, 实际 %q %v", p, ok)
	}
	if p, ok := c.NegotiatedProtocol("b", "a"); !ok || p != "task-exec-v2" {
		t.Fatalf("b→a 协议应同样落定")
	}
	// 会话转 agreed + 协议更新
	conv, _ := c.Conversation(convID)
	if conv.State != ACLConvAgreed || conv.Protocol != "task-exec-v2" {
		t.Fatalf("握手会话应 agreed: %+v", conv)
	}
	// 提案已终态移除
	if _, ok := c.Proposal(propID); ok {
		t.Fatalf("终态提案应从 pending 移除")
	}
	// a 应收到 ACCEPT
	aMsgs := c.Poll("a")
	if len(aMsgs) != 1 || aMsgs[0].Performative != PerfAccept {
		t.Fatalf("a 应收到 ACCEPT: %+v", aMsgs)
	}
}

func TestACLProtocolNegotiationRejectAndExpire(t *testing.T) {
	c := NewACLBus(nil, nil)
	ctx := context.Background()

	// 拒绝路径
	propID, _ := c.ProposeProtocol(ctx, "a", "b", "proto-x", nil)
	c.Poll("b") // 取走 PROPOSE
	if !c.AnswerProposal(ctx, "b", propID, false) {
		t.Fatal("拒绝应答应成功")
	}
	if _, ok := c.NegotiatedProtocol("a", "b"); ok {
		t.Fatal("拒绝后不应落定协议")
	}
	// 非应答方无权应答
	propID2, _ := c.ProposeProtocol(ctx, "a", "b", "proto-y", nil)
	if c.AnswerProposal(ctx, "evil", propID2, true) {
		t.Fatal("非应答方不应能应答")
	}

	// 过期路径: 直接拨快 ProposedAt
	propID3, _ := c.ProposeProtocol(ctx, "a", "b", "proto-z", nil)
	c.mu.Lock()
	c.pendingProps[propID3].ProposedAt = time.Now().UnixMilli() - aclProposalTimeoutMs - 1000
	c.mu.Unlock()
	if c.AnswerProposal(ctx, "b", propID3, true) {
		t.Fatal("过期提案不应能应答")
	}
	if p, _ := c.Proposal(propID3); p.State != "" {
		// expireProposalsLocked 已从 pending 移除
		t.Fatalf("过期提案应被移除, 实际 %+v", p)
	}
}

func TestACLConversationIdleSweep(t *testing.T) {
	c := NewACLBus(nil, nil)
	ctx := context.Background()
	c.Send(ctx, ACLMessage{Sender: "a", Receiver: "b", Performative: PerfInform,
		Content: "hi", ConversationID: "conv-idle-1"})
	c.Poll("b")

	// 拨快会话活跃时间为闲置超时的 3 倍
	c.mu.Lock()
	c.conversations["conv-idle-1"].LastActiveAt = time.Now().UnixMilli() - 3*aclConvIdleCloseMs
	removed := c.sweepConversationsLocked()
	c.mu.Unlock()
	if removed != 1 {
		t.Fatalf("应清扫 1 个闲置会话, 实际 %d", removed)
	}
	if _, ok := c.Conversation("conv-idle-1"); ok {
		t.Fatal("闲置会话应被移除")
	}
}

func TestACLNegotiationSummary(t *testing.T) {
	c := NewACLBus(nil, nil)
	ctx := context.Background()
	c.ProposeProtocol(ctx, "a", "b", "p1", nil)
	s := c.ConversationsSummary()
	if s["pendingProposals"] != 1 {
		t.Fatalf("摘要应含 1 个 pending 提案: %+v", s)
	}
}
