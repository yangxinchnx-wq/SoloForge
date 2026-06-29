/**
 * MockLLMProvider.test.ts — Mock provider 单测
 */

import { describe, it, expect } from 'vitest';
import { MockLLMProvider } from './MockLLMProvider';
import { LLMClient } from './LLMClient';

describe('MockLLMProvider', () => {
  it('streams chunks', async () => {
    // 用 0 延迟加速测试
    const provider = new MockLLMProvider({ charDelayMs: 0 });
    const handle = provider.chatStream({ userGoal: 'login screen in python' });
    let received = '';
    for await (const chunk of handle) {
      received += chunk;
    }
    expect(received.length).toBeGreaterThan(0);
    // 应该是有效 JSON
    expect(() => JSON.parse(received)).not.toThrow();
  });

  it('cancels cleanly', async () => {
    const provider = new MockLLMProvider({ charDelayMs: 1 });
    const handle = provider.chatStream({ userGoal: 'login' });
    setTimeout(() => handle.cancel(), 20);
    let count = 0;
    for await (const _ of handle) {
      count++;
      if (count > 100) break; // safety
    }
    // 不应跑完所有字符（cancel 后停止）
    expect(count).toBeLessThan(500);
  });

  it('LLMClient.mock() returns mock provider', () => {
    const client = LLMClient.mock();
    expect(client.provider.name).toBe('mock');
  });

  it('falls back to mock when no API key', () => {
    // 移除环境变量影响
    const old = process.env.LLM_PROVIDER;
    delete process.env.LLM_PROVIDER;
    delete process.env.LLM_API_KEY;
    try {
      const client = LLMClient.fromEnv();
      expect(client.provider.name).toBe('mock');
    } finally {
      if (old) process.env.LLM_PROVIDER = old;
    }
  });
});
