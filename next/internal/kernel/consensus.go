// ─────────────────────────────────────────────────────────────────
// consensus.go — 内生轻量级 Raft 分布式强共识状态机
// (从 TS src/kernel/consensus/raft-consensus-node.ts 迁移)
//
// 职责: 多物理节点间的全局事务版本戳 (kernel.version) 与核心所有权证
// 的强一致性强同步。内生 1-bit 因果防篡改校验 (causalityChecksum =
// sha256(payload+index)), 阻断硬件分区偶发断插时的非一致性状态篡改倒灌。
//
// 语义对齐 TS:
//   - 角色: LEADER / FOLLOWER / CANDIDATE; 任期单调递增
//   - 基线日志: index 0 = NO_OP_BASE (term 0, checksum "0000")
//   - 单节点模式: 自动晋升 LEADER (无需选举)
//   - 多节点模式: FOLLOWER + 选举超时 (5s + 0~1s 抖动) → CANDIDATE →
//     RequestVote → 法定票数 quorum = floor((peers+1)/2)+1
//   - AppendEntries: 任期屏障 → 日志一致性校验 (prevLogIndex/prevLogTerm)
//     → 冲突截断重写 → commitIndex 推进 → 状态机回填
//   - 复制: nextIndex/matchIndex 追踪 + 失败回退一格 (对数回退修复)
//   - 分裂脑: 法定票数不足 → 不提交 (false); 超过重试上限 → 心跳事件
//     CRITICAL_CLUSTER_BRAIN_SPLIT (broker.go 侧)
//   - 应用: lastApplied 推进 → kernel.version 同步为 entry.index →
//     广播 transaction.committed (domain=ConsensusEngine)
//
// Go 版差异 (有意的正确性修正):
//   - RPC 经 PeerTransport 接口投递 (默认 HTTPTransport; 进程内桩可注入),
//     TS 经命令总线 executeCommand 转发
//   - 合法 AppendEntries 后重置选举计时器 (真实 Raft 语义; TS 漏了重置,
//     会导致 follow 端反复选举)
//
// ─────────────────────────────────────────────────────────────────
package kernel

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"sync"
	"time"
)

// ── 角色 / RPC 类型 ─────────────────────────────────────────────

// RaftRole 共识节点角色
type RaftRole string

const (
	RaftLeader    RaftRole = "LEADER"
	RaftFollower  RaftRole = "FOLLOWER"
	RaftCandidate RaftRole = "CANDIDATE"
)

// Raft RPC 命令类型 (对齐 TS commandBus handler 注册名)
const (
	CmdReceiveAppendEntries = "RECEIVE_APPEND_ENTRIES_RPC"
	CmdReceiveRequestVote   = "RECEIVE_REQUEST_VOTE_RPC"
)

// 共识定时参数 (对齐 TS)
const (
	raftElectionTimeoutMs = 5000                    // 选举超时 5s
	raftElectionJitterMs  = 1000                    // 选举抖动 0~1s
	raftHeartbeatInterval = 1500 * time.Millisecond // 心跳间隔 1.5s
)

// RaftCommand 日志条目命令
type RaftCommand struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

// RaftLogEntry 共识日志条目 (causalityChecksum = sha256(payload+index))
type RaftLogEntry struct {
	Term              int         `json:"term"`
	Index             int         `json:"index"`
	Command           RaftCommand `json:"command"`
	CausalityChecksum string      `json:"causalityChecksum"`
}

// AppendEntriesRPC 日志复制 RPC (对齐 TS AppendEntriesRpc)
type AppendEntriesRPC struct {
	Term              int            `json:"term"`
	LeaderID          string         `json:"leaderId"`
	PrevLogIndex      int            `json:"prevLogIndex"`
	PrevLogTerm       int            `json:"prevLogTerm"`
	Entries           []RaftLogEntry `json:"entries"`
	LeaderCommitIndex int            `json:"leaderCommitIndex"`
}

// VoteRequest 领袖选举投票请求 (对齐 TS handleRequestVoteRpc 入参)
type VoteRequest struct {
	Term         int    `json:"term"`
	CandidateID  string `json:"candidateId"`
	LastLogIndex int    `json:"lastLogIndex"`
	LastLogTerm  int    `json:"lastLogTerm"`
}

// RaftRPCResponse RPC 响应 (对齐 TS RpcResponse)
type RaftRPCResponse struct {
	Term        int    `json:"term"`
	Success     bool   `json:"success"`
	ResponderID string `json:"responderId"`
	MatchIndex  int    `json:"matchIndex,omitempty"`
}

// PeerTransport 节点间 RPC 投递通道 (TS 经命令总线; Go 抽象成接口,
// 默认实现 HTTPTransport, 测试可注入进程内桩)
type PeerTransport interface {
	SendAppendEntries(ctx context.Context, peerID string, rpc AppendEntriesRPC) (RaftRPCResponse, error)
	SendRequestVote(ctx context.Context, peerID string, req VoteRequest) (RaftRPCResponse, error)
}

// ── 共识节点 ────────────────────────────────────────────────────

// RaftConsensusNode Raft 共识节点
type RaftConsensusNode struct {
	nodeID    string
	kernel    *RuntimeKernel
	transport PeerTransport

	mu          sync.Mutex
	currentTerm int
	votedFor    string // "" = 未投票 (TS null)
	log         []RaftLogEntry
	commitIndex int
	lastApplied int
	role        RaftRole
	peers       []string
	operational bool
	nextIndex   map[string]int
	matchIndex  map[string]int

	// 生命周期 (Go 用 goroutine + stop channel 替代 TS setTimeout/setInterval)
	stop        chan struct{}
	stopOnce    sync.Once
	electionMu  sync.Mutex
	electionTmr *time.Timer

	// Metrics 可选指标收集器 (TS metricsCollector.counter)
	Metrics MetricsInserter
}

// MetricsInserter 指标注入接口 (对齐 TS pushMetrics; *metrics.Collector 适配)
type MetricsInserter interface {
	Inc(name string)
}

// NewRaftConsensusNode 构造共识节点 (transport 为 nil 时需后续 SetTransport;
// kernel 必须非 nil — 对齐 TS "Consensus nodes cannot boot without
// completely bound micro-kernel orchestrators")
func NewRaftConsensusNode(k *RuntimeKernel, nodeID string) (*RaftConsensusNode, error) {
	if k == nil {
		return nil, fmt.Errorf("CRITICAL_SF_CONSTITUTION: Consensus nodes cannot boot without completely bound micro-kernel orchestrators")
	}
	return &RaftConsensusNode{
		nodeID:     nodeID,
		kernel:     k,
		role:       RaftFollower,
		nextIndex:  make(map[string]int),
		matchIndex: make(map[string]int),
		stop:       make(chan struct{}),
	}, nil
}

// SetTransport 注入节点间 RPC 通道
func (n *RaftConsensusNode) SetTransport(t PeerTransport) { n.transport = t }

// ── 生命周期 ────────────────────────────────────────────────────

// Boot 共识注册表热拔插引导器 (对齐 TS bootConsensusRegistry):
// 读集群配置 → 播基线日志 → 注册 RPC 命令处理器 → 单节点自动晋升 / 多节点开选举
func (n *RaftConsensusNode) Boot(ctx context.Context) error {
	n.mu.Lock()
	if n.operational {
		n.mu.Unlock()
		return nil
	}

	// 集群节点列表 (TS configCenter: governor.cluster.peers_nodes)
	if n.kernel.Config != nil {
		raw := n.kernel.Config.Get("governor.cluster.peers_nodes", []any{})
		if list, ok := raw.([]any); ok {
			for _, v := range list {
				if s, ok := v.(string); ok {
					n.peers = append(n.peers, s)
				}
			}
		}
	}

	// 播初始空基线日志条目 (index 0 锁任期)
	n.log = []RaftLogEntry{{
		Term: 0, Index: 0,
		Command:           RaftCommand{Type: "NO_OP_BASE", Payload: json.RawMessage("{}")},
		CausalityChecksum: "0000",
	}}

	// RPC 命令处理器注册到内核命令总线 (对齐 TS commandBus.registerHandler)
	if cb := n.kernel.CommandBus(); cb != nil {
		cb.Register(CmdReceiveAppendEntries, func(_ context.Context, payload json.RawMessage) (any, error) {
			var rpc AppendEntriesRPC
			if err := json.Unmarshal(payload, &rpc); err != nil {
				return nil, err
			}
			return n.HandleAppendEntries(context.Background(), rpc)
		})
		cb.Register(CmdReceiveRequestVote, func(_ context.Context, payload json.RawMessage) (any, error) {
			var req VoteRequest
			if err := json.Unmarshal(payload, &req); err != nil {
				return nil, err
			}
			return n.HandleRequestVote(context.Background(), req)
		})
	}

	n.operational = true
	peers := n.peers
	n.mu.Unlock()

	// 单节点模式: 自动晋升 LEADER (无需选举)
	if len(peers) == 0 {
		n.promoteToLeader(ctx)
	} else {
		n.startElectionTimer()
	}

	slog.Warn("Raft 共识节点激活", "nodeId", n.nodeID, "role", n.Role(), "term", n.Term(), "peers", len(peers))
	return nil
}

// Evict 停止计时器并清空日志 (对齐 TS evictConsensusRegistry)
func (n *RaftConsensusNode) Evict() {
	n.stopOnce.Do(func() { close(n.stop) })
	n.electionMu.Lock()
	if n.electionTmr != nil {
		n.electionTmr.Stop()
		n.electionTmr = nil
	}
	n.electionMu.Unlock()

	n.mu.Lock()
	n.log = nil
	n.operational = false
	n.role = RaftFollower
	n.mu.Unlock()
}

// Role 当前角色
func (n *RaftConsensusNode) Role() RaftRole {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.role
}

// Term 当前任期
func (n *RaftConsensusNode) Term() int {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.currentTerm
}

// CommitIndex 已提交日志索引
func (n *RaftConsensusNode) CommitIndex() int {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.commitIndex
}

// ── RPC 处理器 ──────────────────────────────────────────────────

// HandleAppendEntries AppendEntries 强一致性日志追加阻断网关
// (对齐 TS handleAppendEntriesRpc): 严格核对前驱日志条目索引与任期号,
// 瓦解多主机脑裂引发的数据踩踏。
func (n *RaftConsensusNode) HandleAppendEntries(ctx context.Context, rpc AppendEntriesRPC) (RaftRPCResponse, error) {
	n.mu.Lock()

	// 1. 任期屏障: leader 任期低于本地 → 立即拒绝
	if rpc.Term < n.currentTerm {
		resp := RaftRPCResponse{Term: n.currentTerm, ResponderID: n.nodeID}
		n.mu.Unlock()
		return resp, nil
	}

	// 远端 leader 建立更高任期 (或本机在选举中) → 降级 FOLLOWER
	if rpc.Term > n.currentTerm || n.role == RaftCandidate {
		n.currentTerm = rpc.Term
		n.role = RaftFollower
		n.votedFor = ""
	}

	// 2. 日志一致性校验: 前驱条目索引/任期不匹配 → 拒绝
	if len(n.log) <= rpc.PrevLogIndex || n.log[rpc.PrevLogIndex].Term != rpc.PrevLogTerm {
		n.metricInc("governor.consensus.log_mismatch_rejections")
		resp := RaftRPCResponse{Term: n.currentTerm, ResponderID: n.nodeID}
		n.mu.Unlock()
		return resp, nil
	}

	// 3. 追加新日志块 — 冲突时截断本地未对齐尾部重写
	logPointer := rpc.PrevLogIndex + 1
	for _, remote := range rpc.Entries {
		if len(n.log) > logPointer {
			if n.log[logPointer].Term != remote.Term {
				// 截掉未对齐的本地尾部
				n.log = append([]RaftLogEntry(nil), n.log[:logPointer]...)
				n.log = append(n.log, remote)
			}
		} else {
			n.log = append(n.log, remote)
		}
		logPointer++
	}

	// 4. 推进本地 commitIndex 并回填状态机
	if rpc.LeaderCommitIndex > n.commitIndex {
		n.commitIndex = minInt(rpc.LeaderCommitIndex, len(n.log)-1)
	}
	matchIndex := n.lastLogIndex()
	term := n.currentTerm

	// Go 修正: 合法 AppendEntries 视为 leader 存活, 重置选举计时器
	// (TS 漏了此重置, 会导致 follow 端反复选举)
	n.mu.Unlock()

	n.resetElectionTimer()
	n.applyCommittedEntries(ctx)

	return RaftRPCResponse{
		Term:        term,
		Success:     true,
		ResponderID: n.nodeID,
		MatchIndex:  matchIndex,
	}, nil
}

// HandleRequestVote 领袖选举投票处理器 (对齐 TS handleRequestVoteRpc):
// 拒绝过期任期; 更高任期降级; 未投票且候选日志不落后于本地 → 授票。
func (n *RaftConsensusNode) HandleRequestVote(ctx context.Context, req VoteRequest) (RaftRPCResponse, error) {
	n.mu.Lock()

	// 候选任期过期 → 拒绝
	if req.Term < n.currentTerm {
		resp := RaftRPCResponse{Term: n.currentTerm, Success: false, ResponderID: n.nodeID}
		n.mu.Unlock()
		return resp, nil
	}

	// 更高任期 → 降级 FOLLOWER
	if req.Term > n.currentTerm {
		n.currentTerm = req.Term
		n.role = RaftFollower
		n.votedFor = ""
	}

	// 授票条件: 未投票或已投给该候选 且 候选日志至少与本机一样新
	last := n.log[len(n.log)-1]
	logUpToDate := req.LastLogTerm > last.Term ||
		(req.LastLogTerm == last.Term && req.LastLogIndex >= last.Index)

	if (n.votedFor == "" || n.votedFor == req.CandidateID) && logUpToDate {
		n.votedFor = req.CandidateID
		term := n.currentTerm
		n.mu.Unlock()
		// 授票后重置选举计时器 (对齐 TS resetElectionTimer)
		n.resetElectionTimer()
		return RaftRPCResponse{Term: term, Success: true, ResponderID: n.nodeID}, nil
	}

	resp := RaftRPCResponse{Term: n.currentTerm, Success: false, ResponderID: n.nodeID}
	n.mu.Unlock()
	return resp, nil
}

// ── 选举 ────────────────────────────────────────────────────────

// startElectionTimer 启动选举计时器 (对齐 TS startElectionTimer)
func (n *RaftConsensusNode) startElectionTimer() { n.resetElectionTimer() }

// resetElectionTimer 重置选举计时器: 超时 5s + 0~1s 抖动后发起选举
func (n *RaftConsensusNode) resetElectionTimer() {
	n.electionMu.Lock()
	defer n.electionMu.Unlock()
	if n.electionTmr != nil {
		n.electionTmr.Stop()
	}
	jitterMs, _ := randIntn(raftElectionJitterMs)
	delay := raftElectionTimeoutMs + time.Duration(jitterMs)*time.Millisecond
	n.electionTmr = time.AfterFunc(delay, func() {
		select {
		case <-n.stop:
			return
		default:
		}
		n.startElection(context.Background())
	})
}

// startElection 发起选举 (对齐 TS startElection):
// CANDIDATE + 任期 +1 + 自投 → 并发拉票 → 法定票数胜出晋升 / 失败回退重试
func (n *RaftConsensusNode) startElection(ctx context.Context) {
	n.mu.Lock()
	n.role = RaftCandidate
	n.currentTerm++
	n.votedFor = n.nodeID
	term := n.currentTerm
	last := n.log[len(n.log)-1]
	peers := append([]string(nil), n.peers...)
	quorum := int(math.Floor(float64(len(peers)+1)/2)) + 1
	transport := n.transport
	n.mu.Unlock()

	var wg sync.WaitGroup
	var votesMu sync.Mutex
	votesGranted := 1 // 自投

	for _, peerID := range peers {
		wg.Add(1)
		go func(peer string) {
			defer wg.Done()
			if transport == nil {
				return // peer unreachable, skip
			}
			resp, err := transport.SendRequestVote(ctx, peer, VoteRequest{
				Term:         term,
				CandidateID:  n.nodeID,
				LastLogIndex: last.Index,
				LastLogTerm:  last.Term,
			})
			if err != nil {
				return // Peer unreachable, skip
			}
			votesMu.Lock()
			defer votesMu.Unlock()
			if resp.Success {
				votesGranted++
			} else if resp.Term > n.Term() {
				// 更高任期的 leader 存在 → 降级
				n.mu.Lock()
				if resp.Term > n.currentTerm {
					n.currentTerm = resp.Term
					n.role = RaftFollower
					n.votedFor = ""
				}
				n.mu.Unlock()
				n.resetElectionTimer()
			}
		}(peerID)
	}
	wg.Wait()

	// 胜出判定 (须仍是 CANDIDATE — 选举期间可能已降级)
	if n.Role() == RaftCandidate && votesGranted >= quorum {
		n.promoteToLeader(ctx)
	} else if n.Role() == RaftCandidate {
		// 选举失败, 回退 FOLLOWER 并重试
		n.mu.Lock()
		if n.role == RaftCandidate {
			n.role = RaftFollower
		}
		n.mu.Unlock()
		n.resetElectionTimer()
	}
}

// promoteToLeader 晋升 LEADER (对齐 TS promoteToLeader): 任期 +1,
// 初始化 peer 复制进度, 有 peer 时启动心跳。
func (n *RaftConsensusNode) promoteToLeader(ctx context.Context) {
	n.mu.Lock()
	n.role = RaftLeader
	n.currentTerm++
	n.votedFor = n.nodeID
	for _, peer := range n.peers {
		n.nextIndex[peer] = len(n.log)
		n.matchIndex[peer] = 0
	}
	hasPeers := len(n.peers) > 0
	term := n.currentTerm
	n.mu.Unlock()

	if hasPeers {
		n.startHeartbeat()
	}
	slog.Warn("LEADER 当选", "node", n.nodeID, "term", term)
	n.metricInc("governor.consensus.leader_elections")
}

// ── 心跳 ────────────────────────────────────────────────────────

// startHeartbeat LEADER 定期向 FOLLOWER 发送空 AppendEntries 维持权威
func (n *RaftConsensusNode) startHeartbeat() {
	go func() {
		ticker := time.NewTicker(raftHeartbeatInterval)
		defer ticker.Stop()
		for {
			select {
			case <-n.stop:
				return
			case <-ticker.C:
				if n.Role() != RaftLeader {
					return // 非 LEADER 即停 (对齐 TS clearInterval)
				}
				n.broadcastHeartbeat(context.Background())
			}
		}
	}()
}

// broadcastHeartbeat 单轮心跳广播 (空 entries)
func (n *RaftConsensusNode) broadcastHeartbeat(ctx context.Context) {
	n.mu.Lock()
	term := n.currentTerm
	commit := n.commitIndex
	peers := append([]string(nil), n.peers...)
	snapshot := make(map[string]AppendEntriesRPC, len(peers))
	for _, peerID := range peers {
		pIndex := n.nextIndex[peerID]
		if pIndex < 1 {
			pIndex = 1
		}
		prev := n.log[pIndex-1]
		snapshot[peerID] = AppendEntriesRPC{
			Term: term, LeaderID: n.nodeID,
			PrevLogIndex: prev.Index, PrevLogTerm: prev.Term,
			Entries: nil, LeaderCommitIndex: commit,
		}
	}
	transport := n.transport
	n.mu.Unlock()

	if transport == nil {
		return
	}
	for _, peerID := range peers {
		go func(peer string, rpc AppendEntriesRPC) {
			_, _ = transport.SendAppendEntries(ctx, peer, rpc) // Peer unreachable 忽略
		}(peerID, snapshot[peerID])
	}
}

// ── 提交入口 ────────────────────────────────────────────────────

// SubmitCommand 通过共识层提交命令 (对齐 TS submitCommand):
// 单节点模式直接追加并提交; 多节点模式走完整复制流程。
func (n *RaftConsensusNode) SubmitCommand(ctx context.Context, cmdType string, payload json.RawMessage) bool {
	n.mu.Lock()
	if !n.operational {
		n.mu.Unlock()
		slog.Error("共识节点未激活, 拒绝提交")
		return false
	}
	single := len(n.peers) == 0 && n.role == RaftLeader
	leader := n.role == RaftLeader
	n.mu.Unlock()

	// 单节点模式: 本地直接提交 (已是 LEADER)
	if single {
		entry := n.makeEntry(payload, cmdType)
		n.mu.Lock()
		n.log = append(n.log, entry)
		n.commitIndex = entry.Index
		n.mu.Unlock()
		n.applyCommittedEntries(ctx)
		n.metricInc("governor.consensus.entries_applied_count")
		return true
	}

	if !leader {
		return false
	}
	// 多节点模式: 完整复制流程 (达到法定票数才提交)
	return n.ReplicateTransactionalPayload(ctx, payload, cmdType)
}

// ReplicateTransactionalPayload 领袖广播发布算子 (对齐 TS 同名):
// 追加日志 → 并发复制到各 peer (nextIndex/matchIndex 追踪 + 失败回退一格)
// → 法定票数达成才 commit 回填。
func (n *RaftConsensusNode) ReplicateTransactionalPayload(ctx context.Context, payload json.RawMessage, typeString string) bool {
	if n.Role() != RaftLeader {
		return false
	}

	entry := n.makeEntry(payload, typeString)
	n.mu.Lock()
	n.log = append(n.log, entry)
	n.metricInc("governor.consensus.local_logs_appended")
	newIndex := entry.Index
	term := n.currentTerm
	peers := append([]string(nil), n.peers...)
	quorum := int(math.Floor(float64(len(peers)+1)/2)) + 1

	// 快照复制窗口 (对齐 TS: pIndex = nextIndex[peer] ?? 1)
	snapshot := make(map[string]AppendEntriesRPC, len(peers))
	for _, peerID := range peers {
		pIndex := n.nextIndex[peerID]
		if pIndex < 1 {
			pIndex = 1
		}
		if pIndex > len(n.log)-1 {
			pIndex = len(n.log) - 1
		}
		prev := n.log[pIndex-1]
		entries := append([]RaftLogEntry(nil), n.log[pIndex:]...)
		snapshot[peerID] = AppendEntriesRPC{
			Term: term, LeaderID: n.nodeID,
			PrevLogIndex: prev.Index, PrevLogTerm: prev.Term,
			Entries: entries, LeaderCommitIndex: n.commitIndex,
		}
	}
	transport := n.transport
	n.mu.Unlock()

	var wg sync.WaitGroup
	var mu sync.Mutex
	granted := 1 // 自投
	for _, peerID := range peers {
		wg.Add(1)
		go func(peer string) {
			defer wg.Done()
			if transport == nil {
				return
			}
			resp, err := transport.SendAppendEntries(ctx, peer, snapshot[peer])
			if err != nil {
				return // 断链节点被背压熔断动态旁路
			}
			mu.Lock()
			defer mu.Unlock()
			n.mu.Lock()
			defer n.mu.Unlock()
			if resp.Success {
				n.nextIndex[peer] = resp.MatchIndex + 1
				n.matchIndex[peer] = resp.MatchIndex
				granted++
			} else {
				// 动态后滑一格, 快速对数对齐修复
				n.nextIndex[peer] = maxInt(1, snapshot[peer].PrevLogIndex-1)
			}
		}(peerID)
	}
	wg.Wait()

	// 提交判定: 绝对法定票数达成
	if granted >= quorum && newIndex > n.CommitIndex() {
		n.mu.Lock()
		n.commitIndex = newIndex
		n.mu.Unlock()
		n.applyCommittedEntries(ctx)
		return true
	}
	// 法定票数未达成 (分裂脑/断链) → 不提交, 返回 false
	return false
}

// ConvertRoleRegime 平滑角色迁移 (对齐 TS convertRoleRegime, 治理/仲裁路径)
func (n *RaftConsensusNode) ConvertRoleRegime(target RaftRole, term int) {
	n.mu.Lock()
	n.role = target
	n.currentTerm = term
	n.mu.Unlock()
	slog.Warn("共识集群角色迁移", "role", target, "term", term)
}

// ── 状态机回填 ──────────────────────────────────────────────────

// applyCommittedEntries 状态机应用飞轮 (对齐 TS applyCommittedEntriesToStateEngine):
// 将已达成强共识的日志原子级回填灌入微内核事务温层:
// kernel.version 同步为 entry.index → 广播 transaction.committed。
func (n *RaftConsensusNode) applyCommittedEntries(ctx context.Context) {
	for {
		n.mu.Lock()
		if n.commitIndex <= n.lastApplied {
			n.mu.Unlock()
			return
		}
		n.lastApplied++
		entry := n.log[n.lastApplied]
		n.mu.Unlock()

		// 已验证的版本步进直连全局内核序列 (对齐 TS kernel.version = entry.index)
		n.kernel.mu.Lock()
		if int64(entry.Index) > n.kernel.version {
			n.kernel.version = int64(entry.Index)
		}
		n.kernel.mu.Unlock()

		// 复制事实块派发到标准内核事务管线 (级联投影)
		traceID := ""
		var payloadMap map[string]any
		if json.Unmarshal(entry.Command.Payload, &payloadMap) == nil {
			if s, ok := payloadMap["traceId"].(string); ok {
				traceID = s
			}
		}
		n.kernel.emit(ctx, EventTransactionCommitted, map[string]any{
			"domain":  "ConsensusEngine",
			"txId":    fmt.Sprintf("tx_raft_commit_%d", entry.Index),
			"version": entry.Index,
			"traceId": traceID,
			"data":    payloadMap,
		})
		n.metricInc("governor.consensus.entries_applied_count")
	}
}

// ── 内部工具 ────────────────────────────────────────────────────

// makeEntry 构造日志条目 (causalityChecksum = sha256(payload+index))
func (n *RaftConsensusNode) makeEntry(payload json.RawMessage, cmdType string) RaftLogEntry {
	n.mu.Lock()
	newIndex := len(n.log)
	term := n.currentTerm
	n.mu.Unlock()
	return RaftLogEntry{
		Term: term, Index: newIndex,
		Command:           RaftCommand{Type: cmdType, Payload: payload},
		CausalityChecksum: causalityChecksum(payload, newIndex),
	}
}

// causalityChecksum 因果校验和: sha256(JSON(payload) + index) 前 32 hex
// (对齐 TS crypto.createHash('sha256').update(JSON.stringify(payload)+newIndex))
func causalityChecksum(payload json.RawMessage, index int) string {
	h := sha256.New()
	h.Write(payload)
	h.Write([]byte(fmt.Sprintf("%d", index)))
	return hex.EncodeToString(h.Sum(nil))[:32]
}

// lastLogIndex 末条日志索引 (须持锁调用)
func (n *RaftConsensusNode) lastLogIndex() int {
	if len(n.log) == 0 {
		return 0
	}
	return n.log[len(n.log)-1].Index
}

func (n *RaftConsensusNode) metricInc(name string) {
	if n.Metrics != nil {
		n.Metrics.Inc(name)
	}
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// randIntn 加密安全的 [0,n) 随机数 (选举抖动)
func randIntn(n int) (int, error) {
	if n <= 0 {
		return 0, nil
	}
	var b [1]byte
	if _, err := rand.Read(b[:]); err != nil {
		return 0, err
	}
	return int(b[0]) % n, nil
}
