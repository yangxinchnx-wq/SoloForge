import { useState, useEffect, useCallback } from 'react';
import { MainLayout } from './layouts/MainLayout';
import { PopoutLayout } from './components/PopoutLayout';
import { useHotTheme } from './context/ThemeContext';
import { LayoutProvider } from './context/LayoutContext';
import { useChatClickCanvasBridge } from './hooks/useChatClickCanvasBridge';
import { usePreviewBridge } from './hooks/usePreviewBridge';
import { useBroadcastSync } from './hooks/useBroadcastSync';
import { useFileOperations } from './hooks/useFileOperations';
import { useAppStore } from './state/appStore';
import { useChatsStore } from './state/chatsStore';
import { useWorkspaceStore } from './state/useWorkspaceStore';

export default function App() {
  // ── 启动诊断 ──
  useEffect(() => {
    const sf = (window as any).soloforge;
    const diag = {
      hasSoloforge: !!sf,
      soloforgeKeys: sf ? Object.keys(sf) : [],
      hasReadDirTree: !!sf?.readDirTree,
      hasSelectFolder: !!sf?.selectFolder,
    };
    console.log('[App] mount diagnostic:', diag);
    try { fetch('/api/debug-log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'App mount', ...diag }) }); } catch {}
  }, []);

  const {
    mainModel, setMainModel,
    secModels, setSecModels,
    mixedTasks, setMixedTasks,
    currentPermissionMode, setCurrentPermissionMode,
    selectedFile,
    selectedChatId, setSelectedChatId,
    activeTab, setActiveTab,
    setShowHistory,
    showCodeEditor, setShowCodeEditor,
    showHistory,
    setShowThemeCustomizer,
    setShowSettingsModal,
    setShowStatsModal,
  } = useAppStore();

  // ── chatsStore → appStore 单向同步 ──────────────────────────
  const chatsStoreSelectedId = useChatsStore((s) => s.selectedChatId);
  const chatsCount = useChatsStore((s) => s.chats.length);
  useEffect(() => {
    // 诊断: 每次选中对话变化时发日志
    const chat = useChatsStore.getState().chats.find(c => c.id === chatsStoreSelectedId);
    try { fetch('/api/debug-log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'chatSelect', chatsCount, selectedId: chatsStoreSelectedId, selectedTitle: chat?.title, workspaceFolder: chat?.workspaceFolder }) }); } catch {}
    if (chatsStoreSelectedId && chatsStoreSelectedId !== selectedChatId) {
      setSelectedChatId(chatsStoreSelectedId);
    }
  }, [chatsStoreSelectedId, selectedChatId, setSelectedChatId, chatsCount]);

  // ── 切换对话时自动切到"资源管理器"选项卡 + 恢复工作区 ──────
  // 如果选中的对话绑定了 workspaceFolder, 说明该对话有文件工作区,
  // 应自动切换 activeTab 到 'explorer' 让 FileExplorer 显示出来。
  // 同时调用 ensureWorkspace 确保工作区数据存在 (处理孤立数据/服务端恢复)。
  const selectedChat = useChatsStore(
    (s) => s.chats.find((c) => c.id === s.selectedChatId),
  );
  const selectedChatHasWorkspace = !!selectedChat?.workspaceFolder;
  useEffect(() => {
    if (selectedChatHasWorkspace && selectedChat?.workspaceFolder) {
      setActiveTab('explorer');
      // 确保工作区数据存在 (按名称匹配孤立数据 → 服务端恢复)
      useWorkspaceStore.getState().ensureWorkspace(
        chatsStoreSelectedId || 'default',
        selectedChat.workspaceFolder,
      );
    }
  }, [chatsStoreSelectedId, selectedChatHasWorkspace, selectedChat?.workspaceFolder, setActiveTab]);

  // ── modelProviderMap: 从 cherry_providers_v2 构建, 传给 ChatPanel ──
  const [modelProviderMap, setModelProviderMap] = useState<Record<string, {
    baseUrl: string; apiKey: string; model: string;
    providerName: string; enabledInSettings: boolean;
  }>>({});

  useEffect(() => {
    const buildMap = () => {
      try {
        const saved = localStorage.getItem('cherry_providers_v2');
        if (!saved) return;
        const parsed = JSON.parse(saved);
        if (!Array.isArray(parsed)) return;
        const map: Record<string, {
          baseUrl: string; apiKey: string; model: string;
          providerName: string; enabledInSettings: boolean;
        }> = {};
        for (const prov of parsed) {
          if (!prov.enabled || !prov.apiKey) continue;
          const enabledInSettings = prov.status === 'success';
          if (Array.isArray(prov.models)) {
            for (const m of prov.models) {
              if (m.enabled) {
                map[m.id] = {
                  baseUrl: prov.baseUrl,
                  apiKey: prov.apiKey,
                  model: m.id,
                  providerName: prov.name,
                  enabledInSettings,
                };
              }
            }
          }
          if (Array.isArray(prov.customModels)) {
            for (const cm of prov.customModels) {
              const id = typeof cm === 'string' ? cm : (cm?.id ?? '');
              if (id && (typeof cm === 'string' || cm.enabled !== false)) {
                map[id] = {
                  baseUrl: prov.baseUrl,
                  apiKey: prov.apiKey,
                  model: id,
                  providerName: prov.name,
                  enabledInSettings,
                };
              }
            }
          }
        }
        setModelProviderMap(map);
      } catch (e) {
        console.error('Error building modelProviderMap', e);
      }
    };
    buildMap();
    window.addEventListener('storage', buildMap);
    window.addEventListener('providers_updated', buildMap);
    return () => {
      window.removeEventListener('storage', buildMap);
      window.removeEventListener('providers_updated', buildMap);
    };
  }, []);

  // normal 模式下禁用 mixedTasks
  useEffect(() => {
    if (currentPermissionMode === 'normal') {
      setMixedTasks(false);
    }
  }, [currentPermissionMode, setMixedTasks]);

  // 画布 → chat 自动桥接
  const bridge = useChatClickCanvasBridge({
    chatId: selectedChatId,
    allowCreate: false,
    defaultDescription: '默认画布',
  });

  // AST 预览流桥接
  usePreviewBridge();

  // 跨窗口同步
  useBroadcastSync();

  // 文件操作（编辑/切换/事件监听）
  const { handleEditorChange, handleFileChange, handleNewFile } = useFileOperations();

  // 稳定 setter 引用 — 让 memo 过的子组件不被频繁重建
  const onOpenThemeCustomizer = useCallback(() => setShowThemeCustomizer(true), [setShowThemeCustomizer]);
  const onOpenSettingsModal = useCallback(() => setShowSettingsModal(true), [setShowSettingsModal]);
  const onOpenStatsModal = useCallback(() => setShowStatsModal(true), [setShowStatsModal]);

  // popout 模式检测
  const isPopout = typeof window !== 'undefined' && window.location.search.includes('popout=editor');

  const { currentThemeId, setCurrentThemeId } = useHotTheme();
  const editorContent = useAppStore((s) => s.editorContent);

  if (isPopout) {
    return (
      <LayoutProvider>
        <PopoutLayout
          selectedFile={selectedFile}
          handleFileChange={handleFileChange}
          handleNewFile={handleNewFile}
          editorContent={editorContent}
          handleEditorChange={handleEditorChange}
        />
      </LayoutProvider>
    );
  }

  return (
    <LayoutProvider>
      <MainLayout
        mainModel={mainModel}
        setMainModel={setMainModel}
        secModels={secModels}
        setSecModels={setSecModels}
        mixedTasks={mixedTasks}
        setMixedTasks={setMixedTasks}
        currentPermissionMode={currentPermissionMode}
        setCurrentPermissionMode={setCurrentPermissionMode}
        selectedFile={selectedFile}
        selectedChatId={selectedChatId}
        setSelectedChatId={setSelectedChatId}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        setShowHistory={setShowHistory}
        setShowCodeEditor={setShowCodeEditor}
        showHistory={showHistory}
        showCodeEditor={showCodeEditor}
        handleFileChange={handleFileChange}
        handleEditorChange={handleEditorChange}
        handleNewFile={handleNewFile}
        bridge={bridge}
        onOpenThemeCustomizer={onOpenThemeCustomizer}
        onOpenSettingsModal={onOpenSettingsModal}
        onOpenStatsModal={onOpenStatsModal}
        modelProviderMap={modelProviderMap}
        onEditorChange={handleEditorChange}
        currentThemeId={currentThemeId}
        setCurrentThemeId={setCurrentThemeId}
        editorContent={editorContent}
      />
    </LayoutProvider>
  );
}
