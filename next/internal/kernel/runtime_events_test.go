// ─────────────────────────────────────────────────────────────────
// runtime_events_test.go — 批次 8 自测: 事件目录完整性 + traceId 载荷增强
// ─────────────────────────────────────────────────────────────────
package kernel

import (
	"testing"
)

// TestEventCatalog 对齐 TS 三枚举的关键事件名抽查
func TestEventCatalog(t *testing.T) {
	// RuntimeEvent (TS runtime-events.ts)
	checks := map[string]string{
		EventHeartbeat:                    "sys.heartbeat",
		EventSysTick:                      "sys.tick",
		EventSnapshotCreated:              "snapshot.created",
		EventReputationIncrementRequested: "governor.reputation.increment.requested",
		EventAgentReputationUpdated:       "agent.reputation.updated",
		EventTransactionCommitted:         "transaction.committed",
	}
	for got, want := range checks {
		if got != want {
			t.Fatalf("事件名偏离 TS: got=%q want=%q", got, want)
		}
	}
	// CourtEvent (TS court-events.ts)
	if EventCourtDeadlockDetected != "court:deadlock_detected" {
		t.Fatalf("court 事件名偏离: %q", EventCourtDeadlockDetected)
	}
	// DecisionEvent (TS decision-events.ts)
	if EventDecisionMARLPolicyInjected != "decision:marl_policy_injected" {
		t.Fatalf("decision 事件名偏离: %q", EventDecisionMARLPolicyInjected)
	}
}

func TestEmitTraceContext(t *testing.T) {
	// 兜底注入: timestamp + traceId
	p := EmitTraceContext(nil, "tr-1")
	if p["traceId"] != "tr-1" {
		t.Fatalf("应注入 traceId: %v", p)
	}
	if _, has := p["timestamp"]; !has {
		t.Fatal("应注入 timestamp 兜底")
	}
	// 调用方已设置的值不覆盖
	p2 := EmitTraceContext(map[string]any{"traceId": "mine"}, "other")
	if p2["traceId"] != "mine" {
		t.Fatalf("已设置 traceId 不应被覆盖: %v", p2)
	}
}
