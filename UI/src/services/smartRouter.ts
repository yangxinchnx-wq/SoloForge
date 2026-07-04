/**
 * SmartRouter - 多模型智能路由
 * ─────────────────────────────────────────────────────────────
 * 职责: 在用户未手动配置 secModels 时, 自动根据任务类型挑选 2-3 个最合适的副模型,
 *       并生成 subProviders 数组, 让后端走 ensemble 并行投票模式。
 *
 * 工作流:
 *   1. classifyTask(text)        → 任务类型 (code | chat | vision | long_context | reasoning | general)
 *   2. selectBestModels(type, …) → 1-2 个候选副模型 (跳过主模型自己)
 *   3. buildSubProviders(...)    → 输出后端所需的 { baseUrl, apiKey, model, weight, apiFormat }[]
 *
 * 集成位置: ChatPanel.handleSend() 中, 在 fetch 之前调用 buildSubProviders,
 *           把结果作为 subProviders 字段塞进请求体 (并临时打开 mixedTasks)。
 *
 * 降级策略: 没有可用候选 → 返回空数组 → 后端走单一模型循环, 不会报错。
 */

export type TaskType =
  | "code"
  | "reasoning"
  | "vision"
  | "long_context"
  | "chat"
  | "general";

export interface ProviderEntry {
  baseUrl: string;
  apiKey: string;
  model: string;
  providerName: string;
  enabledInSettings: boolean;
  apiFormat?: "openai" | "anthropic";
}

export interface SubProviderSlot {
  baseUrl: string;
  apiKey: string;
  model: string;
  weight: number;
  apiFormat: "openai" | "anthropic";
  _reason?: string;
  _slotIdx: number;
}

// ─────────────────────────────────────────────────────────────
// 任务分类 (轻量级关键字匹配; 真正深度分类交给主模型自己)
// ─────────────────────────────────────────────────────────────
const CODE_HINTS = [
  "```", "function", "const ", "let ", "var ", "class ", "import ", "export ",
  "def ", "return ", "if (", "for (", "while (", "switch (", "=>",
  "react", "vue", "node", "python", "rust", "go", "java", "c++", "typescript",
  "javascript", "html", "css", "sql", "docker", "k8s", "git",
  "bug", "fix", "refactor", "重构", "优化", "改写", "实现", "写一个", "帮我写",
  "代码", "编程", "脚本", "函数", "组件", "接口", "类", "模块",
];

const REASONING_HINTS = [
  "为什么", "怎么", "如何", "分析", "推导", "证明", "假设", "反证",
  "比较", "区别", "优劣", "权衡", "决策", "建议",
  "why", "how", "analyze", "prove", "compare", "tradeoff", "trade-off",
  "implications", "consequence", "evaluate",
];

const VISION_HINTS = [
  "图片", "图像", "照片", "截图", "插图", "画", "看图", "看这张",
  "image", "picture", "photo", "screenshot", "diagram", "figure",
];

const LONG_CONTEXT_HINTS = [
  "整本书", "整篇", "整个文件", "完整", "全文", "所有", "逐字", "逐句",
  "长篇", "详细分析", "深度", "summary", "summarize", "全文翻译",
  "translate the whole", "entire document", "all paragraphs",
];

export function classifyTask(
  text: string,
  hasImages: boolean = false,
): TaskType {
  if (hasImages) return "vision";
  if (!text || text.length < 4) return "general";
  const lower = text.toLowerCase();

  let codeScore = 0;
  let reasoningScore = 0;
  let longCtxScore = 0;
  let visionScore = 0;

  for (const hint of CODE_HINTS) {
    if (lower.includes(hint.toLowerCase())) codeScore += hint.length > 6 ? 2 : 1;
  }
  for (const hint of REASONING_HINTS) {
    if (lower.includes(hint.toLowerCase())) reasoningScore += 1;
  }
  for (const hint of LONG_CONTEXT_HINTS) {
    if (lower.includes(hint.toLowerCase())) longCtxScore += 1;
  }
  for (const hint of VISION_HINTS) {
    if (lower.includes(hint.toLowerCase())) visionScore += 1;
  }
  // 长文本加分
  if (text.length > 4000) longCtxScore += 2;
  else if (text.length > 1500) longCtxScore += 1;
  // 包含代码块加分
  if (/```[\s\S]+```/.test(text)) codeScore += 3;

  const max = Math.max(codeScore, reasoningScore, longCtxScore, visionScore);
  if (max === 0) return "general";
  if (max === codeScore) return "code";
  if (max === visionScore) return "vision";
  if (max === longCtxScore) return "long_context";
  if (max === reasoningScore) return "reasoning";
  return "general";
}

// ─────────────────────────────────────────────────────────────
// 任务类型 → 优选 provider / model 匹配规则
// ─────────────────────────────────────────────────────────────
interface ModelPreference {
  providerPatterns: RegExp[];   // 匹配 providerName (大小写不敏感)
  modelPatterns: RegExp[];      // 匹配 model id
  weight: number;               // 投票权重 (1-5)
  reason: string;               // 选择理由 (debug 用)
}

const PREFERENCES: Record<TaskType, ModelPreference[]> = {
  code: [
    { providerPatterns: [/deepseek/i], modelPatterns: [/coder|deepseek/i], weight: 5, reason: "deepseek 编码强" },
    { providerPatterns: [/anthropic/i, /claude/i], modelPatterns: [/sonnet|opus/i], weight: 4, reason: "claude 逻辑清晰" },
    { providerPatterns: [/openai/i], modelPatterns: [/gpt-4|o1/i], weight: 4, reason: "gpt-4 编码扎实" },
  ],
  reasoning: [
    { providerPatterns: [/anthropic/i, /claude/i], modelPatterns: [/opus|sonnet/i], weight: 5, reason: "claude opus 推理顶尖" },
    { providerPatterns: [/openai/i], modelPatterns: [/o1/i], weight: 5, reason: "o1 推理模型" },
    { providerPatterns: [/deepseek/i], modelPatterns: [/r1|reasoner/i], weight: 4, reason: "deepseek-r1 推理" },
  ],
  vision: [
    { providerPatterns: [/anthropic/i, /claude/i], modelPatterns: [/sonnet|opus|haiku/i], weight: 5, reason: "claude 多模态领先" },
    { providerPatterns: [/openai/i], modelPatterns: [/gpt-4o/i], weight: 5, reason: "gpt-4o vision 强" },
  ],
  long_context: [
    { providerPatterns: [/anthropic/i, /claude/i], modelPatterns: [/sonnet|opus/i], weight: 5, reason: "claude 200K 上下文" },
    { providerPatterns: [/moonshot|kimi/i], modelPatterns: [/.+/], weight: 4, reason: "kimi 长文本" },
  ],
  chat: [
    { providerPatterns: [/anthropic/i, /claude/i], modelPatterns: [/haiku|sonnet/i], weight: 4, reason: "claude 对话流畅" },
    { providerPatterns: [/openai/i], modelPatterns: [/gpt-4o-mini|gpt-3\.5/i], weight: 3, reason: "gpt 轻量对话" },
  ],
  general: [
    { providerPatterns: [/anthropic/i, /claude/i], modelPatterns: [/sonnet|haiku/i], weight: 4, reason: "claude 通用" },
    { providerPatterns: [/openai/i], modelPatterns: [/gpt-4o-mini|gpt-4o/i], weight: 4, reason: "gpt 通用" },
  ],
};

// ─────────────────────────────────────────────────────────────
// 选模型: 从 modelProviderMap 中, 按 taskType 偏好挑选
//   - 自动排除主模型自己
//   - 跳过 enabled=false 或 apiKey 为空的 provider
//   - 最多返回 2 个 (因为主模型 + 2 sub = 3 路, 平衡成本)
// ─────────────────────────────────────────────────────────────
const MAX_SUB_PROVIDERS = 2;

export function selectBestModels(
  taskType: TaskType,
  modelProviderMap: Record<string, ProviderEntry>,
  mainModel: string,
): ProviderEntry[] {
  const prefs = PREFERENCES[taskType] || PREFERENCES.general;
  const available = Object.values(modelProviderMap).filter(
    (e) => e.enabledInSettings && e.apiKey && e.model !== mainModel,
  );
  if (available.length === 0) return [];

  const picked: ProviderEntry[] = [];
  const used = new Set<string>();

  for (const pref of prefs) {
    if (picked.length >= MAX_SUB_PROVIDERS) break;
    for (const entry of available) {
      if (used.has(entry.model)) continue;
      const matchProvider = pref.providerPatterns.some((p) => p.test(entry.providerName) || p.test(entry.baseUrl));
      const matchModel = pref.modelPatterns.some((p) => p.test(entry.model));
      if (matchProvider && matchModel) {
        picked.push(entry);
        used.add(entry.model);
        console.log(`[smartRouter] ${taskType} → ${entry.model} (${pref.reason})`);
        break;
      }
    }
  }

  // 兜底: 偏好未匹配, 按启用顺序取前 N 个
  if (picked.length === 0) {
    for (const entry of available) {
      if (picked.length >= MAX_SUB_PROVIDERS) break;
      picked.push(entry);
      console.log(`[smartRouter] ${taskType} → ${entry.model} (fallback: first available)`);
    }
  }

  return picked;
}

// ─────────────────────────────────────────────────────────────
// 公共入口: buildSubProviders
//   - taskType 由 classifyTask 给出 (调用方可以覆盖)
//   - 启用条件: 至少有 1 个候选 (否则返回空数组, 后端走单模型)
// ─────────────────────────────────────────────────────────────
export function buildSubProviders(opts: {
  text: string;
  hasImages: boolean;
  modelProviderMap: Record<string, ProviderEntry>;
  mainModel: string;
  overrideTaskType?: TaskType;
}): SubProviderSlot[] {
  const taskType = opts.overrideTaskType || classifyTask(opts.text, opts.hasImages);
  const candidates = selectBestModels(taskType, opts.modelProviderMap, opts.mainModel);
  if (candidates.length === 0) {
    console.log(`[smartRouter] ${taskType}: 无可用候选副模型, 走单模型循环`);
    return [];
  }
  const prefs = PREFERENCES[taskType] || PREFERENCES.general;
  return candidates.map((entry, i) => {
    const pref = prefs.find((p) =>
      p.providerPatterns.some((rx) => rx.test(entry.providerName) || rx.test(entry.baseUrl)),
    );
    return {
      baseUrl: entry.baseUrl,
      apiKey: entry.apiKey,
      model: entry.model,
      weight: pref?.weight ?? 3,
      apiFormat: entry.apiFormat || (typeof entry.baseUrl === "string" && /anthropic\.com/i.test(entry.baseUrl) ? "anthropic" : "openai"),
      _reason: pref?.reason || "fallback",
      _slotIdx: i,
    };
  });
}

// ─────────────────────────────────────────────────────────────
// 一句话路由总入口 (供 ChatPanel 简单调用)
// 返回 { subProviders, taskType, enabled } 三元组
//   - enabled=false 时, ChatPanel 不应强制打开 mixedTasks
//   - enabled=true  且 subProviders.length>0 时, 自动激活 ensemble
// ─────────────────────────────────────────────────────────────
export function routeTask(opts: {
  text: string;
  hasImages: boolean;
  modelProviderMap: Record<string, ProviderEntry>;
  mainModel: string;
  forceEnabled?: boolean;
}): { subProviders: SubProviderSlot[]; taskType: TaskType; enabled: boolean } {
  const subProviders = buildSubProviders(opts);
  return {
    subProviders,
    taskType: classifyTask(opts.text, opts.hasImages),
    enabled: !!opts.forceEnabled || subProviders.length > 0,
  };
}
