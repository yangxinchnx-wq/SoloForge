import { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { LayoutProvider } from './context/LayoutContext';
import { usePreviewBridge } from './hooks/usePreviewBridge';
import { useBroadcastSync } from './hooks/useBroadcastSync';
import { useFileOperations } from './hooks/useFileOperations';
import { useRenderTrace } from './hooks/useRenderTrace';
import { useAppStore } from './state/appStore';
import { useChatsStore } from './state/chatsStore';
import { useWorkspaceStore } from './state/useWorkspaceStore';

// ── 页面级 lazy 化 (2026-07-18) ──────────────────────────────
// MainLayout 和 PopoutLayout 拆成独立 chunk,通过路由按需加载。
// App.tsx 只保留路由壳 + 认证 + 数据加载,首屏 bundle 极小。
const MainLayout = lazy(() => import('./layouts/MainLayout').then(m => ({ default: m.MainLayout })));
const PopoutLayout = lazy(() => import('./components/PopoutLayout').then(m => ({ default: m.PopoutLayout })));

// 路由级加载占位
const AppFallback = () => (
  <div className="flex items-center justify-center h-screen w-screen bg-bg">
    <div className="w-8 h-8 rounded-full border-2 border-[var(--color-primary)]/30 border-t-[var(--color-primary)] animate-spin" />
  </div>
);

export default function App() {
  // ★ 调试: 渲染追踪 (根组件)
  useRenderTrace('App');

  // ── 启动诊断 ──
  // ★ 2026-07-14: 移除 POST /api/debug-log 请求
  //   每次刷新都发 POST, 经过 patchedFetch (await ensureToken) 增加不必要的网络往返。
  //   console.log 已足够, DevTools Console 能看到。
  useEffect(() => {
    const sf = (window as any).soloforge;
    const diag = {
      hasSoloforge: !!sf,
      soloforgeKeys: sf ? Object.keys(sf) : [],
      hasReadDirTree: !!sf?.readDirTree,
      hasSelectFolder: !!sf?.selectFolder,
    };
    console.log('[App] mount diagnostic:', diag);
  }, []);

  // ★ 细粒度 selector: 只订阅 App 自身 effect 需要的字段
  //   mainModel/secModels/mixedTasks/selectedFile/activeTab/showHistory/showCodeEditor/
  //   editorContent 等不再订阅 — 各叶子组件自己用 useAppStore(selector) 订阅
  //   这样打字/切文件/切 tab 等高频操作不再触发 App 根组件重渲染
  const selectedChatId = useAppStore(s => s.selectedChatId);
  const setSelectedChatId = useAppStore(s => s.setSelectedChatId);
  const currentPermissionMode = useAppStore(s => s.currentPermissionMode);
  const setMixedTasks = useAppStore(s => s.setMixedTasks);
  const setActiveTab = useAppStore(s => s.setActiveTab);
  const setShowThemeCustomizer = useAppStore(s => s.setShowThemeCustomizer);
  const setShowSettingsModal = useAppStore(s => s.setShowSettingsModal);
  const setShowStatsModal = useAppStore(s => s.setShowStatsModal);

  // ── chatsStore → appStore 单向同步 ──────────────────────────
  const chatsStoreSelectedId = useChatsStore((s) => s.selectedChatId);
  const chatsCount = useChatsStore((s) => s.chats.length);
  useEffect(() => {
    // ★ 2026-07-14: 移除 POST /api/debug-log 请求
    //   每次选中对话变化都发 POST, 经过 patchedFetch (await ensureToken)
    //   增加不必要的网络往返, 且会阻塞选中对话的渲染。
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
          // ★ '__VAULT__:' 是旧版占位符, 不是真实密钥, 跳过
          // ★ 'local' 是本地 LLM 特殊密钥, 用于标识本地推理服务
          if (!prov.enabled || !prov.apiKey || (prov.apiKey === '__VAULT__:' && prov.id !== 'local-llm')) continue;
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

  // ── 启动时从 OS 钥匙串恢复 apiKey 到 localStorage ──────────────
  // 修复「密钥重启后丢失」问题:
  //   - localStorage 中的 apiKey 可能因 leveldb 未落盘 / 清缓存而丢失
  //   - vault (OS keychain) 是安全备份, 重启后仍存在
  //   - 但 vault 恢复逻辑原来只在 ModelAddTab (设置页) 挂载时执行
  //   - 如果用户重启后不打开设置页, vault 中的密钥永远不会被恢复
  //   - 此 effect 在 App 启动时主动拉取 vault keys, 填补 localStorage 中的空缺
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // 1. 读取当前 localStorage 中的 providers
        const saved = localStorage.getItem('cherry_providers_v2');
        if (!saved) return; // 没有 providers 数据, 无法恢复
        const providers = JSON.parse(saved);
        if (!Array.isArray(providers) || providers.length === 0) return;

        // 2. 检查是否有 provider 缺少 apiKey
        //    ★ '__VAULT__:' 是旧版占位符, 不是真实密钥, 视为缺失
        const needsRestore = providers.some(
          (p: any) => p.enabled && (!p.apiKey || p.apiKey === '__VAULT__:')
        );
        if (!needsRestore) return; // 所有 provider 都有真实 apiKey, 无需恢复

        // 3. 从 vault 列出所有有密钥的 provider
        const vr = await fetch('/api/vault/keys');
        if (!vr.ok) return;
        const vd = await vr.json();
        const items: Array<{ id: string; hasKey: boolean }> = vd?.items || [];

        // ★ 2026-07-14: 只 reveal 真正缺 apiKey 的 provider 对应的 vault key
        //   原来对所有有 key 的 vault ID 都 reveal, 浪费 N 个不必要的网络往返。
        //   现在先求交集: provider 缺 apiKey && vault 有 key → 只 reveal 这些。
        const needsKeyIds = new Set(
          providers
            .filter((p: any) => p.enabled && (!p.apiKey || p.apiKey === '__VAULT__:'))
            .map((p: any) => p.id)
        );
        const vaultIds = items
          .filter(i => i.hasKey && needsKeyIds.has(i.id))
          .map(i => i.id);
        if (vaultIds.length === 0) return; // 无需恢复任何 key

        // 4. 逐个 reveal 明文密钥 (只 reveal 真正需要的)
        const reveals = await Promise.all(
          vaultIds.map(async (id) => {
            try {
              const rr = await fetch(`/api/vault/keys/${encodeURIComponent(id)}/reveal`);
              if (!rr.ok) return null;
              const d = await rr.json();
              return { id, key: d?.apiKey || '' };
            } catch {
              return null;
            }
          })
        );
        const vaultKeys = new Map<string, string>();
        for (const rv of reveals) {
          if (rv && rv.key) vaultKeys.set(rv.id, rv.key);
        }
        if (vaultKeys.size === 0) return;

        if (cancelled) return;

        // 5. 合并: 对缺少 apiKey (或含 '__VAULT__:' 占位符) 的 provider, 从 vault 填充
        let changed = false;
        const updated = providers.map((p: any) => {
          const isMissingKey = !p.apiKey || !p.apiKey.trim() || p.apiKey === '__VAULT__:';
          if (isMissingKey && vaultKeys.has(p.id)) {
            changed = true;
            return { ...p, apiKey: vaultKeys.get(p.id) };
          }
          return p;
        });

        if (!changed) return;

        // 6. 写回 localStorage + 通知
        localStorage.setItem('cherry_providers_v2', JSON.stringify(updated));
        window.dispatchEvent(new CustomEvent('providers_updated'));
        console.log('[App] vault key restore: recovered', vaultKeys.size, 'key(s) from OS keychain');
      } catch (e) {
        console.warn('[App] vault key restore failed:', (e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // normal 模式下禁用 mixedTasks
  useEffect(() => {
    if (currentPermissionMode === 'normal') {
      setMixedTasks(false);
    }
  }, [currentPermissionMode, setMixedTasks]);

  // ★ bridge (useChatClickCanvasBridge) 已下沉到 PreviewPanel 内部调用
  //   原在此调用 + 传给 MainLayout → PreviewPanel, bridge 对象每次渲染都是新引用,
  //   会导致 MainLayout 的 React.memo 失效。现改由 PreviewPanel 自包含调用。

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

  // popout 模式检测 — 通过初始 URL query 参数决定路由起点
  // Electron 弹出窗口加载 http://localhost:3000/?popout=editor
  // MemoryRouter 用 initialEntries 设置起始路由,不依赖真实 URL
  const initialPath = typeof window !== 'undefined' && window.location.search.includes('popout=editor')
    ? '/popout' : '/';

  // ★ currentThemeId/setCurrentThemeId 已下沉到 StatusBar (从 ThemeContext 直接读)
  // ★ editorContent 已下沉到 SourceCodeEditor/HistoryAndEditorPanel/ChatPanel/PopoutLayout

  return (
    <LayoutProvider>
      <MemoryRouter initialEntries={[initialPath]}>
        <Suspense fallback={<AppFallback />}>
          <Routes>
            {/* 主工作区 — IDE 布局 (Header + ActivityBar + ChatPanel + 面板) */}
            <Route path="/" element={
              <MainLayout
                handleFileChange={handleFileChange}
                handleEditorChange={handleEditorChange}
                handleNewFile={handleNewFile}
                onOpenThemeCustomizer={onOpenThemeCustomizer}
                onOpenSettingsModal={onOpenSettingsModal}
                onOpenStatsModal={onOpenStatsModal}
                modelProviderMap={modelProviderMap}
              />
            } />
            {/* 弹出编辑器窗口 — 独立 chunk,主窗口不加载 */}
            <Route path="/popout" element={
              <PopoutLayout
                handleFileChange={handleFileChange}
                handleNewFile={handleNewFile}
                handleEditorChange={handleEditorChange}
              />
            } />
          </Routes>
        </Suspense>
      </MemoryRouter>
    </LayoutProvider>
  );
}
