// ─────────────────────────────────────────────────────────────────
// consumers_test.go — 批次 7 自测: 幂等键 / 重放去重 / 投影细则抽查 /
// IPC 帧计数 / 遥测聚合
// ─────────────────────────────────────────────────────────────────
package data

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"soloforge/next/internal/bus"
	"soloforge/next/internal/store"
)

// commitEvent 造一条 transaction.committed 总线事件
func commitEvent(st *store.Store, b *bus.EventBus, domain string, data map[string]any) bus.Event {
	payload, _ := json.Marshal(map[string]any{
		"txId": "tx_test_" + domain, "version": 42, "traceId": "tr1",
		"domain": domain, "data": data,
	})
	ev, _ := st.AppendEvent(context.Background(), EventTypeTransactionCommitted, "test", payload)
	return b.Publish(ev)
}

func TestProjectionIdempotency(t *testing.T) {
	p := NewProjections()
	rec := map[string]any{"k": "v"}
	if !p.InsertIdempotent(TableConsensusLedger, "seq:1", rec) {
		t.Fatal("首次插入应成功")
	}
	if p.InsertIdempotent(TableConsensusLedger, "seq:1", rec) {
		t.Fatal("同键重复插入应被拒")
	}
	// 不同表同键独立
	if !p.InsertIdempotent(TableSocialMemory, "seq:1", rec) {
		t.Fatal("不同表同键应允许")
	}
	if p.Count(TableConsensusLedger) != 1 {
		t.Fatalf("去重后应为 1 行, 实际 %d", p.Count(TableConsensusLedger))
	}
}

func TestIdempotencyEvictionWithTableTrim(t *testing.T) {
	p := NewProjections()
	for i := 0; i < maxTableRecords+50; i++ {
		p.InsertIdempotent(TableConsensusLedger, string(rune('a'+i%26))+string(rune('a'+i/26)), map[string]any{"i": i})
	}
	// 满员裁剪后行数封顶
	if got := p.Count(TableConsensusLedger); got != maxTableRecords {
		t.Fatalf("满员裁剪应封顶 %d, 实际 %d", maxTableRecords, got)
	}
	// 最旧的键被回收 → 同键可再插 (不误判重复)
	if !p.InsertIdempotent(TableConsensusLedger, string(rune('a'))+string(rune('a')), map[string]any{"i": -1}) {
		t.Fatal("被裁剪的旧键应允许重插")
	}
}

func TestConsumerIdempotentDispatch(t *testing.T) {
	st := store.New()
	b := bus.NewEventBus()
	p := NewProjections()
	cons := consumerConsensusAudit(p)

	ev := commitEvent(st, b, DomainConsensusEngine, map[string]any{"task": "run"})
	ctx := context.Background()
	_ = cons.Handle(ctx, ev)
	_ = cons.Handle(ctx, ev) // 重复分发 (重放场景)
	_ = cons.Handle(ctx, ev)

	if p.Count(TableConsensusLedger) != 1 {
		t.Fatalf("重复分发应幂等去重为 1 行, 实际 %d", p.Count(TableConsensusLedger))
	}
	rows := p.Table(TableConsensusLedger, 0)
	if rows[0]["transaction_id"] != "tx_test_ConsensusEngine" {
		t.Fatalf("投影字段错误: %v", rows[0]["transaction_id"])
	}
	if rows[0]["replicated_log_index"] != int64(42) && rows[0]["replicated_log_index"] != float64(42) {
		t.Fatalf("replicated_log_index 应=version: %v", rows[0]["replicated_log_index"])
	}
}

func TestRegistryReplayDoesNotDuplicate(t *testing.T) {
	st := store.New()
	b := bus.NewEventBus()
	p := NewProjections()

	// 预写 3 条事件 (存量)
	for i := 0; i < 3; i++ {
		commitEvent(st, b, DomainConsensusEngine, map[string]any{"n": i})
	}
	reg := NewRegistry(st, b, DefaultConsumers(p)...)
	reg.Start(context.Background())
	defer reg.Stop()

	// 重放后投影只落 3 行 (每事件 seq 唯一); 分发异步, 轮询等待
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if p.Count(TableConsensusLedger) >= 3 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if got := p.Count(TableConsensusLedger); got != 3 {
		t.Fatalf("重放应幂等落 3 行, 实际 %d", got)
	}

	// 新事件实时分发
	commitEvent(st, b, DomainConsensusEngine, map[string]any{"n": 99})
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if p.Count(TableConsensusLedger) >= 4 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if got := p.Count(TableConsensusLedger); got != 4 {
		t.Fatalf("实时事件应追加, 实际 %d", got)
	}
}

func TestTelemetryAggregationIPCAndEntropy(t *testing.T) {
	st := store.New()
	b := bus.NewEventBus()
	p := NewProjections()
	cons := consumerTelemetryAggregation(p)
	ctx := context.Background()

	// IPC 帧计数: snapshot.created + domain=DistributedBroker
	snapPayload, _ := json.Marshal(map[string]any{"domain": "DistributedBroker", "frameId": "f1"})
	snapEv, _ := st.AppendEvent(context.Background(), eventSnapshotCreated, "kernel", snapPayload)
	_ = cons.Handle(ctx, b.Publish(snapEv))
	// 非 DistributedBroker 的快照不计数
	otherPayload, _ := json.Marshal(map[string]any{"domain": "Other"})
	otherEv, _ := st.AppendEvent(context.Background(), eventSnapshotCreated, "kernel", otherPayload)
	_ = cons.Handle(ctx, b.Publish(otherEv))

	metrics, _ := p.Metrics()
	if metrics[MetricIPCFramesSent] != 1 {
		t.Fatalf("IPC 帧计数应为 1, 实际 %d", metrics[MetricIPCFramesSent])
	}

	// 熵启发式: metric_score 分支 (|1-0.7|*0.3=0.09)
	ev1 := commitEvent(st, b, DomainConsensAgentCourt, map[string]any{"status_seal": "ok", "metric_score": 0.7})
	_ = cons.Handle(ctx, ev1)
	_, entropy := p.Metrics()
	if entropy < 0.089 || entropy > 0.091 {
		t.Fatalf("熵代理值应 ≈0.09, 实际 %v", entropy)
	}

	// 迁移域 → relocated_bytes → 0.75
	ev2 := commitEvent(st, b, DomainSandboxMigration, map[string]any{"relocated_bytes": 1024})
	_ = cons.Handle(ctx, ev2)
	_, entropy = p.Metrics()
	if entropy != 0.75 {
		t.Fatalf("迁移熵应 0.75, 实际 %v", entropy)
	}

	// 域路由计数
	e1 := commitEvent(st, b, DomainSocialReputation, nil)
	e2 := commitEvent(st, b, DomainSocialReputation, nil)
	e3 := commitEvent(st, b, DomainConsensAgentCourt, map[string]any{"status_seal": SealEscapeToLLM})
	e4 := commitEvent(st, b, DomainSandboxMigration, nil)
	for _, ev := range []bus.Event{e1, e2, e3, e4} {
		_ = cons.Handle(ctx, ev)
	}
	metrics, _ = p.Metrics()
	if metrics[MetricReputationSuccess] != 2 {
		t.Fatalf("信誉计数应为 2: %v", metrics)
	}
	if metrics[MetricCourtEscalations] != 1 {
		t.Fatalf("升级计数应为 1: %v", metrics)
	}
	if metrics[MetricSandboxMigrations] != 2 {
		t.Fatalf("迁移计数应为 2 (relocated_bytes 事件 + nil 数据事件): %v", metrics)
	}
}

func TestCourtAndGovernanceProjections(t *testing.T) {
	st := store.New()
	b := bus.NewEventBus()
	p := NewProjections()
	reg := NewRegistry(st, b, DefaultConsumers(p)...)
	reg.Start(context.Background())
	defer reg.Stop()

	// 一级仲裁庭
	commitEvent(st, b, DomainConsensAgentCourt, map[string]any{
		"verdict_id": "v1", "status_seal": "CONSENSUS_REACHED",
		"winner_signature": "agent-x", "metric_score": 0.9,
	})
	// 治理评估
	commitEvent(st, b, DomainGovernancePolicy, map[string]any{
		"assessment_id": "a1", "target_node": "agent_cluster_alpha",
		"calculated_efficiency": 0.945, "violation_tps_count": 0,
		"status_seal": "PASS", "current_tick_stamp": 100,
	})

	// 分发为异步 pump, 轮询等待投影落行
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if p.Count(TablePrimaryCourtVerdict) >= 1 && p.Count(TableGovernanceAssessment) >= 1 && p.Count(TableEventLog) >= 2 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	rows := p.Table(TablePrimaryCourtVerdict, 0)
	if len(rows) != 1 || rows[0]["winning_agent"] != "agent-x" {
		t.Fatalf("仲裁庭投影错误: %v", rows)
	}
	rows = p.Table(TableGovernanceAssessment, 0)
	if len(rows) != 1 || rows[0]["efficiency_index"] != float64(0.945) {
		t.Fatalf("治理评估投影错误: %v", rows)
	}
	// 事件审计链路: 全量 committed 均落 event_log
	if got := p.Count(TableEventLog); got < 2 {
		t.Fatalf("event_log 应至少 2 行, 实际 %d", got)
	}
}
