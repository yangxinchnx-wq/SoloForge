/**
 * P8 Garnet Domain Cache 压测验收
 * Path: python/bench/p8_garnet_cache_bench.py  (Node 脚本的 Python wrapper, 实测用 Node)
 * Date: 2026-06-30
 *
 * 对比 cache-aside (Garnet 命中) vs 直读 (模拟 SurrealDB 延迟)
 * 验证 plan §24 P8 标称 "热点读 50x" (0.1ms vs 5ms)
 *
 * 用法:
 *   cd UI && npx tsx src/data/garnet/__bench_p8_domain_cache.ts
 *   # 或:
 *   npx ts-node src/data/garnet/__bench_p8_domain_cache.ts
 *
 * 退出码: 0 = PASS, 1 = FAIL
 */
import { domainCache } from './domain-cache';
import { getClient, healthCheck } from './client';

interface BenchResult {
  scenario: string;
  n: number;
  total_ms: number;
  per_op_us: number;       // 微秒
  p50_us: number;
  p95_us: number;
  p99_us: number;
  speedup?: number;
}

async function benchReadHot(n: number): Promise<BenchResult> {
  // 预热 + 命中: agent:meta:test-agent
  await domainCache.invalidateAgentMeta('test-agent');
  // 第一次: cache miss + loader
  await domainCache.getAgentMeta('test-agent', async () => {
    return { id: 'test-agent', name: 'cached', reputation: 100 };
  });
  // 第 2..n 次: cache hit
  const latencies: number[] = [];
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) {
    const s = process.hrtime.bigint();
    await domainCache.getAgentMeta('test-agent', async () => null);
    const e = process.hrtime.bigint();
    latencies.push(Number(e - s) / 1000);
  }
  const totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
  return mkResult('hot_garnet_hit', n, totalMs, latencies);
}

async function benchReadCold(n: number, fakeDbLatencyMs = 5): Promise<BenchResult> {
  // 直读 (模拟 SurrealDB 5ms 延迟)
  const latencies: number[] = [];
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) {
    const s = process.hrtime.bigint();
    await new Promise((r) => setTimeout(r, fakeDbLatencyMs));
    const e = process.hrtime.bigint();
    latencies.push(Number(e - s) / 1000);
  }
  const totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
  return mkResult(`cold_fake_db_${fakeDbLatencyMs}ms`, n, totalMs, latencies);
}

function mkResult(scenario: string, n: number, totalMs: number, lat: number[]): BenchResult {
  lat.sort((a, b) => a - b);
  const p = (q: number) => lat[Math.min(lat.length - 1, Math.floor(lat.length * q))];
  return {
    scenario,
    n,
    total_ms: round(totalMs, 2),
    per_op_us: round(totalMs * 1000 / n, 2),
    p50_us: round(p(0.5), 1),
    p95_us: round(p(0.95), 1),
    p99_us: round(p(0.99), 1),
  };
}

function round(n: number, d: number): number { return Math.round(n * 10 ** d) / 10 ** d; }

async function main() {
  const ok = await healthCheck().catch(() => false);
  if (!ok) {
    console.error('[FATAL] Garnet 不可达 (6379). 请先启动.');
    process.exit(1);
  }
  console.log('[INFO] Garnet health OK');

  // 清理
  const client = getClient();
  if (client) {
    await client.del('agent:meta:test-agent', 'agent:reputation:test-agent', 'institution:active', 'law:active').catch(() => {});
  }

  const n = 1000;
  const hot = await benchReadHot(n);
  const cold = await benchReadCold(n, 5);
  // speedup = cold_time / hot_time (hot is faster)
  hot.speedup = round(cold.per_op_us / hot.per_op_us, 2);
  cold.speedup = 1;

  const results = [hot, cold];

  console.log('\n=== P8 Garnet Domain Cache 压测结果 ===');
  console.log(`  n = ${n} 次读/场景`);
  for (const r of results) {
    console.log(
      `  ${r.scenario.padEnd(28)} ` +
      `per_op=${String(r.per_op_us).padStart(9)} µs  ` +
      `p50=${String(r.p50_us).padStart(9)} p95=${String(r.p95_us).padStart(9)} p99=${String(r.p99_us).padStart(9)}  ` +
      `speedup=${r.speedup ?? 1}x`,
    );
  }
  const pass = hot.speedup !== undefined && hot.speedup >= 10;
  console.log(`\n[P8 验收] speedup = ${hot.speedup}x  (阈值 10x  →  ${pass ? 'PASS' : 'FAIL'})`);
  console.log(`[INFO] plan §24 P8 标称 50x (0.1ms vs 5ms), 实测 ${hot.speedup}x`);

  // 指标快照
  const stats = await domainCache.stats();
  console.log(`[INFO] garnet keys: ${JSON.stringify(stats)}`);

  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error('[FATAL]', e);
  process.exit(2);
});
