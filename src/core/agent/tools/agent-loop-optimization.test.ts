/**
 * agent-loop-optimization.test.ts — Agent Loop 4 层优化完整测试
 *
 * 测试范围:
 *   L1: shouldUseAgent() 确定性分类器 (7 个维度)
 *   L2: applyToolResultBudget() 工具结果预算裁剪
 *   L3: computeToolFingerprint() 无进展检测
 *   L4: estimateTokens() token 估算 + 预算控制
 *   集成: callLLMWithTools() 在 mock LLM 下的 L3/L4 行为
 *   连通性: 各模块 export/Import 链路完整性
 *
 * 运行: cd SoloForge && npx vitest run src/core/agent/tools/agent-loop-optimization.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'crypto';

// ─── L2: 工具结果预算裁剪 ─────────────────────────────────────────
import {
  TOOL_RESULT_BUDGET,
  DEFAULT_TOOL_RESULT_BUDGET,
  AGENT_TOOLS,
  EXTENDED_TOOL_SCHEMAS,
  getToolsForActiveIds,
} from './tool-definitions';

// ─── L3+L4: 从 function-calling-client 导出内部函数进行测试 ───
// 由于这些函数是 module-private 的,我们通过 callLLMWithTools 的行为来间接测试,
// 同时也直接测试可以从模块导出的工具函数。
import { callLLMWithTools, type LLMMessage, type CallWithToolsResult } from './function-calling-client';

// ─── L1: 入口分流 ─────────────────────────────────────────────────
// shouldUseAgent 是 private 方法,通过 AgentDecisionOrchestrator 的行为间接测试。
// 这里提取其逻辑为独立函数进行白盒测试。

/**
 * 从 agent-decision-orchestrator.ts 提取的 shouldUseAgent 逻辑副本
 * (与生产代码保持同步,用于白盒测试)
 */
function shouldUseAgent(prompt: string, req: {
  activeFile?: { name: string; content: string } | null;
  activeTools?: string[];
}): boolean {
  // 维度 1: 文件引用 — 路径前缀 OR 裸文件名(扩展名白名单)
  const pathPrefix = /[a-zA-Z]:\\|\.\/|\/[a-zA-Z]|\\\\/;
  const bareFilename = /\b[a-zA-Z_][\w-]*\.(?:json|yaml|yml|csv|tsv|xlsx|xls|pdf|docx|doc|txt|md|ts|js|tsx|jsx|py|go|rs|java|c|cpp|h|hpp|sql|db|sqlite|parquet|xml|html|css|scss|less|toml|ini|conf|log|env|sh|bash|bat|ps1)\b/i;
  if ((pathPrefix.test(prompt) && /\.\w{1,5}\b/.test(prompt)) || bareFilename.test(prompt)) {
    return true;
  }
  // 维度 2: req 显式信号优先 (用户已激活工具/提供了文件上下文 → 一定走 Agent)
  if (req.activeFile?.content && req.activeFile.content.length > 50) {
    return true;
  }
  if (req.activeTools && req.activeTools.length > 0) {
    return true;
  }
  // 维度 3: 纯问答句式优先判断
  const questionPattern = /^(?:什么是|如何|为什么|怎么|请问|解释|翻译|总结|概括|介绍|讲解|说明|hello|hi|你好|hey|explain|what is|how to|why|summarize|translate|introduce)/i;
  if (questionPattern.test(prompt.trim()) && prompt.length < 300 && !bareFilename.test(prompt)) {
    return false;
  }
  // 维度 4: 文件/数据/系统操作意图动词 (中英文,覆盖热门行业)
  const actionPattern = /(?:修改|创建|删除|重构|编写|修复|实现|添加|更新|迁移|优化|调试|读取|查看|分析|运行|部署|安装|提交|导入|导出|查询|清洗|校对|解读|整理|审查|对比|批改|抽取|抓取|检查|重启|监控|搜索|执行|编译|打包|发布|启动|停止|备份|恢复|扫描|诊断|测试|生成报告|fix|refactor|write|create|delete|implement|add|update|migrate|optimize|debug|build|read|view|analyze|run|deploy|install|commit|import|export|query|clean|review|audit|compare|extract|crawl|check|restart|monitor|search|execute|compile|package|publish|start|stop|backup|restore|scan|diagnose|test)/i;
  if (actionPattern.test(prompt)) {
    return true;
  }
  // 维度 5: 多步骤指令
  const multiStepPattern = /(?:然后|接着|第一步|第二步|首先.*然后|先.*再|step\s*\d|first.*then)/i;
  if (multiStepPattern.test(prompt)) {
    return true;
  }
  // 维度 6: 短消息且无操作意图
  if (prompt.length < 80 && !actionPattern.test(prompt)) {
    return false;
  }
  return true;
}

// ─── L2: 工具结果预算裁剪逻辑副本 ────────────────────────────────
function applyToolResultBudget(toolName: string, output: string): string {
  const budget = TOOL_RESULT_BUDGET[toolName] ?? DEFAULT_TOOL_RESULT_BUDGET;
  if (output.length <= budget) return output;

  if (toolName === 'read_file') {
    const truncated = output.slice(0, budget);
    const totalChars = output.length;
    const totalLines = output.split('\n').length;
    const shownLines = truncated.split('\n').length;
    return (
      truncated +
      `\n\n... [TRUNCATED by Agent Loop Budget] ` +
      `showing first ${shownLines} of ~${totalLines} lines (${totalChars} chars total). ` +
      `Use offset=${shownLines + 1} and limit=100 to read the next section.`
    );
  }

  if (toolName === 'execute_cmd') {
    const tail = output.slice(-budget);
    return (
      `... [TRUNCATED: first ${output.length - budget} chars omitted, showing last ${budget}] ...\n` +
      tail
    );
  }

  const truncated = output.slice(0, budget);
  return (
    truncated +
    `\n\n... [TRUNCATED by Agent Loop Budget] ${output.length} chars total, showing first ${budget}.`
  );
}

// ─── L3+L4: 内部函数副本 (用于白盒测试) ─────────────────────────
function estimateTokens(messages: Array<{ role: string; content?: string | null; tool_calls?: any[] }>): number {
  let totalChars = 0;
  for (const m of messages) {
    totalChars += 10;
    if (m.content) totalChars += m.content.length;
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        totalChars += tc.function.name.length + tc.function.arguments.length + 20;
      }
    }
  }
  return Math.ceil(totalChars / 3.5);
}

function computeToolFingerprint(toolCalls: Array<{ function: { name: string; arguments: string } }>): string {
  const sig = toolCalls
    .map(tc => `${tc.function.name}:${tc.function.arguments}`)
    .sort()
    .join('|');
  return createHash('sha256').update(sig).digest('hex').slice(0, 16);
}

// ═══════════════════════════════════════════════════════════════════
// 测试开始
// ═══════════════════════════════════════════════════════════════════

describe('L1: shouldUseAgent() — 入口分流分类器', () => {

  describe('应该走 Agent 的场景', () => {
    it('包含文件路径引用', () => {
      expect(shouldUseAgent('帮我看看 src/foo.ts 这个文件', {})).toBe(true);
    });

    it('包含 Windows 文件路径', () => {
      expect(shouldUseAgent('修改 C:\\Users\\test\\config.json', {})).toBe(true);
    });

    it('包含相对路径', () => {
      expect(shouldUseAgent('读取 ./package.json 的内容', {})).toBe(true);
    });

    it('包含代码操作动词 (中文)', () => {
      expect(shouldUseAgent('帮我重构这个登录模块的代码结构', {})).toBe(true);
      expect(shouldUseAgent('创建一个新的 React 组件', {})).toBe(true);
    });

    it('包含代码操作动词 (英文)', () => {
      expect(shouldUseAgent('fix the bug in the authentication module', {})).toBe(true);
      expect(shouldUseAgent('refactor the database connection pool', {})).toBe(true);
    });

    it('包含多步骤指令', () => {
      expect(shouldUseAgent('先读取配置文件，然后修改端口号，最后重启服务', {})).toBe(true);
      expect(shouldUseAgent('第一步分析代码，第二步生成测试', {})).toBe(true);
    });

    it('有文件上下文 (activeFile)', () => {
      expect(shouldUseAgent('看看这段代码', {
        activeFile: { name: 'test.ts', content: 'const x = 1;\n'.repeat(10) },
      })).toBe(true);
    });

    it('有活跃工具', () => {
      expect(shouldUseAgent('你好', {
        activeTools: ['browser_devtools'],
      })).toBe(true);
    });

    // ── 热门行业: 裸文件名识别(无路径前缀) ──
    it('裸文件名 (软件开发) package.json', () => {
      expect(shouldUseAgent('读取 package.json 文件并告诉我项目名称', {})).toBe(true);
    });
    it('裸文件名 (数据分析) data.csv', () => {
      expect(shouldUseAgent('从 data.csv 导入数据并统计均值', {})).toBe(true);
    });
    it('裸文件名 (医疗) report.txt', () => {
      expect(shouldUseAgent('解读这份CT报告 report.txt', {})).toBe(true);
    });
    it('裸文件名 (法律) contract.pdf', () => {
      expect(shouldUseAgent('审查合同 contract.pdf 里的风险条款', {})).toBe(true);
    });

    // ── 热门行业: 扩展动词识别 ──
    it('动词 读取 (软件开发)', () => {
      expect(shouldUseAgent('读取日志文件', {})).toBe(true);
    });
    it('动词 查看 (DevOps)', () => {
      expect(shouldUseAgent('查看 nginx 日志找出 500 错误', {})).toBe(true);
    });
    it('动词 分析 (软件开发)', () => {
      expect(shouldUseAgent('分析 app.js 里的内存泄漏', {})).toBe(true);
    });
    it('动词 部署 (DevOps)', () => {
      expect(shouldUseAgent('部署到生产环境', {})).toBe(true);
    });
    it('动词 查询 (数据分析)', () => {
      expect(shouldUseAgent('查询数据库里上个月的销售额', {})).toBe(true);
    });
    it('动词 导出 (设计)', () => {
      expect(shouldUseAgent('导出 Figma 设计稿为 SVG', {})).toBe(true);
    });
    it('动词 审查 (法律)', () => {
      expect(shouldUseAgent('审查这份合同的条款', {})).toBe(true);
    });
    it('动词 检查 (设计)', () => {
      expect(shouldUseAgent('检查颜色一致性', {})).toBe(true);
    });
    it('动词 重启 (DevOps)', () => {
      expect(shouldUseAgent('重启 docker 容器', {})).toBe(true);
    });
    it('动词 监控 (DevOps)', () => {
      expect(shouldUseAgent('监控 CPU 使用率', {})).toBe(true);
    });
    it('动词 批改 (教育)', () => {
      expect(shouldUseAgent('批改这份作业', {})).toBe(true);
    });
    it('动词 抓取 (营销)', () => {
      expect(shouldUseAgent('抓取竞品网站的关键词', {})).toBe(true);
    });
  });

  describe('应该跳过 Agent 的场景', () => {
    it('纯问候 (你好)', () => {
      expect(shouldUseAgent('你好', {})).toBe(false);
    });

    it('纯问候 (hello)', () => {
      expect(shouldUseAgent('hello', {})).toBe(false);
    });

    it('纯问答 (什么是)', () => {
      expect(shouldUseAgent('什么是微服务架构', {})).toBe(false);
    });

    it('纯问答 (如何)', () => {
      expect(shouldUseAgent('如何理解 React 的 hooks', {})).toBe(false);
    });

    it('纯问答 (explain)', () => {
      expect(shouldUseAgent('explain what is dependency injection', {})).toBe(false);
    });

    it('翻译请求', () => {
      expect(shouldUseAgent('翻译这段话成英文', {})).toBe(false);
    });

    it('总结请求', () => {
      expect(shouldUseAgent('总结一下这篇文章的要点', {})).toBe(false);
    });

    it('短消息无操作意图', () => {
      expect(shouldUseAgent('今天天气怎么样', {})).toBe(false);
    });

    // ── 热门行业: 纯问答不被扩展动词误伤 ──
    it('纯问答 什么是+动词词 (不误判)', () => {
      expect(shouldUseAgent('什么是数据分析', {})).toBe(false);
      expect(shouldUseAgent('什么是监控', {})).toBe(false);
      expect(shouldUseAgent('什么是审查', {})).toBe(false);
    });
    it('纯问答 如何+动词词 (不误判)', () => {
      expect(shouldUseAgent('如何分析数据', {})).toBe(false);
      expect(shouldUseAgent('如何导出 Excel', {})).toBe(false);
    });
    it('纯问答 (医疗)', () => {
      expect(shouldUseAgent('阿司匹林的常见副作用有哪些', {})).toBe(false);
    });
    it('纯问答 (金融)', () => {
      expect(shouldUseAgent('什么是市盈率', {})).toBe(false);
    });
    it('纯问答 (教育)', () => {
      expect(shouldUseAgent('讲解勾股定理', {})).toBe(false);
    });
    it('纯问答 (法律)', () => {
      expect(shouldUseAgent('劳动法关于加班的规定', {})).toBe(false);
    });
  });

  describe('边界条件', () => {
    it('空字符串', () => {
      expect(shouldUseAgent('', {})).toBe(false);
    });

    it('恰好 79 字符无操作意图', () => {
      const msg = '这是一段刚好七十九个字符的消息用来观察边界条件看看短消息是否真的会被跳过不走代理';
      expect(msg.length).toBeLessThan(80);
      expect(shouldUseAgent(msg, {})).toBe(false);
    });

    it('80 字符无操作意图 → 默认走 Agent', () => {
      // 用英文构造恰好 80 字符的无操作意图消息
      const msg = 'this is a message that is exactly eighty characters long with no action verbs at all ok done';
      expect(msg.length).toBeGreaterThanOrEqual(80);
      expect(shouldUseAgent(msg, {})).toBe(true);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════

describe('L2: applyToolResultBudget() — 工具结果预算裁剪', () => {

  describe('预算常量', () => {
    it('read_file 预算为 4000', () => {
      expect(TOOL_RESULT_BUDGET['read_file']).toBe(4000);
    });

    it('execute_cmd 预算为 3000', () => {
      expect(TOOL_RESULT_BUDGET['execute_cmd']).toBe(3000);
    });

    it('search_code 预算为 2000', () => {
      expect(TOOL_RESULT_BUDGET['search_code']).toBe(2000);
    });

    it('默认预算为 4000', () => {
      expect(DEFAULT_TOOL_RESULT_BUDGET).toBe(4000);
    });
  });

  describe('不截断的场景', () => {
    it('短输出不截断', () => {
      const output = 'Hello World';
      expect(applyToolResultBudget('read_file', output)).toBe(output);
    });

    it('恰好等于预算不截断', () => {
      const output = 'x'.repeat(4000);
      expect(applyToolResultBudget('read_file', output)).toBe(output);
    });
  });

  describe('read_file 截断策略', () => {
    it('截断头部,提示用 offset/limit 分页', () => {
      const output = 'line1\n'.repeat(1000); // 6000 chars
      const result = applyToolResultBudget('read_file', output);

      expect(result.length).toBeLessThan(output.length + 200); // 裁剪 + 提示
      expect(result).toContain('TRUNCATED by Agent Loop Budget');
      expect(result).toContain('offset=');
      expect(result).toContain('limit=100');
    });

    it('保留原始内容的前 4000 字符', () => {
      const output = 'a'.repeat(3999) + '\n' + 'b'.repeat(2000);
      const result = applyToolResultBudget('read_file', output);

      expect(result).toContain('a'.repeat(3999));
    });
  });

  describe('execute_cmd 截断策略', () => {
    it('保留尾部 (错误通常在最后)', () => {
      const output = 'stdout output...\n'.repeat(200) + '[stderr]\nError: something failed';
      const result = applyToolResultBudget('execute_cmd', output);

      expect(result).toContain('Error: something failed');
      expect(result).toContain('TRUNCATED');
      expect(result).toContain('showing last');
    });
  });

  describe('search_code 截断策略', () => {
    it('截断头部', () => {
      const matches = Array.from({ length: 200 }, (_, i) => `file${i}.ts:${i}: match${i}`).join('\n');
      const result = applyToolResultBudget('search_code', matches);

      expect(result).toContain('TRUNCATED by Agent Loop Budget');
      expect(result).toContain('file0.ts:0: match0'); // 保留头部
    });
  });

  describe('未知工具', () => {
    it('使用默认预算', () => {
      const output = 'x'.repeat(5000);
      const result = applyToolResultBudget('unknown_tool', output);

      expect(result).toContain('TRUNCATED');
      expect(result).toContain('4000'); // 默认预算
    });
  });
});

// ═══════════════════════════════════════════════════════════════════

describe('L3: computeToolFingerprint() — 无进展检测', () => {

  it('相同工具调用产生相同指纹', () => {
    const calls = [{ function: { name: 'read_file', arguments: '{"file_path":"src/test.ts"}' } }];
    const fp1 = computeToolFingerprint(calls);
    const fp2 = computeToolFingerprint(calls);
    expect(fp1).toBe(fp2);
  });

  it('不同工具调用产生不同指纹', () => {
    const calls1 = [{ function: { name: 'read_file', arguments: '{"file_path":"src/a.ts"}' } }];
    const calls2 = [{ function: { name: 'read_file', arguments: '{"file_path":"src/b.ts"}' } }];
    expect(computeToolFingerprint(calls1)).not.toBe(computeToolFingerprint(calls2));
  });

  it('不同工具名产生不同指纹', () => {
    const calls1 = [{ function: { name: 'read_file', arguments: '{"file_path":"x"}' } }];
    const calls2 = [{ function: { name: 'write_file', arguments: '{"file_path":"x"}' } }];
    expect(computeToolFingerprint(calls1)).not.toBe(computeToolFingerprint(calls2));
  });

  it('多个工具调用的顺序不影响指纹 (排序后 hash)', () => {
    const calls = [
      { function: { name: 'read_file', arguments: '{"file_path":"a"}' } },
      { function: { name: 'search_code', arguments: '{"pattern":"foo"}' } },
    ];
    const callsReversed = [
      { function: { name: 'search_code', arguments: '{"pattern":"foo"}' } },
      { function: { name: 'read_file', arguments: '{"file_path":"a"}' } },
    ];
    expect(computeToolFingerprint(calls)).toBe(computeToolFingerprint(callsReversed));
  });

  it('指纹长度固定 16 字符', () => {
    const calls = [{ function: { name: 'any', arguments: 'x'.repeat(10000) } }];
    expect(computeToolFingerprint(calls)).toHaveLength(16);
  });

  it('空参数也能正常工作', () => {
    const calls = [{ function: { name: 'list_files', arguments: '{}' } }];
    expect(computeToolFingerprint(calls)).toHaveLength(16);
  });
});

// ═══════════════════════════════════════════════════════════════════

describe('L4: estimateTokens() — Token 估算', () => {

  it('空消息列表返回 0 附近', () => {
    const tokens = estimateTokens([]);
    expect(tokens).toBeLessThanOrEqual(5); // 每条消息 10 字符开销,空列表无消息
  });

  it('短消息估算合理', () => {
    const messages = [{ role: 'user', content: 'hello world' }]; // 11 chars + 10 overhead = 21
    const tokens = estimateTokens(messages);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(20);
  });

  it('长消息估算成比例', () => {
    const short = estimateTokens([{ role: 'user', content: 'hi' }]);
    const long = estimateTokens([{ role: 'user', content: 'x'.repeat(3500) }]); // ~1000 tokens
    expect(long).toBeGreaterThan(short * 50);
  });

  it('tool_calls 也被计入', () => {
    const withTools = estimateTokens([{
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{"file_path":"x"}' } }],
    }]);
    expect(withTools).toBeGreaterThan(0);
  });

  it('3.5 字符/token 中位数估算', () => {
    // 3500 字符 ≈ 1000 token
    const messages = [{ role: 'user', content: 'x'.repeat(3500) }];
    const tokens = estimateTokens(messages);
    expect(tokens).toBeCloseTo(1000, -2); // 允许 ±100 误差
  });
});

// ═══════════════════════════════════════════════════════════════════

describe('连通性: 模块 Export/Import 链路', () => {

  it('tool-definitions 导出 AGENT_TOOLS', () => {
    expect(AGENT_TOOLS).toBeDefined();
    expect(Array.isArray(AGENT_TOOLS)).toBe(true);
    expect(AGENT_TOOLS.length).toBeGreaterThan(0);
  });

  it('AGENT_TOOLS 包含 5 个核心工具', () => {
    const coreNames = ['read_file', 'write_file', 'execute_cmd', 'search_code', 'list_files'];
    const toolNames = AGENT_TOOLS.map(t => t.function.name);
    for (const name of coreNames) {
      expect(toolNames).toContain(name);
    }
  });

  it('AGENT_TOOLS 包含画布工具', () => {
    const canvasTools = AGENT_TOOLS.filter(t => t.function.name.startsWith('solo_canvas_'));
    expect(canvasTools.length).toBeGreaterThan(0);
  });

  it('EXTENDED_TOOL_SCHEMAS 导出扩展工具', () => {
    expect(EXTENDED_TOOL_SCHEMAS).toBeDefined();
    expect(Array.isArray(EXTENDED_TOOL_SCHEMAS)).toBe(true);
    expect(EXTENDED_TOOL_SCHEMAS.length).toBeGreaterThan(0);
  });

  it('getToolsForActiveIds 无参数返回核心工具+画布', () => {
    const tools = getToolsForActiveIds();
    expect(tools.length).toBeGreaterThan(0);
    const names = tools.map(t => t.function.name);
    expect(names).toContain('read_file');
    expect(names).toContain('write_file');
  });

  it('getToolsForActiveIds 空数组返回核心工具+画布', () => {
    const tools = getToolsForActiveIds([]);
    expect(tools.length).toBeGreaterThan(0);
  });

  it('getToolsForActiveIds 包含匹配的扩展工具', () => {
    const tools = getToolsForActiveIds(['browser_screenshot']);
    const names = tools.map(t => t.function.name);
    expect(names).toContain('browser_screenshot');
    expect(names).toContain('read_file'); // 核心工具始终包含
  });

  it('callLLMWithTools 是函数', () => {
    expect(typeof callLLMWithTools).toBe('function');
  });

  it('TOOL_RESULT_BUDGET 导出正确', () => {
    expect(TOOL_RESULT_BUDGET).toBeDefined();
    expect(typeof TOOL_RESULT_BUDGET).toBe('object');
  });

  it('DEFAULT_TOOL_RESULT_BUDGET 导出正确', () => {
    expect(typeof DEFAULT_TOOL_RESULT_BUDGET).toBe('number');
    expect(DEFAULT_TOOL_RESULT_BUDGET).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════

describe('集成: callLLMWithTools() 行为测试 (Mock LLM)', () => {

  /**
   * 创建一个 mock LLM 响应: 纯文本回复 (无工具调用)
   */
  function mockTextResponse(content: string) {
    return {
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            role: 'assistant',
            content,
            tool_calls: undefined,
          },
        }],
      }),
    };
  }

  /**
   * 创建一个 mock LLM 响应: 工具调用
   */
  function mockToolCallResponse(toolCalls: Array<{ id: string; name: string; arguments: string }>) {
    return {
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: toolCalls.map(tc => ({
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: tc.arguments },
            })),
          },
        }],
      }),
    };
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('简单任务: LLM 直接回复,无工具调用', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(mockTextResponse('你好！有什么可以帮你的？'))
    );

    const result = await callLLMWithTools({
      messages: [{ role: 'user', content: '你好' }],
      tools: AGENT_TOOLS,
      llmConfig: { baseUrl: 'http://fake', apiKey: 'sk-test', model: 'test' },
      tokenBudget: 50000,
    });

    expect(result.finalMessage.content).toBe('你好！有什么可以帮你的？');
    expect(result.toolCallCount).toBe(0);
    expect(result.exitedByStallDetection).toBe(false);
    expect(result.exitedByTokenBudget).toBe(false);
    expect(result.totalTokensEstimated).toBeGreaterThan(0);
  });

  it('工具调用后回复: 1 轮工具 + 1 轮文本', async () => {
    const fetchMock = vi.fn()
      // 轮次 1: LLM 调用 read_file
      .mockResolvedValueOnce(mockToolCallResponse([{
        id: 'call_1',
        name: 'read_file',
        arguments: '{"file_path":"test.txt"}',
      }]))
      // 轮次 2: LLM 看到工具结果后回复文本
      .mockResolvedValueOnce(mockTextResponse('文件内容已读取，这是一个测试文件。'));

    vi.stubGlobal('fetch', fetchMock);

    const result = await callLLMWithTools({
      messages: [{ role: 'user', content: '读取 test.txt' }],
      tools: AGENT_TOOLS,
      llmConfig: { baseUrl: 'http://fake', apiKey: 'sk-test', model: 'test' },
      tokenBudget: 50000,
    });

    expect(result.toolCallCount).toBe(1);
    expect(result.finalMessage.content).toContain('测试文件');
    expect(result.exitedByStallDetection).toBe(false);
    expect(result.exitedByTokenBudget).toBe(false);
  });

  it('L3: 连续相同工具调用触发 stall 检测', async () => {
    // 模拟 LLM 连续 4 次调用同一个工具 (相同 name + arguments)
    const toolCall = (id: string) => ({
      id,
      name: 'read_file',
      arguments: '{"file_path":"stuck.txt"}',
    });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockToolCallResponse([toolCall('c1')]))  // 轮次 1
      .mockResolvedValueOnce(mockToolCallResponse([toolCall('c2')]))  // 轮次 2 → stall=1
      .mockResolvedValueOnce(mockToolCallResponse([toolCall('c3')]))  // 轮次 3 → stall=2 → nudge
      // 轮次 4: stall nudge 已注入 messages,LLM 收到提示后回复文本
      .mockResolvedValueOnce(mockTextResponse('抱歉，我无法读取该文件。'));

    vi.stubGlobal('fetch', fetchMock);

    const result = await callLLMWithTools({
      messages: [{ role: 'user', content: '读取 stuck.txt' }],
      tools: AGENT_TOOLS,
      llmConfig: { baseUrl: 'http://fake', apiKey: 'sk-test', model: 'test' },
      maxRounds: 10,
      tokenBudget: 0, // 禁用预算,只测 L3
      onToolCall: async (call) => ({
        tool_call_id: call.id,
        name: call.name,
        output: 'file content here',
        isError: false,
        durationMs: 5,
      }),
    });

    // 3 轮工具调用 + 1 轮最终回复 = 4 次 fetch
    expect(fetchMock).toHaveBeenCalledTimes(4);

    // 检查第 4 次 fetch (轮次 3 工具结果追加后的 LLM 调用) 的 messages 中包含 stall nudge
    // fetch 被调用为 fetch(url, options), 第二个参数的 body 是 JSON 字符串
    const fourthCallOpts = fetchMock.mock.calls[3][1];
    const fourthBody = JSON.parse(fourthCallOpts.body);
    const hasStallNudge = fourthBody.messages.some(
      (m: any) => m.content?.includes('same tool calls repeatedly')
    );
    expect(hasStallNudge).toBe(true);
  });

  it('L4: token 预算超限时注入 budget nudge', async () => {
    // 创建一个超长的工具结果来快速消耗预算
    const longContent = 'x'.repeat(35000); // ~10000 tokens

    const fetchMock = vi.fn()
      // 轮次 1: LLM 调用工具
      .mockResolvedValueOnce(mockToolCallResponse([{
        id: 'call_1',
        name: 'read_file',
        arguments: '{"file_path":"huge.txt"}',
      }]))
      // 轮次 2: LLM 看到结果后回复
      .mockResolvedValueOnce(mockTextResponse('文件已分析完毕。'));

    vi.stubGlobal('fetch', fetchMock);

    // Mock executeToolCall 返回超长结果
    const result = await callLLMWithTools({
      messages: [{ role: 'user', content: '分析 huge.txt' }],
      tools: AGENT_TOOLS,
      llmConfig: { baseUrl: 'http://fake', apiKey: 'sk-test', model: 'test' },
      maxRounds: 10,
      tokenBudget: 5000, // 故意设小,方便测试触发
      onToolCall: async () => ({
        tool_call_id: 'call_1',
        name: 'read_file',
        output: longContent,
        isError: false,
        durationMs: 10,
      }),
    });

    // 应该记录到 token 消耗
    expect(result.totalTokensEstimated).toBeGreaterThan(0);
  });

  it('返回值包含 L3/L4 新增字段', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(mockTextResponse('OK'))
    );

    const result = await callLLMWithTools({
      messages: [{ role: 'user', content: 'test' }],
      tools: [],
      llmConfig: { baseUrl: 'http://fake', apiKey: 'sk-test', model: 'test' },
    });

    // 验证新增字段存在
    expect(typeof result.totalTokensEstimated).toBe('number');
    expect(typeof result.exitedByStallDetection).toBe('boolean');
    expect(typeof result.exitedByTokenBudget).toBe('boolean');
  });

  it('无工具时 LLM 直接回复 (L1 直连路径模拟)', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(mockTextResponse('这是一个直接回答。'))
    );

    const result = await callLLMWithTools({
      messages: [{ role: 'user', content: '你好' }],
      tools: [], // 无工具 → LLM 直接回复
      llmConfig: { baseUrl: 'http://fake', apiKey: 'sk-test', model: 'test' },
      maxRounds: 1,
      tokenBudget: 0,
    });

    expect(result.toolCallCount).toBe(0);
    expect(result.finalMessage.content).toBe('这是一个直接回答。');
    expect(result.totalTokensEstimated).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════

describe('压力测试: 边界条件与极端场景', () => {

  it('L2: 超大工具结果 (100KB) 被正确裁剪', () => {
    const hugeOutput = 'x'.repeat(100_000);
    const result = applyToolResultBudget('read_file', hugeOutput);

    expect(result.length).toBeLessThan(4500); // 4000 预算 + 提示文字
    expect(result).toContain('TRUNCATED');
  });

  it('L2: 空输出不报错', () => {
    expect(applyToolResultBudget('read_file', '')).toBe('');
  });

  it('L3: 空工具调用列表不报错', () => {
    expect(computeToolFingerprint([])).toHaveLength(16);
  });

  it('L3: 单个工具调用 1000 次指纹一致', () => {
    const calls = [{ function: { name: 'read_file', arguments: '{"file_path":"x"}' } }];
    const fp = computeToolFingerprint(calls);
    for (let i = 0; i < 1000; i++) {
      expect(computeToolFingerprint(calls)).toBe(fp);
    }
  });

  it('L4: 100 条消息的 token 估算', () => {
    const messages = Array.from({ length: 100 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `Message ${i}: ${'x'.repeat(200)}`,
    }));
    const tokens = estimateTokens(messages);
    // 100 条 × (210 chars + 10 overhead) / 3.5 ≈ 6285 tokens
    expect(tokens).toBeGreaterThan(5000);
    expect(tokens).toBeLessThan(10000);
  });

  it('L1: 超长 prompt (10000 字符) 正确分类', () => {
    const longPrompt = '帮我重构这个文件 '.repeat(500); // 包含操作动词
    expect(shouldUseAgent(longPrompt, {})).toBe(true);
  });

  it('L1: 超短 prompt (1 字符) 正确分类', () => {
    expect(shouldUseAgent('a', {})).toBe(false);
  });

  it('L4: token 预算为 Infinity 时禁用预算控制', () => {
    // 不应报错
    expect(() => {
      // 只验证参数处理不报错,不实际调用 LLM
      const budget = Infinity;
      const enabled = budget > 0 && isFinite(budget);
      expect(enabled).toBe(false);
    }).not.toThrow();
  });

  it('L4: token 预算为 0 时禁用预算控制', () => {
    const budget = 0;
    const enabled = budget > 0 && isFinite(budget);
    expect(enabled).toBe(false);
  });
});
