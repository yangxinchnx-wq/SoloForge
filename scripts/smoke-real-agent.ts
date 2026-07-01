/**
 * smoke-real-agent.ts — 真实 Agent 烟雾测试
 *
 * 前置条件:
 *   设置环境变量 SOLOFORGE_LLM_API_KEY (或在 UI 设置中配置 provider)
 *
 * 运行:
 *   npx tsx scripts/smoke-real-agent.ts
 *
 * 测试内容:
 *   1. 创建 backend-expert Agent
 *   2. 让它读取项目结构
 *   3. 让它生成一个简单的 API 文件
 *   4. 验证文件是否真的被创建
 */

import { SpecializedAgent, type SpecializedAgentConfig } from '../src/core/agent/specialized-agent';

const BACKEND_EXPERT_CONFIG: SpecializedAgentConfig = {
  agentId: 'backend-expert',
  domain: 'backend',
  level: 'expert',
  role: '后端架构专家',
  capabilities: [
    'RESTful API 设计',
    'Express/Fastify 路由',
    '中间件设计',
    '数据库集成',
    '错误处理',
    '认证授权',
  ],
  defaultStrategy: 'deep-analysis',
  systemPrompt: `你是一位资深后端架构专家，擅长设计和实现高质量的后端 API。

你的工作风格：
- 先理解项目现有结构和约定，再动手写代码
- 遵循项目已有的代码风格和架构模式
- 生成的代码必须是可运行的，不能有语法错误
- 每个 API 端点都要有适当的错误处理和输入验证

你正在为 SoloForge 项目工作，这是一个 TypeScript + Express + SurrealDB 的后端系统。`,
};

async function main() {
  console.log('='.repeat(60));
  console.log('  SoloForge Real Agent Smoke Test');
  console.log('='.repeat(60));

  // 检查 LLM 配置
  const { getLLMProxyConfig, isLLMProxyReady } = await import('../src/llm/llmConfig');
  const cfg = getLLMProxyConfig();

  console.log(`\nLLM Config:`);
  console.log(`  Provider: ${cfg.provider}`);
  console.log(`  Base URL: ${cfg.baseUrl}`);
  console.log(`  Model: ${cfg.defaultModel}`);
  console.log(`  API Key: ${cfg.apiKey ? '***' + cfg.apiKey.slice(-4) : 'NOT SET'}`);
  console.log(`  Ready: ${isLLMProxyReady()}`);

  if (!isLLMProxyReady()) {
    console.error('\n❌ LLM not configured. Set SOLOFORGE_LLM_API_KEY env var.');
    console.error('   Example: SOLOFORGE_LLM_API_KEY=sk-xxx npx tsx scripts/smoke-real-agent.ts');
    process.exit(1);
  }

  // 创建 Agent
  const agent = new SpecializedAgent(BACKEND_EXPERT_CONFIG);

  console.log(`\n🤖 Agent created: ${agent.config.agentId} (${agent.config.role})`);
  console.log(`   Domain: ${agent.config.domain}`);
  console.log(`   Level: ${agent.config.level}`);
  console.log(`   Strategy: ${agent.config.defaultStrategy}`);

  // 测试 1: 读取项目结构
  console.log('\n' + '─'.repeat(60));
  console.log('📋 Test 1: Agent 读取项目结构');
  console.log('─'.repeat(60));

  const result1 = await agent.executeTask({
    taskId: 'test-001',
    description: '请列出 src/core/ 目录下的文件结构，告诉我这个项目的后端架构是怎样的。',
    maxRounds: 3,
  });

  console.log(`\n✅ Test 1 结果:`);
  console.log(`   成功: ${result1.success}`);
  console.log(`   工具调用: ${result1.toolCallCount} 次`);
  console.log(`   耗时: ${result1.durationMs}ms`);
  console.log(`   使用工具: ${result1.usedTools}`);
  if (result1.toolSteps.length > 0) {
    console.log(`   工具步骤:`);
    for (const step of result1.toolSteps) {
      console.log(`     ${step.round}. ${step.tool}(${step.args.slice(0, 60)}) → ${step.success ? 'OK' : 'ERROR'}`);
    }
  }
  console.log(`\n   Agent 回答 (前 500 字):\n   ${result1.answer.slice(0, 500).replace(/\n/g, '\n   ')}`);

  // 测试 2: 生成一个简单的 API 文件
  console.log('\n' + '─'.repeat(60));
  console.log('📋 Test 2: Agent 生成 API 文件');
  console.log('─'.repeat(60));

  const testFilePath = 'src/api/test-agent-generated.ts';

  const result2 = await agent.executeTask({
    taskId: 'test-002',
    description: `请创建一个简单的健康检查 API 文件。

要求：
1. 文件路径: ${testFilePath}
2. 使用 Express Router
3. 包含 GET /health 端点，返回 { status: 'ok', timestamp: Date.now() }
4. 包含 GET /version 端点，返回 { version: '1.0.0' }
5. 遵循项目的 TypeScript 风格

请先查看项目中已有的 API 文件作为参考，然后生成代码。`,
    maxRounds: 8,
  });

  console.log(`\n✅ Test 2 结果:`);
  console.log(`   成功: ${result2.success}`);
  console.log(`   工具调用: ${result2.toolCallCount} 次`);
  console.log(`   耗时: ${result2.durationMs}ms`);
  console.log(`   使用工具: ${result2.usedTools}`);
  if (result2.toolSteps.length > 0) {
    console.log(`   工具步骤:`);
    for (const step of result2.toolSteps) {
      console.log(`     ${step.round}. ${step.tool}(${step.args.slice(0, 60)}) → ${step.success ? 'OK' : 'ERROR'}`);
    }
  }

  // 验证文件是否被创建
  const fs = await import('fs/promises');
  try {
    const content = await fs.readFile(testFilePath, 'utf-8');
    console.log(`\n   ✅ 文件已创建: ${testFilePath}`);
    console.log(`   文件内容 (${content.length} 字符):\n`);
    console.log(content.split('\n').map(l => '   ' + l).join('\n'));
  } catch {
    console.log(`\n   ❌ 文件未创建: ${testFilePath}`);
    console.log(`   Agent 可能没有调用 write_file 工具，或写入了其他路径`);
  }

  // 显示 Agent 状态
  console.log('\n' + '─'.repeat(60));
  console.log('📊 Agent 最终状态');
  console.log('─'.repeat(60));
  const status = agent.getStatus();
  console.log(`   Agent ID: ${status.agentId}`);
  console.log(`   任务数: ${status.taskCount}`);
  console.log(`   成功率: ${(status.successRate * 100).toFixed(0)}%`);
  console.log(`   技能库: ${status.skillCount} 条经验`);

  // 清理测试文件
  try {
    await fs.unlink(testFilePath);
    console.log(`\n   🧹 已清理测试文件: ${testFilePath}`);
  } catch { /* 文件不存在也无所谓 */ }

  console.log('\n✅ Smoke test 完成');
}

main().catch(err => {
  console.error('💥 Smoke test failed:', err);
  process.exit(1);
});
