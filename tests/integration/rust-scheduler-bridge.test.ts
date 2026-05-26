import { describe, it, expect, afterAll } from 'vitest';
import { GeminiRustSchedulerClient } from '../../src/kernel/scheduler-client';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('SoloForge Layer 4 Rust 高性能调度内核跨语言管道集成测试套件', () => {
  const client = new GeminiRustSchedulerClient();
  client.initialize();

  afterAll(() => {
    client.shutdown();
  });

  it('验证点 1：[Stdio管道高频握手] 必须成功通过 PING 握手验证 Rust 原生进程的存在', async () => {
    const isAlive = await client.ping();
    expect(isAlive).toBe(true);
  });

  it('验证点 2：[跨语言全生命周期重排自愈] 连续打入不同权重智能体任务，验证真实时间轴下的 Aging 老化反超机制', async () => {
    // 1. 推入一个基础分很高（50分）、但完全不老化的傲慢任务
    await client.pushTask('arrogant_task_a', 50, 0.0);
    
    // 2. 推入一个初始分极低（仅5分）、但老化速度极快（每秒飙升5000分）的饥饿任务
    await client.pushTask('patient_task_b', 5, 5000.0);

    // 3. 故意在 TS 侧让物理时间真实流逝 30 毫秒
    await delay(30);

    // 4. 物理弹出：时间自愈起效，B 节点必须突破压制、率先被弹出！
    const firstOut = await client.popTask();
    expect(firstOut).toBe('patient_task_b');

    // 5. 随后的普通任务弹出
    const secondOut = await client.popTask();
    expect(secondOut).toBe('arrogant_task_a');

    // 6. 队列归空
    const emptyOut = await client.popTask();
    expect(emptyOut).toBeNull();
  });
});