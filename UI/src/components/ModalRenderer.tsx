// ─────────────────────────────────────────────────────────────────
// ModalRenderer — 统一 Modal 渲染器
// Path: UI/src/components/ModalRenderer.tsx
// 从 appStore 直接读取 modal 状态，消除 MainLayout 的 modal props 透传
// ─────────────────────────────────────────────────────────────────

import React, { lazy, Suspense } from 'react';
import { MountTransition } from './MountTransition';
import { X } from '../utils/icons';
import { useAppStore } from '../state/appStore';
import { useHotTheme } from '../context/ThemeContext';

// Heavy modals → lazy loaded (保持原有懒加载策略)
const ThemeModal = lazy(() => import('./ThemeModal').then(m => ({ default: m.default })));
const SettingsModal = lazy(() => import('./SettingsModal').then(m => ({ default: m.default })));
const StatsModal = lazy(() => import('./StatsModal').then(m => ({ default: m.default })));
const LocalLLMPage = lazy(() => import('./LocalLLMPage').then(m => ({ default: m.default })));
const FloatingEditorWindow = lazy(() => import('./FloatingEditorWindow').then(m => ({ default: m.default })));
const AgentSettingsModal = lazy(() => import('./AgentSettingsModal').then(m => ({ default: m.default })));

const ModalFallback = () => (
  <div className="fixed inset-0 z-[200] flex items-center justify-center pointer-events-none">
    <div className="w-8 h-8 rounded-full border-2 border-[var(--color-primary)]/30 border-t-[var(--color-primary)] animate-spin" />
  </div>
);

interface ModalRendererProps {
  /** 编辑器内容变更回调（FloatingEditorWindow 需要） */
  onEditorChange: (content: string) => void;
}

/**
 * 统一 Modal 渲染器
 * 职责：渲染所有 Modal + Toast 通知，从 appStore 直接读取状态
 * 消除 MainLayout 的 10+ 个 modal 相关 props
 */
export const ModalRenderer: React.FC<ModalRendererProps> = ({
  onEditorChange,
}) => {
  // ★ 细粒度 selector: 每个字段独立订阅, 避免任一 modal/toast 状态变化触发全树重渲染
  const showThemeCustomizer = useAppStore(s => s.showThemeCustomizer);
  const setShowThemeCustomizer = useAppStore(s => s.setShowThemeCustomizer);
  const showSettingsModal = useAppStore(s => s.showSettingsModal);
  const setShowSettingsModal = useAppStore(s => s.setShowSettingsModal);
  const showStatsModal = useAppStore(s => s.showStatsModal);
  const setShowStatsModal = useAppStore(s => s.setShowStatsModal);
  const showLocalLLMPage = useAppStore(s => s.showLocalLLMPage);
  const setShowLocalLLMPage = useAppStore(s => s.setShowLocalLLMPage);
  const showFloatingEditor = useAppStore(s => s.showFloatingEditor);
  const setShowFloatingEditor = useAppStore(s => s.setShowFloatingEditor);
  const activeSettingsChat = useAppStore(s => s.activeSettingsChat);
  const setActiveSettingsChat = useAppStore(s => s.setActiveSettingsChat);
  const toastMsg = useAppStore(s => s.toastMsg);
  const setToastMsg = useAppStore(s => s.setToastMsg);
  const currentPermissionMode = useAppStore(s => s.currentPermissionMode);

  const {
    primaryColor, setPrimaryColor,
    primaryColorTargets, setPrimaryColorTargets,
    currentThemeId, setCurrentThemeId,
  } = useHotTheme();

  return (
    <>
      {/* Theme Customizer modal pop-over */}
      <Suspense fallback={<ModalFallback />}>
        {showThemeCustomizer && (
          <ThemeModal
            onClose={() => setShowThemeCustomizer(false)}
            primaryColor={primaryColor}
            setPrimaryColor={setPrimaryColor}
            currentThemeId={currentThemeId}
            setCurrentThemeId={setCurrentThemeId}
            primaryColorTargets={primaryColorTargets}
            setPrimaryColorTargets={setPrimaryColorTargets}
          />
        )}
      </Suspense>

      {/* Geek Settings Modal (13 Core Modules) */}
      <MountTransition show={showSettingsModal} variant="fade" className="fixed inset-0 z-[1000]">
        <Suspense fallback={<ModalFallback />}>
          {showSettingsModal && (
            <SettingsModal
              onClose={() => setShowSettingsModal(false)}
              permissionMode={currentPermissionMode}
            />
          )}
        </Suspense>
      </MountTransition>

      {/* Local LLM Inference Service Page */}
      <MountTransition show={showLocalLLMPage} variant="fade" className="fixed inset-0 z-[1001]">
        <Suspense fallback={<ModalFallback />}>
          {showLocalLLMPage && (
            <LocalLLMPage />
          )}
        </Suspense>
      </MountTransition>

      {/* AI & Token Audit statistics popup */}
      <MountTransition show={showStatsModal} variant="fade-scale" className="fixed inset-0 z-[1000]">
        <Suspense fallback={<ModalFallback />}>
          {showStatsModal && (
            <StatsModal onClose={() => setShowStatsModal(false)} />
          )}
        </Suspense>
      </MountTransition>

      {/* Floating Draggable & Pinnable Code Editor Window */}
      <MountTransition show={showFloatingEditor} variant="fade-scale" duration={220}>
        <Suspense fallback={<ModalFallback />}>
          {showFloatingEditor && (
            <FloatingEditorWindow
              setEditorContent={onEditorChange}
              onClose={() => setShowFloatingEditor(false)}
            />
          )}
        </Suspense>
      </MountTransition>

      {/* Global Exclusive Agent Settings Customizer Overlay */}
      <MountTransition show={!!activeSettingsChat} variant="fade-scale" className="fixed inset-0 z-[9999]">
        <Suspense fallback={<ModalFallback />}>
          {activeSettingsChat && (
            <AgentSettingsModal
              chatId={activeSettingsChat.id}
              chatTitle={activeSettingsChat.title}
              onClose={() => setActiveSettingsChat(null)}
            />
          )}
        </Suspense>
      </MountTransition>

      {/* Premium Toast Notification Banner */}
      <MountTransition show={!!toastMsg} variant="slide-up" duration={250}>
        {toastMsg && (
          <div
            style={{ left: '50%', transform: 'translateX(-50%)' }}
            className="fixed top-6 z-[9999] bg-[#17181c] border border-[var(--color-primary)]/30 rounded-xl px-4 py-3 shadow-[0_12px_40px_rgba(0,0,0,0.5)] flex items-center gap-3 max-w-md w-max"
          >
            <div className="flex flex-col min-w-0 pr-1 select-text">
              <span className="text-[11px] font-bold text-white tracking-wide">工作区跳转定位通知</span>
              <p className="text-[10px] text-on-surface/75 leading-relaxed">{toastMsg}</p>
            </div>
            <button
              onClick={() => setToastMsg(null)}
              className="text-on-surface/40 hover:text-white transition-colors p-1"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </MountTransition>
    </>
  );
};
