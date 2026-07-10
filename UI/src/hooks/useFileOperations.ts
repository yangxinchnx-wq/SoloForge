// ─────────────────────────────────────────────────────────────────
// useFileOperations — 文件操作 Hook
// Path: UI/src/hooks/useFileOperations.ts
// 从 App.tsx 拆分文件编辑/切换/字体加载/事件监听逻辑
// ─────────────────────────────────────────────────────────────────

import { useEffect, useRef, useCallback } from 'react';
import { useAppStore } from '../state/appStore';
import { useStaticTheme } from '../context/ThemeContext';

/**
 * 文件操作 Hook
 * 职责：
 * - 编辑器内容变更（防抖 1000ms 写入 localStorage + 广播）
 * - 文件切换（含字体文件自动加载）
 * - 监听全局自定义事件（soloforge-change-file / floating-editor / agent-settings / toast）
 *
 * @returns handleEditorChange / handleFileChange / handleNewFile
 */
export function useFileOperations() {
  const {
    selectedFile, setSelectedFile,
    fileCache, setFileCache,
    editorContent, setEditorContent,
    setActiveTab, setShowHistory,
    setShowFloatingEditor,
    setActiveSettingsChat,
    setToastMsg,
  } = useAppStore();

  const { addCustomFont, setSelectedFont } = useStaticTheme();

  // 稳定 ref — 避免闭包过期
  const selectedFileRef = useRef(selectedFile);
  const fileCacheRef = useRef(fileCache);

  selectedFileRef.current = selectedFile;
  fileCacheRef.current = fileCache;

  // 防抖自动保存定时器
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 卸载时清理定时器
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, []);

  // selectedFile 切换时同步 editorContent
  const prevSelectedFileRef = useRef(selectedFile);
  if (selectedFile !== prevSelectedFileRef.current) {
    prevSelectedFileRef.current = selectedFile;
    const content = useAppStore.getState().fileCache[selectedFile] !== undefined
      ? useAppStore.getState().fileCache[selectedFile]
      : '';
    setEditorContent(content);
  }

  // 持久化 selectedFile
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('soloforge_selectedFile', selectedFile);
    }
  }, [selectedFile]);

  /**
   * 编辑器内容变更处理
   * 立即更新内存状态，防抖 1000ms 写入 localStorage + 广播
   */
  const handleEditorChange = useCallback((newContent: string) => {
    setEditorContent(newContent);
    const updatedCache = {
      ...fileCacheRef.current,
      [selectedFileRef.current]: newContent
    };
    setFileCache(updatedCache);

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = setTimeout(() => {
      if (typeof window !== 'undefined') {
        const latestCache = fileCacheRef.current;
        const latestFile = selectedFileRef.current;
        const latestContent = latestCache[latestFile] || '';

        localStorage.setItem('soloforge_fileCache', JSON.stringify(latestCache));
        window.dispatchEvent(new CustomEvent('soloforge-file-saved'));

        try {
          const channel = new BroadcastChannel('soloforge-editor-sync-channel');
          channel.postMessage({
            type: 'EDIT',
            file: latestFile,
            content: latestContent
          });
          channel.close();
        } catch (e) {
          console.warn(e);
        }
      }
    }, 1000);
  }, [setEditorContent, setFileCache]);

  /**
   * 文件切换处理
   * 含字体文件 (.ttf/.otf/.woff/.woff2) 自动加载逻辑
   */
  const handleFileChange = useCallback((file: string) => {
    setSelectedFile(file);

    const isFont = file.toLowerCase().endsWith('.ttf') ||
                   file.toLowerCase().endsWith('.otf') ||
                   file.toLowerCase().endsWith('.woff') ||
                   file.toLowerCase().endsWith('.woff2');

    if (isFont) {
      const filename = file.substring(file.lastIndexOf('/') + 1);
      const fontNameDisplay = filename.replace(/\.[^/.]+$/, "") + " (Local)";
      const rawContent = fileCacheRef.current[file] || '';

      const fontUrl = rawContent.startsWith('data:')
        ? rawContent
        : `data:font/woff2;base64,${btoa(rawContent || 'mock-binary-font-package-data')}`;

      addCustomFont(fontNameDisplay, fontUrl);
      setSelectedFont(fontNameDisplay);
      setToastMsg(`已自动从资源管理器加载本地字体「${fontNameDisplay}」并设为激活！`);
    }

    const content = fileCacheRef.current[file] !== undefined ? fileCacheRef.current[file] : '';
    if (typeof window !== 'undefined') {
      try {
        const channel = new BroadcastChannel('soloforge-editor-sync-channel');
        channel.postMessage({
          type: 'FILE_SELECT',
          file: file,
          content: content
        });
        channel.close();
      } catch (e) {
        console.warn(e);
      }
    }
  }, [setSelectedFile, addCustomFont, setSelectedFont, setToastMsg]);

  /**
   * 新建文件（虚拟创建）
   */
  const handleNewFile = useCallback(() => {
    const fileName = prompt('请输入新文件名:', 'index.html');
    if (fileName) {
      alert(`已成功在 workspace 中虚拟创建文件: ${fileName}`);
    }
  }, []);

  // 全局自定义事件监听
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleCustomChangeFile = (e: Event) => {
      const customEvent = e as CustomEvent;
      if (customEvent.detail && customEvent.detail.file) {
        handleFileChange(customEvent.detail.file);
        setActiveTab('explorer');
        setShowHistory(false);
      }
    };
    const handleOpenFloatingEditor = () => {
      setShowFloatingEditor(true);
    };
    const handleOpenAgentSettings = (e: Event) => {
      const customEvent = e as CustomEvent;
      if (customEvent.detail && customEvent.detail.id) {
        setActiveSettingsChat({
          id: customEvent.detail.id,
          title: customEvent.detail.title || ''
        });
      }
    };
    const handleGlobalToast = (e: Event) => {
      const customEvent = e as CustomEvent;
      if (customEvent.detail && customEvent.detail.message) {
        setToastMsg(customEvent.detail.message);
      }
    };

    window.addEventListener('soloforge-change-file', handleCustomChangeFile);
    window.addEventListener('soloforge-open-floating-editor', handleOpenFloatingEditor);
    window.addEventListener('soloforge-open-agent-settings', handleOpenAgentSettings);
    window.addEventListener('soloforge-toast', handleGlobalToast);

    return () => {
      window.removeEventListener('soloforge-change-file', handleCustomChangeFile);
      window.removeEventListener('soloforge-open-floating-editor', handleOpenFloatingEditor);
      window.removeEventListener('soloforge-open-agent-settings', handleOpenAgentSettings);
      window.removeEventListener('soloforge-toast', handleGlobalToast);
    };
  }, [handleFileChange, setActiveTab, setShowHistory, setShowFloatingEditor, setActiveSettingsChat, setToastMsg]);

  return {
    handleEditorChange,
    handleFileChange,
    handleNewFile,
  };
}
