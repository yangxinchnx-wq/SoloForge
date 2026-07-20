import React, { useRef, useEffect, useMemo, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Send, ChevronDown, ChevronUp, FileCode, X, SlidersHorizontal, Check, ShieldAlert, ThumbsUp, ThumbsDown, Copy, Loader2, Pause, Play, RefreshCw, Lock, Unlock } from '../utils/icons';
import { motion, AnimatePresence } from 'framer-motion';
import { MountTransition } from './MountTransition';
import TerminalPanelWithWorkdir from './terminal/TerminalPanelWithWorkdir';
// 2026-07-03 阶段3.1.C: DocsGeneratorModal 抽出为独立子应用, 状态收敛到 useDocsGeneratorStore
import DocsGeneratorModal from './DocsGeneratorModal';
// 2026-07-03 阶段3.1.D: ResourceManagerBar 抽出为独立子应用, 状态收敛到 useResourceManagerStore
import ResourceManagerBar from './ResourceManagerBar';

import { ModelIcon } from './ModelIcon';
import { ToolCallCard } from './ToolCallCard';
import StreamPanel from './StreamPanel';
import { StreamContextMenu } from './StreamContextMenu';
// ★ 2026-07-13: 多轮对话独立气泡 — 每轮 assistant 消息渲染自己的过程 parts
import { UIMessagePartsRenderer } from './UIMessagePartsRenderer';
// ★ 2026-07-19: assistant 消息气泡可拖拽调整高度
import { useUIMessages } from '../services/uiMessageStore';
import type { ChatPanelProps, ChatSettingsItem } from '../types/chat';
import { getSettingsSummary } from '../types/chat';
// 2026-07-03 阶段3.1.B 子组件抽出:
//   4 个权限模式图标 → permissionModeIcons.tsx
//   CollapsibleCodeBlock + FormatChatMessage → chatMessage/
//   6 个 stream 子视图 → streamViews.tsx
import { CollapsibleCodeBlock, FormatChatMessage } from './chatMessage';
import { SuggestEnableView } from './streamViews';
// 2026-07-03 阶段3.1.E: 12 个 state + 9 个 handler 收敛到 useChatStore
import { useChatStore, fallbackActiveSettings } from '../state/useChatStore';
import { useAppStore } from '../state/appStore';
import { useRenderTrace } from '../hooks/useRenderTrace';

// 4 个权限模式图标 (NormalIcon/PerformanceIcon/ExpertIcon/UltimateIcon) 已外移到
// permissionModeIcons.tsx (2026-07-03 阶段3.1.B)
// ★ 2026-07-20: 移除兼容性 re-export — export { } 会导致 Vite Fast Refresh 降级为
//   full page reload (Fast Refresh 要求文件只导出组件, 不能有 re-export)
//   使用者请直接从 permissionModeIcons.tsx 导入

// ChatPanelProps / ChatSettingsItem 已外移到 types/chat.ts (2026-07-03 阶段3.1.A)
export type { ChatPanelProps, ChatSettingsItem } from '../types/chat';

// 模式选择器动画变体 — 与 SecondaryModelSelector 一致的"柔和推出"效果
const modePanelVariants = {
  hidden: {
    opacity: 0,
    scale: 0.94,
    y: 20,
    transition: {
      // 关闭: 快速收起 (140ms), 往下退 + 淡出
      duration: 0.14,
      ease: [0.4, 0, 1, 1] as [number, number, number, number],
    },
  },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: {
      // 开启: 380ms ease-out-expo, 慢启动消除突兀, 长尾缓停丝滑
      duration: 0.38,
      ease: [0.16, 1, 0.3, 1] as [number, number, number, number],
    },
  },
};

const modeContentVariants = {
  hidden: { opacity: 0, y: 8 },
  visible: {
    opacity: 1,
    y: 0,
    // 内容与面板同方向同曲线, 延迟 80ms 让面板先成型再显内容
    transition: {
      duration: 0.32,
      ease: [0.16, 1, 0.3, 1] as [number, number, number, number],
      delay: 0.08,
    },
  },
};

const modeBackdropVariants = {
  hidden: { opacity: 0, transition: { duration: 0.18, ease: [0.4, 0, 1, 1] as [number, number, number, number] } },
  visible: { opacity: 1, transition: { duration: 0.22, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] } },
};

// 模式选择器按钮动画 — 与 backdrop 一致的 opacity 渐入渐出
const modeButtonVariants = {
  hidden: {
    opacity: 0,
    transition: { duration: 0.18, ease: [0.4, 0, 1, 1] as [number, number, number, number] },
  },
  visible: {
    opacity: 1,
    transition: { duration: 0.22, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] },
  },
};

// generateSmartReply 已删除 (2026-07-03 阶段3.1.A) - mock 时代死代码, 实际走 startChat 真实流式
// getSettingsSummary 已外移到 types/chat.ts

// 6 个 stream 子视图 (WorkerOutputsView/ScoresView/JudgeView/AuditView/FinalReplyView/SuggestEnableView)
// 已外移到 streamViews.tsx (2026-07-03 阶段3.1.B) - 顶部已 import, 主组件直接使用

// 2026-07-03 阶段3.1.E:
//   - defaultChatDetails / defaultConversations / defaultConfigs 已迁到 useChatStore.ts (模块级)
//   - 12 个 useState (conversations/configs/showSettingsPopup/chatsList/pendingAttachment/
//     isPendingAttachmentExpanded/isGenerating/lastReqBody/hashlineAgentEnabled/streamState/
//     inputValue/showModeDropdown) → useChatStore
//   - 9 个 handler (loadChatsList/loadChatConfigs/handleUpdateActiveSettings/getActiveChatIcon/
//     getFallbackMessages/handleSend/handleAcceptEnable/handlePhase/streamSse) → useChatStore
//     其中 streamSse 已删除 (死代码, 已被 utils/sseStream.ts 的 parseSseStream 替代)
//   - 持久化 useEffect + persistIdleCancelRef 已迁到 useChatStore 模块级 subscribe
//   - props 依赖通过 syncRuntimeOptions 同步到 store.options,action 内部 get().options 读取

const ChatPanel = React.memo(function ChatPanel({
  modelProviderMap = {}
}: ChatPanelProps) {
  // ★ 从 appStore 直接订阅, 切断 App→MainLayout props 透传链, 避免打字/切文件/切对话全局刷新
  //   原 props (permissionMode/selectedChatId/mainModel/secModels/mixedTasks/selectedFile/editorContent)
  //   全部改由 store 细粒度订阅, MainLayout 不再传这些 prop
  //
  // ★★ 2026-07-20 优化: 移除 selectedFile/editorContent/mixedTasks 的响应式订阅
  //   这三个字段不在 ChatPanel JSX 中直接使用, 只需同步到 useChatStore.options
  //   供 handleSend/resumeChat 内部 get().options 读取即可。
  //   selectedFile/editorContent 高频变化 (编辑器打字时),
  //   响应式订阅会导致 ChatPanel (1200+行大组件) 每次打字都重渲染 →
  //   消息列表/输入框/模式选择器等全部重新创建 JSX → 全局刷新感。
  //   改用 useAppStore.subscribe(selector, listener) 监听变化, 只同步不重渲染。
  const permissionMode = useAppStore(s => s.currentPermissionMode);
  const setPermissionMode = useAppStore(s => s.setCurrentPermissionMode);
  const selectedChatId = useAppStore(s => s.selectedChatId);
  const mainModel = useAppStore(s => s.mainModel);
  const secModels = useAppStore(s => s.secModels);
  // ==========================================
  // 【后端对接提示 - 获取特定会话下的历史消息记录】
  // 原先直接通过 localStorage 读取了所有对话列表记录。接入后端数据库后：
  // 1. 可以封装接口: GET /api/chats/:chatId/messages，返回该会话的所有消息实体，格式包含: sender, content, attachment, time
  // 2. 将数据保存至对应数据库（如 PostgreSQL / Firestore）的消息历史表中
  // ==========================================
  // 2026-07-03 阶段3.1.E: 全部 state 由 useChatStore 提供, 此处只订阅
  const conversations = useChatStore(s => s.conversations);
  const configs = useChatStore(s => s.configs);
  const chatsList = useChatStore(s => s.chatsList);
  const pendingAttachment = useChatStore(s => s.pendingAttachment);
  const isPendingAttachmentExpanded = useChatStore(s => s.isPendingAttachmentExpanded);
  const isGenerating = useChatStore(s => s.isGenerating);
  const isPaused = useChatStore(s => s.isPaused);
  const streamState = useChatStore(s => s.streamState);
  const inputValue = useChatStore(s => s.inputValue);
  const showModeDropdown = useChatStore(s => s.showModeDropdown);
  const workspaceApproval = useChatStore(s => s.workspaceApproval);
  // ★ 调试: 渲染追踪 (传入所有订阅的 store 值, 检测哪个变化触发了重渲染)
  useRenderTrace('ChatPanel', { modelProviderMap, permissionMode, selectedChatId, mainModel, secModels_count: secModels?.length, inputValue_len: inputValue?.length, isGenerating, isPaused });

  // ★ 直接从 appStore 取 setActiveSettingsChat, 不再走 CustomEvent 间接调用
  //   原: button → window.dispatchEvent → useFileOperations useEffect → setActiveSettingsChat
  //   新: button → setActiveSettingsChat (直接, 零中间层)
  const setActiveSettingsChat = useAppStore(s => s.setActiveSettingsChat);

  // setters / actions (函数引用稳定, 不需 selector)
  const setInputValue = useChatStore(s => s.setInputValue);
  const setPendingAttachment = useChatStore(s => s.setPendingAttachment);
  const setIsPendingAttachmentExpanded = useChatStore(s => s.setIsPendingAttachmentExpanded);
  const setShowModeDropdown = useChatStore(s => s.setShowModeDropdown);
  const resolveWorkspaceApproval = useChatStore(s => s.resolveWorkspaceApproval);
  const syncRuntimeOptions = useChatStore(s => s.syncRuntimeOptions);
  const loadChatsList = useChatStore(s => s.loadChatsList);
  const loadChatConfigs = useChatStore(s => s.loadChatConfigs);
  const handleSendFromStore = useChatStore(s => s.handleSend);
  const pauseChat = useChatStore(s => s.pauseChat);
  const resumeChat = useChatStore(s => s.resumeChat);
  const discardPausedGeneration = useChatStore(s => s.discardPausedGeneration);
  const handleAcceptEnable = useChatStore(s => s.handleAcceptEnable);

  // DOM 引用保留组件本地 (transient imperative state, 不进 store)
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // 2026-07-03 阶段3.1.E: 同步 props 到 store.options (action 内部用 get().options 读取)
  // ★★ 2026-07-20: selectedFile/editorContent 改用 getState() 读取 + subscribe 监听
  //   不再作为响应式依赖, 避免编辑器打字时触发 ChatPanel 重渲染
  useEffect(() => {
    const appState = useAppStore.getState();
    syncRuntimeOptions({
      permissionMode,
      selectedChatId,
      mainModel,
      secModels,
      selectedFile: appState.selectedFile,
      editorContent: appState.editorContent,
      modelProviderMap,
    });
  }, [permissionMode, selectedChatId, mainModel, secModels, modelProviderMap, syncRuntimeOptions]);

  // ★★ 2026-07-20: 用 subscribe 监听 selectedFile/editorContent 变化
  //   只同步到 useChatStore.options, 不触发 ChatPanel 重渲染
  //   编辑器打字 → editorContent 变 → 此回调执行 → syncRuntimeOptions → 完
  //   ChatPanel 不参与重渲染, 消息列表/输入框等子组件不受影响
  useEffect(() => {
    const unsubSelectedFile = useAppStore.subscribe(
      (s) => s.selectedFile,
      (selectedFile) => {
        syncRuntimeOptions({ selectedFile });
      }
    );
    const unsubEditorContent = useAppStore.subscribe(
      (s) => s.editorContent,
      (editorContent) => {
        syncRuntimeOptions({ editorContent });
      }
    );
    return () => {
      unsubSelectedFile();
      unsubEditorContent();
    };
  }, [syncRuntimeOptions]);

  // 2026-07-03 阶段3.1.E: chatsList/configs 跨窗口更新事件监听
  useEffect(() => {
    loadChatsList();
    window.addEventListener('soloforge-chats-updated', loadChatsList);
    window.addEventListener('soloforge-chat-configs-updated', loadChatConfigs);
    return () => {
      window.removeEventListener('soloforge-chats-updated', loadChatsList);
      window.removeEventListener('soloforge-chat-configs-updated', loadChatConfigs);
    };
  }, [loadChatsList, loadChatConfigs]);

  // 2026-07-03 阶段3.1.E: add-to-chat / send-code-to-chat 事件监听 (需要 inputRef.focus, 保留组件)
  useEffect(() => {
    const handleAddToChat = (e: Event) => {
      const customVal = (e as CustomEvent).detail;
      if (customVal && customVal.filePath) {
        setInputValue(prev => {
          const sep = prev.trim() ? '\n\n' : '';
          return prev + sep + `[已关联本地文件: ${customVal.filePath}]\n请针对该文件/模块进行代码审查 and 优化。`;
        });
        setTimeout(() => {
          inputRef.current?.focus();
        }, 50);
      }
    };

    const handleSendCodeToChat = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail && detail.text) {
        setPendingAttachment({
          fileName: detail.fileName || '未知文件',
          text: detail.text
        });
        setIsPendingAttachmentExpanded(false);
        setInputValue(prev => {
          if (!prev.trim()) {
            return `请帮我分析并优化 "${detail.fileName || '未知文件'}" 的代码：`;
          }
          return prev;
        });
        setTimeout(() => {
          if (inputRef.current) {
            inputRef.current.focus();
          }
        }, 100);
      }
    };

    window.addEventListener('add-to-chat', handleAddToChat);
    window.addEventListener('send-code-to-chat', handleSendCodeToChat);

    return () => {
      window.removeEventListener('add-to-chat', handleAddToChat);
      window.removeEventListener('send-code-to-chat', handleSendCodeToChat);
    };
  }, [setInputValue, setPendingAttachment, setIsPendingAttachmentExpanded]);

  // ==========================================
  // 派生值 (用 useMemo 计算, 避免每次 store 状态变化都重算)
  // ==========================================
  const activeChatId = selectedChatId;
  const localChatInfo = useMemo(() => chatsList.find(c => c.id === activeChatId) || null, [chatsList, activeChatId]);
  // ── 用户头像 + 名字 (与右上角 UserBadgeSelector 同步) ──────────────
  // 支持: 内置头像 idx / 自定义头像 dataUrl / 动态头像列表 (从 /api/files/list 读取)
  const [userAvatarSrc, setUserAvatarSrc] = useState('/头像/avatar1.svg');
  const [userName, setUserName] = useState('');
  useEffect(() => {
    const DEFAULT_AVATARS = [
      '/头像/avatar1.svg', '/头像/avatar2.svg', '/头像/avatar3.svg', '/头像/avatar4.svg',
    ];
    let avatarList = DEFAULT_AVATARS;

    // 动态加载头像列表 (与 UserBadgeSelector 逻辑一致)
    fetch(`/api/files/list?dir=${encodeURIComponent('UI/public/头像')}`)
      .then((r) => r.json())
      .then((data) => {
        if (data?.success && Array.isArray(data.files)) {
          const IMAGE_EXTS = ['.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'];
          const imageFiles = data.files
            .filter((f: any) => f.type === 'file' && IMAGE_EXTS.some(ext => f.name.toLowerCase().endsWith(ext)))
            .sort((a: any, b: any) => a.name.localeCompare(b.name))
            .map((f: any) => `/头像/${f.name}`);
          if (imageFiles.length > 0) {
            avatarList = imageFiles;
            applyAvatar();
          }
        }
      })
      .catch(() => {});

    const applyAvatar = () => {
      const useCustom = localStorage.getItem('soloforge_user_use_custom_avatar') === 'true';
      const customData = localStorage.getItem('soloforge_user_custom_avatar');
      if (useCustom && customData) {
        setUserAvatarSrc(customData);
        return;
      }
      const idxStr = localStorage.getItem('soloforge_user_avatar_idx');
      const idx = idxStr !== null ? parseInt(idxStr, 10) : 0;
      setUserAvatarSrc(avatarList[idx] ?? avatarList[0] ?? DEFAULT_AVATARS[0]);
    };

    const syncUserBadge = () => {
      applyAvatar();
      const savedName = localStorage.getItem('soloforge_user_name');
      if (savedName) setUserName(savedName);
    };
    syncUserBadge();
    window.addEventListener('storage', syncUserBadge);
    window.addEventListener('soloforge-user-badge-updated', syncUserBadge);
    return () => {
      window.removeEventListener('storage', syncUserBadge);
      window.removeEventListener('soloforge-user-badge-updated', syncUserBadge);
    };
  }, []);

  // ── 模型图标映射: 从 cherry_providers_v2 构建 modelId → { providerId, iconType } ──
  // 与 Header.tsx 的 getModelIconMap 逻辑一致, 确保聊天区头像与模型选择器图标完全对齐
  const [modelIconMap, setModelIconMap] = useState<Record<string, { providerId: string; iconType?: string }>>({});
  useEffect(() => {
    const buildIconMap = () => {
      try {
        const saved = localStorage.getItem('cherry_providers_v2');
        if (!saved) return;
        const parsed = JSON.parse(saved);
        if (!Array.isArray(parsed)) return;
        const map: Record<string, { providerId: string; iconType?: string }> = {};
        parsed.forEach((prov: any) => {
          if (!prov.enabled || !prov.apiKey || prov.apiKey === '__VAULT__:') return;
          const info = { providerId: prov.id, iconType: prov.iconType };
          if (Array.isArray(prov.models)) {
            prov.models.forEach((m: any) => {
              if (m.enabled) map[m.id] = info;
            });
          }
          if (Array.isArray(prov.customModels)) {
            prov.customModels.forEach((cm: any) => {
              const id = typeof cm === 'string' ? cm : (cm?.id ?? '');
              if (id && (typeof cm === 'string' || cm.enabled !== false)) map[id] = info;
            });
          }
        });
        setModelIconMap(map);
      } catch { /* ignore */ }
    };
    buildIconMap();
    window.addEventListener('storage', buildIconMap);
    window.addEventListener('providers_updated', buildIconMap);
    return () => {
      window.removeEventListener('storage', buildIconMap);
      window.removeEventListener('providers_updated', buildIconMap);
    };
  }, []);

  // 当前主模型的 iconType (与设置页/模型选择器对齐)
  const mainModelIconType = mainModel ? modelIconMap[mainModel]?.iconType : undefined;

  const activeMessages = useMemo(() => {
    return conversations[activeChatId]
      || useChatStore.getState().getFallbackMessages(localChatInfo);
  }, [conversations, localChatInfo, activeChatId]);

  // ★ 2026-07-13: 多轮对话独立气泡
  //   uiMessageStore 中只存 assistant UIMessage (每轮一个), 按 chatId 隔离
  //   conversations 中 assistant ChatMessage 与 UIMessage 按"第 N 个 assistant"顺序一一对应
  //   这里构建映射: conversations 中每个 assistant 消息的 index → 对应 UIMessage.id
  //   用于在 map 中渲染每轮独立的 UIMessagePartsRenderer
  const uiMessages = useUIMessages(activeChatId);
  const assistantUiMessageIds = useMemo(
    () => uiMessages.filter(m => m.role === 'assistant').map(m => m.id),
    [uiMessages],
  );

  // ★ FIX 2026-07-14: 检测最后一条 assistant UIMessage 是否已有 parts (流送数据已到达)
  //   当 LLM 只发送 phase 事件 (无文本) 时, msg.content 为空但 uiMessageStore 已有 parts。
  //   此标志用于: 1) 解除 isEmptyGenerating 对 StreamPanel 的屏蔽  2) 隐藏加载占位
  const hasStreamData = useMemo(() => {
    if (assistantUiMessageIds.length === 0) return false;
    const lastId = assistantUiMessageIds[assistantUiMessageIds.length - 1];
    const lastMsg = uiMessages.find(m => m.id === lastId);
    return !!lastMsg && lastMsg.parts.length > 0;
  }, [assistantUiMessageIds, uiMessages]);

  const activeSettings = useMemo<ChatSettingsItem>(
    () => configs[activeChatId] || fallbackActiveSettings,
    [configs, activeChatId]
  );
  const isTemporaryNewChat = useMemo(() => !localChatInfo &&
    !isNaN(Number(activeChatId)) &&
    Number(activeChatId) > 1710000000000, [localChatInfo, activeChatId]);
  const activeChatTitle = useMemo(() => localChatInfo?.title
    || (isTemporaryNewChat ? `新智能对话 #${chatsList.length + 1}` : `智能对话 #${activeChatId}`),
    [localChatInfo, activeChatId, isTemporaryNewChat, chatsList.length]);
  const activeChatIcon = useMemo(
    () => useChatStore.getState().getActiveChatIcon(localChatInfo, activeChatId),
    [localChatInfo, activeChatId]
  );

  const activeChatIDPrefix = activeChatId.length > 5 ? activeChatId.slice(-4) : activeChatId;

  // 流送区滚动锁定: false=自动滚动(锁打开), true=已锁定(锁住)
  const [isScrollLocked, setIsScrollLocked] = useState(false);

  // 2026-07-03 阶段3.1.E: 滚动到底 (依赖 activeMessages) — 仅在未锁定时自动滚动
  useEffect(() => {
    if (scrollRef.current && !isScrollLocked) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [activeMessages, isScrollLocked]);

  // ★ 流送区滚动位置检测: 用户向上滚离底部时自动锁定 (暂停自动滚动),
  //   滚回底部附近 (80px 内) 时自动解锁 (恢复自动滚动)。
  //   与锁按钮手动切换协同: 按钮解锁时会立即滚动到底部, 避免 onScroll 重新锁定。
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setIsScrollLocked(distanceFromBottom >= 80);
  }, []);

  // 2026-07-03 阶段3.1.E: 发送时把 inputRef 传给 store action, 让 store 也能 focus 输入框
  const handleSend = () => handleSendFromStore(inputRef);

  // ── Phase 5 实时训练: 👍/👎 反馈按钮 ──────────────────────────────
  // 每条 assistant 消息独立追踪反馈状态, 累积 negative 反馈触发 PromptOptimizer
  // 后端: POST /api/java-agent/api/feedback (FeedbackController)
  // 触发阈值: soloforge.training.feedback.trigger-threshold (默认 5)
  const [feedbackMap, setFeedbackMap] = useState<Record<number, 'up' | 'down' | undefined>>({});
  const [feedbackBusy, setFeedbackBusy] = useState<Record<number, boolean>>({});
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  // ★ 暂停后输入框有内容时, 点击 Play 弹出确认: 合并继续 / 放弃重发
  const [resumeConfirmOpen, setResumeConfirmOpen] = useState(false);

  // ★ 2026-07-13: 用户消息右键菜单 — 关闭显示名称/头像
  const [ctxMenu, setCtxMenu] = useState<{ index: number; x: number; y: number } | null>(null);
  const [hideUserName, setHideUserName] = useState(false);
  const [hideUserAvatar, setHideUserAvatar] = useState(false);

  // ★ 2026-07-20: assistant 消息气泡右键菜单 — 流送区外观设置
  //   与用户消息的 ctxMenu 分开, 避免冲突
  const [streamCtxMenu, setStreamCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const handleStreamContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setStreamCtxMenu({ x: e.clientX, y: e.clientY });
  }, []);
  const handleCloseStreamContextMenu = useCallback(() => setStreamCtxMenu(null), []);

  // ★ 2026-07-13: 重新生成 — 以当前用户消息重新发送
  const handleRegenerate = (index: number) => {
    const userMsg = activeMessages[index];
    if (!userMsg || userMsg.sender !== 'user') return;
    handleSendFromStore(userMsg.content);
  };

  // ★ 2026-07-13: 右键菜单处理
  const handleUserContextMenu = (e: React.MouseEvent, index: number) => {
    e.preventDefault();
    setCtxMenu({ index, x: e.clientX, y: e.clientY });
  };

  // 点击任意位置关闭右键菜单
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
    };
  }, [ctxMenu]);

  // 复制当前消息内容到剪贴板, 显示短暂"已复制"反馈
  const handleCopyMessage = async (index: number, content: string) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedIndex(index);
      window.setTimeout(() => setCopiedIndex(prev => (prev === index ? null : prev)), 1500);
    } catch (e) {
      console.error('[ChatPanel] 复制失败:', e);
    }
  };

  const submitFeedback = async (index: number, positive: boolean) => {
    if (feedbackMap[index] || feedbackBusy[index]) return; // 已反馈 / 请求中
    setFeedbackBusy(prev => ({ ...prev, [index]: true }));
    setFeedbackMap(prev => ({ ...prev, [index]: positive ? 'up' : 'down' }));
    const msg = activeMessages[index];
    // 向前扫描找触发该回复的用户消息 (ChatMessage 无 parentId, 靠数组顺序反查)
    let userMessage = '';
    for (let i = index - 1; i >= 0; i--) {
      if (activeMessages[i].sender === 'user') {
        userMessage = activeMessages[i].content || '';
        break;
      }
    }

    // ── 路径分流 (2026-07-09) + 经济系统联动 (2026-07-11) ──────────
    // 经验路径 (experienceFingerprint 存在) → Node.js 经验反馈, 更新 successRate
    //   👎 连续打分低于 0.3 → 经验自动失效删除, 下次重新走 Agent Loop (解决越做越错)
    // 其他路径 (无 fingerprint) → Java Agent 案例库 (原逻辑)
    //
    // ★ 2026-07-11: 无论走哪条路径, 都同步调用 Java FeedbackController
    //   → 👍 加信用分 / 👎 扣信用分 (经济系统驱动)
    const expFp = (msg as any)?.experienceFingerprint as string | undefined;
    const agentId = activeSettings.agentId || 'code_agent';

    try {
      // ── 1. 经济系统: 始终调用 Java FeedbackController (👍加钱 / 👎扣钱) ──
      const econPromise = fetch('/api/java-agent/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId,
          positive,
          message: userMessage,
          response: msg?.content || '',
          chatId: activeChatId,
        }),
      }).then(r => r.ok ? r.json().catch(() => ({})) : {}).catch(() => ({}));

      // ── 2. 经验路径: 同时走 Node.js 更新 successRate ──
      if (expFp) {
        const expPromise = fetch('/api/agents/experience/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fingerprint: expFp,
            prompt: userMessage,
            positive,
          }),
        }).then(r => r.ok ? r.json().catch(() => ({})) : {}).catch(() => ({}));

        // 并行等待两个请求
        const [econData, expData] = await Promise.all([econPromise, expPromise]);

        // 经济系统结果
        if (econData?.creditsAfter !== undefined) {
          console.info(`[经济系统] ${positive ? '👍' : '👎'} agent=${agentId} 信用分: ${econData.creditsBefore} → ${econData.creditsAfter}`);
        }

        // 经验系统结果
        if (expData?.alive === false) {
          console.info(`[经验失效] fingerprint=${expFp} 已因 👎 降权失效, 下次重新解决`);
        } else if (expData?.successRate !== undefined) {
          console.info(`[经验${positive ? '强化' : '降权'}] fingerprint=${expFp} successRate=${expData.successRate.toFixed(2)}`);
        }

        if (!econData?.acknowledged && !expData?.acknowledged) {
          setFeedbackMap(prev => ({ ...prev, [index]: undefined }));
        }
      } else {
        // ── 非经验路径: 只走 Java FeedbackController ──
        const econData = await econPromise;
        if (econData?.creditsAfter !== undefined) {
          console.info(`[经济系统] ${positive ? '👍' : '👎'} agent=${agentId} 信用分: ${econData.creditsBefore} → ${econData.creditsAfter}`);
        }
        if (econData?.caseId) {
          console.info(`[案例入库] ${agentId} caseId=${econData.caseId} positive=${positive}`);
        }
        if (!econData?.acknowledged) {
          setFeedbackMap(prev => ({ ...prev, [index]: undefined }));
        }
      }
    } catch (e) {
      setFeedbackMap(prev => ({ ...prev, [index]: undefined })); // 网络失败回滚
    } finally {
      setFeedbackBusy(prev => ({ ...prev, [index]: false }));
    }
  };

  return (
    <div className="flex-1 h-full bg-bg flex flex-col overflow-hidden">
      {/* Active Dialogue Header Bar */}
      <div className="h-14 border-b border-outline/50 bg-surface/85 backdrop-blur px-5 flex items-center justify-between shrink-0 select-none z-30">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="p-1.5 rounded-lg bg-primary/10 text-primary shrink-0 flex items-center justify-center">
            {React.createElement(activeChatIcon, { className: "w-4 h-4 text-primary shrink-0" })}
          </div>
          <div className="min-w-0">
            <div className="text-xs font-bold text-on-surface flex items-center gap-2">
              <span className="truncate">{activeChatTitle}</span>
              <span className="shrink-0 text-[8.5px] font-mono font-bold text-on-surface/30 px-1 py-0.2 border border-outline/35 rounded bg-bg">ID: {activeChatIDPrefix}</span>
            </div>
            <div className="text-[10px] text-on-surface/50 mt-0.5 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse shrink-0" />
              <button
                onClick={() => setActiveSettingsChat({ id: activeChatId, title: activeChatTitle })}
                className="truncate font-sans font-medium hover:text-primary hover:underline cursor-pointer flex items-center gap-0.5 group"
                title="点击配置助理角色表情、状态、回复语调与性格"
                id="agent-role-summary-btn"
              >
                <span>助理角色：</span>
                <span className="text-primary font-semibold group-hover:text-primary/80">{getSettingsSummary(activeSettings)}</span>
                <SlidersHorizontal className="w-2.5 h-2.5 ml-1 select-none text-primary opacity-60 group-hover:opacity-100 transition-opacity" />
              </button>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 relative shrink-0">
          <button
            onClick={() => setActiveSettingsChat({ id: activeChatId, title: activeChatTitle })}
            className="flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1.5 rounded-lg bg-primary/10 hover:bg-primary/20 text-primary hover:text-primary/90 transition-all duration-150 cursor-pointer border border-primary/20 hover:border-primary/35 shadow-sm"
            title="配置当前对话的性格、表情、语调等设置"
            id="chat-header-agent-settings-btn"
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            <span>当前对话设置</span>
          </button>
        </div>
      </div>

      {/* Scrollable Conversation Stream */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto py-4 px-0 select-text scrollbar-thin scrollbar-thumb-outline/50"
      >
        <div className="max-w-5xl lg:max-w-[94%] xl:max-w-[90%] mx-auto w-full flex flex-col space-y-5 py-2">
          {activeMessages.length === 0 && !isGenerating && (
            <div className="flex-1 flex flex-col items-center justify-center min-h-[300px] select-none">
              <div
                className="w-20 h-20 opacity-30 transition-opacity duration-300"
                style={{
                  backgroundColor: 'var(--color-primary)',
                  maskImage: 'url(/lightning_logo.png)',
                  maskSize: 'contain',
                  maskPosition: 'center',
                  maskRepeat: 'no-repeat',
                  WebkitMaskImage: 'url(/lightning_logo.png)',
                  WebkitMaskSize: 'contain',
                  WebkitMaskPosition: 'center',
                  WebkitMaskRepeat: 'no-repeat',
                }}
              />
            </div>
          )}
          {activeMessages.map((msg, index) => {
            const isUser = msg.sender === 'user';
            // ★ 2026-07-13: 空的 assistant 占位消息在生成中时不再完全隐藏,
            //   而是隐藏气泡内容, 保留 header + process parts (loading → 实时过程)
            //   确保发送瞬间流送区立即出现
            const isEmptyGenerating = !isUser && !msg.content.trim() && index === activeMessages.length - 1;
            // ★ 2026-07-20: 气泡内容存在性检查 — 只有文本/附件/工具调用至少有一项时才渲染气泡轮廓
            //   修复: 流送 parts 已到达 (hasStreamData=true) 但 msg.content 还为空时,
            //   气泡渲染了空气泡轮廓 (无实际内容)
            const hasBubbleContent = !!(msg.content.trim() || msg.attachment || (msg.toolCalls && msg.toolCalls.length > 0));
            // ★ 2026-07-13: 计算当前 assistant 消息是第几个 assistant
            //   用于关联 uiMessageStore 中对应索引的 UIMessage.id
            //   conversations 中 assistant 消息按顺序与 uiMessageStore 的 assistant UIMessage 一一对应
            let assistantOrdinal = -1;
            if (!isUser) {
              for (let i = 0; i <= index; i++) {
                if (activeMessages[i].sender === 'assistant') assistantOrdinal++;
              }
            }
            const uiMessageId = assistantOrdinal >= 0 ? assistantUiMessageIds[assistantOrdinal] : undefined;
            // ★ 2026-07-20: 获取当前 assistant 消息对应的 UIMessage 状态
            //   status='streaming'/'pending' → 流送过程进行中, 不显示结果气泡
            //   status='done'/'error' → 流送结束, 显示结果气泡
            //   uiMsg=undefined → 历史消息 (无 UIMessage), 正常显示气泡
            const uiMsg = uiMessageId ? uiMessages.find(m => m.id === uiMessageId) : undefined;
            const isAssistantStreaming = !isUser && uiMsg != null && (uiMsg.status === 'streaming' || uiMsg.status === 'pending');
            // ★ 2026-07-13: 判断是否是最后一个 assistant 消息
            //   StreamPanel (TaskExecutionCard + 任务总结) 只在最后一个 assistant 消息上方渲染
            // ★ FIX 2026-07-14: isLastAssistant 改用 index 判断, 不再依赖 assistantOrdinal 映射
            //   原因: assistantOrdinal (来自 conversations) 与 assistantUiMessageIds.length (来自 uiMessageStore)
            //   可能不同步 (历史对话 uiMessageStore 为空 / 模型未配置错误消息无对应 UIMessage)
            //   导致 isLastAssistant 永远为 false, StreamPanel 不渲染
            const isLastAssistant = !isUser && index === activeMessages.length - 1;
            return (
              <div
                key={index}
                className={`sf-anim sf-anim-slide-up flex flex-col gap-2.5 ${isUser ? 'items-end' : 'items-start'}`}
              >
                {/* Header Row: Avatar + Info
                    ★ 2026-07-13: 用户名称可隐藏, 头像可隐藏 (右键菜单控制)
                    时间移到气泡右下角, 这里不再显示 */}
                <div className={`flex gap-3 items-center mb-1 pl-[5px] ${isUser ? 'flex-row-reverse' : ''}`}>
                  {/* Avatar block */}
                  {isUser ? (
                    !hideUserAvatar && (
                      <div
                        className="shrink-0 overflow-hidden"
                        style={{
                          width: 36,
                          height: 36,
                          borderRadius: 10,
                          boxShadow: 'inset 0 0 0 0.5px rgba(0,0,0,0.20), 0 0 6px rgba(0,0,0,0.06), 2px 3px 5px rgba(0,0,0,0.08)',
                        }}
                      >
                        <img
                          src={userAvatarSrc}
                          alt="用户头像"
                          className="w-9 h-9 object-cover pointer-events-none"
                          draggable={false}
                        />
                      </div>
                    )
                  ) : (
                    <div className="w-11 h-11 rounded-full bg-on-surface/5 border border-on-surface/10 flex items-center justify-center shrink-0">
                      {mainModel ? (
                        <ModelIcon modelName={mainModel} size={32} className="shrink-0" iconType={mainModelIconType} />
                      ) : (
                        <span className="text-on-surface/20 text-xs font-bold">—</span>
                      )}
                    </div>
                  )}

                  {/* Info block (Username/Model only — 时间移到气泡右下角) */}
                  {isUser ? (
                    !hideUserName && (
                      <span className="text-[12px] font-bold text-primary/95 text-right">
                        {userName || '你'}
                      </span>
                    )
                  ) : (
                    <span className="text-[12px] font-bold text-[#3b82f6]">
                      {mainModel || '未选择'}
                    </span>
                  )}
                </div>

                {/* ★ 2026-07-13: 流送过程在 LLM 文本气泡上方
                    最后一个 assistant 消息由 StreamPanel (TaskExecutionCard + 任务总结) 渲染,
                    历史消息由 UIMessagePartsRenderer 渲染各自的过程 parts
                    两者互斥, 避免内容重复
                    发送瞬间 (isEmptyGenerating) StreamPanel 还无 task, 显示 loading 占位 */}
                {/* ★ FIX 2026-07-14: 加载占位只在无内容且无流送数据时显示 */}
                {!isUser && isEmptyGenerating && !hasStreamData && (
                  <div className="w-full pl-[5px] pr-[5px]">
<div className="flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] text-on-surface/50 font-mono">
<span>正在准备…</span>
</div>
                  </div>
                )}
                {/* ★ 2026-07-20: 过程与结果互斥 — 最后一条 assistant 消息只用 StreamPanel 渲染过程,
                    历史消息用 UIMessagePartsRenderer 渲染 (默认折叠).
                    两者不共存, 避免过程重复. */}
                {!isUser && uiMessageId && !isLastAssistant && (
                  <div className="w-full pl-[5px] pr-[5px]">
                    <UIMessagePartsRenderer chatId={activeChatId} messageId={uiMessageId} />
                  </div>
                )}
                {!isUser && isLastAssistant && (!isEmptyGenerating || hasStreamData) && (
                  <StreamPanel
                    chatId={activeChatId}
                    mainModel={mainModel}
                    modelCount={1 + (secModels?.length || 0)}
                    permissionMode={permissionMode}
                  />
                )}

                {/* Content block: aligned on right or left
                    ★ FIX 2026-07-14: 有流送数据时也显示内容块 (工具调用等), 即使文本为空
                    ★ FIX 2026-07-20: assistant 无气泡内容 (无文本/附件/工具调用) 时不渲染空气泡轮廓
                    ★ FIX 2026-07-20: assistant 流送过程中 (status=streaming/pending) 不显示结果气泡 */}
                {(!isEmptyGenerating || hasStreamData) && (isUser || (hasBubbleContent && !isAssistantStreaming)) && (
                <div className={`flex flex-col gap-1 font-sans text-left ${isUser ? 'pr-0 pl-[58px] items-end max-w-[88%]' : 'pl-[5px] pr-3 items-start w-full'}`}>
                  {isUser ? (
                  <div
                    onContextMenu={(e) => handleUserContextMenu(e, index)}
                    className="relative px-3.5 py-2.5 rounded-xl text-[12px] leading-relaxed select-text space-y-1.5 overflow-hidden border w-fit max-w-full bg-transparent border-primary/30 text-on-surface"
                  >
                    <FormatChatMessage content={msg.content} />
                    {msg.attachment && (
                      <CollapsibleCodeBlock
                        fileName={msg.attachment.fileName}
                        text={msg.attachment.text}
                      />
                    )}
                    {msg.toolCalls && msg.toolCalls.length > 0 && (
                      <div className="flex flex-col gap-1.5 pt-1 border-t border-outline/20 mt-1">
                        <div className="text-[9px] uppercase tracking-wider text-on-surface/40 font-semibold">
                          工具调用 · {msg.toolCalls.length}
                        </div>
                        {msg.toolCalls.map((tc) => (
                          <ToolCallCard key={tc.id} call={tc} />
                        ))}
                      </div>
                    )}
                  </div>
                  ) : (
                  <div
                    onContextMenu={handleStreamContextMenu}
                    className="relative px-3.5 py-2.5 rounded-xl text-[12px] leading-relaxed select-text space-y-1.5 overflow-hidden border w-full bg-surface/50 border-primary/40 text-on-surface"
                  >
                    <FormatChatMessage content={msg.content} />
                    {msg.attachment && (
                      <CollapsibleCodeBlock
                        fileName={msg.attachment.fileName}
                        text={msg.attachment.text}
                      />
                    )}
                    {msg.toolCalls && msg.toolCalls.length > 0 && (
                      <div className="flex flex-col gap-1.5 pt-1 border-t border-outline/20 mt-1">
                        <div className="text-[9px] uppercase tracking-wider text-on-surface/40 font-semibold">
                          工具调用 · {msg.toolCalls.length}
                        </div>
                        {msg.toolCalls.map((tc) => (
                          <ToolCallCard key={tc.id} call={tc} />
                        ))}
                      </div>
                    )}
                  </div>
                  )}

                  {/* 用户消息: 复制 + 重新生成按钮 + 时间 */}
                  {isUser && (
                    <div className="flex items-center justify-between gap-1.5 pl-1 pt-0.5 w-full">
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          aria-label="复制消息"
                          title={copiedIndex === index ? '已复制' : '复制消息'}
                          onClick={() => handleCopyMessage(index, msg.content)}
                          className={`p-1 rounded-md transition-all ${
                            copiedIndex === index
                              ? 'bg-primary/15 text-primary'
                              : 'text-on-surface/35 hover:text-primary hover:bg-primary/10 cursor-pointer'
                          }`}
                        >
                          {copiedIndex === index ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                        </button>
                        <button
                          type="button"
                          aria-label="重新生成"
                          title="以当前消息重新生成"
                          onClick={() => handleRegenerate(index)}
                          className="p-1 rounded-md transition-all text-on-surface/35 hover:text-primary hover:bg-primary/10 cursor-pointer"
                        >
                          <RefreshCw className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <div className="text-[10px] text-on-surface/35 font-mono pr-1">{msg.time}</div>
                    </div>
                  )}

                  {/* Phase 5: 👍/👎 反馈按钮 — 仅 assistant 消息, 累积 negative 触发 PromptOptimizer */}
                  {!isUser && !isGenerating && (
                    <div className="flex items-center justify-between gap-1.5 pl-1 pt-0.5 w-full">
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          aria-label="复制此回复"
                          title={copiedIndex === index ? '已复制' : '复制此回复'}
                          onClick={() => handleCopyMessage(index, msg.content)}
                          className={`p-1 rounded-md transition-all ${
                            copiedIndex === index
                              ? 'bg-primary/15 text-primary'
                              : 'text-on-surface/35 hover:text-primary hover:bg-primary/10 cursor-pointer'
                          }`}
                        >
                          {copiedIndex === index ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                        </button>
                        <button
                          type="button"
                          aria-label="赞同此回复"
                          title="赞同此回复"
                          disabled={!!feedbackMap[index] || feedbackBusy[index]}
                          onClick={() => submitFeedback(index, true)}
                          className={`p-1 rounded-md transition-all ${
                            feedbackMap[index] === 'up'
                              ? 'bg-emerald-500/15 text-emerald-500'
                              : feedbackMap[index]
                                ? 'text-on-surface/20 cursor-not-allowed'
                                : 'text-on-surface/35 hover:text-emerald-500 hover:bg-emerald-500/10 cursor-pointer'
                          }`}
                        >
                          <ThumbsUp className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          aria-label="不赞同此回复 (累积触发 Prompt 优化)"
                          title="不赞同此回复 (累积触发 Prompt 优化)"
                          disabled={!!feedbackMap[index] || feedbackBusy[index]}
                          onClick={() => submitFeedback(index, false)}
                          className={`p-1 rounded-md transition-all ${
                            feedbackMap[index] === 'down'
                              ? 'bg-rose-500/15 text-rose-500'
                              : feedbackMap[index]
                                ? 'text-on-surface/20 cursor-not-allowed'
                                : 'text-on-surface/35 hover:text-rose-500 hover:bg-rose-500/10 cursor-pointer'
                          }`}
                        >
                          <ThumbsDown className="w-3.5 h-3.5" />
                        </button>
                        {feedbackBusy[index] && (
                          <span className="text-[9px] text-on-surface/40 ml-0.5">提交中…</span>
                        )}
                      </div>
                      <div className="text-[10px] text-on-surface/35 font-mono pr-1">{msg.time}</div>
                    </div>
                  )}
                </div>
                )}
              </div>
            );
          })}

          {/* ★ 2026-07-13: 用户消息右键菜单 — 关闭显示名称/头像 */}
          {ctxMenu && (
            <div
              className="fixed z-50 min-w-[160px] py-1 rounded-lg bg-surface border border-outline/30 shadow-[0_8px_24px_rgba(0,0,0,0.35)] text-[11px]"
              style={{ left: ctxMenu.x, top: ctxMenu.y }}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                onClick={() => { setHideUserName(v => !v); setCtxMenu(null); }}
                className="w-full flex items-center justify-between gap-2 px-3 py-1.5 text-left text-on-surface/80 hover:bg-primary/10 hover:text-primary transition-colors"
              >
                <span>关闭显示名称</span>
                {hideUserName && <Check className="w-3 h-3 text-primary" />}
              </button>
              <button
                type="button"
                onClick={() => { setHideUserAvatar(v => !v); setCtxMenu(null); }}
                className="w-full flex items-center justify-between gap-2 px-3 py-1.5 text-left text-on-surface/80 hover:bg-primary/10 hover:text-primary transition-colors"
              >
                <span>关闭显示头像</span>
                {hideUserAvatar && <Check className="w-3 h-3 text-primary" />}
              </button>
            </div>
          )}

          {/* ★ 2026-07-20: assistant 消息气泡右键菜单 — 流送区外观设置 (Portal 到 body) */}
          {streamCtxMenu && createPortal(
            <StreamContextMenu
              x={streamCtxMenu.x}
              y={streamCtxMenu.y}
              onClose={handleCloseStreamContextMenu}
            />,
            document.body
          )}

          {isGenerating && streamState.suggestEnables.length > 0 && (
            <div className="sf-anim sf-anim-slide-up flex flex-col gap-2 max-w-[95%] pl-[5px] text-left mb-2">
              {/* SuggestEnableView 保留: StreamPanel 未处理 suggest_enable 事件 */}
              <SuggestEnableView items={streamState.suggestEnables} onAccept={handleAcceptEnable} />
            </div>
          )}


        {/* 1:1 Static Agent Execution Process 已删除 (2026-07-03 阶段3.1.A)
            原 demo 卡硬编码 "3/5 步骤进行中" 假数据, 不随真实 streamState 变化,
            属于 mock 时代遗留. 真实流程展示由 streamState.toolCalls / AuditView 等驱动. */}
        </div>
      </div>

      {/* 2026-07-03 阶段3.1.D: ResourceManagerBar 抽出为独立子应用
          - 状态全部在 useResourceManagerStore (14 state + 3 helper + 11 actions)
          - 事件监听/resize effect/loadResources 已迁入组件
          - 主题用 data-theme-region="skill-bar" 走 Phase 4 CSS 变量级联,不再 inline style
          - 此处仅渲染 <ResourceManagerBar />,ChatPanel 不再持有任何资源管理相关 state
      */}
      <ResourceManagerBar />

      {/* Input Area */}
      <div className="p-3 border-t border-outline bg-surface shrink-0">
        <div className="max-w-5xl lg:max-w-[94%] xl:max-w-[90%] mx-auto w-full px-4 md:px-6 flex items-end gap-2">
          <div className="flex-1 min-w-0 bg-bg rounded-lg border border-outline focus-within:border-primary/50 transition-colors p-2 flex flex-col gap-2">
          {pendingAttachment && (
            <div className="bg-surface border border-outline rounded-md overflow-hidden transition-all duration-200">
              <div className="flex items-center justify-between p-2 bg-surface-bright/40">
                <div className="flex items-center gap-1.5 text-[10.5px] font-sans text-on-surface/90 min-w-0">
                  <FileCode className="w-3.5 h-3.5 text-primary shrink-0" />
                  <span className="truncate max-w-[180px] font-bold text-on-surface">{pendingAttachment.fileName}</span>
                  <span className="text-[9px] text-on-surface/40 font-mono shrink-0">({pendingAttachment.text.split('\n').length} 行)</span>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => setIsPendingAttachmentExpanded(!isPendingAttachmentExpanded)}
                    className="p-1 rounded hover:bg-neutral-500/10 text-on-surface/60 hover:text-primary transition-colors cursor-pointer"
                    title={isPendingAttachmentExpanded ? "折叠预览" : "展开预览"}
                  >
                    {isPendingAttachmentExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                  </button>
                  <button
                    onClick={() => setPendingAttachment(null)}
                    className="p-1 rounded hover:bg-red-500/15 text-on-surface/60 hover:text-red-400 transition-colors cursor-pointer"
                    title="移除附件"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              </div>
              {isPendingAttachmentExpanded && (
                <div className="max-h-32 overflow-y-auto border-t border-outline/25 p-2 font-mono text-[9px] text-on-surface/85 bg-bg/40 whitespace-pre select-text scrollbar-thin">
                  {pendingAttachment.text}
                </div>
              )}
            </div>
          )}
          <textarea
            ref={inputRef}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.ctrlKey) {
                if (isPaused) { if (inputValue.trim()) setResumeConfirmOpen(true); else resumeChat(); }
                else if (isGenerating) pauseChat();
                else handleSend();
              }
            }}
            placeholder="请输入您的需求... (Ctrl + Enter 发送)"
            className="bg-transparent text-xs text-on-surface placeholder-on-surface/30 select-text outline-none resize-none h-14 w-full p-1"
          />

          <div className="flex items-center justify-between pt-1 border-t border-outline/30">
            {/* Conversation mode select dropdown */}
            <div className="relative" id="chat-mode-selection-dropdown">
              <motion.button
                onClick={() => setShowModeDropdown(!showModeDropdown)}
                variants={modeButtonVariants}
                initial="hidden"
                animate="visible"
                className="flex items-center gap-1.5 text-[10px] text-on-surface/85 bg-surface-bright hover:bg-bg border border-outline px-2.5 py-1 rounded cursor-pointer hover:text-on-surface transition-all font-sans font-bold shadow select-none"
                style={{ backfaceVisibility: "hidden", WebkitFontSmoothing: "subpixel-antialiased" }}
              >
                <span>
                  {permissionMode === 'normal' ? '普通模式 (安全)' :
                   permissionMode === 'performance' ? '性能模式 (半自动)' :
                   permissionMode === 'expert' ? '专家模式 (全自动)' : '极致模式 (全自动)'}
                </span>
                <ChevronDown className={`w-2.5 h-2.5 opacity-60 transition-transform duration-200 ${showModeDropdown ? 'rotate-180' : ''}`} />
              </motion.button>

              <AnimatePresence>
                {showModeDropdown && (
                  <>
                    {/* 透明 backdrop 仅用于承载 click-outside + z-index */}
                    <motion.div
                      key="mode-backdrop"
                      variants={modeBackdropVariants}
                      initial="hidden"
                      animate="visible"
                      exit="hidden"
                      className="fixed inset-0 z-40 cursor-default"
                      onClick={() => setShowModeDropdown(false)}
                    />

                    {/* 模式选择面板: 与 SecondaryModelSelector 一致的"柔和推出"动画 */}
                    <motion.div
                      key="mode-panel"
                      variants={modePanelVariants}
                      initial="hidden"
                      animate="visible"
                      exit="hidden"
                      style={{
                        // 锚点: 底部左侧 (clipPath 从底部展开, scale 围绕此点生长)
                        transformOrigin: 'bottom left',
                        willChange: 'transform, opacity',
                        transform: 'translateZ(0)',
                        backfaceVisibility: 'hidden',
                        WebkitBackfaceVisibility: 'hidden',
                      }}
                      className="absolute left-0 bottom-full mb-1.5 w-[230px] bg-surface/98 backdrop-blur-md border border-outline/35 rounded-lg shadow-2xl p-1.5 flex flex-col font-sans z-50 capitalize-none text-left"
                    >
                      <motion.span
                        variants={modeContentVariants}
                        className="text-[9px] text-primary/70 px-2 py-1 font-semibold border-b border-outline/25 mb-1 tracking-wider uppercase select-none"
                      >
                        运行资源模式
                      </motion.span>

                      {/* Normal Mode Option */}
                      <motion.button
                        variants={modeContentVariants}
                        onClick={() => {
                          setPermissionMode?.('normal');
                          setShowModeDropdown(false);
                        }}
                        className={`flex flex-col gap-0.5 p-2 rounded text-left transition-colors cursor-pointer select-none group sf-lift ${
                          permissionMode === 'normal' ? 'bg-primary/10 border border-primary/25 text-on-surface' : 'hover:bg-surface-bright text-on-surface/80 hover:text-on-surface'
                        }`}
                        style={{ backfaceVisibility: "hidden", WebkitFontSmoothing: "subpixel-antialiased" }}
                      >
                        <div className="flex items-center justify-between text-[10.5px] font-bold">
                          <div className="flex items-center gap-1.5 font-sans">
                            <span>普通模式 (安全)</span>
                          </div>
                          {permissionMode === 'normal' && <Check className="w-3 h-3 text-primary" />}
                        </div>
                        <p className="text-[9px] leading-relaxed text-on-surface/50 font-medium whitespace-normal font-sans group-hover:text-on-surface/70 transition-colors">
                          自动识别并绕过风险命令，守护代码与环境安全。
                        </p>
                      </motion.button>

                      {/* Performance Mode Option */}
                      <motion.button
                        variants={modeContentVariants}
                        onClick={() => {
                          setPermissionMode?.('performance');
                          setShowModeDropdown(false);
                        }}
                        className={`flex flex-col gap-0.5 p-2 rounded text-left transition-colors cursor-pointer select-none group sf-lift ${
                          permissionMode === 'performance' ? 'bg-primary/10 border border-primary/25 text-on-surface' : 'hover:bg-surface-bright text-on-surface/80 hover:text-on-surface'
                        }`}
                        style={{ backfaceVisibility: "hidden", WebkitFontSmoothing: "subpixel-antialiased" }}
                      >
                        <div className="flex items-center justify-between text-[10.5px] font-bold">
                          <div className="flex items-center gap-1.5 font-sans">
                            <span>性能模式 (半自动)</span>
                          </div>
                          {permissionMode === 'performance' && <Check className="w-3 h-3 text-primary" />}
                        </div>
                        <p className="text-[9px] leading-relaxed text-on-surface/50 font-medium whitespace-normal font-sans group-hover:text-on-surface/70 transition-colors">
                          自主加载各项基础工具逻辑，支持多模型智能混合。
                        </p>
                      </motion.button>

                      {/* Ultimate Mode Option */}
                      <motion.button
                        variants={modeContentVariants}
                        onClick={() => {
                          setPermissionMode?.('ultimate');
                          setShowModeDropdown(false);
                        }}
                        className={`flex flex-col gap-0.5 p-2 rounded text-left transition-colors cursor-pointer select-none group sf-lift ${
                          permissionMode === 'ultimate' ? 'bg-primary/10 border border-primary/25 text-on-surface' : 'hover:bg-surface-bright text-on-surface/80 hover:text-on-surface'
                        }`}
                        style={{ backfaceVisibility: "hidden", WebkitFontSmoothing: "subpixel-antialiased" }}
                      >
                        <div className="flex items-center justify-between text-[10.5px] font-bold">
                          <div className="flex items-center gap-1.5 font-sans">
                            <span>极致模式 (全自动)</span>
                          </div>
                          {permissionMode === 'ultimate' && <Check className="w-3 h-3 text-primary" />}
                        </div>
                        <p className="text-[9px] leading-relaxed text-on-surface/50 font-medium whitespace-normal font-sans group-hover:text-on-surface/70 transition-colors">
                          最大化释放算力，无中断调度全部工具加速实现诉求。
                        </p>
                      </motion.button>
                    </motion.div>
                  </>
                )}
              </AnimatePresence>
            </div>

            {/* Submit Send Button — 三态: 发送(Send) / 生成中暂停(Pause) / 已暂停恢复或合并指令(Play) */}
            <div className="relative shrink-0">
              {/* ★ 弹窗打开时的全屏透明遮罩, 点击空白处关闭 */}
              {resumeConfirmOpen && <div className="fixed inset-0 z-40" onClick={() => setResumeConfirmOpen(false)} />}
              <button
                onClick={isPaused ? () => { if (inputValue.trim()) setResumeConfirmOpen(true); else resumeChat(); } : isGenerating ? pauseChat : handleSend}
                aria-label={isPaused ? '恢复' : isGenerating ? '暂停' : '发送'}
                title={isPaused ? (inputValue.trim() ? '合并指令并继续生成' : '恢复生成') : isGenerating ? '暂停生成' : '发送'}
                className={`rounded-md p-1.5 flex items-center justify-center active:scale-95 transition-all cursor-pointer shadow-md ${isGenerating || isPaused ? 'bg-on-surface/15 hover:bg-on-surface/25 text-on-surface' : 'bg-primary hover:bg-primary/85 text-white'}`}
              >
                {isPaused ? <Play className="w-3.5 h-3.5" /> : isGenerating ? <Pause className="w-3.5 h-3.5" /> : <Send className="w-3.5 h-3.5" />}
              </button>
              {/* ★ 暂停后输入框有内容时的确认弹窗: 合并继续 / 放弃重发 */}
              <MountTransition show={resumeConfirmOpen} variant="fade-scale" duration={180} unmountOnExit>
                <div className="absolute bottom-full right-0 mb-2 w-56 bg-surface border border-outline/40 rounded-lg shadow-xl z-50 overflow-hidden"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="px-3 py-2 text-[10px] text-on-surface/70 border-b border-outline/30 bg-surface/50">检测到输入框有新内容，请选择：</div>
                  <button
                    type="button"
                    onClick={() => { const v = inputValue.trim(); setInputValue(''); setResumeConfirmOpen(false); resumeChat(v); }}
                    className="w-full px-3 py-2 flex items-center gap-2 text-[11px] text-on-surface hover:bg-primary/10 transition-colors text-left"
                  >
                    <Play className="w-3.5 h-3.5 text-primary shrink-0" />
                    <div>
                      <div className="font-medium">合并继续</div>
                      <div className="text-[9px] text-on-surface/50">把新内容作为追加指令，基于已生成内容继续</div>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => { setResumeConfirmOpen(false); discardPausedGeneration(); handleSend(); }}
                    className="w-full px-3 py-2 flex items-center gap-2 text-[11px] text-on-surface hover:bg-red-500/10 transition-colors text-left border-t border-outline/30"
                  >
                    <Send className="w-3.5 h-3.5 text-red-500 shrink-0" />
                    <div>
                      <div className="font-medium">放弃重发</div>
                      <div className="text-[9px] text-on-surface/50">丢弃已生成内容，发送全新请求</div>
                    </div>
                  </button>
                </div>
              </MountTransition>
            </div>
          </div>
          </div>

          {/* Lock Button — 流送区滚动锁定, 点击切换锁住/锁打开 */}
          <button
            type="button"
            onClick={() => {
              const newLocked = !isScrollLocked;
              setIsScrollLocked(newLocked);
              // 解锁时立即滚动到底部, 避免 onScroll handler 检测到不在底部而重新锁定
              if (!newLocked && scrollRef.current) {
                scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
              }
            }}
            aria-label={isScrollLocked ? '解锁滚动' : '锁定滚动'}
            title={isScrollLocked ? '已锁定 — 自动滚动暂停, 使用鼠标滚轮浏览 (点击解锁)' : '自动滚动中 — 新消息自动滚到底部 (点击锁定)'}
            className="flex items-center justify-center p-1.5 active:scale-95 transition-transform cursor-pointer shrink-0 mb-[10px] text-primary hover:opacity-70"
          >
            {isScrollLocked ? (
              // 锁住 (滚动已暂停) — 关闭的锁
              <Lock className="w-3.5 h-3.5" />
            ) : (
              // 锁打开 (自动滚动中) — 打开的锁
              <Unlock className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      </div>

      {/* 2026-07-03 阶段3.1.C: DocsGeneratorModal 抽出为独立子应用
          - 状态全部在 useDocsGeneratorStore (11 state + 6 actions)
          - 事件监听 (soloforge-response-selected-text / soloforge-open-docs-generator) 已迁入组件
          - ESC keydown handler 已迁入组件
          - 此处仅渲染 <DocsGeneratorModal />，ChatPanel 不再持有任何 docs 相关 state
      */}
      <DocsGeneratorModal />



      {/* Integrated Terminal Panel Stacked — workdir 自动跟随 activeChatId */}
      <TerminalPanelWithWorkdir chatId={activeChatId} permissionMode={permissionMode} />

      {/* 工作区越界审批对话框 */}
      <MountTransition show={!!workspaceApproval} variant="fade">
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-[9999]">
          <div className="bg-surface border border-amber-500/35 rounded-2xl p-5 max-w-sm w-full shadow-2xl flex flex-col gap-4 font-sans text-on-surface">
            <div className="flex flex-col gap-2">
              <h3 className="text-[13px] font-bold text-amber-400 flex items-center gap-2">
                <ShieldAlert className="w-4 h-4" />
                工作区越界确认
              </h3>
              <p className="text-[11px] text-on-surface/65 leading-relaxed">
                {workspaceApproval?.message}
              </p>
            </div>
            <div className="flex flex-col gap-2 text-[11px]">
              <button
                onClick={() => workspaceApproval && resolveWorkspaceApproval(workspaceApproval.chatId, 'deny')}
                className="px-3 py-1.5 rounded-lg border border-red-500/35 bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors cursor-pointer font-bold text-left"
              >
                拒绝 — 不允许离开当前文件夹范围
              </button>
              <button
                onClick={() => workspaceApproval && resolveWorkspaceApproval(workspaceApproval.chatId, 'allow')}
                className="px-3 py-1.5 rounded-lg border border-primary/35 bg-primary/10 text-primary hover:bg-primary/20 transition-colors cursor-pointer font-bold text-left"
              >
                允许 — 仅本次允许
              </button>
              <button
                onClick={() => workspaceApproval && resolveWorkspaceApproval(workspaceApproval.chatId, 'always')}
                className="px-3 py-1.5 rounded-lg border border-emerald-500/35 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-colors cursor-pointer font-bold text-left"
              >
                允许并不再询问 — 接下来一直允许
              </button>
            </div>
          </div>
        </div>
      </MountTransition>
    </div>
  );
});

export default ChatPanel;
