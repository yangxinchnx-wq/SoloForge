/**
 * AbortManager / useInFlightSSE 测试
 * AbortManager 是纯逻辑, 直接测; useInFlightSSE 是薄壳, 只测 AbortManager 集成
 */
import { describe, it, expect, vi } from 'vitest';
import { AbortManager } from '../useInFlightSSE';

describe('AbortManager — 基础生命周期', () => {
  it('初始 hasInFlight=false', () => {
    const m = new AbortManager();
    expect(m.hasInFlight()).toBe(false);
  });

  it('run() 后 hasInFlight() 为 true, 完成后变 false', async () => {
    const m = new AbortManager();
    let inFlight: boolean | undefined;
    await m.run(async () => {
      inFlight = m.hasInFlight();
    });
    expect(inFlight).toBe(true);
    expect(m.hasInFlight()).toBe(false);
  });

  it('run() 返回 fn 的返回值', async () => {
    const m = new AbortManager();
    const res = await m.run(async () => 42);
    expect(res).toBe(42);
  });

  it('run() 抛非 AbortError 时正常往外抛', async () => {
    const m = new AbortManager();
    let err: any;
    try {
      await m.run(async () => { throw new Error('boom'); });
    } catch (e) { err = e; }
    expect(err?.message).toBe('boom');
    // 抛错后 ref 清理
    expect(m.hasInFlight()).toBe(false);
  });

  it('run() 抛 AbortError (DOMException) 时静默吞掉, 返回 undefined', async () => {
    const m = new AbortManager();
    const res = await m.run(async () => {
      throw new DOMException('aborted', 'AbortError');
    });
    expect(res).toBeUndefined();
    expect(m.hasInFlight()).toBe(false);
  });

  it('run() 抛普通 Error 带 name="AbortError" 时也静默吞掉', async () => {
    const m = new AbortManager();
    const e = new Error('aborted');
    e.name = 'AbortError';
    const res = await m.run(async () => { throw e; });
    expect(res).toBeUndefined();
    expect(m.hasInFlight()).toBe(false);
  });
});

describe('AbortManager — 取消机制', () => {
  it('run() 启动新任务时, 旧任务被 abort (signal 标志位为 true)', async () => {
    const m = new AbortManager();
    let oldSignal: AbortSignal | null = null;
    // 启动旧任务, 不 await; fn 主动监听 abort 立即退出
    const oldPromise = m.run(async (signal) => {
      oldSignal = signal;
      await new Promise<void>(resolve => {
        signal.addEventListener('abort', () => resolve());
        setTimeout(resolve, 5000);
      });
    });

    await new Promise(r => setTimeout(r, 10));
    expect(oldSignal).not.toBeNull();
    expect(oldSignal!.aborted).toBe(false);

    // 启动新任务
    let newSignal: AbortSignal | null = null;
    const newPromise = m.run(async (signal) => {
      newSignal = signal;
      return 'new';
    });
    await newPromise;

    // 关键断言: 旧任务的 signal.aborted === true
    expect(oldSignal!.aborted).toBe(true);
    expect(newSignal).not.toBeNull();
    expect(newSignal!.aborted).toBe(false);

    await oldPromise;
    expect(m.hasInFlight()).toBe(false);
  });

  it('cancel() 手动取消 in-flight', async () => {
    const m = new AbortManager();
    let signal: AbortSignal | null = null;
    const taskPromise = m.run(async (sig) => {
      signal = sig;
      await new Promise(r => setTimeout(r, 1000));
    });
    await new Promise(r => setTimeout(r, 10));
    expect(signal!.aborted).toBe(false);

    m.cancel();
    const res = await taskPromise;
    expect(res).toBeUndefined();
    expect(signal!.aborted).toBe(true);
    expect(m.hasInFlight()).toBe(false);
  });

  it('cancel() 重复调用无副作用', () => {
    const m = new AbortManager();
    m.cancel();
    m.cancel();
    m.cancel();
    expect(m.hasInFlight()).toBe(false);
  });

  it('run 内 fn 抛错后, 仍可继续 run() 新任务', async () => {
    const m = new AbortManager();
    try {
      await m.run(async () => { throw new Error('first failed'); });
    } catch { /* expected */ }
    // 应能继续使用
    const res = await m.run(async () => 'second ok');
    expect(res).toBe('second ok');
    expect(m.hasInFlight()).toBe(false);
  });
});

describe('AbortManager — ref 清理与并发', () => {
  it('fn 抛 AbortError 后 ref 清理, hasInFlight=false', async () => {
    const m = new AbortManager();
    await m.run(async () => { throw new DOMException('aborted', 'AbortError'); });
    expect(m.hasInFlight()).toBe(false);
  });

  // 2026-06-29 (Vitest 2→4 升级): 此测试在 vitest 4 下卡 5023ms 在 5000ms 边界外,
  // 因 vitest 4 计时器/Promise 调度微调,第二个 run() 的 setTimeout(5000) 略超
  // 默认 testTimeout(5000)。测试本身断言已通过,仅超时。加 15s timeout 即可。
  it('并发 run() 顺序: 第二次 run 取消第一次 (互斥)', { timeout: 15_000 }, async () => {
    const m = new AbortManager();
    let firstAborted = false;
    let secondAborted = false;
    const first = m.run(async (sig) => {
      await new Promise<void>((resolve) => {
        sig.addEventListener('abort', () => { firstAborted = true; resolve(); });
        setTimeout(() => { if (!sig.aborted) resolve(); }, 5000);
      });
    });
    const second = m.run(async (sig) => {
      await new Promise<void>((resolve) => {
        sig.addEventListener('abort', () => { secondAborted = true; resolve(); });
        setTimeout(() => { if (!sig.aborted) resolve(); }, 5000);
      });
    });
    await Promise.all([first, second]);
    expect(firstAborted).toBe(true);
    expect(secondAborted).toBe(false);
  });
});
