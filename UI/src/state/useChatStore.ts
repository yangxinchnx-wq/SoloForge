/**
 * ChatPanel 核心 store
 *
 * 2026-07-03 阶段3.1.E 从 ChatPanel.tsx 抽出。
 * 原 12 个 useState + 9 个 handler 收敛到单一 zustand store,ChatPanel 只订阅渲染。
 *
 * 设计原则:
 *  - store 只持有 state + actions,不持有派生值 (派生值由组件 useMemo 计算)
 *  - props 依赖 (permissionMode/mainModel/secModels/selectedFile/editorContent/modelProviderMap/selectedChatId)
 *    通过 syncRuntimeOptions 同步到 store.options,action 内部用 get().options 读取
 *  - 持久化用模块级 useChatStore.subscribe,不依赖组件 useEffect
 *  - DOM 引用 (scrollRef/inputRef) 保留在组件,因为是 transient imperative state
 */

import { create } from 'zustand';
import { Code, Key, Brain, Database, CreditCard, HelpCircle } from '../utils/icons';
import { AndroidIcon, WindowsIcon, HarmonyOSIcon, DefaultChatIcon } from '../components/HistoryAndEditorPanel';
import { sanitizeConversations } from '../utils/chatMessageSanitizer';
import { startChat, ChatStreamEvent } from '../services/aiBackend';
import { useChatsStore } from './chatsStore';
import type { ChatMessage, ChatSettingsItem } from '../types/chat';
import type { ToolCall, HashlineReadCall, HashlineEditCall, HashlineBatchCall } from '../types';

// ==========================================
// 模块级常量 - 占位数据已清除
// ==========================================

const defaultChatDetails: Record<string, { title: string; icon: any }> = {};

const defaultConversations: Record<string, ChatMessage[]> = {};

const defaultConfigs: Record<string, ChatSettingsItem> = {};

const fallbackActiveSettings: ChatSettingsItem = {
  enabledSkills: ['code_review'],
  contextSize: 32000,
  personality: 'professional',
  tone: 'detailed',
  emojiEnabled: true,
  emojiType: 'mixed'
};

const emptyStreamState: StreamState = {
  workerOutputs: [],
  reply: '',
  scores: [],
  judgeChosen: [],
  judgeReasoning: '',
  auditFindings: [],
  deliver: '',
  suggestEnables: [],
  toolCalls: [],
};

// ==========================================
// 类型
// ==========================================

export interface StreamState {
  workerOutputs: Array<{ workerIdx: number; modelName: string; content: string; status: 'pending' | 'streaming' | 'done' | 'error' }>;
  reply: string;
  scores: Array<{ workerIdx: number; score: number; reason: string; modelName?: string }>;
  judgeChosen: number[];
  judgeReasoning: string;
  auditFindings: Array<{ severity: string; target: string; suggestion: string }>;
  deliver: string;
  suggestEnables: Array<{ candidateName: string; expectedGain: number; reason: string }>;
  toolCalls: ToolCall[];
}

/** 从 ChatPanel props 同步过来的运行时上下文 (action 内部用 get().options 读取) */
export interface ChatRuntimeOptions {
  permissionMode?: 'normal' | 'performance' | 'ultimate' | 'expert';
  selectedChatId?: string;
  mainModel?: string;
  secModels?: any[];
  selectedFile?: string;
  editorContent?: string;
  modelProviderMap?: Record<string, {
    baseUrl: string;
    apiKey: string;
    model: string;
    providerName: string;
    enabledInSettings: boolean;
  }>;
}

interface ChatStoreState {
  // ── 状态 ──────────────────────────────────────────
  conversations: Record<string, ChatMessage[]>;
  configs: Record<string, ChatSettingsItem>;
  showSettingsPopup: boolean;
  chatsList: any[];
  pendingAttachment: { fileName: string; text: string } | null;
  isPendingAttachmentExpanded: boolean;
  isGenerating: boolean;
  lastReqBody: any;
  hashlineAgentEnabled: boolean;
  streamState: StreamState;
  inputValue: string;
  showModeDropdown: boolean;

  /** props 注入字段 - 由组件挂载时 syncRuntimeOptions 同步,action 内部用 get().options 读取 */
  options: ChatRuntimeOptions;

  // ── setters ──────────────────────────────────────
  setConversations: (updater: Record<string, ChatMessage[]> | ((prev: Record<string, ChatMessage[]>) => Record<string, ChatMessage[]>)) => void;
  setConfigs: (updater: Record<string, ChatSettingsItem> | ((prev: Record<string, ChatSettingsItem>) => Record<string, ChatSettingsItem>)) => void;
  setShowSettingsPopup: (v: boolean) => void;
  setChatsList: (v: any[]) => void;
  setPendingAttachment: (v: { fileName: string; text: string } | null) => void;
  setIsPendingAttachmentExpanded: (v: boolean) => void;
  setIsGenerating: (v: boolean) => void;
  setLastReqBody: (v: any) => void;
  setHashlineAgentEnabled: (v: boolean) => void;
  setStreamState: (updater: StreamState | ((prev: StreamState) => StreamState)) => void;
  setInputValue: (updater: string | ((prev: string) => string)) => void;
  setShowModeDropdown: (v: boolean) => void;
  syncRuntimeOptions: (opts: Partial<ChatRuntimeOptions>) => void;

  // ── 复合 actions ─────────────────────────────────
  /** 从后端加载会话列表 */
  loadChatsList: () => void;
  /** 从后端加载会话配置 */
  loadChatConfigs: () => void;
  /** 从后端一次性加载所有对话消息 + 配置 (启动时调用) */
  loadConversationsFromBackend: () => Promise<void>;
  /** 更新当前激活会话的设置 (merge) */
  handleUpdateActiveSettings: (updates: Partial<ChatSettingsItem>) => void;
  /** 根据会话 tag 返回对应 React 图标组件 */
  getActiveChatIcon: (localChatInfo: any, activeChatId: string) => any;
  /** 根据会话 tag 返回兜底消息数组 */
  getFallbackMessages: (localChatInfo: any) => ChatMessage[];
  /** 核心发送逻辑:构造 reqBody + startChat 调用 + SSE 回调 */
  handleSend: (inputRef?: React.RefObject<HTMLTextAreaElement | null>) => void;
  /** 阶段 0 建议启用 - 用户点"启用并重发"后回调 */
  handleAcceptEnable: (candidateName: string) => void;
  /** 处理单个 SSE 事件,更新 streamState + 提交 assistant 消息 */
  handlePhase: (evt: any, currentChatMsgs: ChatMessage[]) => void;
}

// ==========================================
// 模块级持久化 — 后端 API (替代旧 localStorage)
// ==========================================

let persistIdleHandle: any = null;
let lastPersistedConversations: Record<string, ChatMessage[]> | null = null;
let lastPersistedConfigs: Record<string, ChatSettingsItem> | null = null;

/**
 * 防抖全量同步 conversations + configs 到后端
 * 用 requestIdleCallback (或 setTimeout fallback) 防止流式 token 高频写入打满网络
 */
function schedulePersistToBackend(conversations: Record<string, ChatMessage[]>, configs: Record<string, ChatSettingsItem>) {
  if (typeof window === 'undefined') return;
  if (persistIdleHandle) {
    if (typeof persistIdleHandle === 'object' && typeof (persistIdleHandle as any).cancel === 'function') {
      (persistIdleHandle as any).cancel();
    } else if (typeof persistIdleHandle === 'number') {
      clearTimeout(persistIdleHandle);
    }
    persistIdleHandle = null;
  }
  const w = window as any;
  const doFlush = () => {
    try {
      fetch('/api/conversations', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversations, configs }),
      }).catch(() => {});
    } catch {}
  };
  if (w.requestIdleCallback && w.cancelIdleCallback) {
    const handle = w.requestIdleCallback(doFlush, { timeout: 2000 });
    persistIdleHandle = { cancel: () => w.cancelIdleCallback(handle) };
  } else {
    persistIdleHandle = setTimeout(doFlush, 800);
  }
}

// ==========================================
// store 创建
// ==========================================
// 2026-07-06: initialConversations / initialConfigs 不再从 localStorage 读取
// 启动时由 main.tsx 调 loadConversationsFromBackend() 从后端异步加载

const initialConversations: Record<string, ChatMessage[]> = {};
const initialConfigs: Record<string, ChatSettingsItem> = {};

export const useChatStore = create<ChatStoreState>((set, get) => ({
  // ── 初始状态 ──────────────────────────────────────
  conversations: initialConversations,
  configs: initialConfigs,
  showSettingsPopup: false,
  chatsList: [],
  pendingAttachment: null,
  isPendingAttachmentExpanded: false,
  isGenerating: false,
  lastReqBody: null,
  hashlineAgentEnabled: false,
  streamState: emptyStreamState,
  inputValue: '',
  showModeDropdown: false,
  options: {},

  // ── setters ──────────────────────────────────────
  setConversations: (updater) => set((state) => ({
    conversations: typeof updater === 'function' ? (updater as any)(state.conversations) : updater
  })),
  setConfigs: (updater) => set((state) => ({
    configs: typeof updater === 'function' ? (updater as any)(state.configs) : updater
  })),
  setShowSettingsPopup: (v) => set({ showSettingsPopup: v }),
  setChatsList: (v) => set({ chatsList: v }),
  setPendingAttachment: (v) => set({ pendingAttachment: v }),
  setIsPendingAttachmentExpanded: (v) => set({ isPendingAttachmentExpanded: v }),
  setIsGenerating: (v) => set({ isGenerating: v }),
  setLastReqBody: (v) => set({ lastReqBody: v }),
  setHashlineAgentEnabled: (v) => set({ hashlineAgentEnabled: v }),
  setStreamState: (updater) => set((state) => ({
    streamState: typeof updater === 'function' ? (updater as any)(state.streamState) : updater
  })),
  setInputValue: (updater) => set((state) => ({
    inputValue: typeof updater === 'function' ? (updater as any)(state.inputValue) : updater
  })),
  setShowModeDropdown: (v) => set({ showModeDropdown: v }),
  syncRuntimeOptions: (opts) => set((state) => ({ options: { ...state.options, ...opts } })),

  // ── 复合 actions ─────────────────────────────────
  loadChatsList: () => {
    if (typeof window === 'undefined') return;
    // 从后端权威的 chatsStore 拉取 (替代旧 localStorage 读取)
    // chatsStore 由 main.tsx 启动时 loadFromBackend 填充, 此处只是镜像同步
    try {
      const chats = useChatsStore.getState().chats;
      const mapped = chats.map((c: any) => ({
        id: c.id,
        title: c.title,
        time: c.time || '',
        tag: c.tag,
        tagBg: c.tagBg,
        tagText: c.tagText,
        icon: undefined, // icon 由 getActiveChatIcon 根据 tag 动态映射, 不需预存
        permission: c.permission,
      }));
      set({ chatsList: mapped });
    } catch {
      // chatsStore 尚未初始化, 留空即可
    }
  },

  loadChatConfigs: () => {
    if (typeof window === 'undefined') return;
    // configs 已随 loadConversationsFromBackend 一起加载, 这里只做 noop
  },

  loadConversationsFromBackend: async () => {
    if (typeof window === 'undefined') return;
    try {
      const resp = await fetch('/api/conversations');
      if (!resp.ok) return;
      const data = await resp.json();
      if (data.success) {
        const convos = data.conversations && typeof data.conversations === 'object' ? data.conversations : {};
        const cfgs = data.configs && typeof data.configs === 'object' ? data.configs : {};
        // 用 sanitizeConversations 清理旧数据中可能残留的外链 avatar
        const sanitized = sanitizeConversations(convos);
        // 更新 store, 同时更新 lastPersisted 避免触发回写循环
        lastPersistedConversations = sanitized;
        lastPersistedConfigs = cfgs;
        set({ conversations: sanitized, configs: cfgs });
        console.log('[useChatStore] 从后端加载对话消息:', Object.keys(sanitized).length, '条对话');
      }
    } catch (e) {
      console.warn('[useChatStore] 从后端加载对话消息失败:', (e as Error).message);
    }
  },

  handleUpdateActiveSettings: (updates) => {
    const { options, configs } = get();
    const activeChatId = options.selectedChatId || '1';
    const activeSettings = configs[activeChatId] || fallbackActiveSettings;
    set({
      configs: {
        ...configs,
        [activeChatId]: { ...activeSettings, ...updates }
      }
    });
  },

  getActiveChatIcon: (localChatInfo, activeChatId) => {
    if (localChatInfo?.tag === 'ANDROID') return AndroidIcon;
    if (localChatInfo?.tag === 'WINDOWS') return WindowsIcon;
    if (localChatInfo?.tag === 'HARMONY') return HarmonyOSIcon;
    if (localChatInfo?.tag === 'NEW') return DefaultChatIcon;
    if (localChatInfo?.tag === 'VUE') return Code;
    if (localChatInfo?.tag === 'AUTH') return Key;
    if (localChatInfo?.tag === 'AI') return Brain;
    if (localChatInfo?.tag === 'DB') return Database;
    if (localChatInfo?.tag === 'PAY') return CreditCard;
    if (localChatInfo?.tag === 'HELP') return HelpCircle;
    return DefaultChatIcon;
  },

  getFallbackMessages: (localChatInfo) => {
    if (localChatInfo?.tag === 'ANDROID') {
      return [
        {
          sender: 'assistant',
          content: '👋 你好！已为您开启 **Android 应用开发** 专属智能架构与调试辅助面板。\n\n后端系统与真实工具编译调试接口已接入就绪。您可以就以下领域发起提问：\n\n1. 📱 **Jetpack Compose 视图流**：高效的声明式 UI 最佳组件化划分姿态。\n2. 协程 & Flow 异步并发管理，避免主线程卡死现象。\n3. Gradle 构建重构、三方 SDK 统一依赖配置与 Android SDK 高版本适配规约。\n4. 真机/模拟器 ADB 调试报错堆栈智能定位。\n\n请在输入框键入您想要探讨的代码问题！',
          time: '刚才',
          avatar: ''
        }
      ];
    }
    if (localChatInfo?.tag === 'WINDOWS') {
      return [
        {
          sender: 'assistant',
          content: '👋 你好！已为您开启 **Windows 软件开发/桌面系统** 专属智能架构辅助面板。\n\n后端编译及运行接口环境整备完成。支持提问的技术体系：\n\n1. 🖥️ **WPF / WinForms / WinUI 3**：MVVM 架构重构及自定义精美现代皮肤制作。\n2. Win32 底层 API 调用、高性能 C++ DLL 混合调用与多线程资源释放预防内存积压。\n3. MSIX / Advanced Installer 标准静默打包、Windows 平台软件防病毒篡改签名工作流。\n4. 针对不同版本的 Windows OS 精细化桌面通知及注册表检索。\n\n欢迎直接向我提供您的需求！',
          time: '刚才',
          avatar: ''
        }
      ];
    }
    if (localChatInfo?.tag === 'HARMONY') {
      return [
        {
          sender: 'assistant',
          content: '👋 你好！已为您开启 **鸿蒙 (HarmonyOS / OpenHarmony)** 生态开发专属高级顾问。\n\n后端调试器与 DevEco Studio 热重载模块交互链路随时待命。核心探讨板块示范：\n\n1. 🔴 **ArkTS 极速业务逻辑编写**：理解 `@State`, `@Prop`, `@Link`, `@Provide` 极佳响应式流状态装饰器搭配运作。\n2. ArkUI 自定义精致声明式组件构建，精细控制渲染性能指标。\n3. Stage 分层架构模型规范、多个 Feature Ability (FA级) 交互安全防护与切片加载处理机制。\n4. 鸿蒙原生多设备适配分布式流转，在平板、折叠屏及智能穿戴间无缝同步。\n\n有什么问题尽管问！',
          time: '刚才',
          avatar: ''
        }
      ];
    }
    return [];
  },

  handleSend: (inputRef) => {
    const state = get();
    const { inputValue, pendingAttachment, conversations, options, hashlineAgentEnabled } = state;
    const { permissionMode = 'normal', mainModel = 'GPT-4o', secModels = [], selectedFile, editorContent, modelProviderMap = {}, selectedChatId = '1' } = options;

    if (!inputValue.trim() && !pendingAttachment) return;

    const finalContent = inputValue.trim() || `请帮我分析如下来自于 "${pendingAttachment?.fileName}" 的代码。`;

    const userMsg: ChatMessage = {
      sender: 'user',
      content: finalContent,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      avatar: '',
    };

    if (pendingAttachment) {
      userMsg.attachment = {
        fileName: pendingAttachment.fileName,
        text: pendingAttachment.text
      };
    }

    const activeChatId = selectedChatId || '1';
    const activeMessages = conversations[activeChatId] || [];
    const currentChatMsgs = [...activeMessages, userMsg];

    set({
      conversations: { ...conversations, [activeChatId]: currentChatMsgs },
      inputValue: '',
      pendingAttachment: null,
      isGenerating: true,
      streamState: { ...emptyStreamState },
    });

    // 构造请求体 (设计文档: UI/连接.md §3.1 §4.1)
    const mainEntry = modelProviderMap[mainModel];
    if (!mainEntry || !mainEntry.apiKey) {
      const assistantMsg: ChatMessage = {
        sender: 'assistant',
        content: `❌ **主模型未配置**：请在「设置 → 模型」中测试通过主模型「${mainModel}」后再试。`,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        avatar: ''
      };
      set((s) => ({
        conversations: { ...s.conversations, [activeChatId]: [...currentChatMsgs, assistantMsg] },
        isGenerating: false,
      }));
      return;
    }

    // 副模型:必须是 secModels 列表里 + map 里存在 + enabledInSettings=true
    const subModelIds = (secModels || []).map((s: any) => s.id || s.name);
    const subEntries = subModelIds
      .map((name: string) => modelProviderMap[name])
      .filter((e: any): e is NonNullable<typeof e> => !!e && e.enabledInSettings && !!e.apiKey);

    // 候选副模型:所有 enabledInSettings=true 但不在 secModels 里的
    const candidateEntries = Object.values(modelProviderMap)
      .filter((e: any) => e.enabledInSettings && !!e.apiKey && !subModelIds.includes(e.model));

    const reqBody = {
      mode: permissionMode,
      query: finalContent,
      history: activeMessages.map(m => ({ sender: m.sender, content: m.content })),
      fileContext: selectedFile ? { name: selectedFile, content: editorContent } : undefined,
      toolCallMode: hashlineAgentEnabled ? 'hashline' : undefined,
      mainProvider: {
        baseUrl: mainEntry.baseUrl,
        apiKey: mainEntry.apiKey,
        model: mainEntry.model
      },
      subProviders: subEntries.map(e => ({ baseUrl: e.baseUrl, apiKey: e.apiKey, model: e.model })),
      candidateProviders: candidateEntries.map((e: any) => ({
        displayName: e.model,
        providerName: e.providerName,
        modelName: e.model,
        baseUrl: e.baseUrl
      }))
    };
    set({ lastReqBody: reqBody });

    const assistantMsg: ChatMessage = {
      sender: 'assistant',
      content: '',
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      avatar: '',
    };
    set((s) => ({
      conversations: { ...s.conversations, [activeChatId]: [...currentChatMsgs, assistantMsg] },
    }));

    // 2026-07-06 阶段3: 派发 AST 预览触发事件 → usePreviewBridge 接收
    //   - 预览流并行于主聊天 SSE, 独立 LLM 调用生成 UniversalAST
    //   - PreviewPanel 订阅 previewStreamStore 展示流式状态
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('soloforge-preview-trigger', {
        detail: { chatId: activeChatId, message: finalContent }
      }));
    }

    // 2026-07-03 阶段5.B: 调用形式对齐 aiBackend.startChat(req, onEvent) 单回调签名
    //   - aiBackend 把所有事件 (text/phase/error/done) 都通过 onEvent 推送
    //   - 不再有 { onDelta, onEvent, onError, onDone } 4 回调对象 (旧形式, 用 as any 绕过类型)
    //   - 这里按 evt.kind 分派到对应处理逻辑
    startChat(
      {
        chatId: activeChatId,
        prompt: finalContent,
        mode: permissionMode,
        history: activeMessages.map(m => ({ sender: m.sender, content: m.content })),
        fileContext: selectedFile ? { name: selectedFile, content: editorContent } : undefined,
        mainProvider: {
          baseUrl: mainEntry.baseUrl,
          apiKey: mainEntry.apiKey,
          model: mainEntry.model
        },
        subProviders: subEntries.map(e => ({ baseUrl: e.baseUrl, apiKey: e.apiKey, model: e.model })),
        candidateProviders: candidateEntries.map((e: any) => ({
          displayName: e.model,
          providerName: e.providerName,
          modelName: e.model,
          baseUrl: e.baseUrl
        })),
        ...(hashlineAgentEnabled ? { toolCallMode: 'hashline' } : {})
      } as any,
      (evt: ChatStreamEvent) => {
        switch (evt.kind) {
          case 'text': {
            // 流式增量文本 → 追加到当前 assistant 消息
            set({ isGenerating: false });
            set((s) => {
              const currentList = s.conversations[activeChatId] || [];
              if (currentList.length === 0) return s;
              const newList = [...currentList];
              const lastMsg = { ...newList[newList.length - 1] };
              if (lastMsg.sender === 'assistant') {
                lastMsg.content += evt.text;
                newList[newList.length - 1] = lastMsg;
              }
              return { conversations: { ...s.conversations, [activeChatId]: newList } };
            });
            break;
          }
          case 'phase': {
            // phase 事件 → 走 handlePhase 更新 streamState
            get().handlePhase(evt, currentChatMsgs);
            break;
          }
          case 'error': {
            console.error('[aiBackend error]', evt.error);
            set((s) => {
              const currentList = s.conversations[activeChatId] || [];
              if (currentList.length === 0) return s;
              const newList = [...currentList];
              const lastMsg = { ...newList[newList.length - 1] };
              if (lastMsg.sender === 'assistant') {
                lastMsg.content = `❌ **AI 调用失败**：${evt.error}\n\n请检查后端 /api/agents/dispatch 是否在运行。`;
                newList[newList.length - 1] = lastMsg;
              }
              return { conversations: { ...s.conversations, [activeChatId]: newList } };
            });
            break;
          }
          case 'done': {
            set({ isGenerating: false });
            break;
          }
        }
      }
    );
  },

  handleAcceptEnable: (candidateName) => {
    const state = get();
    const { lastReqBody, options } = state;
    if (!lastReqBody) return;
    const entry = (options.modelProviderMap || {})[candidateName];
    if (!entry || !entry.apiKey) return;
    const activeChatId = options.selectedChatId || '1';
    // 把 candidate 提升为 sub
    const newSub = { baseUrl: entry.baseUrl, apiKey: entry.apiKey, model: entry.model };
    const newReqBody = {
      ...lastReqBody,
      subProviders: [...(lastReqBody.subProviders as any[]), newSub],
      candidateProviders: (lastReqBody.candidateProviders as any[]).filter((c: any) => c.modelName !== candidateName),
      enableDecision: { candidateName: candidateName, accept: true }
    };
    set({
      streamState: { ...emptyStreamState },
      isGenerating: true,
    });
    // 2026-07-03 阶段5.B: 调用形式对齐 aiBackend.startChat(req, onEvent) 单回调签名
    startChat(
      {
        chatId: activeChatId,
        prompt: '',
        mode: lastReqBody.mode,
        history: [],
        mainProvider: (lastReqBody.mainProvider as any),
        subProviders: newSub ? [...(lastReqBody.subProviders as any[]), newSub] : (lastReqBody.subProviders as any[]),
        candidateProviders: (lastReqBody.candidateProviders as any[]).filter((c: any) => c.modelName !== candidateName)
      } as any,
      (evt: ChatStreamEvent) => {
        switch (evt.kind) {
          case 'phase': {
            const s = get();
            const activeMessages = s.conversations[activeChatId] || [];
            s.handlePhase(evt, activeMessages);
            break;
          }
          case 'error':
            console.error('[handleAcceptEnable error]', evt.error);
            break;
          case 'done':
            set({ isGenerating: false });
            break;
          case 'text':
            // handleAcceptEnable 不消费流式文本, 留空
            break;
        }
      }
    );
  },

  handlePhase: (evt, currentChatMsgs) => {
    // 2026-07-03 阶段5.B: 守卫 - 只处理 kind==='phase' 的事件
    //   aiBackend 推送的 ChatStreamEvent 有 4 种 kind: text/phase/error/done
    //   text/error/done 由调用方 (handleSend/handleAcceptEnable) 处理, 不进 handlePhase
    if (evt.kind !== 'phase') return;
    const { options } = get();
    const activeChatId = options.selectedChatId || '1';

    set((s) => {
      const prev = s.streamState;
      const next: StreamState = { ...prev };
      switch (evt.phase) {
        case 'phase0_skip':
          break;
        case 'suggest_enable':
          next.suggestEnables = [...prev.suggestEnables, {
            candidateName: evt.candidateName,
            expectedGain: evt.expectedGain,
            reason: evt.reason ?? ''
          }];
          break;
        case 'dispatch':
          next.workerOutputs = (evt.subtasks as string[]).map((m, i) => ({
            workerIdx: i, modelName: m, content: '', status: 'pending'
          }));
          break;
        case 'worker_start':
          next.workerOutputs = prev.workerOutputs.map(w =>
            w.workerIdx === evt.workerIdx ? { ...w, status: 'streaming' } : w
          );
          break;
        case 'worker_done':
          next.workerOutputs = prev.workerOutputs.map(w =>
            w.workerIdx === evt.workerIdx
              ? { ...w, status: evt.content?.startsWith('⚠️') ? 'error' : 'done', content: evt.content ?? '' }
              : w
          );
          break;
        case 'reply':
          next.reply = prev.reply + (evt.delta ?? '');
          break;
        case 'audit_stream':
          next.reply = prev.reply + (evt.delta ?? '');
          break;
        case 'score':
          next.scores = evt.scores ?? [];
          break;
        case 'judge':
          next.judgeChosen = evt.chosen ?? [];
          next.judgeReasoning = evt.reasoning ?? '';
          break;
        case 'audit':
          next.auditFindings = evt.findings ?? [];
          break;
        case 'deliver':
          next.deliver = prev.deliver + (evt.delta ?? '');
          break;
        case 'tool_call': {
          const idx = prev.toolCalls.findIndex(t => t.id === evt.callId);
          const status = evt.status;
          const kind = evt.tool;
          const stamp = evt.timestamp ?? Date.now();
          const baseList = [...prev.toolCalls];
          if (kind === 'hashline.read') {
            const tc: HashlineReadCall = {
              id: evt.callId,
              kind: 'hashline.read',
              status,
              filePath: evt.filePath ?? '',
              version: evt.version,
              errorCode: evt.errorCode,
              timestamp: stamp,
            };
            if (idx >= 0) baseList[idx] = tc; else baseList.push(tc);
          } else if (kind === 'hashline.edit') {
            const tc: HashlineEditCall = {
              id: evt.callId,
              kind: 'hashline.edit',
              status,
              filePath: evt.filePath ?? '',
              op: evt.op ?? 'replace',
              diff: evt.diff,
              diffSummary: evt.diffSummary,
              removedLineCount: evt.removedLineCount,
              insertedLineCount: evt.insertedLineCount,
              newVersion: evt.version,
              errorCode: evt.errorCode,
              timestamp: stamp,
            };
            if (idx >= 0) baseList[idx] = tc; else baseList.push(tc);
          } else {
            const tc: HashlineBatchCall = {
              id: evt.callId,
              kind: 'hashline.batch',
              status,
              total: evt.results?.length ?? 1,
              succeeded: status === 'success' ? (evt.results?.length ?? 0) : (evt.results?.length ?? 0),
              failedAt: evt.failedAt,
              errorCode: evt.errorCode,
              results: evt.results as any,
              timestamp: stamp,
            };
            if (idx >= 0) baseList[idx] = tc; else baseList.push(tc);
          }
          next.toolCalls = baseList;
          break;
        }
        case 'warn':
          console.warn('[orchestrator warn]', evt.msg);
          break;
        case 'done': {
          const finalReply = evt.reply ?? prev.deliver ?? prev.reply;
          const findings = evt.audit ?? prev.auditFindings;
          let content = finalReply;
          if (findings && findings.length > 0) {
            content += '\n\n---\n\n## ⚠️ 审计提示\n\n' +
              findings.map((f: any) => `- **[${f.severity?.toUpperCase()}]** ${f.target}\n  建议：${f.suggestion}`).join('\n');
          }
          if (next.suggestEnables.length > 0) {
            content += '\n\n---\n\n## 💡 建议启用\n\n' +
              next.suggestEnables.map(s => `- **${s.candidateName}**（预期增益 ${(s.expectedGain * 100).toFixed(0)}%）：${s.reason}`).join('\n');
          }
          const assistantMsg: ChatMessage = {
            sender: 'assistant',
            content,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
            avatar: '',
            toolCalls: next.toolCalls.length > 0 ? next.toolCalls : undefined,
          };
          // 提交最终 assistant 消息 (覆盖中间流式 placeholder)
          // zustand 允许在 set 回调内嵌套 set, 会触发两次 store 通知, 与原 useState 嵌套行为一致
          set((s2) => ({
            conversations: { ...s2.conversations, [activeChatId]: [...currentChatMsgs, assistantMsg] }
          }));
          break;
        }
        case 'error':
          console.error('[orchestrator error]', evt.msg);
          break;
        default:
          break;
      }
      return { streamState: next };
    });
  },
}));

// ==========================================
// 模块级持久化订阅 — 后端 API 同步
// 在 store 模块加载时立即注册,组件卸载也不取消 (持久化是全局行为)
// ==========================================

useChatStore.subscribe((state, prevState) => {
  const convChanged = state.conversations !== prevState.conversations && state.conversations !== lastPersistedConversations;
  const cfgChanged = state.configs !== prevState.configs && state.configs !== lastPersistedConfigs;
  if (convChanged) {
    lastPersistedConversations = state.conversations;
  }
  if (cfgChanged) {
    lastPersistedConfigs = state.configs;
  }
  if (convChanged || cfgChanged) {
    schedulePersistToBackend(state.conversations, state.configs);
  }
});

// 导出模块级常量供组件 useMemo 使用
export { defaultChatDetails, defaultConversations, defaultConfigs, fallbackActiveSettings };
