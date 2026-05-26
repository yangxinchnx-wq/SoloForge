// ─────────────────────────────────────────────────────────────────
// SoloForge Core Layer Test Harness: Courtroom & Sovereign Kernel Integration
// Path: tests/integration/court-runtime-bound.test.ts
// ─────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { SovereignRuntimeKernel } from '../../src/kernel/runtime-kernel';
import { GeminiConsensAgentCourtRoom, AdjudicationArgumentClaim, LegalEvidenceNode } from '../../src/core/court/consensagent';
import { CourtEvent } from '../../src/core/events/court-events';

// 严格对齐 SurrealDatabaseInterface 契约的测试桩驱动
class CourtRealtimeTestSqlDriver {
  public registry = new Map<string, any>();
  public async query(sqlStatement: string, queryBindings: Record<string, any>): Promise<any[][]> {
    const targetId = queryBindings.id;
    const record = this.registry.get(targetId);
    return record ? [[record]] : [[]];
  }
}

describe('SoloForge Layer 1 司法审判房间与主安全内核所有权级集成测试套件', () => {

  it('验证点 1：[内核通配符所有权识别] 法庭必须能够通过白名单模式安全改写 court_case_registry 前缀的受控状态键', async () => {
    // 1. 物理拉起真实的自治底座内核与法庭实例
    const realKernel = new SovereignRuntimeKernel();
    const dbDriver = new CourtRealtimeTestSqlDriver();
    const courtRoom = new GeminiConsensAgentCourtRoom(realKernel, dbDriver);

    // 2. 激活 Phase 1 锁定状态，使其准许进入 Phase 2 裁决
    courtRoom.enforcePhase1LockState(true);

    const dummyArguments: AdjudicationArgumentClaim[] = [
      { originatingAgentId: 'agent-001', disputedClaimStatement: '测试中文安全匹配', linkedEvidenceRegistry: [] }
    ];

    // 3. 传入匹配 court_case_registry* 的合法通配符键值
    const legitimatePrefixKey = 'court_case_registry_session_999';
    
    // 执行裁决，预期内核应当通过校验，顺利完成空争议项的平局断言，不抛出所有权异常
    const verdict = await courtRoom.executeEvidentiaryArbitration(dummyArguments, legitimatePrefixKey);
    expect(verdict.verdictResolutionStatus).toBe('DECIDED_LEGITIMATE');
  });

  it('验证点 2：[跨域篡改硬拦截] 当法庭恶意或错误地企图篡改归属于 AIRuntime 的核心资产键时，内核必须物理截断并抛出未授权异常', async () => {
    const realKernel = new SovereignRuntimeKernel();
    const dbDriver = new CourtRealtimeTestSqlDriver();
    const courtRoom = new GeminiConsensAgentCourtRoom(realKernel, dbDriver);
    courtRoom.enforcePhase1LockState(true);

    const dummyArguments: AdjudicationArgumentClaim[] = [
      { originatingAgentId: 'agent-001', disputedClaimStatement: 'attack', linkedEvidenceRegistry: [] }
    ];

    // 故意传入属于 AIRuntime 域专属控制的物理键 core_scheduler_memory
    const protectedAiKey = 'core_scheduler_memory';

    // 断言：内核守卫必须冷酷无情，严密阻断这次越权篡改行为
    await expect(
      courtRoom.executeEvidentiaryArbitration(dummyArguments, protectedAiKey)
    ).rejects.toThrowError(`[COURT_CRITICAL] 🚨 Access Denied: Unauthorized state modification block at key [${protectedAiKey}]`);
  });

  it('验证点 3：[Bug #7 与 Flaw #2 真实防线集成检验] 注入中文无空格关联、虚假野指针，并制造真实平局分差低于 0.1 的死锁，验证防线闭环', async () => {
    const realKernel = new SovereignRuntimeKernel();
    const dbDriver = new CourtRealtimeTestSqlDriver();
    const courtRoom = new GeminiConsensAgentCourtRoom(realKernel, dbDriver);
    courtRoom.enforcePhase1LockState(true);

    // 往真实驱动里注册一个中文特征证据
    const realEvidenceUuid = 'evidence_chinese_001';
    const mockEvidence: LegalEvidenceNode = {
      id: realEvidenceUuid,
      credibilityIndex: 0.9,
      relevanceWeight: 0.8,
      temporalRecencyValue: 0.7,
      rawContent: '大模型控流算法核心底座安全审计宪法'
    };
    dbDriver.registry.set(realEvidenceUuid, mockEvidence);

    // 构造博弈对抗双方：
    // Agent X 提交了真实存在的中文证据
    // Agent Y 试图通过混入完全未在底层注册的虚假野指针 `fraud_evidence_999` 来引流、伪造权重
    const argumentsList: AdjudicationArgumentClaim[] = [
      {
        originatingAgentId: 'agent-x-honest',
        disputedClaimStatement: '核心底座安全审计', // 完美命中上面 evidence 的中文词组特征
        linkedEvidenceRegistry: [realEvidenceUuid]
      },
      {
        originatingAgentId: 'agent-y-malicious',
        disputedClaimStatement: '无关数据破坏',
        linkedEvidenceRegistry: ['fraud_evidence_999'] // 邪恶节点提交的欺诈野指针
      }
    ];

    const legitimateKey = 'court_case_registry_production_run';
    const finalVerdict = await courtRoom.executeEvidentiaryArbitration(argumentsList, legitimateKey);

    // ★ 断言一：Bug #7 彻底抹平。法庭不能因为欺诈野指针崩溃，恶意节点的权重分数应该直接为 0
    // Honest 节点拿到高分，Malicious 节点得分为 0，两名分差大于 0.1，必须给出合法胜出断言，拒绝被恶意节点死锁
    expect(finalVerdict.verdictResolutionStatus).toBe('DECIDED_LEGITIMATE');
    expect(finalVerdict.winningAgentSignature).toBe('agent-x-honest');

    // ★ 断言二：检查内核事件总线，必须捕获到全套的强类型 CourtEvent 轨迹，证明不是假测试
    const eventLogs = realKernel.getEventBus().getEventLog();
    expect(eventLogs.some(e => e.event === CourtEvent.EVIDENCE_EVALUATED)).toBe(true);
    expect(eventLogs.some(e => e.event === CourtEvent.CLAIM_SUBMITTED)).toBe(true);
    expect(eventLogs.some(e => e.event === CourtEvent.ARBITRATION_DECIDED)).toBe(true);
  });
});