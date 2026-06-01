/**
 * 数据归档服务测试脚本
 * 用法: npx tsx scripts/test-archiver.ts
 */

import { DataArchiverService } from '../src/data/data-archiver';
import { SurrealPersistence } from '../src/data/surreal_persistence';

async function main() {
  console.log('🧪 数据归档服务测试\n');

  const surreal = new SurrealPersistence();
  const archiver = new DataArchiverService(surreal, 60000); // 1分钟检查间隔

  // 1. 测试记录访问
  console.log('--- 测试 1: 记录访问 ---');
  const table = 'conversation';
  const id = 'test_conv_001';

  await archiver.recordAccess(table, id);
  console.log(`第1次访问: ${await archiver.getCallCount(table, id)}`);

  await archiver.recordAccess(table, id);
  console.log(`第2次访问: ${await archiver.getCallCount(table, id)}`);

  await archiver.recordAccess(table, id);
  console.log(`第3次访问: ${await archiver.getCallCount(table, id)}`);

  await archiver.recordAccess(table, id);
  console.log(`第4次访问: ${await archiver.getCallCount(table, id)}`);

  // 2. 测试冷热数据判定
  console.log('\n--- 测试 2: 冷热数据判定 ---');
  const callCount = await archiver.getCallCount(table, id);
  if (callCount < 5) {
    console.log(`❄️ 冷数据: 24h内调用 ${callCount} 次 < 5 → 将归档到 JSONL`);
  } else {
    console.log(`🔥 热数据: 24h内调用 ${callCount} 次 ≥ 5 → 保留在 SurrealDB`);
  }

  // 3. 模拟再调用一次达到阈值
  await archiver.recordAccess(table, id);
  const finalCount = await archiver.getCallCount(table, id);
  console.log(`\n第5次访问后: ${finalCount} 次`);
  if (finalCount >= 5) {
    console.log(`🔥 热数据: 24h内调用 ${finalCount} 次 ≥ 5 → 保留在 SurrealDB`);
  }

  // 4. 测试运行归档检查
  console.log('\n--- 测试 3: 运行归档检查 ---');
  const stats = await archiver.runArchiveCheck();
  console.log('归档统计:', stats);

  // 5. 测试同步删除
  console.log('\n--- 测试 4: 同步删除 ---');
  await archiver.syncDelete('conversation', 'test_conv_001');
  console.log('✅ 同步删除完成 (SurrealDB + JSONL + Garnet计数器)');

  // 清理
  archiver.stop();
  console.log('\n✅ 所有测试完成!');
}

main().catch(console.error);
