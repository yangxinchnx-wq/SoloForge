// ─────────────────────────────────────────────────────────────────
// useBroadcastSync — 跨窗口实时同步 Hook
// Path: UI/src/hooks/useBroadcastSync.ts
// 从 App.tsx 拆分 BroadcastChannel 逻辑，处理主窗口与 popout 窗口的双向同步
// ─────────────────────────────────────────────────────────────────

import { useEffect, useRef } from 'react';
import { useAppStore } from '../state/appStore';
import { useHotTheme } from '../context/ThemeContext';

/**
 * 跨窗口实时同步
 * 通过 BroadcastChannel 'soloforge-editor-sync-channel' 实现：
 * - 文件选择同步 (FILE_SELECT)
 * - 编辑内容同步 (EDIT)
 * - 主题同步 (THEME_SELECT / THEME_SYNC)
 * - 请求/响应初始同步 (REQUEST_SYNC / RESPONSE_SYNC)
 * - 跳转到资源管理器 (JUMP_TO_EXPLORER)
 */
export function useBroadcastSync(): void {
  const {
    selectedFile, setSelectedFile,
    editorContent, setEditorContent,
    fileCache, setFileCache,
    activeTab, setActiveTab,
    toastMsg, setToastMsg,
  } = useAppStore();

  const { syncTheme, currentThemeId, primaryColor, primaryColorTargets } = useHotTheme();

  // 稳定的 ref 引用 — 避免闭包过期
  const selectedFileRef = useRef(selectedFile);
  const editorContentRef = useRef(editorContent);
  const fileCacheRef = useRef(fileCache);
  const currentThemeIdRef = useRef(currentThemeId);
  const primaryColorRef = useRef(primaryColor);
  const primaryColorTargetsRef = useRef(primaryColorTargets);

  selectedFileRef.current = selectedFile;
  editorContentRef.current = editorContent;
  fileCacheRef.current = fileCache;
  currentThemeIdRef.current = currentThemeId;
  primaryColorRef.current = primaryColor;
  primaryColorTargetsRef.current = primaryColorTargets;

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const channel = new BroadcastChannel('soloforge-editor-sync-channel');

      const handleMessage = (event: MessageEvent) => {
        const msg = event.data;
        if (!msg) return;

        if (msg.type === 'REQUEST_SYNC') {
          channel.postMessage({
            type: 'RESPONSE_SYNC',
            file: selectedFileRef.current,
            content: editorContentRef.current,
            cache: fileCacheRef.current,
            color: primaryColorRef.current,
            themeId: currentThemeIdRef.current,
            targets: primaryColorTargetsRef.current
          });
        } else if (msg.type === 'RESPONSE_SYNC') {
          if (msg.file && msg.file !== selectedFileRef.current) {
            setSelectedFile(msg.file);
          }
          if (msg.content !== undefined && msg.content !== editorContentRef.current) {
            setEditorContent(msg.content);
          }
          if (msg.themeId || msg.color || msg.targets) {
            syncTheme(
              msg.themeId || currentThemeIdRef.current,
              msg.color || primaryColorRef.current,
              msg.targets || primaryColorTargetsRef.current
            );
          }
          if (msg.cache) {
            const sPrev = JSON.stringify(fileCacheRef.current);
            const sNext = JSON.stringify(msg.cache);
            if (sPrev !== sNext) {
              setFileCache(msg.cache);
              localStorage.setItem('soloforge_fileCache', sNext);
            }
          }
        } else if (msg.type === 'FILE_SELECT') {
          if (msg.file && msg.file !== selectedFileRef.current) {
            setSelectedFile(msg.file);
          }
          if (msg.content !== undefined && msg.content !== editorContentRef.current) {
            setEditorContent(msg.content);
          }
        } else if (msg.type === 'EDIT') {
          setFileCache(prev => {
            const currentVal = prev[msg.file];
            if (currentVal === msg.content) return prev;
            const updated = { ...prev, [msg.file]: msg.content };
            localStorage.setItem('soloforge_fileCache', JSON.stringify(updated));
            return updated;
          });
          if (msg.file === selectedFileRef.current && msg.content !== editorContentRef.current) {
            setEditorContent(msg.content);
          }
        } else if (msg.type === 'THEME_SELECT' || msg.type === 'THEME_SYNC') {
          if (msg.themeId || msg.color || msg.targets) {
            syncTheme(
              msg.themeId || currentThemeIdRef.current,
              msg.color || primaryColorRef.current,
              msg.targets || primaryColorTargetsRef.current
            );
          }
        } else if (msg.type === 'JUMP_TO_EXPLORER') {
          setActiveTab('explorer');
          if (msg.toast) {
            setToastMsg(msg.toast);
          }
        }
      };

      channel.addEventListener('message', handleMessage);

      if (window.location.search.includes('popout=editor')) {
        channel.postMessage({ type: 'REQUEST_SYNC' });
      }

      return () => {
        channel.removeEventListener('message', handleMessage);
        channel.close();
      };
    } catch (e) {
      console.warn('BroadcastChannel initialization warning:', e);
    }
  }, []); // 故意空依赖，仅在挂载时建立 channel
}
