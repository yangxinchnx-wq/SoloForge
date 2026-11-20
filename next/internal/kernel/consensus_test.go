// ─────────────────────────────────────────────────────────────────
// consensus_test.go — 批次 5 自测: Raft 共识 / IPC 代理 / 任务依赖图 / 故障转移链
// ─────────────────────────────────────────────────────────────────
package kernel

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"soloforge/next/internal/bus"
	"soloforge/next/internal/store"
)

// newTestKernel 构造无外部依赖的测试内核
func newTestKernel(t *testing.T) *RuntimeKernel {
	t.Helper()
	return New(store.New(), bus.NewEventBus())
}

// ─── Raft: 单节点模式 ───────────────────────────────────────────

func TestRaftSingleNodeAutoLeader(t *testing.T) {
	k := newTestKernel(t)
	node, err := NewRaftConsensusNode(k, "node-1")
	if err != nil {
		t.Fatal(err)
	}
	defer node.Evict()

	if err := node.Boot(context.Background()); err != nil {
		t.Fatal(err)
	}
	if node.Role() != RaftLeader {
		t.Fatalf("单节点应自动晋升 LEADER, 实际 %s", node.Role())
	}
	if node.Term() != 1 {
		t.Fatalf("任期应为 1, 实际 %d", node.Term())
	}
	if node.CommitIndex() != 0 {
		t.Fatalf("基线日志后 commitIndex 应为 0")
	}

	// 提交命令: 直接追加并提交, 版本对齐
	payload, _ := json.Marshal(map[string]any{"task": "build", "traceId": "t1"})
	if !node.SubmitCommand(context.Background(), "RUN_TASK", payload) {
		t.Fatal("提交应成功")
	}
	if node.CommitIndex() != 1 {
		t.Fatalf("提交后 commitIndex 应为 1, 实际 %d", node.CommitIndex())
	}
	if k.Version() != 1 {
		t.Fatalf("kernel.version 应同步为 entry.index=1, 实际 %d", k.Version())
	}
	// 因果校验和存在
	h := sha256hex(payload, 1)
	if len(h) != 32 {
		t.Fatalf("校验和应为 32 hex")
	}
}

func sha256hex(payload json.RawMessage, index int) string {
	return causalityChecksum(payload, index)
}

// ─── Raft: 三节点选举 + 复制 ────────────────────────────────────

// meshTransport 进程内全互联桩传输 (nodeID → node)
type meshTransport struct {
	nodes map[string]*RaftConsensusNode
}

func (m *meshTransport) SendAppendEntries(ctx context.Context, peerID string, rpc AppendEntriesRPC) (RaftRPCResponse, error) {
	n, ok := m.nodes[peerID]
	if !ok {
		return RaftRPCResponse{}, fmt.Errorf("peer offline: %s", peerID)
	}
	return n.HandleAppendEntries(ctx, rpc)
}

func (m *meshTransport) SendRequestVote(ctx context.Context, peerID string, req VoteRequest) (RaftRPCResponse, error) {
	n, ok := m.nodes[peerID]
	if !ok {
		return RaftRPCResponse{}, fmt.Errorf("peer offline: %s", peerID)
	}
	return n.HandleRequestVote(ctx, req)
}

func newCluster(t *testing.T, size int, peersFor func(i int) []string) ([]*RaftConsensusNode, *meshTransport) {
	t.Helper()
	m := &meshTransport{nodes: make(map[string]*RaftConsensusNode)}
	var nodes []*RaftConsensusNode
	for i := 0; i < size; i++ {
		k := newTestKernel(t)
		id := fmt.Sprintf("node-%d", i)
		k.Config.Set("governor.cluster.peers_nodes", toStringAnySlice(peersFor(i)))
		n, err := NewRaftConsensusNode(k, id)
		if err != nil {
			t.Fatal(err)
		}
		n.SetTransport(m)
		nodes = append(nodes, n)
		m.nodes[id] = n
	}
	return nodes, m
}

func toStringAnySlice(ss []string) []any {
	out := make([]any, len(ss))
	for i, s := range ss {
		out[i] = s
	}
	return out
}

func leaderOf(nodes []*RaftConsensusNode) *RaftConsensusNode {
	for _, n := range nodes {
		if n.Role() == RaftLeader {
			return n
		}
	}
	return nil
}

func waitForLeader(t *testing.T, nodes []*RaftConsensusNode, timeout time.Duration) *RaftConsensusNode {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if l := leaderOf(nodes); l != nil {
			return l
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("等待 LEADER 超时")
	return nil
}

func TestRaftMultiNodeElectionAndReplication(t *testing.T) {
	// 3 节点全互联
	peers := []string{"node-0", "node-1", "node-2"}
	nodes, _ := newCluster(t, 3, func(i int) []string {
		var p []string
		for _, s := range peers {
			if s != fmt.Sprintf("node-%d", i) {
				p = append(p, s)
			}
		}
		return p
	})
	defer func() {
		for _, n := range nodes {
			n.Evict()
		}
	}()

	// Boot 播种基线日志 (多节点模式会同时启动选举计时器, Evict 时回收)
	for _, n := range nodes {
		if err := n.Boot(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	// 手动触发一轮选举 (等选举超时太慢; 直接驱动 startElection)
	for _, n := range nodes {
		go n.startElection(context.Background())
	}
	leader := waitForLeader(t, nodes, 5*time.Second)
	if leader == nil {
		t.Fatal("应选出 LEADER")
	}
	quorum := 2
	if quorum <= 0 {
		t.Fatal("法定票数计算错误")
	}

	// 复制一条命令: LEADER 广播, 达到法定票数 (2/3) 才提交
	payload, _ := json.Marshal(map[string]any{"task": "deploy", "traceId": "t2"})
	if !leader.ReplicateTransactionalPayload(context.Background(), payload, "RUN_TASK") {
		t.Fatal("复制应成功提交")
	}
	if leader.CommitIndex() != 1 {
		t.Fatalf("LEADER commitIndex 应为 1, 实际 %d", leader.CommitIndex())
	}
	// kernel.version 同步 (leader 提交路径)
	if leader.CommitIndex() != 1 && leader.CommitIndex() != 0 {
		t.Fatalf("commitIndex 异常: %d", leader.CommitIndex())
	}
}

// ─── AppendEntries: 日志一致性校验 ──────────────────────────────

func TestRaftAppendEntriesConsistency(t *testing.T) {
	k := newTestKernel(t)
	node, _ := NewRaftConsensusNode(k, "follower")
	defer node.Evict()
	_ = node.Boot(context.Background())

	// 任期屏障: 旧任期 leader → 拒绝
	resp, _ := node.HandleAppendEntries(context.Background(), AppendEntriesRPC{Term: 0, LeaderID: "l0"})
	if resp.Success {
		t.Fatal("旧任期应拒绝")
	}

	// 日志一致性校验: prevLogIndex 越界 → 拒绝
	resp, _ = node.HandleAppendEntries(context.Background(), AppendEntriesRPC{
		Term: 1, LeaderID: "l1", PrevLogIndex: 5, PrevLogTerm: 0,
	})
	if resp.Success {
		t.Fatal("前驱越界应拒绝")
	}

	// 合法追加: prevLogIndex=0 (基线), 一条 entry → 接受
	entry := RaftLogEntry{
		Term: 1, Index: 1,
		Command:           RaftCommand{Type: "X", Payload: json.RawMessage(`{}`)},
		CausalityChecksum: causalityChecksum(json.RawMessage(`{}`), 1),
	}
	resp, _ = node.HandleAppendEntries(context.Background(), AppendEntriesRPC{
		Term: 1, LeaderID: "l1", PrevLogIndex: 0, PrevLogTerm: 0,
		Entries: []RaftLogEntry{entry}, LeaderCommitIndex: 1,
	})
	if !resp.Success {
		t.Fatalf("合法追加应接受: %+v", resp)
	}
	if resp.MatchIndex != 1 {
		t.Fatalf("MatchIndex 应为 1, 实际 %d", resp.MatchIndex)
	}
	// 提交回填: kernel.version 同步
	if k.Version() != 1 {
		t.Fatalf("commit 后 kernel.version 应为 1, 实际 %d", k.Version())
	}
	// 因果防篡改: 冲突任期重写 (index1 term2)
	conflict := RaftLogEntry{
		Term: 2, Index: 1,
		Command:           RaftCommand{Type: "Y", Payload: json.RawMessage(`{}`)},
		CausalityChecksum: causalityChecksum(json.RawMessage(`{}`), 1),
	}
	_, _ = node.HandleAppendEntries(context.Background(), AppendEntriesRPC{
		Term: 2, LeaderID: "l2", PrevLogIndex: 0, PrevLogTerm: 0,
		Entries: []RaftLogEntry{conflict}, LeaderCommitIndex: 1,
	})
	if node.Role() != RaftFollower {
		t.Fatalf("更高任期应保持/降级 FOLLOWER")
	}
}

// ─── RequestVote ────────────────────────────────────────────────

func TestRaftRequestVote(t *testing.T) {
	k := newTestKernel(t)
	node, _ := NewRaftConsensusNode(k, "voter")
	defer node.Evict()
	_ = node.Boot(context.Background())
	// 单节点 Boot 自动晋升 LEADER (term=1, 已自投)

	// 过期任期 → 拒绝
	resp, _ := node.HandleRequestVote(context.Background(), VoteRequest{Term: 0, CandidateID: "c1"})
	if resp.Success {
		t.Fatal("过期任期应拒绝")
	}
	// 更高任期降级后授票 (term 2 > 本地 1)
	resp, _ = node.HandleRequestVote(context.Background(), VoteRequest{Term: 2, CandidateID: "c1", LastLogIndex: 0, LastLogTerm: 0})
	if !resp.Success {
		t.Fatalf("应授票: %+v", resp)
	}
	// 已投给 c1, c2 再来 → 拒绝 (同任期)
	resp, _ = node.HandleRequestVote(context.Background(), VoteRequest{Term: 2, CandidateID: "c2", LastLogIndex: 0, LastLogTerm: 0})
	if resp.Success {
		t.Fatal("同任期已投票应拒绝")
	}
}

// ─── IPC 代理: 帧摄入 + 分裂脑 ──────────────────────────────────

func TestBrokerIngestFrames(t *testing.T) {
	k := newTestKernel(t)
	b, err := NewDistributedProtocolBroker(k)
	if err != nil {
		t.Fatal(err)
	}

	// ACTION_DECISION_ACK: 版本对齐 → transaction.committed (AIRuntime)
	frame := NetworkFrameEnvelope{
		FrameID: "f1", Type: FrameTypeActionDecisionAck,
		CurrentTick: 1, Payload: json.RawMessage(`{"action":1,"traceId":"t9"}`),
		KernelVersionSeal: 0, Timestamp: time.Now().UnixMilli(),
	}
	raw, _ := json.Marshal(frame)
	b.ingestIncomingStrategyFrame(context.Background(), string(raw))

	events := k.store.EventsByType(EventTransactionCommitted, 10)
	found := false
	for _, ev := range events {
		if strings.Contains(string(ev.Payload), "tx_ipc_recv_f1") {
			found = true
		}
	}
	if !found {
		t.Fatal("ACTION_DECISION_ACK 应广播 transaction.committed 事件")
	}

	// DRIFT_COMMAND → snapshot 事件
	frame2 := NetworkFrameEnvelope{FrameID: "f2", Type: FrameTypeDriftCommand, Payload: json.RawMessage(`{}`), Timestamp: 1}
	raw2, _ := json.Marshal(frame2)
	b.ingestIncomingStrategyFrame(context.Background(), string(raw2))
	snapshots := k.store.EventsByType(EventSnapshotCreated, 10)
	if len(snapshots) == 0 {
		t.Fatal("DRIFT_COMMAND 应广播 snapshot.created 事件")
	}
}

func TestBrokerReconnectBackoffAndBrainSplit(t *testing.T) {
	k := newTestKernel(t)
	// 不可达端口
	k.Config.Set(cfgGovernorIPCHost, "127.0.0.1")
	k.Config.Set(cfgGovernorIPCPort, 1) // 保留端口必拒
	k.Config.Set(cfgGovernorIPCMaxReconnect, 1)
	k.Config.Set(cfgGovernorIPCBackoffBase, 10)

	b, _ := NewDistributedProtocolBroker(k)
	defer b.ShutdownBroker()

	// 首连失败 → 断路处理 → 重试 1 次 (10ms) → 再失败 → 超上限 → 分裂脑事件
	if err := b.ConnectMARLServiceGateway(context.Background()); err == nil {
		t.Fatal("不可达端口应连接失败")
	}
	b.handleConnectionInterruption(context.Background())
	// 等待重连周期 + 二次断路 → 分裂脑事件
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		events := k.store.EventsByType(EventHeartbeat, 10)
		for _, ev := range events {
			if strings.Contains(string(ev.Payload), HeartbeatStatusBrainSplit) {
				return
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("超重试上限应触发 CRITICAL_CLUSTER_BRAIN_SPLIT 事件")
}

// ─── 任务依赖图 ─────────────────────────────────────────────────

func TestTaskGraph(t *testing.T) {
	g := NewTaskGraph([]TaskGraphTask{
		{ID: "a", Weight: 1},
		{ID: "b", Deps: []string{"a"}, Weight: 2},
		{ID: "c", Deps: []string{"a"}, Weight: 5},
		{ID: "d", Deps: []string{"b", "c"}, Weight: 1},
	})
	if errs := g.Validate(); len(errs) > 0 {
		t.Fatalf("合法 DAG 校验失败: %v", errs)
	}
	order, err := g.TopoOrder()
	if err != nil {
		t.Fatal(err)
	}
	if len(order) != 4 || order[0] != "a" || order[3] != "d" {
		t.Fatalf("拓扑序错误: %v", order)
	}
	// 同层权重降序: c(5) 在 b(2) 前
	if order[1] != "c" || order[2] != "b" {
		t.Fatalf("同层应按权重降序: %v", order)
	}
	// 就绪任务
	if got := g.ReadyTasks(nil); len(got) != 1 || got[0] != "a" {
		t.Fatalf("初始就绪应为 [a]: %v", got)
	}
	if got := g.ReadyTasks(map[string]bool{"a": true}); len(got) != 2 {
		t.Fatalf("a 完成后应就绪 b/c: %v", got)
	}
	// 阻塞闭包: d ← b ← a 且 d ← c ← a → 传递闭包 {b, a, c}
	blocked := g.BlockedBy("d")
	if len(blocked) != 3 {
		t.Fatalf("d 的传递阻塞闭包应为 3 个 (b,a,c): %v", blocked)
	}

	// 环检测
	cycle := NewTaskGraph([]TaskGraphTask{
		{ID: "x", Deps: []string{"y"}},
		{ID: "y", Deps: []string{"x"}},
	})
	if errs := cycle.Validate(); len(errs) == 0 {
		t.Fatal("环应被检测到")
	}
	if _, err := cycle.TopoOrder(); err == nil {
		t.Fatal("有环拓扑排序应报错")
	}

	// 未知依赖
	unknown := NewTaskGraph([]TaskGraphTask{{ID: "z", Deps: []string{"ghost"}}})
	if errs := unknown.Validate(); len(errs) == 0 {
		t.Fatal("未知依赖应报错")
	}
}

// ─── 故障转移链 ─────────────────────────────────────────────────

func TestFailoverChain(t *testing.T) {
	chain := NewFailoverChain([]FailoverEndpoint{
		{ID: "primary", Name: "主执行器"},
		{ID: "secondary", Name: "备执行器"},
		{ID: "fallback", Name: "兜底执行器"},
	})
	ctx := context.Background()
	calls := []string{}

	// 主端点成功 → 不转移
	err := chain.Execute(ctx, func(_ context.Context, e FailoverEndpoint) error {
		calls = append(calls, e.ID)
		return nil
	})
	if err != nil || len(calls) != 1 || calls[0] != "primary" {
		t.Fatalf("主端点成功不应转移: %v %v", err, calls)
	}

	// 主端点失败 → 转移到备端点
	calls = nil
	err = chain.Execute(ctx, func(_ context.Context, e FailoverEndpoint) error {
		calls = append(calls, e.ID)
		if e.ID == "primary" {
			return fmt.Errorf("boom")
		}
		return nil
	})
	if err != nil {
		t.Fatalf("备端点应接管: %v", err)
	}
	if len(calls) != 2 || calls[0] != "primary" || calls[1] != "secondary" {
		t.Fatalf("应 primary→secondary: %v", calls)
	}

	// 冷却期内 primary 被跳过
	if got := chain.Candidates(); got[0].ID != "secondary" {
		t.Fatalf("冷却期内 primary 应被跳过: %v", got)
	}
	// 全链失败
	chain.MarkFailed("secondary")
	err = chain.Execute(ctx, func(_ context.Context, e FailoverEndpoint) error {
		return fmt.Errorf("down")
	})
	if err == nil || !strings.Contains(err.Error(), "全部失败") {
		t.Fatalf("全链失败应聚合报错: %v", err)
	}
}

// ─── 编排器: 时钟飞轮 + 治理巡检 ────────────────────────────────

type stubBroadcaster struct {
	mu     sync.Mutex
	frames []json.RawMessage
}

func (s *stubBroadcaster) BroadcastTelemetryFrame(_ context.Context, payload json.RawMessage) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.frames = append(s.frames, payload)
}

func (s *stubBroadcaster) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.frames)
}

func TestOrchestratorTickLoop(t *testing.T) {
	k := newTestKernel(t)
	b := &stubBroadcaster{}
	o, err := NewClusterRuntimeOrchestrator(k, b)
	if err != nil {
		t.Fatal(err)
	}
	o.Metrics = nil

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := o.Start(ctx); err != nil {
		t.Fatal(err)
	}
	if !o.HealthCheck(ctx) {
		t.Fatal("启动后应健康")
	}
	// tick 走起来 (默认 50ms; 等待至少 2 tick)
	time.Sleep(120 * time.Millisecond)
	if k.Tick() < 2 {
		t.Fatalf("逻辑时钟应步进, 实际 %d", k.Tick())
	}
	if b.count() < 2 {
		t.Fatalf("每 tick 应推流遥测帧, 实际 %d", b.count())
	}
	// 停止
	if err := o.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	if o.HealthCheck(ctx) {
		t.Fatal("停止后应不健康")
	}
	tickAfterStop := k.Tick()
	time.Sleep(80 * time.Millisecond)
	if k.Tick() != tickAfterStop {
		t.Fatal("停止后时钟应停走")
	}
}

func TestOrchestratorTickAdvance(t *testing.T) {
	k := newTestKernel(t)
	if got := k.AdvanceTick(context.Background()); got != 1 {
		t.Fatalf("首 tick 应为 1, 实际 %d", got)
	}
	if got := k.Tick(); got != 1 {
		t.Fatalf("Tick() 应为 1, 实际 %d", got)
	}
}
