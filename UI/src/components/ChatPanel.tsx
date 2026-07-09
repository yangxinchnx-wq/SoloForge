import React, { useRef, useEffect, useMemo, useState } from 'react';
import { Send, ChevronDown, ChevronUp, FileCode, X, SlidersHorizontal, Check, ShieldAlert, ThumbsUp, ThumbsDown } from '../utils/icons';
import { MountTransition } from './MountTransition';
import TerminalPanelWithWorkdir from './terminal/TerminalPanelWithWorkdir';
// 2026-07-03 阶段3.1.C: DocsGeneratorModal 抽出为独立子应用, 状态收敛到 useDocsGeneratorStore
import DocsGeneratorModal from './DocsGeneratorModal';
// 2026-07-03 阶段3.1.D: ResourceManagerBar 抽出为独立子应用, 状态收敛到 useResourceManagerStore
import ResourceManagerBar from './ResourceManagerBar';

import { ModelIcon } from './ModelIcon';
import { ToolCallCard } from './ToolCallCard';
import StreamPanel from './StreamPanel';
import type { ChatPanelProps, ChatSettingsItem } from '../types/chat';
import { getSettingsSummary } from '../types/chat';
// 2026-07-03 阶段3.1.B 子组件抽出:
//   4 个权限模式图标 → permissionModeIcons.tsx
//   CollapsibleCodeBlock + FormatChatMessage → chatMessage/
//   6 个 stream 子视图 → streamViews.tsx
import { CollapsibleCodeBlock, FormatChatMessage } from './chatMessage';
import { SuggestEnableView } from './streamViews';
// StreamPanel 选择器: 获取事件缓冲 (通知用)
import { useEventBufferForChat } from '../state/streamingStore';
// 2026-07-03 阶段3.1.E: 12 个 state + 9 个 handler 收敛到 useChatStore
import { useChatStore, fallbackActiveSettings } from '../state/useChatStore';
import { NormalIcon, PerformanceIcon, ExpertIcon, UltimateIcon } from './permissionModeIcons';

// 4 个权限模式图标 (NormalIcon/PerformanceIcon/ExpertIcon/UltimateIcon) 已外移到
// permissionModeIcons.tsx (2026-07-03 阶段3.1.B)
// 兼容性 re-export: SettingsModal 仍可 `from './ChatPanel'` 拿这 4 个图标
export { NormalIcon, PerformanceIcon, ExpertIcon, UltimateIcon } from './permissionModeIcons';

// ChatPanelProps / ChatSettingsItem 已外移到 types/chat.ts (2026-07-03 阶段3.1.A)
export type { ChatPanelProps, ChatSettingsItem } from '../types/chat';

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

export default function ChatPanel({
  permissionMode = 'normal',
  setPermissionMode,
  // 2026-07-03 阶段3.1.D: primaryColorTargets 已不再使用
  //   (原仅用于 skill-bar inline --color-primary, 已迁到 ResourceManagerBar 走 data-theme-region="skill-bar")
  selectedChatId = '1',
  mainModel = '',
  secModels = [],
  mixedTasks = false,
  selectedFile = '',
  editorContent = '',
  modelProviderMap = {}
}: ChatPanelProps) {
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
  const streamState = useChatStore(s => s.streamState);
  const inputValue = useChatStore(s => s.inputValue);
  const showModeDropdown = useChatStore(s => s.showModeDropdown);
  const workspaceApproval = useChatStore(s => s.workspaceApproval);

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
  const handleAcceptEnable = useChatStore(s => s.handleAcceptEnable);

  // DOM 引用保留组件本地 (transient imperative state, 不进 store)
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // 2026-07-03 阶段3.1.E: 同步 props 到 store.options (action 内部用 get().options 读取)
  useEffect(() => {
    syncRuntimeOptions({
      permissionMode,
      selectedChatId,
      mainModel,
      secModels,
      selectedFile,
      editorContent,
      modelProviderMap,
    });
  }, [permissionMode, selectedChatId, mainModel, secModels, selectedFile, editorContent, modelProviderMap, syncRuntimeOptions]);

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
  const activeChatId = selectedChatId || '1';
  const localChatInfo = useMemo(() => chatsList.find(c => c.id === activeChatId) || null, [chatsList, activeChatId]);
  // ── 用户头像 + 名字 (与右上角 UserBadgeSelector 同步) ──────────────
  const [userAvatarIdx, setUserAvatarIdx] = useState(0);
  const [userName, setUserName] = useState('');
  useEffect(() => {
    const syncUserBadge = () => {
      const savedAvatar = localStorage.getItem('soloforge_user_avatar_idx');
      if (savedAvatar !== null) {
        const idx = parseInt(savedAvatar, 10);
        if (idx >= 0 && idx < 4) setUserAvatarIdx(idx);
      }
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
          if (!prov.enabled || !prov.apiKey) return;
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

  // 2026-07-03 阶段3.1.E: 滚动到底 (依赖 activeMessages)
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [activeMessages]);

  // StreamPanel 事件缓冲 (按 chatId 隔离, 仅用于事件到达通知)
  const eventBuffer = useEventBufferForChat(activeChatId);

  // 2026-07-03 阶段3.1.E: 发送时把 inputRef 传给 store action, 让 store 也能 focus 输入框
  const handleSend = () => handleSendFromStore(inputRef);

  // ── Phase 5 实时训练: 👍/👎 反馈按钮 ──────────────────────────────
  // 每条 assistant 消息独立追踪反馈状态, 累积 negative 反馈触发 PromptOptimizer
  // 后端: POST /api/java-agent/api/feedback (FeedbackController)
  // 触发阈值: soloforge.training.feedback.trigger-threshold (默认 5)
  const [feedbackMap, setFeedbackMap] = useState<Record<number, 'up' | 'down' | undefined>>({});
  const [feedbackBusy, setFeedbackBusy] = useState<Record<number, boolean>>({});

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

    // ── 路径分流 (2026-07-09) ──────────────────────────────────────
    // 经验路径 (experienceFingerprint 存在) → Node.js 经验反馈, 更新 successRate
    //   👎 连续打分低于 0.3 → 经验自动失效删除, 下次重新走 Agent Loop (解决越做越错)
    // 其他路径 (无 fingerprint) → Java Agent 案例库 (原逻辑)
    const expFp = (msg as any)?.experienceFingerprint as string | undefined;

    try {
      if (expFp) {
        // ── 经验路径: 走 Node.js /api/agents/experience/feedback ──
        const res = await fetch('/api/agents/experience/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fingerprint: expFp,
            prompt: userMessage,
            positive,
          }),
        });
        if (!res.ok) {
          setFeedbackMap(prev => ({ ...prev, [index]: undefined }));
        } else {
          const data = await res.json().catch(() => ({}));
          if (data?.alive === false) {
            // 经验已失效删除, 下次该问题重新走 Agent Loop
            console.info(`[经验失效] fingerprint=${expFp} 已因 👎 降权失效, 下次重新解决`);
          } else {
            console.info(`[经验${positive ? '强化' : '降权'}] fingerprint=${expFp} successRate=${data?.successRate?.toFixed(2)}`);
          }
        }
      } else {
        // ── 其他路径: 走 Java Agent /api/java-agent/api/feedback (原逻辑) ──
        const res = await fetch('/api/java-agent/api/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId: activeSettings.agentId || 'code_agent',
            positive,
            message: userMessage,
            response: msg?.content || '',
            chatId: activeChatId,
          }),
        });
        if (!res.ok) {
          setFeedbackMap(prev => ({ ...prev, [index]: undefined }));
        } else {
          const data = await res.json().catch(() => ({}));
          if (data?.caseId) {
            console.info(`[案例入库] ${data.agentId || activeSettings.agentId} caseId=${data.caseId} positive=${positive}`);
          }
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
                onClick={() => window.dispatchEvent(new CustomEvent('soloforge-open-agent-settings', { detail: { id: activeChatId, title: activeChatTitle } }))}
                className="truncate font-sans font-medium hover:text-primary hover:underline cursor-pointer flex items-center gap-0.5 group"
                title="点击配置智能体角色表情、状态、回复语调与性格"
                id="agent-role-summary-btn"
              >
                <span>智能体角色：</span>
                <span className="text-primary font-semibold group-hover:text-primary/80">{getSettingsSummary(activeSettings)}</span>
                <SlidersHorizontal className="w-2.5 h-2.5 ml-1 select-none text-primary opacity-60 group-hover:opacity-100 transition-opacity" />
              </button>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 relative shrink-0">
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('soloforge-open-agent-settings', { detail: { id: activeChatId, title: activeChatTitle } }))}
            className="flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1.5 rounded-lg bg-primary/10 hover:bg-primary/20 text-primary hover:text-primary/90 transition-all duration-150 cursor-pointer border border-primary/20 hover:border-primary/35 shadow-sm"
            title="定制智能体性格、表情状态与回复语调"
            id="chat-header-agent-settings-btn"
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            <span>智能体配置</span>
          </button>
        </div>
      </div>

      {/* Scrollable Conversation Stream */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-4 select-text scrollbar-thin scrollbar-thumb-outline/50"
      >
        <div className="max-w-5xl lg:max-w-[94%] xl:max-w-[90%] mx-auto w-full flex flex-col space-y-5 py-2 px-4 md:px-6">
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
            // 隐藏空的 assistant 占位消息: 当 isGenerating 时, 空的 assistant
            // 气泡 + 流式 UI 看起来像"两个模型对话"。跳过它, 只显示流式 UI。
            if (!isUser && isGenerating && !msg.content.trim() && index === activeMessages.length - 1) {
              return null;
            }
            return (
              <div
                key={index}
                className={`sf-anim sf-anim-slide-up flex flex-col gap-2.5 ${isUser ? 'items-end' : 'items-start'}`}
              >
                {/* Header Row: Avatar + Info */}
                <div className={`flex gap-3 items-center mb-1 ${isUser ? 'flex-row-reverse' : ''}`}>
                  {/* Avatar block — 始终使用本地兜底，不加载外链头像 (CSP 安全) */}
                  {isUser ? (
                    <img
                      src={`/头像/avatar${userAvatarIdx + 1}.svg`}
                      alt="用户头像"
                      className="w-11 h-11 rounded-full shrink-0 object-cover pointer-events-none border border-primary/25 shadow-sm"
                      draggable={false}
                    />
                  ) : (
                    <div className="w-11 h-11 rounded-full bg-on-surface/5 border border-on-surface/10 flex items-center justify-center shrink-0">
                      {mainModel ? (
                        <ModelIcon modelName={mainModel} size={32} className="shrink-0" iconType={mainModelIconType} />
                      ) : (
                        <span className="text-on-surface/20 text-xs font-bold">—</span>
                      )}
                    </div>
                  )}

                  {/* Info block (Username/Model + Time) */}
                  <div className={`flex items-center gap-2 ${isUser ? 'flex-row-reverse' : ''}`}>
                    <span className={`text-[11px] font-bold ${isUser ? 'text-primary/95 text-right' : 'text-[#3b82f6]'}`}>
                      {isUser ? (userName || '你') : (mainModel || '未选择')}
                    </span>
                    <span className="text-[9px] text-on-surface/30 font-mono tracking-wide">{msg.time}</span>
                  </div>
                </div>

                {/* Content block: aligned on right or left */}
                <div className={`flex flex-col gap-1 max-w-[88%] font-sans text-left ${isUser ? 'pr-3 pl-[58px] items-end' : 'pl-[58px] pr-3 items-start'}`}>
                  <div className={`px-3.5 py-2.5 rounded-xl text-[12px] leading-relaxed select-text space-y-1.5 w-fit max-w-full overflow-hidden border ${isUser ? 'bg-primary/8 border-primary/30 text-on-surface' : 'bg-surface/50 border-outline/30 text-on-surface'}`}>
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
                  {/* Phase 5: 👍/👎 反馈按钮 — 仅 assistant 消息, 累积 negative 触发 PromptOptimizer */}
                  {!isUser && !isGenerating && (
                    <div className="flex items-center gap-1.5 pl-1 pt-0.5">
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
                  )}
                </div>
              </div>
            );
          })}

          {isGenerating && (
            <div className="sf-anim sf-anim-slide-up">
              {/* SuggestEnableView 保留: StreamPanel 未处理 suggest_enable 事件 */}
              {streamState.suggestEnables.length > 0 && (
                <div className="flex flex-col gap-2 max-w-[95%] pl-[58px] text-left mb-2">
                  <SuggestEnableView items={streamState.suggestEnables} onAccept={handleAcceptEnable} />
                </div>
              )}

              {/* StreamPanel: AI 行为流送区 */}
              <StreamPanel
                chatId={activeChatId}
                mainModel={mainModel}
                modelCount={1 + (secModels?.length || 0)}
                permissionMode={permissionMode}
                events={eventBuffer ?? []}
              />
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
        <div className="max-w-5xl lg:max-w-[94%] xl:max-w-[90%] mx-auto w-full px-4 md:px-6">
          <div className="bg-bg rounded-lg border border-outline focus-within:border-primary/50 transition-colors p-2 flex flex-col gap-2">
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
                handleSend();
              }
            }}
            placeholder="请输入您的需求... (Ctrl + Enter 发送)"
            className="bg-transparent text-xs text-on-surface placeholder-on-surface/30 select-text outline-none resize-none h-14 w-full p-1"
          />

          <div className="flex items-center justify-between pt-1 border-t border-outline/30">
            {/* Conversation mode select dropdown */}
            <div className="relative" id="chat-mode-selection-dropdown">
              <button
                onClick={() => setShowModeDropdown(!showModeDropdown)}
                className="sf-lift flex items-center gap-1.5 text-[10px] text-on-surface/85 bg-surface-bright hover:bg-bg border border-outline px-2.5 py-1 rounded cursor-pointer hover:text-on-surface transition-all font-sans font-bold shadow select-none"
                style={{ backfaceVisibility: "hidden", WebkitFontSmoothing: "subpixel-antialiased" }}
              >
                {permissionMode === 'normal' && <NormalIcon className="w-3.5 h-3.5" />}
                {permissionMode === 'performance' && <PerformanceIcon className="w-3.5 h-3.5" />}
                {permissionMode === 'expert' && <ExpertIcon className="w-3.5 h-3.5" />}
                {permissionMode === 'ultimate' && <UltimateIcon className="w-3.5 h-3.5" />}
                <span>
                  {permissionMode === 'normal' ? '普通模式 (安全)' :
                   permissionMode === 'performance' ? '性能模式 (半自动)' :
                   permissionMode === 'expert' ? '专家模式 (全自动)' : '极致模式 (全自动)'}
                </span>
                <ChevronDown className={`w-2.5 h-2.5 opacity-60 transition-transform duration-200 ${showModeDropdown ? 'rotate-180' : ''}`} />
              </button>

              <MountTransition show={showModeDropdown} variant="slide-up" duration={150}>
                  <>
                    <div
                      className="fixed inset-0 z-40 cursor-default"
                      onClick={() => setShowModeDropdown(false)}
                    />
                    <div
                      style={{
                        transformOrigin: "bottom left",
                        backfaceVisibility: "hidden",
                        WebkitFontSmoothing: "subpixel-antialiased"
                      }}
                      className="absolute left-0 bottom-full mb-1.5 w-[230px] bg-surface/98 backdrop-blur-md border border-outline/35 rounded-lg shadow-2xl p-1.5 flex flex-col font-sans z-50 capitalize-none text-left"
                    >
                      <span className="text-[9px] text-primary/70 px-2 py-1 font-semibold border-b border-outline/25 mb-1 tracking-wider uppercase select-none">
                        运行资源模式
                      </span>

                      {/* Normal Mode Option */}
                      <button
                        onClick={() => {
                          setPermissionMode?.('normal');
                          setShowModeDropdown(false);
                        }}
                        className={`flex flex-col gap-0.5 p-2 rounded text-left transition-colors cursor-pointer select-none group sf-lift ${
                          permissionMode === 'normal' ? 'bg-emerald-500/10 border border-emerald-500/25 text-on-surface' : 'hover:bg-surface-bright text-on-surface/80 hover:text-on-surface'
                        }`}
                        style={{ backfaceVisibility: "hidden", WebkitFontSmoothing: "subpixel-antialiased" }}
                      >
                        <div className="flex items-center justify-between text-[10.5px] font-bold">
                          <div className="flex items-center gap-1.5 text-emerald-400 font-sans group-hover:text-emerald-300 transition-colors">
                            <NormalIcon className="w-4 h-4" />
                            <span>普通模式 (安全)</span>
                          </div>
                          {permissionMode === 'normal' && <Check className="w-3 h-3 text-emerald-400" />}
                        </div>
                        <p className="text-[9px] leading-relaxed text-on-surface/50 font-medium whitespace-normal font-sans group-hover:text-on-surface/70 transition-colors">
                          自动识别并绕过风险命令，守护代码与环境安全。
                        </p>
                      </button>

                      {/* Performance Mode Option */}
                      <button
                        onClick={() => {
                          setPermissionMode?.('performance');
                          setShowModeDropdown(false);
                        }}
                        className={`flex flex-col gap-0.5 p-2 rounded text-left transition-colors cursor-pointer select-none group sf-lift ${
                          permissionMode === 'performance' ? 'bg-purple-500/10 border border-purple-500/25 text-on-surface' : 'hover:bg-surface-bright text-on-surface/80 hover:text-on-surface'
                        }`}
                        style={{ backfaceVisibility: "hidden", WebkitFontSmoothing: "subpixel-antialiased" }}
                      >
                        <div className="flex items-center justify-between text-[10.5px] font-bold">
                          <div className="flex items-center gap-1.5 text-purple-400 font-sans group-hover:text-purple-300 transition-colors">
                            <PerformanceIcon className="w-4 h-4" />
                            <span>性能模式 (半自动)</span>
                          </div>
                          {permissionMode === 'performance' && <Check className="w-3 h-3 text-purple-400" />}
                        </div>
                        <p className="text-[9px] leading-relaxed text-on-surface/50 font-medium whitespace-normal font-sans group-hover:text-on-surface/70 transition-colors">
                          自主加载各项基础工具逻辑，支持多模型智能混合。
                        </p>
                      </button>

                      {/* Expert Mode Option */}
                      <button
                        onClick={() => {
                          setPermissionMode?.('expert');
                          setShowModeDropdown(false);
                        }}
                        className={`flex flex-col gap-0.5 p-2 rounded text-left transition-colors cursor-pointer select-none group sf-lift ${
                          permissionMode === 'expert' ? 'bg-amber-500/10 border border-amber-500/25 text-on-surface' : 'hover:bg-surface-bright text-on-surface/80 hover:text-on-surface'
                        }`}
                        style={{ backfaceVisibility: "hidden", WebkitFontSmoothing: "subpixel-antialiased" }}
                      >
                        <div className="flex items-center justify-between text-[10.5px] font-bold">
                          <div className="flex items-center gap-1.5 text-amber-500 font-sans group-hover:text-amber-400 transition-colors">
                            <ExpertIcon className="w-4 h-4" />
                            <span>专家模式 (全自动)</span>
                          </div>
                          {permissionMode === 'expert' && <Check className="w-3 h-3 text-amber-500" />}
                        </div>
                        <p className="text-[9px] leading-relaxed text-on-surface/50 font-medium whitespace-normal font-sans group-hover:text-on-surface/70 transition-colors">
                          深度专家级 resource 调度，多模型高频协同攻坚复杂任务。
                        </p>
                      </button>

                      {/* Ultimate Mode Option */}
                      <button
                        onClick={() => {
                          setPermissionMode?.('ultimate');
                          setShowModeDropdown(false);
                        }}
                        className={`flex flex-col gap-0.5 p-2 rounded text-left transition-colors cursor-pointer select-none group sf-lift ${
                          permissionMode === 'ultimate' ? 'bg-red-500/10 border border-red-500/25 text-on-surface' : 'hover:bg-surface-bright text-on-surface/80 hover:text-on-surface'
                        }`}
                        style={{ backfaceVisibility: "hidden", WebkitFontSmoothing: "subpixel-antialiased" }}
                      >
                        <div className="flex items-center justify-between text-[10.5px] font-bold">
                          <div className="flex items-center gap-1.5 text-red-500 font-sans group-hover:text-red-400 transition-colors">
                            <UltimateIcon className="w-4 h-4" />
                            <span>极致模式 (全自动)</span>
                          </div>
                          {permissionMode === 'ultimate' && <Check className="w-3 h-3 text-red-500" />}
                        </div>
                        <p className="text-[9px] leading-relaxed text-on-surface/50 font-medium whitespace-normal font-sans group-hover:text-on-surface/70 transition-colors">
                          最大化释放算力，无中断调度全部工具加速实现诉求。
                        </p>
                      </button>
                    </div>
                  </>
              </MountTransition>
            </div>

            {/* Submit Send Button */}
            <button
              onClick={handleSend}
              className="bg-[#2563eb] hover:bg-blue-500 text-white rounded px-3 py-1 flex items-center gap-1 text-[10px] font-semibold tracking-wide active:scale-95 transition-all cursor-pointer shadow-md"
            >
              <span>发送</span>
              <Send className="w-3 h-3" />
            </button>
          </div>
        </div>
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
}
