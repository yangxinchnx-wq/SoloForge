// ─────────────────────────────────────────────────────────────────
// 全局快捷键绑定 store
// - 用户可在设置中修改 (并重置回默认)
// - 所有 default shortcut 集中维护,避免散落在 useKeyboard 调用中
// ─────────────────────────────────────────────────────────────────

import { useEffect, useState, useCallback, useMemo } from 'react';

export interface KeyCombo {
  /** 主键: 'k', ',', '`', 'F1' 等,大小写不敏感 */
  key: string;
  /** 修饰键 (Mac 上 ctrl = cmd) */
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
}

export interface Keybinding {
  id: string;
  combo: KeyCombo;
  description: string;
  group: '视图' | '会话' | '工具' | '导航' | '布局';
  /** 是否锁定不可改 (系统级保留) */
  locked?: boolean;
}

// ─── 默认绑定 (与 App.tsx 中 useKeyboard 一一对应) ───
export const DEFAULT_BINDINGS: Keybinding[] = [
  // 视图
  { id: 'palette',    combo: { key: 'k', ctrl: true },                description: '打开命令面板',           group: '视图' },
  { id: 'paletteAlt', combo: { key: 'p', ctrl: true, shift: true },   description: '命令面板 (备)',          group: '视图' },
  { id: 'search',     combo: { key: 'f', ctrl: true, shift: true },   description: '打开全局搜索',           group: '视图' },
  { id: 'deploy',     combo: { key: 'd', ctrl: true, shift: true },   description: '部署向导',               group: '视图' },
  { id: 'settings',   combo: { key: ',', ctrl: true },                description: '打开设置',               group: '视图' },
  { id: 'terminal',   combo: { key: '`' },                            description: '打开终端',               group: '视图' },
  { id: 'hotkey',     combo: { key: '?' },                            description: '快捷键速查',             group: '视图' },
  { id: 'chatHistory',combo: { key: 'h', ctrl: true },                description: '搜索对话历史',           group: '视图' },
  { id: 'splitCompare',combo: { key: '\\', ctrl: true, shift: true }, description: '分屏对比',               group: '视图' },
  { id: 'abTest',      combo: { key: 'a', ctrl: true, shift: true },  description: 'A/B 测试提示词',         group: '工具' },
  { id: 'detach',      combo: { key: 'd', ctrl: true, alt: true },     description: '拖出独立窗口',           group: '视图' },
  { id: 'codeReview',  combo: { key: 'r', ctrl: true, shift: true },   description: '代码多模型评审',         group: '工具' },
  { id: 'taskScheduler',combo: { key: 't', ctrl: true, shift: true },  description: 'AI 计划任务调度',         group: '工具' },
  { id: 'collab',       combo: { key: 'c', ctrl: true, shift: true, alt: true },  description: '协同光标 (模拟)',  group: '工具' },
  { id: 'debugger',     combo: { key: 'b', ctrl: true, alt: true },               description: '断点调试器 (模拟)', group: '工具' },
  { id: 'plugins',      combo: { key: 'p', ctrl: true, alt: true, shift: true },  description: '插件管理',         group: '工具' },
  { id: 'snippets',     combo: { key: 'j', ctrl: true, alt: true, shift: true },  description: '代码片段',         group: '工具' },
  { id: 'surreal',      combo: { key: 'q', ctrl: true, alt: true, shift: true },  description: 'SurrealDB 浏览器',  group: '工具' },
  { id: 'gitTime',      combo: { key: 'h', ctrl: true, alt: true, shift: true },  description: 'Git 时光机',         group: '工具' },
  { id: 'workflow',     combo: { key: 'w', ctrl: true, alt: true, shift: true },  description: 'AI 工作流 Pipeline', group: '工具' },
  { id: 'mermaid',      combo: { key: 'm', ctrl: true, alt: true, shift: true },  description: 'Mermaid 图表',       group: '工具' },
  { id: 'themeGen',     combo: { key: 't', ctrl: true, alt: true, shift: true },  description: 'AI 主题生成器',       group: '工具' },
  { id: 'codeMap',      combo: { key: 'l', ctrl: true, alt: true, shift: true },  description: '代码地图',           group: '工具' },
  { id: 'pomodoro',     combo: { key: 'o', ctrl: true, alt: true, shift: true },  description: '番茄钟 + 编码统计',  group: '工具' },
  { id: 'regexLab',     combo: { key: 'x', ctrl: true, alt: true, shift: true },  description: '正则表达式工作台',  group: '工具' },
  { id: 'sticky',       combo: { key: 'n', ctrl: true, alt: true, shift: true },  description: '便签 Sticky Notes',  group: '工具' },
  { id: 'dashboard',    combo: { key: 'd', ctrl: true, alt: true, shift: true },  description: '数据可视化面板',    group: '视图' },
  { id: 'prompts',      combo: { key: 'f', ctrl: true, alt: true, shift: true },  description: 'AI 提示词模板库',    group: '工具' },
  { id: 'cmdHistory',   combo: { key: 'k', ctrl: true, alt: true, shift: true },  description: '命令历史与收藏',    group: '工具' },
  { id: 'perfMon',      combo: { key: 'y', ctrl: true, alt: true, shift: true },  description: '性能监控',         group: '工具' },
  { id: 'timeline',     combo: { key: 'i', ctrl: true, alt: true, shift: true },  description: '编码时间线',       group: '工具' },
  { id: 'translator',   combo: { key: 'z', ctrl: true, alt: true, shift: true },  description: '多语言翻译',       group: '工具' },
  { id: 'collab2',      combo: { key: 'a', ctrl: true, alt: true, shift: true },  description: '远程协作',         group: '工具' },
  { id: 'eventBrowser', combo: { key: 'v', ctrl: true, alt: true, shift: true },  description: '事件浏览器',       group: '工具' },
  { id: 'agentTheater', combo: { key: 'e', ctrl: true, alt: true, shift: true },  description: '智能体剧场',       group: '工具' },
  { id: 'voiceChat',    combo: { key: 'g', ctrl: true, alt: true, shift: true },  description: '语音对话',         group: '工具' },
  { id: 'screenShare',  combo: { key: 'u', ctrl: true, alt: true, shift: true },  description: '屏幕共享',         group: '工具' },
  { id: 'advSearch',    combo: { key: ';', ctrl: true, alt: true, shift: true },  description: '高级搜索',         group: '工具' },
  { id: 'dataIO',       combo: { key: "'", ctrl: true, alt: true, shift: true },  description: '数据导入导出',     group: '工具' },
  { id: 'docCollab',    combo: { key: ',', ctrl: true, alt: true, shift: true },  description: '文档协作',         group: '工具' },
  { id: 'themeMarket',  combo: { key: '.', ctrl: true, alt: true, shift: true },  description: '主题市场',         group: '工具' },
  { id: 'logStream',    combo: { key: '/', ctrl: true, alt: true, shift: true },  description: '日志流',           group: '工具' },
  { id: 'mindMap',      combo: { key: '1', ctrl: true, alt: true, shift: true },  description: '思维导图',         group: '工具' },
  { id: 'apiTester',    combo: { key: '2', ctrl: true, alt: true, shift: true },  description: 'API 测试器',       group: '工具' },
  { id: 'dbDesigner',   combo: { key: '3', ctrl: true, alt: true, shift: true },  description: '数据库设计器',     group: '工具' },
  { id: 'umlTools',     combo: { key: '4', ctrl: true, alt: true, shift: true },  description: 'UML 工具',         group: '工具' },
  { id: 'taskBoard',    combo: { key: '5', ctrl: true, alt: true, shift: true },  description: '任务看板',         group: '工具' },
  { id: 'snapshotMgr',  combo: { key: '6', ctrl: true, alt: true, shift: true },  description: '快照管理',         group: '工具' },
  { id: 'notifierRules',combo: { key: '7', ctrl: true, alt: true, shift: true },  description: '通知规则',         group: '工具' },
  { id: 'fullTextSearch',combo: { key: '8', ctrl: true, alt: true, shift: true }, description: '全文搜索',         group: '工具' },
  { id: 'jsonTools',    combo: { key: '9', ctrl: true, alt: true, shift: true },  description: 'JSON 工具',        group: '工具' },
  { id: 'cronEditor',   combo: { key: '0', ctrl: true, alt: true, shift: true },  description: 'Cron 编辑器',      group: '工具' },
  { id: 'changelog',    combo: { key: '-', ctrl: true, alt: true, shift: true },  description: '更新日志',         group: '工具' },
  { id: 'envManager',   combo: { key: '=', ctrl: true, alt: true, shift: true },  description: '环境变量',         group: '工具' },
  { id: 'bookmarkMgr',  combo: { key: '[', ctrl: true, alt: true, shift: true },  description: '书签管理',         group: '工具' },
  { id: 'colorPalette', combo: { key: ']', ctrl: true, alt: true, shift: true },  description: '调色板',           group: '工具' },
  { id: 'iconBrowser',  combo: { key: 'i', ctrl: true, alt: true },              description: '图标浏览器',       group: '工具' },
  { id: 'diffViewer',   combo: { key: 'd', ctrl: true, alt: true, meta: true },    description: '差异对比',         group: '工具' },
  { id: 'webPreview',   combo: { key: 'F5', ctrl: true, shift: true },           description: 'Web 预览',          group: '工具' },
  { id: 'notesEditor',  combo: { key: 'F6', ctrl: true, shift: true },           description: '笔记编辑器',        group: '工具' },
  { id: 'netMon',       combo: { key: 'F7', ctrl: true, shift: true },           description: '网络监控',          group: '工具' },
  { id: 'assetLib',     combo: { key: 'F8', ctrl: true, shift: true },           description: '资源库',            group: '工具' },
  { id: 'buildMon',     combo: { key: 'F9', ctrl: true, shift: true },           description: '构建监控',          group: '工具' },
  { id: 'webhook',      combo: { key: 'F10', ctrl: true, shift: true },          description: 'Webhook 测试',      group: '工具' },
  { id: 'scriptRun',    combo: { key: 'F11', ctrl: true, shift: true },          description: '脚本执行器',        group: '工具' },
  { id: 'qrGen',        combo: { key: 'F12', ctrl: true, shift: true },          description: '二维码生成器',      group: '工具' },
  { id: 'dbSeeder',     combo: { key: 'F1', ctrl: true, alt: true },              description: '数据库种子生成器',  group: '工具' },
  { id: 'k8sPanel',     combo: { key: 'F2', ctrl: true, alt: true },              description: 'K8s 资源面板',      group: '工具' },
  { id: 'depGraph',     combo: { key: 'F3', ctrl: true, alt: true },              description: '依赖关系图',        group: '工具' },
  { id: 'licenseAudit', combo: { key: 'F4', ctrl: true, alt: true },              description: '许可证审计',        group: '工具' },
  { id: 'costMonitor',  combo: { key: '1', ctrl: true, alt: true },               description: '云成本监控',        group: '工具' },
  { id: 'testCoverage', combo: { key: '2', ctrl: true, alt: true },               description: '测试覆盖率',        group: '工具' },
  { id: 'dbBrowser',    combo: { key: '3', ctrl: true, alt: true },               description: '数据库浏览器',      group: '工具' },
  { id: 'apiMonitor',   combo: { key: '4', ctrl: true, alt: true },               description: 'API 监控',          group: '工具' },
  { id: 'secretScanner',combo: { key: '5', ctrl: true, alt: true },               description: '密钥扫描器',        group: '工具' },
  { id: 'privacyScanner',combo: { key: '6', ctrl: true, alt: true },              description: '隐私合规扫描',      group: '工具' },
  { id: 'vulnScanner',  combo: { key: '7', ctrl: true, alt: true },               description: '漏洞扫描器',        group: '工具' },
  { id: 'accessAuditor',combo: { key: '8', ctrl: true, alt: true },               description: '访问审计',          group: '工具' },
  { id: 'incidentMgr',  combo: { key: '9', ctrl: true, alt: true },               description: '事件响应管理器',    group: '工具' },
  { id: 'compliance',   combo: { key: '0', ctrl: true, alt: true },               description: '合规审计',          group: '工具' },
  { id: 'dataMasking',  combo: { key: '-', ctrl: true, alt: true },               description: '数据脱敏工具',      group: '工具' },
  { id: 'threatModel',  combo: { key: '=', ctrl: true, alt: true },               description: '威胁建模 (STRIDE)', group: '工具' },
  { id: 'promptLab',    combo: { key: '[', ctrl: true, alt: true },               description: '提示词工程实验室',  group: '工具' },
  { id: 'tokenTracker', combo: { key: ']', ctrl: true, alt: true },               description: 'Token 用量追踪',    group: '工具' },
  { id: 'agentOrch',    combo: { key: '\\', ctrl: true, alt: true },              description: '智能体编排器',      group: '工具' },
  { id: 'embedding',    combo: { key: ';', ctrl: true, alt: true },               description: '嵌入向量浏览器',    group: '工具' },
  { id: 'cacheInsp',    combo: { key: "'", ctrl: true, alt: true },               description: '缓存检查器',        group: '工具' },
  { id: 'deployPipe',   combo: { key: ',', ctrl: true, alt: true },               description: '部署流水线',        group: '工具' },
  { id: 'experiment',   combo: { key: '.', ctrl: true, alt: true },               description: '特征实验看板',      group: '工具' },
  { id: 'modelReg',     combo: { key: '/', ctrl: true, alt: true },               description: '模型注册中心',      group: '工具' },
  { id: 'queueMon',     combo: { key: '`', ctrl: true, alt: true },               description: '消息队列监控',      group: '工具' },
  { id: 'worktree',     combo: { key: 'F1', ctrl: true, alt: true, shift: true }, description: 'Git Worktree 管理', group: '工具' },
  { id: 'prReviewer',   combo: { key: 'F2', ctrl: true, alt: true, shift: true }, description: 'PR 审查器',        group: '工具' },
  { id: 'kanban',       combo: { key: 'F3', ctrl: true, alt: true, shift: true }, description: '看板',              group: '工具' },
  { id: 'loadTest',     combo: { key: 'F4', ctrl: true, alt: true, shift: true }, description: '负载测试器',        group: '工具' },
  { id: 'docGen',       combo: { key: 'F5', ctrl: true, alt: true, shift: true }, description: 'API 文档生成器',    group: '工具' },
  { id: 'knowledge',    combo: { key: 'F6', ctrl: true, alt: true, shift: true }, description: '知识库',            group: '工具' },
  { id: 'teamDir',      combo: { key: 'F7', ctrl: true, alt: true, shift: true }, description: '团队目录',          group: '工具' },
  { id: 'release',      combo: { key: 'F8', ctrl: true, alt: true, shift: true }, description: '发布规划器',        group: '工具' },

  // 导航
  { id: 'explorer',   combo: { key: 'b', ctrl: true },                description: '切到资源管理',           group: '导航' },
  { id: 'quickJump',  combo: { key: 'p', ctrl: true },                description: 'QuickJump 跳到文件',     group: '导航' },
  { id: 'quickJumpAlt',combo: { key: 'e', ctrl: true },               description: 'QuickJump (备)',         group: '导航' },
  { id: 'git',        combo: { key: 'g', ctrl: true },                description: '切到源码管理',           group: '导航' },
  { id: 'searchPane', combo: { key: 's', ctrl: true },                description: '切到搜索',               group: '导航' },

  // 会话
  { id: 'newSession', combo: { key: 'n', ctrl: true },                description: '新建对话',               group: '会话' },

  // 工具
  { id: 'clearStream',combo: { key: 'l', ctrl: true },                description: '清空流送区',             group: '工具' },
  { id: 'refresh',    combo: { key: 'r', ctrl: true },                description: '刷新后端',               group: '工具' },
];

const STORE_KEY = 'soloforge.keybindings.v1';

type OverrideMap = Record<string, KeyCombo>;

function loadOverrides(): OverrideMap {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return {};
}
function saveOverrides(m: OverrideMap) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(m)); } catch { /* ignore */ }
}

/** 内部 hook：给 useKeyboard 用,返回已合并默认 + 用户覆盖的 ShortcutBinding[] */
export function useKeybindings() {
  const [overrides, setOverrides] = useState<OverrideMap>(loadOverrides);

  useEffect(() => { saveOverrides(overrides); }, [overrides]);

  const bindings: Keybinding[] = useMemo(() => {
    return DEFAULT_BINDINGS.map(b => ({
      ...b,
      combo: overrides[b.id] || b.combo,
    }));
  }, [overrides]);

  const setBinding = useCallback((id: string, combo: KeyCombo) => {
    setOverrides(prev => ({ ...prev, [id]: combo }));
  }, []);

  const resetBinding = useCallback((id: string) => {
    setOverrides(prev => {
      const n = { ...prev };
      delete n[id];
      return n;
    });
  }, []);

  const resetAll = useCallback(() => {
    setOverrides({});
  }, []);

  /** 检查某组合是否被占用 (排除自己) */
  const isConflict = useCallback((combo: KeyCombo, exceptId?: string): Keybinding | null => {
    const norm = (c: KeyCombo) => `${c.key.toLowerCase()}|${!!c.ctrl}|${!!c.shift}|${!!c.alt}|${!!c.meta}`;
    const target = norm(combo);
    for (const b of bindings) {
      if (b.id === exceptId) continue;
      if (norm(b.combo) === target) return b;
    }
    return null;
  }, [bindings]);

  return { bindings, overrides, setBinding, resetBinding, resetAll, isConflict };
}

/** 把 KeyCombo 转为可读字符串 (e.g. "Ctrl+Shift+P") */
export function formatKeyCombo(c: KeyCombo): string {
  const parts: string[] = [];
  if (c.ctrl) parts.push('Ctrl');
  if (c.shift) parts.push('Shift');
  if (c.alt) parts.push('Alt');
  if (c.meta) parts.push('Cmd');
  if (c.key === ' ') parts.push('Space');
  else if (c.key.length === 1) parts.push(c.key.toUpperCase());
  else parts.push(c.key);
  return parts.join('+');
}

/** 解析键盘事件为 KeyCombo */
export function eventToCombo(e: KeyboardEvent): KeyCombo {
  // 修饰键本身不算
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) {
    return { key: '' };
  }
  return {
    key: e.key,
    ctrl: e.ctrlKey,
    shift: e.shiftKey,
    alt: e.altKey,
    meta: e.metaKey,
  };
}
