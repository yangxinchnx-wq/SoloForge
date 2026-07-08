import { describe, it, expect } from 'vitest';
import type { EscalationVerdict } from '../../src/core/court/llm_escalation';

describe('EscalationVerdict Interface', () => {
  it('should have required properties with correct types', () => {
    const verdict: EscalationVerdict = {
      verdictId: 'verd_test_12345678901234',
      finalWinner: 'agent-alpha-fast-edge',
      sanctionedLoser: 'agent-gamma-sybil-intruder',
      adjudicationReason: 'Fraud poison tokens detected in evidence',
      confidenceScore: 0.99,
      kernelVersionSeal: 1,
      timestamp: Date.now(),
    };

    expect(verdict.verdictId).toBe('verd_test_12345678901234');
    expect(verdict.finalWinner).toBe('agent-alpha-fast-edge');
    expect(verdict.sanctionedLoser).toBe('agent-gamma-sybil-intruder');
    expect(verdict.adjudicationReason).toBe('Fraud poison tokens detected in evidence');
    expect(verdict.confidenceScore).toBe(0.99);
    expect(verdict.kernelVersionSeal).toBe(1);
    expect(verdict.timestamp).toBeTypeOf('number');
  });

  it('should allow null for finalWinner and sanctionedLoser', () => {
    const verdict: EscalationVerdict = {
      verdictId: 'verd_test_unknown',
      finalWinner: null,
      sanctionedLoser: null,
      adjudicationReason: 'Unable to determine winner',
      confidenceScore: 0.5,
      kernelVersionSeal: 0,
      timestamp: Date.now(),
    };

    expect(verdict.finalWinner).toBeNull();
    expect(verdict.sanctionedLoser).toBeNull();
  });

  it('should have confidenceScore between 0 and 1', () => {
    const verdict: EscalationVerdict = {
      verdictId: 'verd_test_confidence',
      finalWinner: 'agent-alpha',
      sanctionedLoser: 'agent-beta',
      adjudicationReason: 'Test',
      confidenceScore: 0.85,
      kernelVersionSeal: 1,
      timestamp: Date.now(),
    };

    expect(verdict.confidenceScore).toBeGreaterThanOrEqual(0);
    expect(verdict.confidenceScore).toBeLessThanOrEqual(1);
  });

  it('should have valid verdictId format', () => {
    const verdict: EscalationVerdict = {
      verdictId: 'verd_2nd_abc123def456789',
      finalWinner: 'agent-alpha',
      sanctionedLoser: 'agent-beta',
      adjudicationReason: 'Test',
      confidenceScore: 0.99,
      kernelVersionSeal: 1,
      timestamp: Date.now(),
    };

    expect(verdict.verdictId).toMatch(/^verd_/);
  });

  it('should have positive kernelVersionSeal', () => {
    const verdict: EscalationVerdict = {
      verdictId: 'verd_test_version',
      finalWinner: 'agent-alpha',
      sanctionedLoser: 'agent-beta',
      adjudicationReason: 'Test',
      confidenceScore: 0.99,
      kernelVersionSeal: 42,
      timestamp: Date.now(),
    };

    expect(verdict.kernelVersionSeal).toBeGreaterThan(0);
  });
});
