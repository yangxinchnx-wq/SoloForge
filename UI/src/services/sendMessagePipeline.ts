/**
 * sendMessagePipeline.ts — handleSend 的纯逻辑拆解 (R3.2)
 *
 * 目标: 把 ChatPanel.handleSend (~400 行) 拆成 5 个独立可测的步骤
 *   1. validateInput()           — 输入校验, 返回 null 表示无效
 *   2. buildUserMessage()        — 构造 ChatMessage
 *   3. preprocessImages()        — Claude 压缩 vs 其他 provider 原图
 *   4. resolveMainEntryForSend() — 解析主模型 entry, 处理 fallback + 错误信息
 *   5. buildRequestBody()        — 拼装最终 POST 请求体
 *
 * 步骤 1-5 是纯函数, 无 React 依赖, 易测
 * 步骤 6 (fetch + SSE + UI projection) 仍留在 ChatPanel, 因为它强依赖 UI 状态机
 */
import type { ChatMessage, SecondaryModel } from '../types';
import type { PermissionMode } from '../types/streaming';

// ============== 类型定义 ==============

export interface PendingAttachment {
  fileName: string;
  text: string;
}

export interface ImagePending {
  file: File;
  previewUrl: string;
}

export interface ModelProviderEntry {
  model: string;
  providerName: string;
  baseUrl: string;
  apiKey: string;
  vaultProviderId?: string;
  enabledInSettings: boolean;
}

export interface RoutedSubProvider {
  baseUrl: string;
  apiKey: string;
  model: string;
  weight: number;
  apiFormat?: string;
  vaultProviderId?: string;
  _reason?: string;
}

export interface SmartRouterResult {
  taskType: string;
  subProviders: RoutedSubProvider[];
}

export interface SendContext {
  inputValue: string;
  pendingAttachment: PendingAttachment | null;
  pendingImages: ImagePending[];
  activeChatId: string;
  activeMessages: ChatMessage[];
  activeSettings: any;
  selectedFile: string | null;
  editorContent: string;
  mainModel: string;
  resolvedMainModel: string;
  mainEntry: ModelProviderEntry;
  modelProviderMap: Record<string, ModelProviderEntry>;
  secModels: SecondaryModel[];
  candidateEntries: ModelProviderEntry[];
  subEntries: ModelProviderEntry[];
  isClaudeMain: boolean;
  smartRoute: boolean;
  mixedTasks: boolean;
  hashlineAgentEnabled: boolean;
  permissionMode: PermissionMode;
  imagesToSend: string[];
}

// ============== Step 1: validateInput ==============

export interface ValidationOk {
  ok: true;
  finalContent: string;
}
export interface ValidationEmpty {
  ok: false;
  reason: 'empty';
}
export type ValidationResult = ValidationOk | ValidationEmpty;

/**
 * 校验输入, 返回有效内容 (含 attachment 默认文本) 或失败原因
 */
export function validateInput(
  inputValue: string,
  pendingAttachment: PendingAttachment | null,
): ValidationResult {
  if (!inputValue.trim() && !pendingAttachment) return { ok: false, reason: 'empty' };
  const finalContent = inputValue.trim() ||
    `请帮我分析如下来自于 "${pendingAttachment?.fileName}" 的代码。`;
  return { ok: true, finalContent };
}

// ============== Step 2: buildUserMessage ==============

/**
 * 构造 user ChatMessage (含 attachment 字段)
 */
export function buildUserMessage(
  finalContent: string,
  pendingAttachment: PendingAttachment | null,
): ChatMessage {
  const userMsg: ChatMessage = {
    sender: 'user',
    content: finalContent,
    time: new Date().toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }),
    avatar: '',
  };
  if (pendingAttachment) {
    userMsg.attachment = {
      fileName: pendingAttachment.fileName,
      text: pendingAttachment.text,
    };
  }
  return userMsg;
}

// ============== Step 3: preprocessImages ==============

/**
 * 多模态图片预处理:
 *   - Claude 走 compressImageForClaude (Canvas 缩到 ≤1568px JPEG 85%)
 *   - 其他 provider 走 fileToDataUrl 原图直传
 *
 * 同步侧: 调用方传入 helpers, 避免 import chain 循环依赖
 */
export async function preprocessImages(
  pendingImages: ImagePending[],
  isClaudeMain: boolean,
  helpers: {
    compressImageForClaude: (file: File) => Promise<string>;
    fileToDataUrl: (file: File) => Promise<string>;
  },
): Promise<{
  imagesToSend: string[];
  revokeObjectUrls: () => void;
}> {
  const imagesToSend: string[] = await Promise.all(
    pendingImages.map(img =>
      isClaudeMain ? helpers.compressImageForClaude(img.file) : helpers.fileToDataUrl(img.file)
    ),
  );
  return {
    imagesToSend,
    revokeObjectUrls: () => {
      pendingImages.forEach(img => URL.revokeObjectURL(img.previewUrl));
    },
  };
}

// ============== Step 4: resolveMainEntryForSend ==============

export type ResolveMainEntryResult =
  | { ok: true; resolvedMainModel: string; entry: ModelProviderEntry }
  | { ok: false; errorMessage: string };

/**
 * 解析主模型 entry 并给出人类可读的错误信息
 *
 * 优先级:
 *   1. 已解开的 entry + 有 apiKey / vaultProviderId → 成功
 *   2. decryptionFailures 非空 → 设备指纹变化, 需重新输入 key
 *   3. modelProviderMap 为空 → 未配置任何模型
 *   4. 其他 → 当前主模型未配置 / 服务未连通
 */
export function resolveMainEntryForSend(
  mainModel: string,
  modelProviderMap: Record<string, ModelProviderEntry> | undefined,
  resolvedMainModel: string,
  entry: ModelProviderEntry | undefined,
  decryptionFailures: Array<{ name: string }> | undefined,
): ResolveMainEntryResult {
  if (entry && (entry.apiKey || entry.vaultProviderId)) {
    return { ok: true, resolvedMainModel, entry };
  }

  // 区分三种失败原因, 给用户更精准的引导
  const mapEmpty = !modelProviderMap || Object.keys(modelProviderMap).length === 0;
  const failures = decryptionFailures || [];
  const failureNames = failures.slice(0, 3).map(f => f.name).join('、');
  const failureMore = failures.length > 3 ? ` 等 ${failures.length} 个` : '';

  let reason: string;
  if (failures.length > 0) {
    reason = `检测到 ${failures.length} 个提供商 (${failureNames}${failureMore}) 的 API key 无法在本设备解密（设备指纹已变化, AES-GCM 解密失败）。请在「设置 → 模型」中重新输入 API key 以恢复访问。`;
  } else if (mapEmpty) {
    reason = '尚未在「设置 → 模型」中启用任何模型, 请先添加并测试通过至少一个模型后再试。';
  } else {
    reason = `当前主模型「${mainModel}」未配置 API Key 或服务未连通, 请在「设置 → 模型」中测试通过后再试。可选模型: ${Object.keys(modelProviderMap || {}).join(', ') || '(空)'}`;
  }
  return { ok: false, errorMessage: `❌ **主模型未配置**：${reason}` };
}

// ============== Step 5: buildRequestBody ==============

/**
 * 构造最终 POST 请求体 (含 subProviders + candidateProviders + images)
 *
 * subProviders 智能路由策略:
 *   - smartRoute=true 且 routeTask 返回非空 → 智能路由结果优先
 *   - 否则, mixedTasks=true 且 subEntries 非空 → 手动配置
 *   - 否则, 空数组 (后端走单模型循环)
 */
export function buildRequestBody(ctx: SendContext & {
  routed?: SmartRouterResult;
  detectApiFormat: (e: ModelProviderEntry) => string;
}): {
  prompt: string;
  history: Array<{ sender: string; content: string }>;
  activeFile: { name: string; content: string } | null;
  mainModel: string;
  activeSettings: any;
  chatId: string;
  provider: {
    baseUrl: string;
    apiKey: string;
    model: string;
    providerId?: string;
  };
  subProviders: Array<{
    baseUrl: string;
    apiKey: string;
    model: string;
    weight?: number;
    apiFormat?: string;
    providerId?: string;
    _weight?: number;
    _slotIdx?: number;
    _reason?: string;
    _taskType?: string;
  }>;
  candidateProviders: Array<{
    displayName: string;
    providerName: string;
    modelName: string;
    baseUrl: string;
  }>;
  images: string[];
} {
  // subProviders 智能路由 vs 手动配置
  let subProviders: any[] = [];
  if (ctx.smartRoute && ctx.routed && ctx.routed.subProviders.length > 0) {
    subProviders = ctx.routed.subProviders.map((s, i) => ({
      baseUrl: s.baseUrl,
      apiKey: s.apiKey,
      model: s.model,
      weight: s.weight,
      apiFormat: s.apiFormat,
      providerId: s.vaultProviderId || undefined,
      _weight: s.weight,
      _slotIdx: i,
      _reason: s._reason,
      _taskType: ctx.routed!.taskType,
    }));
  } else if (ctx.mixedTasks && ctx.subEntries.length > 0) {
    subProviders = ctx.subEntries.map((e, i) => {
      const sm = (ctx.secModels || []).find(s => (s.id || s.name) === e.model);
      return {
        baseUrl: e.baseUrl,
        apiKey: e.apiKey,
        model: e.model,
        weight: sm?.weight ?? 5,
        apiFormat: ctx.detectApiFormat(e),
        providerId: e.vaultProviderId || undefined,
        _weight: sm?.weight ?? 5,
        _slotIdx: i,
      };
    });
  }

  return {
    prompt: ctx.inputValue.trim() || `请帮我分析如下来自于 "${ctx.pendingAttachment?.fileName}" 的代码。`,
    history: ctx.activeMessages.map(m => ({ sender: m.sender, content: m.content })),
    activeFile: ctx.selectedFile ? { name: ctx.selectedFile, content: ctx.editorContent } : null,
    mainModel: ctx.mainModel,
    activeSettings: ctx.activeSettings,
    chatId: ctx.activeChatId,
    provider: {
      baseUrl: ctx.mainEntry.baseUrl,
      apiKey: ctx.mainEntry.apiKey,
      model: ctx.mainEntry.model,
      providerId: ctx.mainEntry.vaultProviderId || undefined,
    },
    subProviders,
    candidateProviders: ctx.candidateEntries.map(e => ({
      displayName: e.model,
      providerName: e.providerName,
      modelName: e.model,
      baseUrl: e.baseUrl,
    })),
    images: ctx.imagesToSend,
  };
}

// ============== 辅助: 过滤 subEntries / candidateEntries ==============

/**
 * 从 modelProviderMap 提取 subEntries (在 secModels 列表 + 启用 + 有 apiKey)
 */
export function pickSubEntries(
  secModels: SecondaryModel[],
  modelProviderMap: Record<string, ModelProviderEntry>,
): ModelProviderEntry[] {
  const subModels = (secModels || []).map(s => s.id || s.name);
  return subModels
    .map(name => modelProviderMap[name])
    .filter((e): e is NonNullable<typeof e> => !!e && e.enabledInSettings && !!e.apiKey);
}

/**
 * 从 modelProviderMap 提取 candidateEntries (启用 + 有 apiKey + 不在 secModels)
 */
export function pickCandidateEntries(
  secModels: SecondaryModel[],
  modelProviderMap: Record<string, ModelProviderEntry>,
): ModelProviderEntry[] {
  const subModels = (secModels || []).map(s => s.id || s.name);
  return Object.values(modelProviderMap)
    .filter(e => e.enabledInSettings && !!e.apiKey && !subModels.includes(e.model));
}