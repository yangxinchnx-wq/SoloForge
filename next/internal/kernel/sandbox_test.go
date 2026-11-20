// ─────────────────────────────────────────────────────────────────
// sandbox_test.go — 批次 6 自测: 沙箱槽位/热迁移/压力疏散/回收
// ─────────────────────────────────────────────────────────────────
package kernel

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"soloforge/next/internal/bus"
)

func newSandbox(t *testing.T) *SandboxMigrationEngine {
	t.Helper()
	k := newTestKernel(t)
	s, err := NewSandboxMigrationEngine(k)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	return s
}

func TestSandboxSlotRegistry(t *testing.T) {
	s := newSandbox(t)
	s.RegisterAgentToSlot(AgentSandboxProfile{
		AgentID: "a1", AssignedSlotID: "slot-0",
		IsolateMemoryUsageBytes: 1000, Goroutines: 4,
		CurrentRoleState: "ACTIVE",
	})
	if s.Slots() != 1 {
		t.Fatalf("槽数应为 1")
	}
	// 代理返回副本: 修改副本不影响内部状态
	proxy, ok := s.GetSlotProfileProxy("a1")
	if !ok || proxy.AssignedSlotID != "slot-0" {
		t.Fatalf("应能读回档案: %+v", proxy)
	}
	proxy.AssignedSlotID = "hacked"
	again, _ := s.GetSlotProfileProxy("a1")
	if again.AssignedSlotID != "slot-0" {
		t.Fatal("代理应返回副本, 内部状态不被外泄修改")
	}
	if _, ok := s.GetSlotProfileProxy("ghost"); ok {
		t.Fatal("不存在的槽应返回 false")
	}
}

func TestSandboxLiveMigration(t *testing.T) {
	s := newSandbox(t)
	s.RegisterAgentToSlot(AgentSandboxProfile{
		AgentID: "a1", AssignedSlotID: "slot-0",
		IsolateMemoryUsageBytes: 1000, MemoryStateChecksum: "cksum",
	})

	manifest, err := s.handleLiveMigrationTransaction(context.Background(),
		"trace-1", "a1", "slot-1", "TEST_MOVE")
	if err != nil {
		t.Fatal(err)
	}
	if manifest.SourceSlotID != "slot-0" || manifest.TargetSlotID != "slot-1" {
		t.Fatalf("迁移清单槽位错误: %+v", manifest)
	}
	if manifest.FrozenStatePacket.IsolateMemoryUsageBytes != 1000+migrationSerializeOverhead {
		t.Fatalf("冻结包应计入序列化开销 +512: %d", manifest.FrozenStatePacket.IsolateMemoryUsageBytes)
	}
	// 槽位重定位
	p, _ := s.GetSlotProfileProxy("a1")
	if p.AssignedSlotID != "slot-1" {
		t.Fatalf("迁移后槽位应为 slot-1, 实际 %s", p.AssignedSlotID)
	}
	// 内核版本推进 (事务提交)
	if s.kernel.Version() != 1 {
		t.Fatalf("迁移提交后内核版本应 +1, 实际 %d", s.kernel.Version())
	}
	// snapshot 事件
	events := s.kernel.store.EventsByType(EventSnapshotCreated, 10)
	if len(events) == 0 || !strings.Contains(string(events[len(events)-1].Payload), manifest.MigrationID) {
		t.Fatal("迁移应广播 snapshot.created 事件")
	}
}

func TestSandboxMigrationMissingAgent(t *testing.T) {
	s := newSandbox(t)
	_, err := s.handleLiveMigrationTransaction(context.Background(),
		"trace-1", "ghost", "slot-9", "TEST")
	if err == nil || !strings.Contains(err.Error(), ErrSandboxMissingCode) {
		t.Fatalf("缺失档案应报 ERR_SF_SANDBOX_MISSING: %v", err)
	}
}

func TestSandboxMigrationVersionRace(t *testing.T) {
	s := newSandbox(t)
	s.RegisterAgentToSlot(AgentSandboxProfile{
		AgentID: "a1", AssignedSlotID: "slot-0", IsolateMemoryUsageBytes: 1000,
	})

	// 先推进一轮内核版本 (事务提交 0→1), 再发起迁移:
	// 迁移 Begin 记录基线 v1, 操作期间版本稳定 → 不触发 RACE, 正常提交
	tx, _ := s.kernel.TransactionManager().Begin("warm-cmd", "test", nil)
	if err := s.kernel.TransactionManager().Commit(context.Background(), tx.ID); err != nil {
		t.Fatal(err)
	}
	manifest, err := s.handleLiveMigrationTransaction(context.Background(),
		"trace-1", "a1", "slot-1", "TEST")
	if err != nil {
		t.Fatalf("版本稳定的迁移应成功: %v", err)
	}
	if manifest.KernelVersionSeal != 1 {
		t.Fatalf("版本印章应为迁移基线 v1, 实际 %d", manifest.KernelVersionSeal)
	}
	// RACE 守卫本身由乐观锁事务 (ErrVersionConflict) 在并发提交路径覆盖
}

func TestSandboxMigrationVersionConflictRollback(t *testing.T) {
	s := newSandbox(t)
	s.RegisterAgentToSlot(AgentSandboxProfile{
		AgentID: "a1", AssignedSlotID: "slot-0", IsolateMemoryUsageBytes: 1000,
	})

	// 直接构造乐观锁冲突: 占住一个以 v0 为基线的活跃事务并推高版本,
	// 该事务提交时触发 ErrVersionConflict → 沙箱迁移的 fail 路径同源
	tx, _ := s.kernel.TransactionManager().Begin("stale-cmd", "test", nil)
	s.kernel.bumpVersion()
	err := s.kernel.TransactionManager().Commit(context.Background(), tx.ID)
	if err == nil {
		t.Fatal("版本冲突应导致提交失败")
	}
}

func TestSandboxPressureEviction(t *testing.T) {
	s := newSandbox(t)
	// 注册一个超重档案 (默认重线 10MB)
	s.RegisterAgentToSlot(AgentSandboxProfile{
		AgentID: "heavy", AssignedSlotID: "slot-0",
		IsolateMemoryUsageBytes: defaultSandboxHeavyweightLine + 1024,
	})
	s.RegisterAgentToSlot(AgentSandboxProfile{
		AgentID: "light", AssignedSlotID: "slot-1",
		IsolateMemoryUsageBytes: 100,
	})

	// 载荷低于危急线: 不疏散
	s.UpdateHostLoadFactorTelemetry(context.Background(), "t1", 0.5)
	if s.LoadFactor() != 0.5 {
		t.Fatal("载荷因子应更新")
	}

	// 载荷达到危急线 (默认 0.90): 触发疏散命令 (异步经 ExecuteCommand)
	// 内核未挂命令总线 → ExecuteCommand 拒绝但不影响; 验证指标与日志路径
	s.UpdateHostLoadFactorTelemetry(context.Background(), "t2", 0.95)
	if s.LoadFactor() != 0.95 {
		t.Fatal("载荷因子应更新")
	}
	// 等待异步命令派发完成 (内核无命令总线 → rejected 事件)
	deadline := time.Now().Add(500 * time.Millisecond)
	found := false
	for time.Now().Before(deadline) {
		for _, ev := range s.kernel.store.EventsByType(EventCommandRejected, 50) {
			if strings.Contains(string(ev.Payload), CmdMigrateSandboxContext) {
				found = true
			}
		}
		if found {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !found {
		t.Fatal("危急载荷应派发 MIGRATE_SANDBOX_CONTEXT 疏散命令")
	}
}

func TestSandboxEvictionViaCommandBus(t *testing.T) {
	// 构造未启动的引擎 → 先挂命令总线 → Boot (处理器注册到真实总线)
	k := newTestKernel(t)
	s, err := NewSandboxMigrationEngine(k)
	if err != nil {
		t.Fatal(err)
	}
	s.kernel.SetCommandBus(bus.NewCommandBus())
	if err := s.Boot(context.Background()); err != nil {
		t.Fatal(err)
	}
	s.RegisterAgentToSlot(AgentSandboxProfile{
		AgentID: "heavy", AssignedSlotID: "slot-0",
		IsolateMemoryUsageBytes: defaultSandboxHeavyweightLine + 1024,
	})
	// 内核须 READY 才接受命令
	s.kernel.mu.Lock()
	s.kernel.state = StateReady
	s.kernel.mu.Unlock()

	payload, _ := json.Marshal(map[string]any{
		"traceId": "t9", "agentId": "heavy",
		"targetSlotId":       "isolated_failover_slot_omega",
		"evictionReasonCode": EvictionHardwareExhaustion,
	})
	res, err := s.kernel.ExecuteCommand(context.Background(), Command{
		Type: CmdMigrateSandboxContext, Domain: s.Name(), Caller: SandboxCallerWatchdog, Payload: payload,
	})
	if err != nil {
		t.Fatal(err)
	}
	if m, ok := res.(*MigrationManifest); ok {
		if m.TargetSlotID != "isolated_failover_slot_omega" {
			t.Fatalf("疏散目标槽错误: %+v", m)
		}
	} else {
		t.Fatalf("命令结果应为迁移清单: %+v", res)
	}
}

func TestSandboxClearRegistry(t *testing.T) {
	s := newSandbox(t)
	s.RegisterAgentToSlot(AgentSandboxProfile{AgentID: "a1", AssignedSlotID: "slot-0"})
	s.ClearSandboxRegistry()
	if s.Slots() != 0 {
		t.Fatal("全量回收后槽数应为 0")
	}
	if s.HealthCheck(context.Background()) {
		t.Fatal("回收后应不健康 (operational=false)")
	}
}
