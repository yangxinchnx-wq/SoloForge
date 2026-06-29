/**
 * arbitration — 混合裁决服务
 * 子Agent 评分 → 主模型仲裁 → AI社会制度校验，三层递进
 * 权重根据模型数量动态调整
 */
import type { AuditFinding, PermissionMode } from '../types/streaming';

export interface ArbitrationResult {
  verdict: 'accept' | 'revise' | 'reject';
  finalScore: number;
  layerScores: {
    subAgent: number;
    mainModel: number;
    society: number;
  };
  findings: AuditFinding[];
  reasoning: string;
}

interface ArbitrationWeights {
  subAgent: number;
  mainModel: number;
  secondary: number;
}

/**
 * 根据模型数量计算权重
 * 1 模型: 子Agent 0.4 + 主模型 0.6
 * 2 模型: 子Agent 0.3 + 主模型 0.5 + 副模型 0.2
 * 3+ 模型: 子Agent 0 + 主模型 0.4 + 副模型 0.6（子Agent不参与，避免混淆）
 */
export function getArbitrationWeights(modelCount: number): ArbitrationWeights {
  switch (modelCount) {
    case 1:
      return { subAgent: 0.4, mainModel: 0.6, secondary: 0 };
    case 2:
      return { subAgent: 0.3, mainModel: 0.5, secondary: 0.2 };
    default:
      return { subAgent: 0, mainModel: 0.4, secondary: 0.6 };
  }
}

/**
 * 执行混合裁决
 */
export function arbitrate(
  subAgentScore: number,
  subAgentFindings: AuditFinding[],
  mainModelScore: number,
  mainModelReasoning: string,
  societyScore: number,
  modelCount: number,
  mode: PermissionMode,
): ArbitrationResult {
  const weights = getArbitrationWeights(modelCount);

  // 全自动模式跳过 AI 社会制度校验
  const effectiveSocietyScore = mode === 'ultimate' ? 1.0 : societyScore;
  const societyWeight = mode === 'ultimate' ? 0 : 0.1;
  const totalMainWeight = mode === 'ultimate'
    ? weights.mainModel + 0.1
    : weights.mainModel;

  const finalScore =
    subAgentScore * weights.subAgent +
    mainModelScore * totalMainWeight +
    effectiveSocietyScore * societyWeight;

  let verdict: 'accept' | 'revise' | 'reject';
  if (finalScore >= 0.8) {
    verdict = 'accept';
  } else if (finalScore >= 0.5) {
    verdict = 'revise';
  } else {
    verdict = 'reject';
  }

  return {
    verdict,
    finalScore: Math.round(finalScore * 100) / 100,
    layerScores: {
      subAgent: subAgentScore,
      mainModel: mainModelScore,
      society: effectiveSocietyScore,
    },
    findings: subAgentFindings,
    reasoning: mainModelReasoning,
  };
}

/**
 * 评估子任务质量（0-1）
 */
export function evaluateSubTaskQuality(findings: AuditFinding[]): number {
  if (findings.length === 0) return 1.0;
  const deductions = findings.reduce((sum, f) => {
    switch (f.severity) {
      case 'error': return sum + 0.3;
      case 'warning': return sum + 0.15;
      case 'info': return sum + 0.05;
      default: return sum;
    }
  }, 0);
  return Math.max(0, 1 - deductions);
}