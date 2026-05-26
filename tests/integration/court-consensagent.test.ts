// ─────────────────────────────────────────────────────────────────
// SoloForge Acceptance Test Harness: Court ConsensAgent Blueprint
// Path: tests/integration/court-consensagent.test.ts
// ─────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { GeminiConsensAgentCourtRoom, AdjudicationArgumentClaim, SurrealDatabaseInterface } from '../../src/core/court/consensagent';
import { SovereignRuntimeKernel } from '../../src/kernel/runtime-kernel';

// 构造虚设且对齐契约的 Mock SurrealDB 驱动，接管盲审证据存储
class MockSurrealDriver implements SurrealDatabaseInterface {
  private registry: Map<string, any> = new Map();

  public injectEvidence(id: string, data: any) {
    this.registry.set(id, data);
  }

  public async query(sqlStatement: string, queryBindings: Record<string, any>): Promise<any[][]> {
    const targetId = queryBindings.id;
    const match = this.registry.get(targetId);
    return [[match ? match : null]];
  }
}

describe('SoloForge 智能法庭两阶段盲审与死锁防御集成验收测试套件', () => {

  it('验收点 1：[Flaw #4 中文安全关联匹配] 面对无西式空格分割的纯中文断言文本，系统必须能够正确提取特征交叉比例，拒绝分数归零', async () => {
    const kernel = new SovereignRuntimeKernel();
    const db = new MockSurrealDriver();

    // 物理注入一条不含英文空格的中文核心合规证据
    db.injectEvidence('evidence:rule_1', {
      id: 'evidence:rule_1',
      credibilityIndex: 0.9,
      temporalRecencyValue: 0.8,
      rawContent: '设计变更或者核心层重构应优先建立高覆盖率的集成验收测试套件保护'
    });

    const court = new GeminiConsensAgentCourtRoom(kernel, db);
    court.enforcePhase1LockState(true); // 物理锁死 Phase 1 阶段，向 Phase 2 演进

    const claims: AdjudicationArgumentClaim[] = [
      {
        originatingAgentId: 'agent_alpha',
        disputedClaimStatement: '核心代码重构必须先编写集成验收测试套件规避线上脏化风险', // 含有大量交集字符
        linkedEvidenceRegistry: ['evidence:rule_1']
      }
    ];

    const verdict = await court.executeEvidentiaryArbitration(claims, 'court_case_registry_secure_node');
    
    // 断言：由于相关度被中英双语计算器正确挽救，该决议必须合法通过，且权重饱满
    expect(verdict.verdictResolutionStatus).toBe('DECIDED_LEGITIMATE');
    expect(verdict.winningAgentSignature).toBe('agent_alpha');
    expect(verdict.adjudicatedMetricScore).toBeGreaterThan(0.5); 
  });

  it('验收点 2：[Flaw #2 真实平局胶着拦截] 存在多个智能体对抗且前两名分数极其接近、但第三名极低时，死锁保护锁必须精准切断，击穿 Grok 伪算法', async () => {
    const kernel = new SovereignRuntimeKernel();
    const db = new MockSurrealDriver();

    // 注入两条极具实力、势均力敌导致社会撕裂的对立决议证据
    db.injectEvidence('evidence:alpha', { id: 'evidence:alpha', credibilityIndex: 0.95, temporalRecencyValue: 0.9, rawContent: 'A' });
    db.injectEvidence('evidence:beta', { id: 'evidence:beta', credibilityIndex: 0.94, temporalRecencyValue: 0.9, rawContent: 'A' });
    // 注入一条低劣的、陪跑的倒数第一名劣质伪造证据
    db.injectEvidence('evidence:gamma', { id: 'evidence:gamma', credibilityIndex: 0.12, temporalRecencyValue: 0.1, rawContent: 'X' });

    const court = new GeminiConsensAgentCourtRoom(kernel, db);
    court.enforcePhase1LockState(true);

    const claims: AdjudicationArgumentClaim[] = [
      { originatingAgentId: 'agent_alpha', disputedClaimStatement: 'A', linkedEvidenceRegistry: ['evidence:alpha'] }, // Winner 1st
      { originatingAgentId: 'agent_beta', disputedClaimStatement: 'A', linkedEvidenceRegistry: ['evidence:beta'] },   // Runner-Up 2nd (高分咬死)
      { originatingAgentId: 'agent_gamma', disputedClaimStatement: 'B', linkedEvidenceRegistry: ['evidence:gamma'] }  // Loser 3rd (极低边缘分)
    ];

    const verdict = await court.executeEvidentiaryArbitration(claims, 'court_case_registry_secure_node');

    // 断言：系统必须绝对识破欺骗，正确锁定在 CONSERVATIVE_DEADLOCK_TRIGGER 僵局防线上，决不盲目放行
    expect(verdict.verdictResolutionStatus).toBe('CONSERVATIVE_DEADLOCK_TRIGGER');
    expect(verdict.winningAgentSignature).toBeNull();
    
    // 追溯内核 EventBus 审计环，断言死锁捕获事件已被准确发射上链
    const log = kernel.getEventBus().getEventLog();
    const deadlockEvent = log.find(e => e.event === 'court:deadlock_detected');
    expect(deadlockEvent).toBeDefined();
  });

  it('验收点 3：[Bug #7 虚假野指针清除拦截] 当恶意节点提交完全未在底座注册的随机证据 ID 时，法庭不予崩盘，其关联权重直接清零', async () => {
    const kernel = new SovereignRuntimeKernel();
    const db = new MockSurrealDriver(); // 空白 DB，未映射对应证据键

    const court = new GeminiConsensAgentCourtRoom(kernel, db);
    court.enforcePhase1LockState(true);

    const claims: AdjudicationArgumentClaim[] = [
      {
        originatingAgentId: 'malicious_node_x',
        disputedClaimStatement: '物理删库破坏指令',
        linkedEvidenceRegistry: ['evidence:unregistered_fraud_uuid_999']
      }
    ];

    const verdict = await court.executeEvidentiaryArbitration(claims, 'court_case_registry_secure_node');
    
    // 无法欺诈积分，最终计算的法庭得分必然彻底归零
    expect(verdict.adjudicatedMetricScore).toBe(0);
  });
});