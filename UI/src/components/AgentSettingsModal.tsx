import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { MountTransition } from './MountTransition';
import {
  Bot, X, ShieldCheck, Hammer, Database, Shield,
  SlidersHorizontal, ChevronDown, Flame, Brain,
  Rocket, Workflow, FileText, Save, FolderOpen,
  ZoomIn, ZoomOut, RefreshCw, Cpu
} from '../utils/icons';
import { useHotTheme } from '../context/ThemeContext';
// 2026-07-03 阶段3.1.A: ChatSettingsItem + getSettingsSummary 复用 types/chat.ts (与 ChatPanel 共享)
import type { ChatSettingsItem } from '../types/chat';
import { getSettingsSummary } from '../types/chat';
// 2026-07-06: configs 从 useChatStore 读取 (后端持久化), 不再走 localStorage
import { useChatStore } from '../state/useChatStore';
// 重新导出保持外部 import 兼容 (老代码若有 from './AgentSettingsModal' 拿 ChatSettingsItem)
export type { ChatSettingsItem } from '../types/chat';

interface AgentSettingsModalProps {
  chatId: string;
  chatTitle: string;
  onClose: () => void;
}

const pMapPlaceholder: Record<string, string> = {
  professional: "专业",
  sarcastic: "毒舌",
  zen: "禅意",
  geek: "极客"
};

export default function AgentSettingsModal({ chatId, chatTitle, onClose }: AgentSettingsModalProps) {
  const { activeTheme } = useHotTheme();

  // Load configs — 从 useChatStore 读取 (后端持久化)
  const storeConfigs = useChatStore(s => s.configs);
  const setStoreConfigs = useChatStore(s => s.setConfigs);

  // Get active settings for target chatId
  const activeSettings = useMemo(() => {
    const defaultSettings: ChatSettingsItem = {
      enabledSkills: ['custom_rules'],
      contextSize: 32000,
      personality: 'professional',
      tone: 'detailed',
      emojiEnabled: true,
      emojiType: 'mixed',
      agentId: 'code_agent'
    };
    return storeConfigs[chatId] || defaultSettings;
  }, [storeConfigs, chatId]);

  // 改变设置时同步到 store (store 模块级 subscribe 会自动防抖推到后端)
  const handleUpdateSettings = (updates: Partial<ChatSettingsItem>) => {
    setStoreConfigs(prev => ({
      ...prev,
      [chatId]: {
        ...activeSettings,
        ...updates
      }
    }));
    // Notify other components (e.g. ChatPanel)
    window.dispatchEvent(new CustomEvent('soloforge-chat-configs-updated'));
  };

  // Phase 4: 从 Java 服务拉取 Agent 列表 (用于 Agent 角色选择)
  const [agentOptions, setAgentOptions] = useState<Array<{ id: string; name: string; avatar?: string; role: string; strategy: string }>>([]);
  const [agentLoading, setAgentLoading] = useState(false);
  // agent profile 编辑 (名称 + 头像)
  const [editingAvatar, setEditingAvatar] = useState('');
  const [editingName, setEditingName] = useState('');
  const [isSavingProfile, setIsSavingProfile] = useState(false);

  const fetchAgentOptions = useCallback(async () => {
    setAgentLoading(true);
    try {
      const res = await fetch('/api/java-agent/api/agents');
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data)) {
        setAgentOptions(data);
        // 同步当前选中 agent 的 name/avatar 到编辑框
        const current = data.find((a: any) => a.id === activeSettings.agentId);
        if (current) {
          setEditingName(current.name || '');
          setEditingAvatar(current.avatar || '');
        }
      }
    } catch {
      // Java 服务未启动时静默失败, 保留默认 code_agent
    } finally {
      setAgentLoading(false);
    }
  }, [activeSettings.agentId]);

  // 切换 agent 时同步编辑框
  useEffect(() => {
    const current = agentOptions.find(a => a.id === activeSettings.agentId);
    if (current) {
      setEditingName(current.name || '');
      setEditingAvatar(current.avatar || '');
    }
  }, [activeSettings.agentId, agentOptions]);

  const saveAgentProfile = async () => {
    const agentId = activeSettings.agentId || 'code_agent';
    setIsSavingProfile(true);
    try {
      const res = await fetch(`/api/java-agent/api/agents/${agentId}/profile`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editingName, avatar: editingAvatar }),
      });
      if (res.ok) {
        // 更新本地 agentOptions
        setAgentOptions(prev => prev.map(a => a.id === agentId ? { ...a, name: editingName, avatar: editingAvatar } : a));
      }
    } catch {
      // 静默失败
    } finally {
      setIsSavingProfile(false);
    }
  };

  useEffect(() => {
    fetchAgentOptions();
  }, [fetchAgentOptions]);

  const [customRules, setCustomRules] = useState('');
  const [isSavingRules, setIsSavingRules] = useState(false);

  const [selectedSkillToEdit, setSelectedSkillToEdit] = useState<string | null>(null);
  const [skillRulesContent, setSkillRulesContent] = useState('');
  const [isSavingSkillRules, setIsSavingSkillRules] = useState(false);

  const getRulesFileName = (skillId: string) => {
    if (skillId === 'custom_rules') return 'custom_rules.md';
    if (skillId === 'frontend_expert') return 'frontend_rules.md';
    if (skillId === 'db_manager') return 'db_rules.md';
    if (skillId === 'security_warden') return 'security_rules.md';
    if (skillId === 'hashline_auditor') return 'hashline_rules.md';
    if (skillId === 'extreme_mode') return 'extreme_rules.md';
    return 'custom_rules.md';
  };

  const getSkillLabel = (skillId: string) => {
    if (skillId === 'custom_rules') return '自定义规范 (.md)';
    if (skillId === 'frontend_expert') return '前端视觉专家';
    if (skillId === 'db_manager') return '数据库架构师';
    if (skillId === 'security_warden') return '安全防御卫士';
    if (skillId === 'hashline_auditor') return '行哈希速变器';
    if (skillId === 'extreme_mode') return '极致模式';
    return skillId;
  };

  const syncFileToExplorer = (fileName: string, content: string) => {
    if (typeof window === 'undefined') return;

    const dbPath = `BlogSystem/${fileName}`;
    
    // 1. Sync to file Cache
    try {
      const savedCache = localStorage.getItem('soloforge_fileCache');
      const cache = savedCache ? JSON.parse(savedCache) : {};
      cache[dbPath] = content;
      localStorage.setItem('soloforge_fileCache', JSON.stringify(cache));
      // Notify components like SourceCodeEditor of cache save
      window.dispatchEvent(new CustomEvent('soloforge-file-saved'));
    } catch (e) {
      console.error(e);
    }

    // 2. Insert into explorer tree if absent (with nested folder support)
    try {
      const savedTree = localStorage.getItem('soloforge_fileTree');
      if (savedTree) {
        const tree = JSON.parse(savedTree);
        if (tree && tree.children) {
          let isTreeUpdated = false;
          
          if (fileName.includes('/')) {
            const parts = fileName.split('/');
            const folderName = parts[0];
            const realFileName = parts[1];
            
            let folder = tree.children.find((c: any) => c.name === folderName && c.type === 'folder');
            if (!folder) {
              folder = {
                name: folderName,
                type: 'folder',
                path: `BlogSystem/${folderName}`,
                children: []
              };
              tree.children.push(folder);
              isTreeUpdated = true;
            }
            
            const fileExists = folder.children.some((c: any) => c.name === realFileName);
            if (!fileExists) {
              folder.children.push({
                name: realFileName,
                type: 'file',
                path: dbPath
              });
              isTreeUpdated = true;
            }
          } else {
            const fileExists = tree.children.some((c: any) => c.name === fileName);
            if (!fileExists) {
              tree.children.push({
                name: fileName,
                type: 'file',
                path: dbPath
              });
              isTreeUpdated = true;
            }
          }
          
          if (isTreeUpdated) {
            localStorage.setItem('soloforge_fileTree', JSON.stringify(tree));
            
            // Broadcast via sync channel
            const channel = new BroadcastChannel('soloforge-editor-sync-channel');
            channel.postMessage({
              type: 'TREE_UPDATE',
              tree: tree
            });
            channel.close();
          }
        }
      }
    } catch (e) {
      console.error(e);
    }
  };

  const fetchSkillRules = async (skillId: string) => {
    try {
      const res = await fetch(`/api/custom-rules?skill=${skillId}`);
      const data = await res.json();
      if (data.success) {
        setSkillRulesContent(data.content);
        // Sync to explorer cache
        syncFileToExplorer(data.fileName, data.content);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleSaveSkillRules = async (skillId: string, content: string) => {
    setSkillRulesContent(content);
    setIsSavingSkillRules(true);
    try {
      const res = await fetch('/api/custom-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, skill: skillId })
      });
      const data = await res.json();
      if (data.success) {
        // Sync to explorer cache
        syncFileToExplorer(data.fileName, content);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsSavingSkillRules(false);
    }
  };

  useEffect(() => {
    if (selectedSkillToEdit) {
      fetchSkillRules(selectedSkillToEdit);
    }
  }, [selectedSkillToEdit]);

  useEffect(() => {
    // Fetch custom rules when modal loads
    fetch('/api/custom-rules')
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          setCustomRules(data.content);
        }
      })
      .catch(err => console.error(err));
  }, []);

  const handleSaveRules = async (newVal: string) => {
    setCustomRules(newVal);
    setIsSavingRules(true);
    try {
      await fetch('/api/custom-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: newVal })
      });
    } catch (err) {
      console.error(err);
    } finally {
      setIsSavingRules(false);
    }
  };

  // Dragging states
  const [size, setSize] = useState({ width: 380, height: 460 });
  const [position, setPosition] = useState({ x: 120, y: 80 });
  const [subSize, setSubSize] = useState({ width: 340, height: 460 });

  useEffect(() => {
    setSubSize(prev => ({ ...prev, height: size.height }));
  }, [size.height]);

  // Customized Zoom/Scale effect state
  const [scaleFactor, setScaleFactor] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('soloforge_agent_scale');
      return saved ? Number(saved) : 1.0;
    }
    return 1.0;
  });

  const handleScaleChange = (val: number) => {
    setScaleFactor(val);
    if (typeof window !== 'undefined') {
      localStorage.setItem('soloforge_agent_scale', String(val));
    }
  };

  // Sub-panel customizable zoom state
  const [subScaleFactor, setSubScaleFactor] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('soloforge_sub_agent_scale');
      return saved ? Number(saved) : 1.00;
    }
    return 1.00;
  });

  const handleSubScaleChange = (val: number) => {
    setSubScaleFactor(val);
    if (typeof window !== 'undefined') {
      localStorage.setItem('soloforge_sub_agent_scale', String(val));
    }
  };

  // Sub-panel relative coordinates (offset relative to top-left of main settings panel list)
  const [subRelativePos, setSubRelativePos] = useState({ x: 392, y: 0 });

  const subPanelX = useMemo(() => {
    if (typeof window === 'undefined') return position.x + size.width + 12;
    const rightCoord = position.x + size.width + 352;
    if (rightCoord > window.innerWidth) {
      // Show on the left
      return Math.max(8, position.x - 350);
    }
    return position.x + size.width + 12;
  }, [position.x, size.width]);

  // Adjust relative position of detailed config box on first load
  useEffect(() => {
    if (selectedSkillToEdit) {
      if (typeof window !== 'undefined') {
        const isLeft = (position.x + size.width + 352) > window.innerWidth;
        const defaultRelX = isLeft ? -352 : (size.width + 12);
        setSubRelativePos({ x: defaultRelX, y: 0 });
      }
    }
  }, [selectedSkillToEdit]);

  // Absolute coordinate calculation on viewport matrix
  const subPanelAbsolute = useMemo(() => {
    return {
      x: position.x + subRelativePos.x,
      y: position.y + subRelativePos.y
    };
  }, [position, subRelativePos]);

  // Handle detailed config card mouse drag movement
  const handleSubMouseDown = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const isInteractive = target.closest('button, input, textarea, select, [role="button"], a') !== null;
    const isScrollable = target.closest('.overflow-x-auto, .overflow-y-auto') !== null;

    if (isInteractive || isScrollable) {
      return;
    }

    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const startRelX = subRelativePos.x;
    const startRelY = subRelativePos.y;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;

      setSubRelativePos({
        x: startRelX + deltaX,
        y: startRelY + deltaY
      });
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  // Center window on mount
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const initX = Math.max(20, (window.innerWidth - 380) / 2);
      const initY = Math.max(25, (window.innerHeight - 460) / 2);
      setPosition({ x: initX, y: initY });
    }
  }, []);

  const handleMouseDown = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const isInteractive = target.closest('button, input, textarea, select, [role="button"], a') !== null;
    const isScrollable = target.closest('.overflow-x-auto, .overflow-y-auto') !== null;

    if (isInteractive || isScrollable) {
      return;
    }

    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const startPosX = position.x;
    const startPosY = position.y;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;
      
      const nextX = Math.max(0, Math.min(window.innerWidth - size.width, startPosX + deltaX));
      const nextY = Math.max(0, Math.min(window.innerHeight - size.height, startPosY + deltaY));
      
      setPosition({ x: nextX, y: nextY });
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  type Corner = 'tl' | 'tr' | 'bl' | 'br';

  const handleResizeStart = (corner: Corner, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const startX = e.clientX;
    const startY = e.clientY;
    const startWidth = size.width;
    const startHeight = size.height;
    const startPosX = position.x;
    const startPosY = position.y;

    const minWidth = 280;
    const minHeight = 320;
    const maxWidth = 1000;
    const maxHeight = 800;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;

      let nextWidth = startWidth;
      let nextHeight = startHeight;
      let nextX = startPosX;
      let nextY = startPosY;

      if (corner === 'br') {
        nextWidth = Math.max(minWidth, Math.min(maxWidth, startWidth + deltaX));
        nextHeight = Math.max(minHeight, Math.min(maxHeight, startHeight + deltaY));
      } else if (corner === 'bl') {
        const potentialWidth = startWidth - deltaX;
        nextWidth = Math.max(minWidth, Math.min(maxWidth, potentialWidth));
        nextHeight = Math.max(minHeight, Math.min(maxHeight, startHeight + deltaY));
        if (potentialWidth >= minWidth && potentialWidth <= maxWidth) {
          nextX = startPosX + deltaX;
        }
      } else if (corner === 'tr') {
        nextWidth = Math.max(minWidth, Math.min(maxWidth, startWidth + deltaX));
        const potentialHeight = startHeight - deltaY;
        nextHeight = Math.max(minHeight, Math.min(maxHeight, potentialHeight));
        if (potentialHeight >= minHeight && potentialHeight <= maxHeight) {
          nextY = startPosY + deltaY;
        }
      } else if (corner === 'tl') {
        const potentialWidth = startWidth - deltaX;
        nextWidth = Math.max(minWidth, Math.min(maxWidth, potentialWidth));
        const potentialHeight = startHeight - deltaY;
        nextHeight = Math.max(minHeight, Math.min(maxHeight, potentialHeight));
        if (potentialWidth >= minWidth && potentialWidth <= maxWidth) {
          nextX = startPosX + deltaX;
        }
        if (potentialHeight >= minHeight && potentialHeight <= maxHeight) {
          nextY = startPosY + deltaY;
        }
      }

      setSize({ width: nextWidth, height: nextHeight });
      setPosition({ x: nextX, y: nextY });
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  const handleSubResizeStart = (corner: Corner, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const startX = e.clientX;
    const startY = e.clientY;
    const startWidth = subSize.width;
    const startHeight = subSize.height;
    const startRelX = subRelativePos.x;
    const startRelY = subRelativePos.y;

    const minWidth = 280;
    const minHeight = 320;
    const maxWidth = 800;
    const maxHeight = 800;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;

      let nextWidth = startWidth;
      let nextHeight = startHeight;
      let nextRelX = startRelX;
      let nextRelY = startRelY;

      if (corner === 'br') {
        nextWidth = Math.max(minWidth, Math.min(maxWidth, startWidth + deltaX));
        nextHeight = Math.max(minHeight, Math.min(maxHeight, startHeight + deltaY));
      } else if (corner === 'bl') {
        const potentialWidth = startWidth - deltaX;
        nextWidth = Math.max(minWidth, Math.min(maxWidth, potentialWidth));
        nextHeight = Math.max(minHeight, Math.min(maxHeight, startHeight + deltaY));
        if (potentialWidth >= minWidth && potentialWidth <= maxWidth) {
          nextRelX = startRelX + deltaX;
        }
      } else if (corner === 'tr') {
        nextWidth = Math.max(minWidth, Math.min(maxWidth, startWidth + deltaX));
        const potentialHeight = startHeight - deltaY;
        nextHeight = Math.max(minHeight, Math.min(maxHeight, potentialHeight));
        if (potentialHeight >= minHeight && potentialHeight <= maxHeight) {
          nextRelY = startRelY + deltaY;
        }
      } else if (corner === 'tl') {
        const potentialWidth = startWidth - deltaX;
        nextWidth = Math.max(minWidth, Math.min(maxWidth, potentialWidth));
        const potentialHeight = startHeight - deltaY;
        nextHeight = Math.max(minHeight, Math.min(maxHeight, potentialHeight));
        if (potentialWidth >= minWidth && potentialWidth <= maxWidth) {
          nextRelX = startRelX + deltaX;
        }
        if (potentialHeight >= minHeight && potentialHeight <= maxHeight) {
          nextRelY = startRelY + deltaY;
        }
      }

      setSubSize({ width: nextWidth, height: nextHeight });
      setSubRelativePos({ x: nextRelX, y: nextRelY });
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 pointer-events-none z-[9999] text-on-surface font-sans select-none overflow-hidden animate-fadeIn">
      {/* Inject a non-invasive custom CSS tag to guarantee absolute zero scrollbars inside are visible and standard cursors override any hands */}
      <style>{`
        .no-scrollbar-now::-webkit-scrollbar,
        .no-scrollbar-now *::-webkit-scrollbar,
        #root::-webkit-scrollbar {
          display: none !important;
          width: 0 !important;
          height: 0 !important;
        }
        .no-scrollbar-now,
        .no-scrollbar-now *,
        #root * {
          scrollbar-width: none !important;
          -ms-overflow-style: none !important;
        }
        /* Explicitly override all cursor pointers to standard default cursors, disabling hand pointers completely inside settings panel, EXCEPT for resize handles */
        .pointer-events-auto:not(.resize-handle):not(.resize-handle-alt):not(.cursor-nwse-resize):not(.cursor-nesw-resize),
        .pointer-events-auto select,
        .pointer-events-auto button,
        .pointer-events-auto input,
        .pointer-events-auto textarea,
        .pointer-events-auto svg,
        .pointer-events-auto div:not(.resize-handle):not(.resize-handle-alt):not(.cursor-nwse-resize):not(.cursor-nesw-resize),
        .pointer-events-auto span:not(.resize-handle):not(.resize-handle-alt),
        .pointer-events-auto a {
          cursor: default !important;
        }
        /* Permit native diagonal resize cursors on corner handles */
        .pointer-events-auto .resize-handle,
        .pointer-events-auto .cursor-nwse-resize {
          cursor: nwse-resize !important;
        }
        .pointer-events-auto .resize-handle-alt,
        .pointer-events-auto .cursor-nesw-resize {
          cursor: nesw-resize !important;
        }
      `}</style>
      <div 
        style={{
          position: 'absolute',
          left: `${position.x}px`,
          top: `${position.y}px`,
          width: `${size.width}px`,
          height: `${size.height}px`,
          backgroundColor: activeTheme.surface,
          borderColor: activeTheme.outline,
        }}
        className="sf-anim sf-anim-fade-scale pointer-events-auto border rounded-2xl shadow-[0_16px_50px_rgba(0,0,0,0.85)] overflow-hidden flex flex-col cursor-default relative backdrop-blur-md bg-opacity-95"
        onMouseDown={handleMouseDown}
      >

        {/* Modal Header */}
        <div className="flex items-center gap-3 p-4 border-b border-outline/35 shrink-0">
          <div className="p-1.5 rounded-lg bg-primary/15 text-primary shrink-0">
            <Bot className="w-4 h-4 text-primary" />
          </div>
          <div className="min-w-0">
            <h4 className="text-xs font-bold text-on-surface truncate flex items-center gap-2">
              <span>专属助理配置</span>
              <span className="text-[10px] bg-primary/10 px-1.5 py-0.2 rounded font-normal text-primary">ID: {chatId.slice(-4)}</span>
            </h4>
            <p className="text-[10px] text-on-surface/40 mt-0.5 truncate font-medium">配置：{chatTitle}</p>
          </div>
          <button 
            onClick={onClose} 
            className="p-1 hover:bg-surface-bright rounded text-on-surface/30 hover:text-white shrink-0 ml-auto cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scrollable Form Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
          {/* Phase 4: 助理角色选择 (Java Spring AI AgentOrchestrator 路由) */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[10px] text-primary/80 font-bold uppercase tracking-wider block font-mono flex items-center gap-1">
                <Cpu className="w-3 h-3" />
                0. 助理角色 (Java 编排)
              </span>
              <button
                type="button"
                onClick={fetchAgentOptions}
                className="text-[9px] font-mono opacity-50 hover:opacity-100 flex items-center gap-1"
                title="刷新助理列表"
              >
                <RefreshCw className={`w-2.5 h-2.5 ${agentLoading ? 'animate-spin' : ''}`} />
                刷新
              </button>
            </div>
            <select
              value={activeSettings.agentId || 'code_agent'}
              onChange={(e) => handleUpdateSettings({ agentId: e.target.value })}
              className="w-full text-[10px] font-semibold bg-bg border border-outline/40 hover:border-primary/50 text-on-surface rounded-lg p-1.5 cursor-pointer outline-none"
            >
              <option value="code_agent">代码开发 (默认)</option>
              {agentOptions.map(ag => (
                <option key={ag.id} value={ag.id}>
                  {ag.avatar ? ag.avatar + ' ' : ''}{ag.name}
                </option>
              ))}
            </select>
            {agentOptions.length === 0 && !agentLoading && (
              <p className="text-[9px] text-on-surface/30 mt-1 font-mono">
                · Java 服务未启动, 使用默认 code_agent (8770 离线)
              </p>
            )}
            {/* 助理名称 + 头像编辑 (Java 服务在线时可用) */}
            {agentOptions.length > 0 && (
              <div className="mt-2 p-2 rounded-lg bg-surface-bright/50 border border-outline/20 space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <span className="text-[9px] text-on-surface/50 font-mono shrink-0 w-8">名称</span>
                  <input
                    type="text"
                    value={editingName}
                    onChange={(e) => setEditingName(e.target.value)}
                    placeholder="代码工程师"
                    className="flex-1 text-[10px] bg-bg border border-outline/30 focus:border-primary/50 rounded px-1.5 py-1 outline-none"
                  />
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[9px] text-on-surface/50 font-mono shrink-0 w-8">头像</span>
                  <input
                    type="text"
                    value={editingAvatar}
                    onChange={(e) => setEditingAvatar(e.target.value)}
                    placeholder="💻 或 /avatars/code.png"
                    className="flex-1 text-[10px] bg-bg border border-outline/30 focus:border-primary/50 rounded px-1.5 py-1 outline-none"
                  />
                  {editingAvatar && (
                    editingAvatar.startsWith('http') || editingAvatar.startsWith('/') || editingAvatar.startsWith('data:')
                      ? <img src={editingAvatar} alt="" className="w-5 h-5 rounded-full object-cover shrink-0" />
                      : <span className="text-base leading-none shrink-0">{editingAvatar}</span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={saveAgentProfile}
                  disabled={isSavingProfile || !editingName.trim()}
                  className="text-[9px] font-mono px-2 py-0.5 rounded bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {isSavingProfile ? '保存中...' : '保存'}
                </button>
              </div>
            )}
          </div>

          {/* Skills Module */}
          <div>
            <span className="text-[10px] text-primary/80 font-bold uppercase tracking-wider block mb-2 font-mono">1. Skills 模组配置 ({activeSettings.enabledSkills.length})</span>
            <div className="grid grid-cols-2 gap-1.5">
              {[
                { id: 'custom_rules', label: '自定义规范 (.md)', icon: FileText },
                { id: 'frontend_expert', label: '前端视觉专家', icon: Hammer },
                { id: 'db_manager', label: '数据库架构师', icon: Database },
                { id: 'security_warden', label: '安全防御卫士', icon: Shield },
                { id: 'hashline_auditor', label: '行哈希速变器', icon: SlidersHorizontal },
                { id: 'extreme_mode', label: '极致模式', icon: Rocket },
              ].map(sk => {
                const isEnabled = activeSettings.enabledSkills.includes(sk.id);
                const isEditing = selectedSkillToEdit === sk.id;
                return (
                  <button
                    key={sk.id}
                    onClick={() => {
                      const newSkills = isEnabled
                        ? activeSettings.enabledSkills.filter(id => id !== sk.id)
                        : [...activeSettings.enabledSkills, sk.id];
                      handleUpdateSettings({ enabledSkills: newSkills });
                      setSelectedSkillToEdit(sk.id);
                    }}
                    className={`flex items-center justify-between gap-1.5 p-1.5 rounded-lg border text-left cursor-pointer transition-all ${
                      isEnabled 
                        ? 'bg-primary/15 border-primary/30 text-primary font-bold shadow-sm' 
                        : 'bg-surface-bright border-outline/30 text-on-surface/65 hover:text-on-surface hover:bg-bg/60'
                    } ${isEditing ? 'ring-1 ring-primary/80 border-primary/60' : ''}`}
                  >
                    <div className="flex items-center gap-1.5 min-w-0 flex-1">
                      <sk.icon className="w-3.5 h-3.5 shrink-0 text-primary" />
                      <span className="text-[10px] font-medium leading-none truncate">{sk.label}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Context Window Slider */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[10px] text-primary/80 font-bold uppercase tracking-wider block font-mono">2. 上下文记忆窗口</span>
              <span className="text-[10px] font-mono font-bold px-1.5 py-0.2 shrink-0 bg-[#3b82f6]/10 text-blue-400 border border-[#3b82f6]/20 rounded-md">
                {activeSettings.contextSize >= 132000 ? '无限制 (Infinity)' : (activeSettings.contextSize >= 1000 ? `${activeSettings.contextSize / 1000}k Tokens` : `${activeSettings.contextSize} Tokens`)}
              </span>
            </div>
            <input
              type="range"
              min="4000"
              max="132000"
              step="4000"
              value={activeSettings.contextSize}
              onChange={(e) => handleUpdateSettings({ contextSize: Number(e.target.value) })}
              className="w-full accent-primary bg-outline h-1 rounded cursor-pointer outline-none focus:outline-none"
            />
            <div className="flex justify-between text-[8px] text-on-surface/30 font-mono mt-1 font-bold">
              <span>4k</span>
              <span>32k (默认)</span>
              <span>64k</span>
              <span>128k</span>
              <span>无限制</span>
            </div>
          </div>

          {/* Personality Segment */}
          <div>
            <span className="text-[10px] text-primary/80 font-bold uppercase tracking-wider block mb-1.5 font-mono">3. 助理性格 (Personality)</span>
            <div className="grid grid-cols-4 gap-1">
              {[
                { id: 'professional', label: '专业严谨', icon: ShieldCheck, color: 'text-blue-400 bg-blue-500/10' },
                { id: 'sarcastic', label: '毒舌点评', icon: Flame, color: 'text-rose-400 bg-rose-500/10' },
                { id: 'zen', label: '禅意修行', icon: Brain, color: 'text-amber-400 bg-amber-500/10' },
                { id: 'geek', label: '中二极客', icon: Rocket, color: 'text-purple-400 bg-purple-500/10' },
              ].map(p => {
                const isActive = activeSettings.personality === p.id;
                return (
                  <button
                    key={p.id}
                    onClick={() => handleUpdateSettings({ personality: p.id as any })}
                    className={`flex flex-col items-center justify-center p-1.5 rounded-lg border text-center cursor-pointer transition-all gap-1 ${
                      isActive
                        ? `border-primary/40 bg-primary/10 text-primary font-bold ${p.color}`
                        : 'bg-surface-bright border-outline/35 text-on-surface/60 hover:text-on-surface hover:bg-bg/40'
                    }`}
                  >
                    <p.icon className="w-3.5 h-3.5 shrink-0" />
                    <span className="text-[9px] truncate leading-none">{p.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Tone Section */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <span className="text-[10px] text-primary/80 font-bold uppercase tracking-wider block mb-1.5 font-mono">4. 回复语调 (Tone)</span>
              <select
                value={activeSettings.tone}
                onChange={(e) => handleUpdateSettings({ tone: e.target.value as any })}
                className="w-full text-[10px] font-semibold bg-bg border border-outline/40 hover:border-primary/50 text-on-surface rounded-lg p-1.5 cursor-pointer outline-none"
              >
                <option value="detailed">详尽周密 (Detailed)</option>
                <option value="concise">极简凝练 (Concise)</option>
                <option value="humorous">幽默风趣 (Humorous)</option>
              </select>
            </div>
            
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[10px] text-primary/80 font-bold uppercase tracking-wider block font-mono">5. 表情回复 (Emoji)</span>
                <button
                  type="button"
                  onClick={() => handleUpdateSettings({ emojiEnabled: !activeSettings.emojiEnabled })}
                  className={`text-[9.5px] font-bold px-1.5 py-0.2 border rounded cursor-pointer transition-all ${
                    activeSettings.emojiEnabled 
                      ? 'bg-emerald-500/15 border-emerald-500/20 text-emerald-400' 
                      : 'bg-on-surface/5 border-outline/30 text-on-surface/50'
                  }`}
                >
                  {activeSettings.emojiEnabled ? '已开启' : '已关闭'}
                </button>
              </div>
              <select
                disabled={!activeSettings.emojiEnabled}
                value={activeSettings.emojiType}
                onChange={(e) => handleUpdateSettings({ emojiType: e.target.value as any })}
                className={`w-full text-[10px] font-semibold bg-bg border border-outline/40 text-on-surface rounded-lg p-1.5 cursor-pointer outline-none ${
                  !activeSettings.emojiEnabled ? 'opacity-40 cursor-not-allowed border-outline/10' : 'hover:border-primary/50'
                }`}
              >
                <option value="standard">经典 Emoji 🤖</option>
                <option value="kaomoji">颜文字 (๑•̀ㅂ•́)و✧</option>
                <option value="mixed">混合表现力</option>
              </select>
            </div>
          </div>


        </div>

        {/* 4 Corner Resizers for Custom Size Manipulation */}
        <div 
          onMouseDown={(e) => handleResizeStart('tl', e)}
          className="absolute top-0 left-0 w-6 h-6 cursor-nwse-resize z-[100] group/corner select-none"
          title="拖拽左上角调整大小"
        >
          <div className="absolute top-1.5 left-1.5 w-3 h-3 border-t-2 border-l-2 border-primary/45 group-hover/corner:border-primary group-hover/corner:scale-110 transition-all pointer-events-none rounded-tl-sm" />
        </div>
        <div 
          onMouseDown={(e) => handleResizeStart('tr', e)}
          className="absolute top-0 right-0 w-6 h-6 cursor-nesw-resize z-[100] group/corner select-none"
          title="拖拽右上角调整大小"
        >
          <div className="absolute top-1.5 right-1.5 w-3 h-3 border-t-2 border-r-2 border-primary/45 group-hover/corner:border-primary group-hover/corner:scale-110 transition-all pointer-events-none rounded-tr-sm" />
        </div>
        <div 
          onMouseDown={(e) => handleResizeStart('bl', e)}
          className="absolute bottom-0 left-0 w-6 h-6 cursor-nesw-resize z-[100] group/corner select-none"
          title="拖拽左下角调整大小"
        >
          <div className="absolute bottom-1.5 left-1.5 w-3 h-3 border-b-2 border-l-2 border-primary/45 group-hover/corner:border-primary group-hover/corner:scale-110 transition-all pointer-events-none rounded-bl-sm" />
        </div>
        <div 
          onMouseDown={(e) => handleResizeStart('br', e)}
          className="absolute bottom-0 right-0 w-6 h-6 cursor-nwse-resize z-[100] group/corner select-none"
          title="拖拽右下角调整大小"
        >
          <div className="absolute bottom-1.5 right-1.5 w-3 h-3 border-b-2 border-r-2 border-primary/45 group-hover/corner:border-primary group-hover/corner:scale-110 transition-all pointer-events-none rounded-br-sm" />
        </div>
      </div>

      <MountTransition show={!!selectedSkillToEdit} variant="fade-scale" duration={150}>
          <div
            style={{
              position: 'absolute',
              left: `${subPanelAbsolute.x}px`,
              top: `${subPanelAbsolute.y}px`,
              width: `${subSize.width}px`,
              height: `${subSize.height}px`,
              backgroundColor: activeTheme.surface,
              borderColor: activeTheme.outline,
            }}
            className="pointer-events-auto border rounded-2xl shadow-[0_16px_50px_rgba(0,0,0,0.85)] overflow-hidden flex flex-col cursor-default backdrop-blur-md bg-opacity-95 relative"
            onMouseDown={handleSubMouseDown}
            onWheel={(e) => {
              // Zoom support on Wheel
              if (e.ctrlKey) {
                e.preventDefault();
                const direction = e.deltaY < 0 ? 0.05 : -0.05;
                handleSubScaleChange(Math.min(1.50, Math.max(0.60, subScaleFactor + direction)));
              }
            }}
          >

            {/* Sub-panel Header */}
            <div className="flex items-center gap-3 p-4 border-b border-outline/35 shrink-0 select-none">
              <div className="p-1.5 rounded-lg bg-primary/10 text-primary shrink-0">
                <FileText className="w-4 h-4 text-primary" />
              </div>
              <div className="min-w-0">
                <h4 className="text-xs font-bold text-on-surface truncate flex items-center gap-1.5">
                  <span>配置: {getSkillLabel(selectedSkillToEdit)}</span>
                </h4>
                <p className="text-[9px] text-on-surface/40 mt-0.5 truncate font-mono">
                  文件: {getRulesFileName(selectedSkillToEdit)}
                </p>
              </div>
              <button 
                type="button"
                onClick={() => setSelectedSkillToEdit(null)} 
                className="p-1 hover:bg-surface-bright rounded text-on-surface/30 hover:text-white shrink-0 ml-auto cursor-default animate-none"
                title="关闭配置栏"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Sub-panel Editor Body */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4 no-scrollbar-now">
              <div className="space-y-2">
                <div className="flex items-center justify-between text-[10px] text-primary font-bold font-mono select-none">
                  <span>写入行为规范与约束 (Markdown)</span>
                  {isSavingSkillRules ? (
                    <span className="text-[8px] font-mono animate-pulse text-primary/70">自动保存中...</span>
                  ) : (
                    <span className="text-[8px] font-mono text-emerald-400">● 已同步至硬盘</span>
                  )}
                </div>
                <textarea
                  value={skillRulesContent}
                  onChange={(e) => handleSaveSkillRules(selectedSkillToEdit, e.target.value)}
                  placeholder="# 在此输入大语言模型做工时的定制化规划与约束准则"
                  className="w-full h-44 text-[11px] bg-bg border border-outline/30 rounded-lg p-2 focus:border-primary/50 text-on-surface font-mono outline-none resize-none overflow-y-auto no-scrollbar-now cursor-default"
                />
              </div>

              {/* Open File / System Folder Connection button */}
              <div className="pt-2 select-none">
                <button
                  type="button"
                  onClick={() => {
                    const rulePath = `BlogSystem/${getRulesFileName(selectedSkillToEdit)}`;
                    
                    // 1. Dispatch workspace change-file event so that sidebar file explorer and source editor focus context
                    window.dispatchEvent(new CustomEvent('soloforge-change-file', {
                      detail: { file: rulePath }
                    }));

                    // 2. Alert user via elegant toast system
                    const customToastEv = new CustomEvent('soloforge-toast', {
                      detail: { message: `已成功在工作空间本地文件夹中定位并高亮打开目标配置文件: ${getRulesFileName(selectedSkillToEdit)}` }
                    });
                    window.dispatchEvent(customToastEv);

                    // 3. Close the modal on successful redirection
                    onClose();
                  }}
                  className="w-full flex items-center justify-center gap-2 p-2.5 rounded-lg border border-primary/20 bg-primary/10 hover:bg-primary/20 text-primary font-bold text-[11px] transition-all cursor-default"
                >
                  <FolderOpen className="w-4 h-4 text-primary" />
                  <span>在文件夹中打开</span>
                </button>
                <p className="text-[9.5px] text-on-surface/40 mt-1.5 leading-relaxed">
                  提示：点击该选项将在左侧工程文件夹树中对当前配置文件执行极速寻轨与目录跳跃聚焦，免除人工翻找的繁琐流程。
                </p>
              </div>
            </div>

            {/* 4 Corner Resizers for Custom Size Manipulation */}
            <div 
              onMouseDown={(e) => handleSubResizeStart('tl', e)}
              className="absolute top-0 left-0 w-6 h-6 cursor-nwse-resize z-[100] group/corner select-none"
              title="拖拽左上角调整大小"
            >
              <div className="absolute top-1.5 left-1.5 w-3 h-3 border-t-2 border-l-2 border-primary/45 group-hover/corner:border-primary group-hover/corner:scale-110 transition-all pointer-events-none rounded-tl-sm" />
            </div>
            <div 
              onMouseDown={(e) => handleSubResizeStart('tr', e)}
              className="absolute top-0 right-0 w-6 h-6 cursor-nesw-resize z-[100] group/corner select-none"
              title="拖拽右上角调整大小"
            >
              <div className="absolute top-1.5 right-1.5 w-3 h-3 border-t-2 border-r-2 border-primary/45 group-hover/corner:border-primary group-hover/corner:scale-110 transition-all pointer-events-none rounded-tr-sm" />
            </div>
            <div 
              onMouseDown={(e) => handleSubResizeStart('bl', e)}
              className="absolute bottom-0 left-0 w-6 h-6 cursor-nesw-resize z-[100] group/corner select-none"
              title="拖拽左下角调整大小"
            >
              <div className="absolute bottom-1.5 left-1.5 w-3 h-3 border-b-2 border-l-2 border-primary/45 group-hover/corner:border-primary group-hover/corner:scale-110 transition-all pointer-events-none rounded-bl-sm" />
            </div>
            <div 
              onMouseDown={(e) => handleSubResizeStart('br', e)}
              className="absolute bottom-0 right-0 w-6 h-6 cursor-nwse-resize z-[100] group/corner select-none"
              title="拖拽右下角调整大小"
            >
              <div className="absolute bottom-1.5 right-1.5 w-3 h-3 border-b-2 border-r-2 border-primary/45 group-hover/corner:border-primary group-hover/corner:scale-110 transition-all pointer-events-none rounded-br-sm" />
            </div>
          </div>
      </MountTransition>
    </div>
  );
}
