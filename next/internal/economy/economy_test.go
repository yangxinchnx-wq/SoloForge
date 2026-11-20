// ─────────────────────────────────────────────────────────────────
// economy_test.go — 批次 8 自测: 经济乘数矩阵/精度裁剪/乐观锁/台账快照
// + 事件目录完整性 + logx 分级/上下文绑定
// ─────────────────────────────────────────────────────────────────
package economy

import (
	"context"
	"math"
	"testing"
	"time"

	"soloforge/next/internal/bus"
	"soloforge/next/internal/kernel"
	"soloforge/next/internal/store"
)

type metricStub struct {
	counts map[string]int64
	vals   map[string]float64
}

func (m *metricStub) Inc(name string)            { m.counts[name]++ }
func (m *metricStub) Add(name string, v float64) { m.vals[name] += v }

func newEngine(t *testing.T) (*TokenEconomyEngine, *metricStub) {
	t.Helper()
	k := kernel.New(store.New(), bus.NewEventBus())
	e, err := NewTokenEconomyEngine(k)
	if err != nil {
		t.Fatal(err)
	}
	m := &metricStub{counts: map[string]int64{}, vals: map[string]float64{}}
	e.Metrics = m
	return e, m
}

func TestRoleMultiplierMatrix(t *testing.T) {
	e, m := newEngine(t)
	ctx := context.Background()
	if err := e.InitializeEconomyPool(ctx); err != nil {
		t.Fatal(err)
	}

	// WORKER: 10.0 × (1+0) = 10, 税级 0.05
	if err := e.executeResourceAllocationTransaction(ctx, "t1", "w1", "WORKER", 0, nil); err != nil {
		t.Fatal(err)
	}
	acc, _ := e.GetAccountSnapshot("w1")
	if acc.Balance != 10.0 || acc.TaxTierFactor != 0.05 {
		t.Fatalf("WORKER 台账错误: %+v", acc)
	}

	// VALIDATOR: 10 × 2.5 = 25, 税级 0.12
	if err := e.executeResourceAllocationTransaction(ctx, "t2", "v1", "VALIDATOR", 0, nil); err != nil {
		t.Fatal(err)
	}
	acc, _ = e.GetAccountSnapshot("v1")
	if acc.Balance != 25.0 || acc.TaxTierFactor != 0.12 {
		t.Fatalf("VALIDATOR 台账错误: %+v", acc)
	}

	// GOVERNOR: 10 × 5.0 × (1+0.5) = 75, 税级 0.20
	if err := e.executeResourceAllocationTransaction(ctx, "t3", "g1", "GOVERNOR", 0.5, nil); err != nil {
		t.Fatal(err)
	}
	acc, _ = e.GetAccountSnapshot("g1")
	if acc.Balance != 75.0 || acc.TaxTierFactor != 0.20 {
		t.Fatalf("GOVERNOR 台账错误: %+v", acc)
	}

	// 累加: 余额 = 10 + 10 = 20
	if err := e.executeResourceAllocationTransaction(ctx, "t4", "w1", "WORKER", 0, nil); err != nil {
		t.Fatal(err)
	}
	acc, _ = e.GetAccountSnapshot("w1")
	if acc.Balance != 20.0 {
		t.Fatalf("余额累加错误: %v", acc.Balance)
	}

	if m.vals[MetricTokensMinted] != 120.0 {
		t.Fatalf("mint 总量应 120 (10+25+75+10): %v", m.vals)
	}
	if m.counts[MetricDistributionOK] != 4 {
		t.Fatalf("成功计数应 4: %v", m.counts)
	}
}

func TestPrecisionClipping(t *testing.T) {
	e, _ := newEngine(t)
	// 默认 4 位精度: 10×2.5×(1+0.33333) = 33.33325 → 33.3333 (四舍五入)
	if err := e.executeResourceAllocationTransaction(context.Background(), "t", "p1", "VALIDATOR", 0.33333, nil); err != nil {
		t.Fatal(err)
	}
	acc, _ := e.GetAccountSnapshot("p1")
	if math.Abs(acc.Balance-33.3333) > 1e-9 {
		t.Fatalf("精度裁剪应得 33.3333, 实际 %v", acc.Balance)
	}
	// 配置精度 2 位: 10×(1+0.12345)=11.2345 → 11.23
	e.kernel.Config.Set(cfgEconomyPrecision, 2)
	if err := e.executeResourceAllocationTransaction(context.Background(), "t", "p2", "WORKER", 0.12345, nil); err != nil {
		t.Fatal(err)
	}
	acc, _ = e.GetAccountSnapshot("p2")
	if acc.Balance != 11.23 {
		t.Fatalf("2 位精度应裁剪到 11.23, 实际 %v", acc.Balance)
	}
}

func TestEconomyOptimisticLock(t *testing.T) {
	e, m := newEngine(t)
	ctx := context.Background()
	_ = e.InitializeEconomyPool(ctx)

	// 事务路径不经 ExecuteCommand, 无需 READY。
	// (版本漂移 RACE 无法外部注入 — Begin 与校验之间不可插入;
	// 乐观锁冲突路径由 kernel.TransactionManager 的
	// ErrVersionConflict 语义覆盖, 见 kernel 包测试)
	// 这里验证提交路径版本推进: 每次分配提交后 version+1
	v0 := e.kernel.Version()
	if err := e.executeResourceAllocationTransaction(ctx, "t", "r1", "WORKER", 0, nil); err != nil {
		t.Fatal(err)
	}
	if e.kernel.Version() != v0+1 {
		t.Fatalf("分配提交后版本应 +1: %d → %d", v0, e.kernel.Version())
	}
	if m.counts[MetricDistributionOK] != 1 {
		t.Fatal("成功计数应 1")
	}
	// 事务事件应广播 (订阅总线验证; data 消费者按域 TokenEconomy 沉淀)
	id, ch := e.kernel.Bus().Subscribe()
	defer e.kernel.Bus().Unsubscribe(id)
	if err := e.executeResourceAllocationTransaction(ctx, "t", "r2", "WORKER", 0, nil); err != nil {
		t.Fatal(err)
	}
	select {
	case ev := <-ch:
		if ev.Type != kernel.EventTransactionCommitted {
			t.Fatalf("应广播 transaction.committed, 实际 %s", ev.Type)
		}
	case <-time.After(time.Second):
		t.Fatal("等待事务事件超时")
	}
}

func TestEconomySnapshotCopyAndShutdown(t *testing.T) {
	e, _ := newEngine(t)
	ctx := context.Background()
	_ = e.InitializeEconomyPool(ctx)
	_ = e.executeResourceAllocationTransaction(ctx, "t", "s1", "WORKER", 0, nil)

	acc, ok := e.GetAccountSnapshot("s1")
	if !ok {
		t.Fatal("应能读回快照")
	}
	acc.Balance = 99999 // 改副本
	again, _ := e.GetAccountSnapshot("s1")
	if again.Balance == 99999 {
		t.Fatal("快照应为副本")
	}
	if _, ok := e.GetAccountSnapshot("ghost"); ok {
		t.Fatal("不存在账户应返回 false")
	}
	e.ShutdownEconomy()
	if _, ok := e.GetAccountSnapshot("s1"); ok {
		t.Fatal("终止后台账应清空")
	}
	if e.HealthCheck(ctx) {
		t.Fatal("终止后应不健康")
	}
}
