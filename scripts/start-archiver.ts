/**
 * 归档服务独立启动脚本
 * 用法: npm run archiver:start
 *
 * 独立运行归档服务，定时检查冷热数据
 */

import { DataArchiverService } from '../src/data/data-archiver';
import { SurrealPersistence } from '../src/data/surreal_persistence';
import { connect as garnetConnect, disconnect as garnetDisconnect } from '../src/data/garnet/index';

async function main() {
  console.log('🚀 SoloForge 数据归档服务启动\n');
  console.log('规则:');
  console.log('  - 24小时内调用 < 5次 → 归档到 JSONL');
  console.log('  - 24小时内调用 ≥ 5次 → 保留在 SurrealDB');
  console.log('  - 用户删除 → SurrealDB + JSONL 同步删除\n');

  try {
    // 1. 连接 Garnet（用于计数器）
    console.log('🔄 连接 Garnet...');
    await garnetConnect();
    console.log('✅ Garnet 已连接\n');

    // 2. 创建 SurrealDB 实例
    console.log('🔄 连接 SurrealDB...');
    const surreal = new SurrealPersistence();
    // 注意：这里需要手动设置驱动，在完整系统中由 kernel 注入
    console.log('✅ SurrealDB 已初始化\n');

    // 3. 创建并启动归档服务（每 5 分钟检查一次）
    const archiver = new DataArchiverService(surreal, 5 * 60 * 1000);
    archiver.start();

    console.log('📊 归档服务已启动，每 5 分钟检查一次\n');

    // 4. 立即运行一次检查
    console.log('🔄 立即运行首次归档检查...');
    await archiver.runArchiveCheck();
    console.log('');

    // 5. 优雅关闭处理
    const shutdown = async () => {
      console.log('\n🛑 正在关闭归档服务...');
      archiver.stop();
      await garnetDisconnect();
      console.log('✅ 已关闭');
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

  } catch (err: any) {
    console.error('❌ 启动失败:', err.message);
    process.exit(1);
  }
}

main();
