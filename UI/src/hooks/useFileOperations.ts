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
  // ★ 只订阅 setter (引用稳定, 不触发 App 重渲染); 值字段在回调里用 getState() 读取
  //   原 useAppStore() 不带 selector 订阅整个 store, 导致任一字段变化都触发 App 重渲染
  const setSelectedFile = useAppStore(s => s.setSelectedFile);
  const setFileCache = useAppStore(s => s.setFileCache);
  const setEditorContent = useAppStore(s => s.setEditorContent);
  const setActiveTab = useAppStore(s => s.setActiveTab);
  const setShowHistory = useAppStore(s => s.setShowHistory);
  const setShowFloatingEditor = useAppStore(s => s.setShowFloatingEditor);
  const setActiveSettingsChat = useAppStore(s => s.setActiveSettingsChat);
  const setToastMsg = useAppStore(s => s.setToastMsg);

  const { addCustomFont, setSelectedFont } = useStaticTheme();

  // 防抖自动保存定时器
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // ★ FIX #18: BroadcastChannel 单例复用, 避免每次编辑都 new+close
  const syncChannelRef = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      syncChannelRef.current = new BroadcastChannel('soloforge-editor-sync-channel');
    } catch (e) {
      console.warn('[useFileOperations] BroadcastChannel not available', e);
    }
    return () => {
      syncChannelRef.current?.close();
      syncChannelRef.current = null;
    };
  }, []);

  // ★ FIX #15: 卸载时不仅清除定时器, 还要 flush 待保存的内容
  //   原代码只 clearTimeout, 最后 1000ms 防抖窗口内的编辑内容会丢失
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        // 同步 flush: 将待保存内容写入 localStorage + 广播
        const latestCache = useAppStore.getState().fileCache;
        const latestFile = useAppStore.getState().selectedFile;
        const latestContent = latestCache[latestFile] || '';
        if (typeof window !== 'undefined') {
          localStorage.setItem('soloforge_fileCache', JSON.stringify(latestCache));
          window.dispatchEvent(new CustomEvent('soloforge-file-saved'));
          try {
            syncChannelRef.current?.postMessage({
              type: 'EDIT',
              file: latestFile,
              content: latestContent,
            });
          } catch { /* channel 可能已关闭, 静默 */ }
        }
      }
    };
  }, []);

  // ★ selectedFile 变化时: 同步 editorContent + 持久化 (用 subscribe, 不触发 App 重渲染)
  useEffect(() => {
    const persist = (file: string) => {
      if (typeof window !== 'undefined') {
        localStorage.setItem('soloforge_selectedFile', file);
      }
    };
    persist(useAppStore.getState().selectedFile);
    return useAppStore.subscribe(
      (s) => s.selectedFile,
      (file) => {
        persist(file);
        const cache = useAppStore.getState().fileCache;
        const content = cache[file] !== undefined ? cache[file] : '';
        useAppStore.getState().setEditorContent(content);
      }
    );
  }, []);

  /**
   * 编辑器内容变更处理
   * 立即更新内存状态，防抖 1000ms 写入 localStorage + 广播
   */
  const handleEditorChange = useCallback((newContent: string) => {
    setEditorContent(newContent);
    const curFile = useAppStore.getState().selectedFile;
    const updatedCache = {
      ...useAppStore.getState().fileCache,
      [curFile]: newContent
    };
    setFileCache(updatedCache);

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = setTimeout(() => {
      if (typeof window !== 'undefined') {
        const latestCache = useAppStore.getState().fileCache;
        const latestFile = useAppStore.getState().selectedFile;
        const latestContent = latestCache[latestFile] || '';

        localStorage.setItem('soloforge_fileCache', JSON.stringify(latestCache));
        window.dispatchEvent(new CustomEvent('soloforge-file-saved'));

        // ★ FIX #18: 使用单例 channel, 避免反复 new+close
        try {
          syncChannelRef.current?.postMessage({
            type: 'EDIT',
            file: latestFile,
            content: latestContent,
          });
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
      const rawContent = useAppStore.getState().fileCache[file] || '';

      // ★ FIX #11: btoa() 对非 Latin-1 字符会抛 InvalidCharacterError
      //   fileCache 存的是编辑器文本, 不是二进制字体数据, btoa 编码后也不是有效字体
      //   修复策略:
      //   1. 如果 rawContent 已是 data: URL, 直接用
      //   2. 否则用文件路径作为相对 URL (addCustomFont 最终通过 @font-face url() 加载)
      //   3. 不再尝试 btoa 编码文本内容作为字体 data URL
      let fontUrl: string | undefined;
      if (rawContent.startsWith('data:')) {
        fontUrl = rawContent;
      } else {
        // 用文件路径作为 URL — @font-face 的 src: url() 会处理加载
        // 确保路径不以 / 开头 (相对路径)
        fontUrl = file.startsWith('/') ? file.slice(1) : file;
      }

      if (fontUrl) {
        addCustomFont(fontNameDisplay, fontUrl);
        setSelectedFont(fontNameDisplay);
        setToastMsg(`已自动从资源管理器加载本地字体「${fontNameDisplay}」并设为激活！`);
      } else {
        setToastMsg(`字体「${fontNameDisplay}」无法加载: 文件内容无效且路径不可用`);
      }
    }

    const content = useAppStore.getState().fileCache[file] !== undefined ? useAppStore.getState().fileCache[file] : '';
    if (typeof window !== 'undefined') {
      // ★ FIX #18: 使用单例 channel
      try {
        syncChannelRef.current?.postMessage({
          type: 'FILE_SELECT',
          file: file,
          content: content,
        });
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
