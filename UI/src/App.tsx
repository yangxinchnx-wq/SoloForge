import React, { useState, useEffect, useRef } from 'react';
import Header from './components/Header';
import ActivityBar from './components/ActivityBar';
import FileExplorer from './components/FileExplorer';
import GitPanel from './components/GitPanel';
import HistoryAndEditorPanel from './components/HistoryAndEditorPanel';
import SourceCodeEditor from './components/SourceCodeEditor';
import ChatPanel from './components/ChatPanel';
import PreviewPanel from './components/PreviewPanel';
import StatusBar from './components/StatusBar';
import ThemeModal from './components/ThemeModal';
import SettingsModal from './components/SettingsModal';
import StatsModal from './components/StatsModal';
import FloatingEditorWindow from './components/FloatingEditorWindow';
import AgentSettingsModal from './components/AgentSettingsModal';
import { SecondaryModel } from './types';
import { useTheme, THEME_PRESETS } from './context/ThemeContext';
import { MountTransition } from './components/MountTransition';
import { X } from 'lucide-react';

export default function App() {
  // Model Settings State
  const [mainModel, setMainModel] = useState('GPT-4o');
  const [secModels, setSecModels] = useState<SecondaryModel[]>([
    { id: 'DeepSeek-V3', name: 'DeepSeek-V3', weight: 5 },
    { id: 'Gemini-1.5-Pro', name: 'Gemini-1.5-Pro', weight: 5 }
  ]);
  const [mixedTasks, setMixedTasks] = useState(true);
  const [currentPermissionMode, setCurrentPermissionMode] = useState<'normal' | 'performance' | 'ultimate' | 'expert'>('normal');

  // Synchronize multi-model mixedTasks based on the active mode (only 'normal' mode needs it disabled)
  useEffect(() => {
    if (currentPermissionMode === 'normal') {
      setMixedTasks(false);
    }
  }, [currentPermissionMode]);

  // File explorer node state & text-editor content state
  const [selectedFile, setSelectedFile] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('soloforge_selectedFile') || 'BlogSystem/src/App.vue';
    }
    return 'BlogSystem/src/App.vue';
  });

  // Track modified code cache to keep user changes persistent during exploration
  const [fileCache, setFileCache] = useState<Record<string, string>>(() => {
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem('soloforge_fileCache');
        return saved ? JSON.parse(saved) : {};
      } catch (e) {
        return {};
      }
    }
    return {};
  });

  const [editorContent, setEditorContent] = useState(() => {
    const file = typeof window !== 'undefined' ? (localStorage.getItem('soloforge_selectedFile') || 'BlogSystem/src/App.vue') : 'BlogSystem/src/App.vue';
    let cache: Record<string, string> = {};
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem('soloforge_fileCache');
        if (saved) cache = JSON.parse(saved);
      } catch (e) {}
    }
    return cache[file] !== undefined ? cache[file] : '';
  });

  // Synchronous state adjustment when selectedFile changes to prevent intermediate mismatched frames
  const [prevSelectedFile, setPrevSelectedFile] = useState(selectedFile);
  if (selectedFile !== prevSelectedFile) {
    setPrevSelectedFile(selectedFile);
    const content = fileCache[selectedFile] !== undefined ? fileCache[selectedFile] : '';
    setEditorContent(content);
  }

  // Active Chats history state
  const [selectedChatId, setSelectedChatId] = useState('1');

  // Sidebar navigation toggled tab (explorer/search/git/plugin tabs)
  const [activeTab, setActiveTab] = useState('explorer');

  // Toast notifications state
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(true);
  const [showCodeEditor, setShowCodeEditor] = useState(true);

  // Interactive Theme Customization and Settings trigger states
  const [showThemeCustomizer, setShowThemeCustomizer] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showStatsModal, setShowStatsModal] = useState(false);
  const [showFloatingEditor, setShowFloatingEditor] = useState(false);
  const [activeSettingsChat, setActiveSettingsChat] = useState<{ id: string; title: string } | null>(null);

  const {
    primaryColor,
    primaryColorTargets,
    currentThemeId,
    activeTheme,
    setPrimaryColor,
    setPrimaryColorTargets,
    setCurrentThemeId,
    syncTheme,
    addCustomFont,
    setSelectedFont
  } = useTheme();

  // Unique stable state tracking references to avoid stale closures and infinite loop triggers
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

  // Ref for the debouncing auto-save timer
  const saveTimeoutRef = useRef<any>(null);

  // Clear timeout on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, []);

  // Interactive Resizing Panel States
  const [sidebarWidth, setSidebarWidth] = useState(250);
  const [previewWidth, setPreviewWidth] = useState(385);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const [isResizingPreview, setIsResizingPreview] = useState(false);
  const [dragStartSidebarWidth, setDragStartSidebarWidth] = useState(250);
  const [dragStartPreviewWidth, setDragStartPreviewWidth] = useState(385);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isResizingSidebar) {
        // Left offset for sidebar next to vertical narrow Activity bar (48px)
        const newWidth = e.clientX - 48;
        if (newWidth >= 160 && newWidth <= 600) {
          setSidebarWidth(newWidth);
        }
      } else if (isResizingPreview) {
        // Right offset for preview panel from screen edge
        const newWidth = window.innerWidth - e.clientX;
        if (newWidth >= 250 && newWidth <= 750) {
          setPreviewWidth(newWidth);
        }
      }
    };

    const handleMouseUp = () => {
      setIsResizingSidebar(false);
      setIsResizingPreview(false);
    };

    if (isResizingSidebar || isResizingPreview) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      // Disable pointer events on all iframes to prevent dragging freeze!
      const iframes = document.querySelectorAll('iframe');
      iframes.forEach(iframe => {
        iframe.style.pointerEvents = 'none';
      });
    } else {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';

      const iframes = document.querySelectorAll('iframe');
      iframes.forEach(iframe => {
        iframe.style.pointerEvents = 'auto';
      });
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizingSidebar, isResizingPreview]);

  // Check if we are in popout mode
  const isPopout = typeof window !== 'undefined' && window.location.search.includes('popout=editor');

  // Sync selected file persistence
  // ==========================================
  // 【后端对接提示 - 主会话状态持久化与文件加载】
  // 原先直接通过 localStorage 保存当前选中的文件路径并在本地进行匹配读取。
  // 1. 后端接口设计: GET /api/files/read?path=xxx
  // 2. 切换选定文件时，发起异步请求读取宿主端物理磁盘真实文件：
  //    fetch(`/api/files/read?path=${encodeURIComponent(selectedFile)}`)
  // 3. 将拉取到的真实字符串内容 set 至 editorContent 驱动视图
  // ==========================================
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('soloforge_selectedFile', selectedFile);
    }
  }, [selectedFile]);

  // Keep cache updated when user types in editor
  // ==========================================
  // 【后端对接提示 - 代码持久化同步与版本暂存】
  // 原通过内存 fileCache 与 localStorage 来进行本地草稿管理。
  // 后期对接真实文件系统或数据库持久化：
  // 1. 可以设计自动保存机制 (Auto-Save, 比如防抖 debounce 300ms 触发写盘操作)
  // 2. 接口设计: POST /api/files/save, 载荷: { path: selectedFile, content: newContent }
  // 3. 此时可在后端执行真正的物理磁盘写入操作
  // ==========================================
  const handleEditorChange = (newContent: string) => {
    // 立即更新内存中的编辑器状态和缓存，保证打字及界面无任何延迟且文件切换正常
    setEditorContent(newContent);
    const updatedCache = {
      ...fileCache,
      [selectedFile]: newContent
    };
    setFileCache(updatedCache);

    // 清理之前的自动保存定时器实现防抖
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    // 设置 1 秒（1000 毫秒）的防抖定时器
    saveTimeoutRef.current = setTimeout(() => {
      if (typeof window !== 'undefined') {
        const latestCache = fileCacheRef.current;
        const latestFile = selectedFileRef.current;
        const latestContent = latestCache[latestFile] || '';

        // 将编辑器内容存入 localStorage
        localStorage.setItem('soloforge_fileCache', JSON.stringify(latestCache));
        
        // 广播保存事件 (驱动状态栏等处的保存就绪状态)
        window.dispatchEvent(new CustomEvent('soloforge-file-saved'));

        // 广播同步事件
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
  };

  // Broadcast file switching
  const handleFileChange = (file: string) => {
    setSelectedFile(file);
    
    // Check if the switched file is a local font resource Clicked from File Explorer
    const isFont = file.toLowerCase().endsWith('.ttf') || 
                   file.toLowerCase().endsWith('.otf') || 
                   file.toLowerCase().endsWith('.woff') || 
                   file.toLowerCase().endsWith('.woff2');
                   
    if (isFont) {
      const filename = file.substring(file.lastIndexOf('/') + 1);
      const fontNameDisplay = filename.replace(/\.[^/.]+$/, "") + " (Local)";
      const rawContent = fileCacheRef.current[file] || '';
      
      // Seed base64 / dataUrl if not already a data uri
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
  };

  // Add event listener to support file switching from the breadcrumb navigation bar
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleCustomChangeFile = (e: Event) => {
      const customEvent = e as CustomEvent;
      if (customEvent.detail && customEvent.detail.file) {
        handleFileChange(customEvent.detail.file);
        setActiveTab('explorer'); // Make sure Explorer is visible!
        setShowHistory(false); // Close overlapping history list on explicit file switch!
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
  }, []);

  // Clear toast after a short period
  useEffect(() => {
    if (toastMsg) {
      const timer = setTimeout(() => {
        setToastMsg(null);
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [toastMsg]);

  // Synchronize popout window and main tab active sessions dynamically
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
  }, []);

  const handleNewFile = () => {
    const fileName = prompt('请输入新文件名:', 'index.html');
    if (fileName) {
      alert(`已成功在 workspace 中虚拟创建文件: ${fileName}`);
    }
  };

  if (isPopout) {
    return (
      <div className="flex flex-col h-screen w-screen bg-bg text-on-surface overflow-hidden select-none font-sans">
        {/* Dynamic Custom Top-Bar for Popout Window */}
        <div className="h-10 border-b border-[var(--color-primary)]/20 bg-surface px-4 flex items-center justify-between shrink-0 select-none">
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 rounded-full bg-amber-400 shrink-0" />
            <span className="text-[12px] font-bold text-[var(--color-primary)] tracking-wider uppercase">SoloForge IDE - 编程视图 (窗口模式)</span>
          </div>
          <div className="text-[10px] text-on-surface/40 font-mono flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-400 font-sans text-[9px] font-bold tracking-wide border border-emerald-500/25">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              双向工作区实时通信已建立
            </span>
          </div>
        </div>

        {/* Core Layout split pane */}
        <div className="flex flex-1 overflow-hidden relative">
          {/* File Explorer sidebar */}
          <div 
            className="h-full bg-surface flex flex-col shrink-0 overflow-hidden"
            style={{ 
              width: `${sidebarWidth}px`,
              transition: isResizingSidebar ? 'none' : 'width 250ms cubic-bezier(0.16, 1, 0.3, 1)'
            }}
          >
            <div className="flex-grow h-full w-full overflow-hidden" style={{ '--color-primary': primaryColorTargets.editorAndExplorer ? 'var(--color-main-primary)' : '#8c8c8c' } as React.CSSProperties}>
              <FileExplorer 
                selectedFile={selectedFile} 
                setSelectedFile={handleFileChange}
                onNewFile={handleNewFile}
              />
            </div>
          </div>

          {/* Drag Resizer for Sidebar */}
          <div
            onMouseDown={() => {
              setIsResizingSidebar(true);
              setDragStartSidebarWidth(sidebarWidth);
            }}
            className="group relative w-3 h-full cursor-col-resize shrink-0 z-35 select-none -mx-1.5 flex items-center justify-center transition-all bg-[var(--color-primary)]/5 hover:bg-[var(--color-primary)]/10"
            title="拖拽调整左侧栏宽度"
          >
            <div className={`absolute top-0 bottom-0 w-[1px] bg-[var(--color-primary)]/25 group-hover:bg-[var(--color-primary)]/80 group-hover:w-[3px] group-hover:shadow-[0_0_8px_var(--color-primary)] transition-all duration-150 ${isResizingSidebar ? 'bg-[var(--color-primary)] w-[3px] shadow-[0_0_8px_var(--color-primary)]' : ''}`} />
          </div>

          {/* Source Code Editor */}
          <div className="flex-1 h-full overflow-hidden bg-surface flex flex-col" style={{ '--color-primary': primaryColorTargets.editorAndExplorer ? 'var(--color-main-primary)' : '#8c8c8c' } as React.CSSProperties}>
            <SourceCodeEditor 
              selectedFile={selectedFile}
              editorContent={editorContent}
              setEditorContent={handleEditorChange}
              isPopoutView={true}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen w-screen bg-bg text-on-surface overflow-hidden select-none">
      {/* Top Controls Header Bar */}
      <div className="relative z-[60]" style={{ '--color-primary': primaryColorTargets.header ? 'var(--color-main-primary)' : activeTheme.primary } as React.CSSProperties}>
        <Header 
          mainModel={mainModel} 
          setMainModel={setMainModel} 
          secModels={secModels} 
          setSecModels={setSecModels}
          mixedTasks={mixedTasks}
          setMixedTasks={setMixedTasks}
          permissionMode={currentPermissionMode}
          sidebarWidth={activeTab === 'explorer' || activeTab === 'git' || showCodeEditor || showHistory ? sidebarWidth + 48 : 48}
          isResizingSidebar={isResizingSidebar}
          selectedFile={selectedFile}
          setSelectedFile={setSelectedFile}
        />
      </div>

      <div className="flex flex-1 overflow-hidden relative">
        {/* Column 1: Vertical Narrow Activity Bar */}
        <div style={{ '--color-primary': primaryColorTargets.activityBar ? 'var(--color-main-primary)' : '#8c8c8c' } as React.CSSProperties} className="h-full flex shrink-0">
          <ActivityBar 
            activeTab={activeTab} 
            setActiveTab={setActiveTab} 
            showHistory={showHistory}
            setShowHistory={setShowHistory}
            showCodeEditor={showCodeEditor}
            setShowCodeEditor={setShowCodeEditor}
            onOpenThemeCustomizer={() => setShowThemeCustomizer(true)}
            onOpenSettingsModal={() => setShowSettingsModal(true)}
            onOpenStatsModal={() => setShowStatsModal(true)}
          />
        </div>

        {/* Column 2: File Explorer & Source Code Editor stacked (If active) */}
        <div
          className="h-full bg-surface flex flex-col shrink-0 overflow-hidden select-none border-r border-[var(--color-primary)]/20"
          style={{
            width: (activeTab === 'explorer' || activeTab === 'git' || showCodeEditor) ? `${sidebarWidth}px` : '0px',
            opacity: (activeTab === 'explorer' || activeTab === 'git' || showCodeEditor) ? 1 : 0,
            pointerEvents: (activeTab === 'explorer' || activeTab === 'git' || showCodeEditor) ? 'auto' : 'none',
            transition: isResizingSidebar ? 'none' : 'width 250ms cubic-bezier(0.16, 1, 0.3, 1), opacity 200ms ease-out',
            '--color-primary': primaryColorTargets.editorAndExplorer ? 'var(--color-main-primary)' : '#8c8c8c'
          } as React.CSSProperties}
        >
          <div
            style={{
              width: isResizingSidebar ? `${dragStartSidebarWidth}px` : '100%',
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
              flexShrink: 0,
              overflow: 'hidden'
            }}
          >
            {/* Conditional Sub-panels */}
            {activeTab === 'explorer' ? (
              <div className="flex-1 flex flex-col overflow-hidden">
                <FileExplorer 
                  selectedFile={selectedFile} 
                  setSelectedFile={handleFileChange}
                  onNewFile={handleNewFile}
                  onClose={() => setActiveTab('')}
                  isFloatingEditorOpen={showFloatingEditor}
                />
              </div>
            ) : activeTab === 'git' ? (
              <div className="flex-grow flex flex-col overflow-hidden">
                <GitPanel onClose={() => setActiveTab('')} />
              </div>
            ) : null}

            {/* Source Code Editor (Bottom half or master panel, optional) */}
            {activeTab !== 'git' && showCodeEditor && (
              <div className={`${activeTab === 'explorer' ? 'h-[340px] border-t border-[var(--color-primary)]/50' : 'flex-1'} flex flex-col overflow-hidden bg-surface`}>
                <SourceCodeEditor 
                  selectedFile={selectedFile}
                  editorContent={editorContent}
                  setEditorContent={handleEditorChange}
                />
              </div>
            )}
          </div>
        </div>

        {/* Drag Resizer for Left Sidebar */}
        {(activeTab === 'explorer' || activeTab === 'git' || showCodeEditor) && (
          <div
            onMouseDown={() => {
              setIsResizingSidebar(true);
              setDragStartSidebarWidth(sidebarWidth);
            }}
            className="group relative w-3 h-full cursor-col-resize shrink-0 z-35 select-none -mx-1.5 flex items-center justify-center transition-all"
            title="拖拽调整左侧栏宽度"
          >
            <div className={`absolute top-0 bottom-0 w-[1px] bg-[var(--color-primary)]/25 group-hover:bg-[var(--color-primary)]/80 group-hover:w-[3px] group-hover:shadow-[0_0_8px_var(--color-primary)] transition-all duration-150 ${isResizingSidebar ? 'bg-[var(--color-primary)] w-[3px] shadow-[0_0_8px_var(--color-primary)]' : ''}`} />
          </div>
        )}

        {/* Column 3: History Dialogues List */}
        <div
          className="absolute left-[48px] top-0 bottom-0 z-40 flex flex-col overflow-hidden border-r border-[var(--color-primary)]/20 shadow-[4px_0_15px_rgba(0,0,0,0.22)]"
          style={{
            width: showHistory ? `${sidebarWidth}px` : '0px',
            opacity: showHistory ? 1 : 0,
            pointerEvents: showHistory ? 'auto' : 'none',
            transition: isResizingSidebar ? 'none' : 'width 250ms cubic-bezier(0.16, 1, 0.3, 1), opacity 200ms ease-out',
            '--color-primary': primaryColorTargets.editorAndExplorer ? 'var(--color-main-primary)' : '#8c8c8c'
          } as React.CSSProperties}
        >
          <div
            style={{
              width: isResizingSidebar ? `${dragStartSidebarWidth}px` : '100%',
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
              flexShrink: 0,
              overflow: 'hidden'
            }}
          >
            <HistoryAndEditorPanel 
              isResizing={isResizingSidebar}
              selectedFile={selectedFile}
              selectedChatId={selectedChatId}
              setSelectedChatId={setSelectedChatId}
              editorContent={editorContent}
              setEditorContent={handleEditorChange}
              onClose={() => setShowHistory(false)}
              width={sidebarWidth}
              parentPermissionMode={currentPermissionMode}
              onPermissionChange={setCurrentPermissionMode}
              isFloatingEditorOpen={showFloatingEditor}
            />
          </div>
        </div>

        {/* Drag Resizer for absolute History Panel */}
        {showHistory && (
          <div
            onMouseDown={() => {
              setIsResizingSidebar(true);
              setDragStartSidebarWidth(sidebarWidth);
            }}
            className="group absolute top-0 bottom-0 h-full w-3 cursor-col-resize select-none z-50 flex items-center justify-center"
            style={{ 
              left: 48 + sidebarWidth - 6,
              transition: isResizingSidebar ? 'none' : 'left 250ms cubic-bezier(0.16, 1, 0.3, 1)'
            }}
            title="拖拽调整历史面板宽度"
          >
            <div className={`absolute top-0 bottom-0 w-[1px] bg-[var(--color-primary)]/25 group-hover:bg-[var(--color-primary)]/80 group-hover:w-[3px] group-hover:shadow-[0_0_8px_var(--color-primary)] transition-all duration-150 ${isResizingSidebar ? 'bg-[var(--color-primary)] w-[3px] shadow-[0_0_8px_var(--color-primary)]' : ''}`} />
          </div>
        )}

        {/* Column 4: Main Chat Workspace Output Pane + Terminal Logs */}
        <div style={{ '--color-primary': primaryColorTargets.chatPanel ? 'var(--color-main-primary)' : '#8c8c8c' } as React.CSSProperties} className="flex-1 h-full min-w-0">
          <ChatPanel 
            permissionMode={currentPermissionMode} 
            setPermissionMode={setCurrentPermissionMode} 
            primaryColorTargets={primaryColorTargets}
            selectedChatId={selectedChatId}
            mainModel={mainModel}
            secModels={secModels}
            mixedTasks={mixedTasks}
            selectedFile={selectedFile}
            editorContent={editorContent}
          />
        </div>

        {/* Right Drag Resizer for Preview Panel */}
        <div
          onMouseDown={() => {
            setIsResizingPreview(true);
            setDragStartPreviewWidth(previewWidth);
          }}
          className="group relative w-3 h-full cursor-col-resize shrink-0 z-35 select-none -mx-1.5 flex items-center justify-center transition-all"
          title="拖拽调整右侧预览宽度"
        >
          <div className={`absolute top-0 bottom-0 w-[1px] bg-[var(--color-primary)]/25 group-hover:bg-[var(--color-primary)]/80 group-hover:w-[3px] group-hover:shadow-[0_0_8px_var(--color-primary)] transition-all duration-150 ${isResizingPreview ? 'bg-[var(--color-primary)] w-[3px] shadow-[0_0_8px_var(--color-primary)]' : ''}`} />
        </div>

        {/* Column 5: Right Column Interactive Preview Web Application */}
        <PreviewPanel 
          width={previewWidth} 
          isResizing={isResizingPreview} 
          dragStartWidth={dragStartPreviewWidth}
          selectedChatId={selectedChatId}
        />
      </div>

      {/* Micro Status Bar indicator at the very bottom */}
      <div 
        className="relative z-50"
        style={{ '--color-primary': primaryColorTargets.statusBar ? 'var(--color-main-primary)' : activeTheme.primary } as React.CSSProperties}
      >
        <StatusBar 
          currentThemeId={currentThemeId}
          setCurrentThemeId={setCurrentThemeId}
        />
      </div>

      {/* Theme Customizer modal pop-over */}
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

      {/* Geek Settings Modal (13 Core Modules) */}
      <MountTransition show={showSettingsModal} variant="fade">
        {showSettingsModal && (
          <SettingsModal
            onClose={() => setShowSettingsModal(false)}
            permissionMode={currentPermissionMode}
          />
        )}
      </MountTransition>

      {/* AI & Token Audit statistics popup */}
      <MountTransition show={showStatsModal} variant="fade-scale">
        {showStatsModal && (
          <StatsModal
            onClose={() => setShowStatsModal(false)}
          />
        )}
      </MountTransition>

      {/* Floating Draggable & Pinnable Code Editor Window */}
      <MountTransition show={showFloatingEditor} variant="fade-scale" duration={220}>
        {showFloatingEditor && (
          <FloatingEditorWindow
            selectedFile={selectedFile}
            editorContent={editorContent}
            setEditorContent={handleEditorChange}
            onClose={() => setShowFloatingEditor(false)}
          />
        )}
      </MountTransition>

      {/* Global Exclusive Agent Settings Customizer Overlay */}
      <MountTransition show={!!activeSettingsChat} variant="fade-scale">
        {activeSettingsChat && (
          <AgentSettingsModal
            chatId={activeSettingsChat.id}
            chatTitle={activeSettingsChat.title}
            onClose={() => setActiveSettingsChat(null)}
          />
        )}
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
    </div>
  );
}
