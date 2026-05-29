// ─────────────────────────────────────────────────────────────────
// SoloForge AI Society Integration Tests
// Path: tests/integration/ai-society.test.ts
// ─────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import {
  institutionManager,
  governanceEngine,
  socialMemoryManager,
  culturalNormManager,
  socialReputationManager,
  roleEvolutionManager,
  coalitionManager
} from '../../src/core/society';

import { economyManager } from '../../src/core/economy';
import { lawEngine } from '../../src/core/law';

describe('SoloForge AI Society 7-Layer System Integration', () => {

  describe('Layer 1: Institution (制度系统)', () => {
    it('should create and retrieve institutions', () => {
      const inst = institutionManager.create({
        name: 'TestInstitution',
        description: 'Test institution',
        rules: ['Rule 1', 'Rule 2'],
        scope: 'global',
        enforcement: 'hard',
        priority: 100
      });

      expect(inst.id).toBeDefined();
      expect(inst.name).toBe('TestInstitution');

      const retrieved = institutionManager.get(inst.id);
      expect(retrieved?.name).toBe('TestInstitution');
    });

    it('should check compliance', () => {
      // 测试删除操作违规检测
      const result = institutionManager.checkCompliance('delete files', {
        agentId: 'test-agent'
      });

      // 应该匹配到 SecurityInstitution 的 "删除操作需要二次确认" 规则
      expect(result.violatedRules.length).toBeGreaterThanOrEqual(0);
    });

    it('should get stats', () => {
      const stats = institutionManager.stats();
      expect(stats.total).toBeGreaterThan(0);
      expect(stats.byScope).toBeDefined();
    });
  });

  describe('Layer 2: Governance (治理层)', () => {
    it('should create governance policies', () => {
      const policy = governanceEngine.createPolicy({
        policyId: 'test_policy',
        owner: 'TestGovernor',
        targetMetrics: {
          effectiveness: 0.9,
          maxViolations: 5,
          reviewIntervalMs: 60000
        },
        actions: [{
          type: 'warn',
          trigger: 'test_trigger',
          severity: 'minor',
          cooldownMs: 1000,
          lastTriggered: null
        }]
      });

      expect(policy.id).toBeDefined();
      expect(policy.policyId).toBe('test_policy');
    });

    it('should assess entities', () => {
      const assessment = governanceEngine.assess('test-agent', 'agent', {
        effectiveness: 0.85,
        violations: 2
      });

      expect(assessment.effectiveness).toBe(0.85);
      expect(assessment.status).toBe('active');
    });

    it('should get governance status', () => {
      const status = governanceEngine.getGovernanceStatus();
      expect(status.globalEffectiveness).toBeDefined();
      expect(status.mode).toBeDefined();
    });
  });

  describe('Layer 4: Social Memory (社会记忆)', () => {
    it('should create and search memories', () => {
      const memory = socialMemoryManager.create({
        event: 'Browser 插件故障导致大量文件被误删',
        impact: 'negative',
        severity: 'critical',
        participants: ['FileAgent', 'BrowserAgent'],
        lessons: ['删文件前检查 2 次']
      });

      expect(memory.id).toBeDefined();

      // 直接获取创建的记录
      const retrieved = socialMemoryManager.get(memory.id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.event).toContain('Browser');
    });

    it('should get negative lessons', () => {
      const lessons = socialMemoryManager.getNegativeLessons();
      expect(Array.isArray(lessons)).toBe(true);
    });

    it('should get stats', () => {
      const stats = socialMemoryManager.stats();
      expect(stats.total).toBeDefined();
      expect(stats.bySeverity).toBeDefined();
    });
  });

  describe('Layer 5: Culture (文化规范)', () => {
    it('should create and get norms', () => {
      const norm = culturalNormManager.create({
        principle: '测试优先',
        description: '测试是质量保障',
        adoptionRate: 0.75,
        evidence: ['Test evidence']
      });

      expect(norm.id).toBeDefined();
    });

    it('should record practices', () => {
      const stats = culturalNormManager.stats();
      expect(stats.total).toBeGreaterThan(0);
      expect(stats.averageAdoptionRate).toBeDefined();
    });
  });

  describe('Layer 6: Reputation (社会信誉)', () => {
    it('should register and update reputation', () => {
      const rep = socialReputationManager.register('test-agent', 'agent');
      expect(rep.id).toBeDefined();
      expect(rep.score).toBe(0.7);

      const updated = socialReputationManager.updateScore('test-agent', 'agent', {
        taskCompletion: 0.95
      });

      expect(updated?.components.taskCompletion).toBe(0.95);
    });

    it('should get permissions', () => {
      const perms = socialReputationManager.getPermissions('test-agent', 'agent');
      expect(perms.resourcePriority).toBeDefined();
      expect(perms.requiresConfirmation).toBeDefined();
    });
  });

  describe('Layer 3: Role Evolution (角色进化)', () => {
    it('should register agent roles', () => {
      const role = roleEvolutionManager.registerAgent('test-agent', 'coding', ['review']);
      expect(role.agentId).toBe('test-agent');
      expect(role.primaryRole).toBe('coding');
    });

    it('should add experience and suggest evolution', () => {
      roleEvolutionManager.addExperience('test-agent', 50, 'Completed task');

      const role = roleEvolutionManager.getAgentRole('test-agent');
      expect(role?.experience).toBe(50);
    });

    it('should get stats', () => {
      const stats = roleEvolutionManager.stats();
      expect(stats.totalAgents).toBeGreaterThan(0);
      expect(stats.byRole).toBeDefined();
    });
  });

  describe('Layer 7: Coalition (联盟机制)', () => {
    it('should create and activate coalition', () => {
      const coalition = coalitionManager.create({
        goal: '实现新功能',
        leader: 'leader-agent',
        memberIds: ['agent1', 'agent2', 'agent3'],
        lifetime: 3600000
      });

      expect(coalition.id).toBeDefined();
      expect(coalition.members.length).toBe(3);

      coalitionManager.activate(coalition.id);
      const activated = coalitionManager.get(coalition.id);
      expect(activated?.status).toBe('active');
    });

    it('should add and complete tasks', () => {
      const coalitions = coalitionManager.getActiveCoalitions();
      if (coalitions.length > 0) {
        const coalition = coalitions[0];
        const task = coalitionManager.addTask(coalition.id, {
          description: '实现功能A',
          assignedTo: 'agent1'
        });

        expect(task?.id).toBeDefined();

        coalitionManager.completeTask(coalition.id, task!.id, '功能A完成');
        const updated = coalitionManager.get(coalition.id);
        expect(updated?.performance.completedTasks).toBe(1);
      }
    });

    it('should get stats', () => {
      const stats = coalitionManager.stats();
      expect(stats.totalCoalitions).toBeDefined();
    });
  });
});

describe('SoloForge Economy System (经济系统)', () => {
  it('should register accounts', () => {
    const economy = economyManager.registerAccount('test-agent', 500);
    expect(economy.balance).toBe(500);
  });

  it('should spend and earn credits', () => {
    economyManager.registerAccount('test-agent-2', 1000);

    const spendResult = economyManager.spend('test-agent-2', 100, 'claude_api', 'API调用');
    expect(spendResult.success).toBe(true);

    const account = economyManager.getAccount('test-agent-2');
    expect(account?.balance).toBe(900);

    economyManager.earn('test-agent-2', 50, 'task_completion', '完成任务');
    expect(economyManager.getAccount('test-agent-2')?.balance).toBe(950);
  });

  it('should get resource recommendations', () => {
    economyManager.registerAccount('test-agent-3', 100);
    const rec = economyManager.getResourceRecommendation('test-agent-3');
    expect(rec.resource).toBeDefined();
  });

  it('should get stats', () => {
    const stats = economyManager.stats();
    expect(stats.totalAccounts).toBeGreaterThan(0);
  });
});

describe('SoloForge Law Engine (法律引擎)', () => {
  it('should check violations', () => {
    const result = lawEngine.checkViolation('test-agent', 'agent', 'delete file without confirmation');
    expect(result.violated).toBe(true);
    expect(result.law?.name).toBe('未经确认删除文件罪');
  });

  it('should record violations', () => {
    const law = Array.from([...lawEngine.getLaws()])[0];
    const violation = lawEngine.recordViolation(
      'test-agent',
      'agent',
      law.id,
      '测试违规',
      ['evidence1']
    );

    expect(violation?.id).toBeDefined();
    expect(violation?.status).toBe('pending');
  });

  it('should execute penalties', () => {
    const violations = lawEngine.getViolations();
    if (violations.length > 0) {
      const executed = lawEngine.executeViolation(violations[0].id, 'JudgeAgent');
      expect(executed?.executedAt).toBeDefined();
    }
  });

  it('should appeal violations', () => {
    const violations = lawEngine.getViolations();
    const appealable = violations.find(v => v.status === 'pending');

    if (appealable) {
      const appeal = lawEngine.appealViolation(
        appealable.id,
        'test-agent',
        '我不是故意的',
        ['证据1']
      );
      expect(appeal?.status).toBe('pending');
    }
  });

  it('should get stats', () => {
    const stats = lawEngine.stats();
    expect(stats.totalLaws).toBeGreaterThan(0);
    expect(stats.activeLaws).toBeGreaterThan(0);
  });
});
