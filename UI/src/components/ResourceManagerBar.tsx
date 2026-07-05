/**
 * 资源管理器 Bar (Mini Command Shortcuts)
 *
 * 2026-07-03 阶段3.1.D 从 ChatPanel.tsx 抽出。
 * 原 314 行 JSX (3 个 popover + 按钮组) 拆为独立组件。
 *
 * - 状态全部在 useResourceManagerStore,本组件只订阅 + 渲染
 * - 主题:用 data-theme-region="skill-bar" 走 Phase 4 CSS 变量级联,不再 inline style
 * - resize:本地 useRef 跟踪拖拽 (imperative,不触发重渲染),通过 mousemove effect 写回 store
 *
 * 组件挂载时调用 store.loadResources() 拉取后端 manifest + active 列表。
 */

import React, { useEffect, useRef } from 'react';
import {
  Brain, Upload, ChevronDown, FolderPlus, X, Pencil, Trash2,
  Circle, GripVertical,
} from '../utils/icons';
import {
  useResourceManagerStore,
  isParentTool, getChildIds,
  ResourceType,
} from '../state/useResourceManagerStore';

export default function ResourceManagerBar() {
  // ── store 订阅 ───────────────────────────────────
  const activeTools = useResourceManagerStore(s => s.activeTools);
  const activeKnowledge = useResourceManagerStore(s => s.activeKnowledge);
  const activeSkills = useResourceManagerStore(s => s.activeSkills);
  const activeResourcePopover = useResourceManagerStore(s => s.activeResourcePopover);
  const editingGroup = useResourceManagerStore(s => s.editingGroup);
  const expandedTools = useResourceManagerStore(s => s.expandedTools);
  const customGroups = useResourceManagerStore(s => s.customGroups);
  const popoverHeight = useResourceManagerStore(s => s.popoverHeight);
  const popoverWidth = useResourceManagerStore(s => s.popoverWidth);

  // ── setters / actions (函数引用稳定) ──────────────
  const setActiveResourcePopover = useResourceManagerStore(s => s.setActiveResourcePopover);
  const setEditingGroup = useResourceManagerStore(s => s.setEditingGroup);
  const setExpandedTools = useResourceManagerStore(s => s.setExpandedTools);
  const setPopoverHeight = useResourceManagerStore(s => s.setPopoverHeight);
  const setPopoverWidth = useResourceManagerStore(s => s.setPopoverWidth);
  const isParentActiveState = useResourceManagerStore(s => s.isParentActiveState);
  const getActiveParentToolCount = useResourceManagerStore(s => s.getActiveParentToolCount);
  const getGroupedItems = useResourceManagerStore(s => s.getGroupedItems);
  const loadResources = useResourceManagerStore(s => s.loadResources);
  const handleTogglePopover = useResourceManagerStore(s => s.handleTogglePopover);
  const toggleItemSelection = useResourceManagerStore(s => s.toggleItemSelection);
  const toggleParentTool = useResourceManagerStore(s => s.toggleParentTool);
  const toggleChildTool = useResourceManagerStore(s => s.toggleChildTool);
  const handleAddNewGroup = useResourceManagerStore(s => s.handleAddNewGroup);
  const handleRenameGroup = useResourceManagerStore(s => s.handleRenameGroup);
  const handleDeleteGroup = useResourceManagerStore(s => s.handleDeleteGroup);
  const toggleGroupSelection = useResourceManagerStore(s => s.toggleGroupSelection);
  const handleDragStart = useResourceManagerStore(s => s.handleDragStart);
  const handleGroupDrop = useResourceManagerStore(s => s.handleGroupDrop);

  // ── resize refs (transient imperative state, 不入 React tree) ──
  const isResizingPopover = useRef(false);
  const popoverResizeStart = useRef({
    y: 0, h: 340, x: 0, w: 280, dir: 'height' as 'height' | 'width' | 'width-left',
  });

  // ── 首次挂载: 拉取后端 manifest + active 列表 ────
  useEffect(() => {
    loadResources();
  }, [loadResources]);

  // ── resize mousemove / mouseup 监听 ───────────────
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizingPopover.current) return;
      const dir = popoverResizeStart.current.dir;
      if (dir === 'height') {
        const delta = e.clientY - popoverResizeStart.current.y;
        const newHeight = popoverResizeStart.current.h + delta;
        setPopoverHeight(Math.max(340, Math.min(window.innerHeight - 180, newHeight)));
      } else if (dir === 'width-left') {
        const delta = popoverResizeStart.current.x - e.clientX;
        const newWidth = popoverResizeStart.current.w + delta;
        setPopoverWidth(Math.max(280, Math.min(Math.min(window.innerWidth - 80, 560), newWidth)));
      } else {
        const delta = e.clientX - popoverResizeStart.current.x;
        const newWidth = popoverResizeStart.current.w + delta;
        setPopoverWidth(Math.max(280, Math.min(Math.min(window.innerWidth - 80, 560), newWidth)));
      }
    };
    const handleMouseUp = () => { isResizingPopover.current = false; };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [setPopoverHeight, setPopoverWidth]);

  // ── 渲染 ────────────────────────────────────────────
  // 2026-07-03 阶段4 主题优化: 用 data-theme-region="skill-bar" 替代 inline --color-primary
  // 由 :root[data-theme-skill-bar="1"] [data-theme-region="skill-bar"] 选择器驱动
  const labels: Record<ResourceType, string> = { skills: '技能', tools: '工具', knowledge: '知识库' };

  return (
    <div
      data-theme-region="skill-bar"
      className="px-4 py-1.5 border-t border-outline/50 flex items-center text-[10px] text-on-surface/60 font-medium select-none bg-surface/80"
    >
      <div className="max-w-5xl lg:max-w-[94%] xl:max-w-[90%] mx-auto w-full flex items-center gap-2 px-4 md:px-6 relative">
        <button className="flex items-center gap-1.5 px-3 py-1 rounded-lg hover:text-primary hover:bg-on-surface/5 transition-all cursor-pointer font-sans text-[11px] text-primary border border-transparent">
          <Brain className="w-3.5 h-3.5 text-primary" />
          <span>记忆</span>
        </button>
        <button className="flex items-center gap-1.5 px-3 py-1 rounded-lg hover:text-primary hover:bg-on-surface/5 transition-all cursor-pointer font-sans text-[11px] text-primary border border-transparent">
          <Upload className="w-3.5 h-3.5 text-primary" />
          <span>上传文件</span>
        </button>

        <div className="w-px h-4 bg-primary/12 shrink-0 mx-1" />

        {(['skills', 'tools', 'knowledge'] as const).map((resType, idx, arr) => {
          const isActive = activeResourcePopover === resType;
          const hasSelected = resType === 'skills'
            ? activeSkills.size > 0
            : resType === 'tools'
            ? getActiveParentToolCount() > 0
            : activeKnowledge.size > 0;
          const displayCount = resType === 'tools'
            ? getActiveParentToolCount()
            : resType === 'skills'
            ? activeSkills.size
            : activeKnowledge.size;
          return (
            <React.Fragment key={resType}>
              <div className="relative shrink-0">
                <button
                  type="button"
                  onClick={() => handleTogglePopover(resType)}
                  className={`flex items-center justify-center gap-1.5 px-3 py-1 rounded-lg transition-all cursor-pointer font-sans text-[11px] border shrink-0 ${
                    isActive
                      ? 'bg-primary/20 border-primary text-primary shadow-sm'
                      : hasSelected
                      ? 'bg-primary/8 border-primary/25 text-primary font-bold shadow-sm'
                      : 'bg-transparent border-transparent text-on-surface/65 hover:bg-on-surface/5 hover:text-primary'
                  }`}
                >
                  <div className="flex items-center gap-1 min-w-0">
                    <span className="truncate leading-none">{labels[resType]}</span>
                    <span className={`${hasSelected ? '' : 'text-transparent'}`}>·</span>
                    <span className={`w-[2ch] text-left leading-none shrink-0 ${hasSelected ? '' : 'text-transparent'}`}>
                      {hasSelected ? displayCount : '·'}
                    </span>
                  </div>
                  <ChevronDown className={`w-2.5 h-2.5 opacity-65 transition-transform duration-200 ${isActive ? 'rotate-180 text-primary' : ''} shrink-0`} />
                </button>

                {/* 弹出面板 - 向右弹出 */}
                {isActive && (() => {
                  const type = resType;
                  const activeSet = type === 'skills' ? activeSkills : type === 'tools' ? activeTools : activeKnowledge;
                  const groupedItems = getGroupedItems(type);
                  return (
                    <>
                      <div className="fixed inset-0 z-40" onClick={() => setActiveResourcePopover(null)} />
                      <div
                        className="absolute left-full top-0 ml-2 z-50 flex flex-col overflow-hidden border border-outline/20 bg-surface/95 backdrop-blur-md shadow-2xl rounded-xl text-left font-sans select-none"
                        style={{ height: popoverHeight, width: popoverWidth }}
                        onWheel={(e) => e.stopPropagation()}
                      >
                        {/* Header */}
                        <div className="px-2 py-1.5 flex items-center justify-between border-b border-outline/15 shrink-0">
                          <span className="text-[10px] font-bold text-on-surface/80 tracking-wider uppercase select-none">{labels[type]}</span>
                          <div className="flex items-center gap-1">
                            <button onClick={() => handleAddNewGroup(type)} className="p-0.5 rounded hover:bg-on-surface/5 text-on-surface/40 hover:text-primary transition-colors cursor-pointer" title="新建分组">
                              <FolderPlus className="w-3.5 h-3.5" />
                            </button>
                            <button onClick={() => setActiveResourcePopover(null)} className="p-0.5 rounded hover:bg-on-surface/5 text-on-surface/40 hover:text-primary transition-colors cursor-pointer" title="关闭">
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>

                        {/* Scrollable content */}
                        <div className="flex-1 overflow-y-auto space-y-1 p-1.5 text-[10px]" style={{ maxHeight: popoverHeight - 32 }}>
                          {Object.entries(groupedItems).map(([groupName, groupItems]) => {
                            const allSelected = groupItems.length > 0 && groupItems.every((item: any) => {
                              if (type === 'tools' && isParentTool(item)) return isParentActiveState(item);
                              return activeSet.has(item.id);
                            });
                            return (
                              <div
                                key={groupName}
                                className="space-y-1 group/title"
                                onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('ring-1', 'ring-primary/40'); }}
                                onDragLeave={(e) => { e.currentTarget.classList.remove('ring-1', 'ring-primary/40'); }}
                                onDrop={(e) => { e.currentTarget.classList.remove('ring-1', 'ring-primary/40'); handleGroupDrop(type, groupName, e); }}
                              >
                                {/* Group header */}
                                <div className="flex items-center gap-1 px-1 py-0.5 rounded hover:bg-on-surface/[0.02]">
                                  <button
                                    onClick={() => toggleGroupSelection(type, groupItems, allSelected)}
                                    className={`flex items-center justify-center shrink-0 ${allSelected ? 'opacity-100' : 'opacity-30'} hover:opacity-100 transition-all cursor-pointer`}
                                    title={allSelected ? '取消全选' : '全选'}
                                  >
                                    <Circle className={`w-3.5 h-3.5 ${allSelected ? 'text-primary fill-primary/20' : 'text-on-surface/30'}`} />
                                  </button>

                                  <div className="flex items-center gap-0.5 min-w-0 flex-1">
                                    {editingGroup?.type === type && editingGroup?.oldName === groupName ? (
                                      <input
                                        autoFocus
                                        defaultValue={groupName}
                                        onKeyDown={(e) => {
                                          if (e.key === 'Enter') handleRenameGroup(type, groupName, (e.target as HTMLInputElement).value);
                                          if (e.key === 'Escape') setEditingGroup(null);
                                        }}
                                        onBlur={(e) => handleRenameGroup(type, groupName, e.target.value)}
                                        className="w-full bg-transparent border-b border-primary/50 text-[10px] font-bold text-on-surface outline-none px-0.5 py-0"
                                        onClick={(e) => e.stopPropagation()}
                                      />
                                    ) : (
                                      <span className="text-[10px] font-bold tracking-wide text-on-surface/60 truncate">
                                        {groupName}
                                      </span>
                                    )}
                                    {editingGroup?.type !== type || editingGroup?.oldName !== groupName ? (
                                      <>
                                        <button
                                          onClick={() => setEditingGroup({ type, oldName: groupName, value: groupName })}
                                          className="p-0.5 rounded hover:bg-on-surface/5 text-on-surface/30 hover:text-on-surface transition-colors cursor-pointer"
                                          title="重命名分组"
                                        >
                                          <Pencil className="w-2.5 h-2.5" />
                                        </button>
                                        {(customGroups[type] || []).length > 1 && (
                                          <button
                                            onClick={() => handleDeleteGroup(type, groupName)}
                                            className="p-0.5 rounded hover:bg-red-500/15 text-on-surface/30 hover:text-red-400 transition-colors cursor-pointer"
                                            title="删除此分组（项目将移至其他分组）"
                                          >
                                            <Trash2 className="w-2.5 h-2.5" />
                                          </button>
                                        )}
                                      </>
                                    ) : null}
                                  </div>
                                </div>

                                {/* Item list */}
                                <div className="space-y-1 pl-0.5 min-h-[16px] border-l border-dashed border-outline/10 ml-2">
                                  {groupItems.length === 0 ? (
                                    <div className="text-[8.5px] text-on-surface/30 px-2 py-1 italic">拖拽项目至此分组</div>
                                  ) : (
                                    groupItems.map((item: any) => {
                                      const isParent = type === 'tools' && isParentTool(item);
                                      const isExpanded = isParent && expandedTools.has(item.id);
                                      const isParentActive = isParent ? isParentActiveState(item) : activeSet.has(item.id);
                                      const isParentFullyActive = isParent && activeSet.has(item.id);

                                      if (isParent) {
                                        return (
                                          <div key={item.id} className="space-y-0.5">
                                            <div
                                              draggable
                                              onDragStart={(e) => handleDragStart(item.id)}
                                              onClick={() => toggleParentTool(item.id, getChildIds(item))}
                                              className={`group/item flex items-start gap-1 p-1.5 rounded-md border transition-all cursor-pointer select-none ${
                                                isParentFullyActive
                                                  ? 'bg-primary/[0.04] border-primary/35 text-on-surface shadow-sm font-medium'
                                                  : isParentActive
                                                  ? 'bg-primary/[0.02] border-primary/15 text-on-surface/85 shadow-sm'
                                                  : 'bg-transparent border-outline/5 text-on-surface/50 opacity-60 hover:opacity-100 hover:border-outline/20 hover:bg-on-surface/[0.01]'
                                              }`}
                                            >
                                              <button
                                                type="button"
                                                onClick={(e) => {
                                                  e.stopPropagation();
                                                  const next = new Set(expandedTools);
                                                  if (isExpanded) next.delete(item.id); else next.add(item.id);
                                                  setExpandedTools(next);
                                                }}
                                                className="p-0.5 rounded hover:bg-on-surface/5 text-on-surface/40 hover:text-on-surface transition-colors cursor-pointer shrink-0 mt-0.5"
                                              >
                                                <ChevronDown className={`w-3 h-3 transition-transform duration-150 ${isExpanded ? 'rotate-0' : '-rotate-90'}`} />
                                              </button>
                                              <div className="min-w-0 flex-1 text-left">
                                                <span className={`text-[11px] font-bold leading-tight ${isParentActive ? 'text-on-surface' : 'text-on-surface/50'}`}>
                                                  {item.name}
                                                </span>
                                                {item.description && (
                                                  <div className={`text-[8.5px] leading-tight mt-px ${isParentActive ? 'text-on-surface/40' : 'text-on-surface/25'}`}>
                                                    {item.description}
                                                  </div>
                                                )}
                                              </div>
                                              <div className="shrink-0 flex items-center justify-center mt-[5px]">
                                                <div className={`w-4 h-4 rounded-full border flex items-center justify-center transition-all duration-155 ${
                                                  isParentActive ? 'border-on-surface/50 bg-on-surface/5' : 'border-on-surface/20 bg-transparent'
                                                }`}>
                                                  {isParentActive && (
                                                    <svg className="w-2.5 h-2.5 text-on-surface shrink-0" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="0.75" strokeLinecap="round" strokeLinejoin="round">
                                                      <path d="M2.5 6.5L5 9L10 3.5" />
                                                    </svg>
                                                  )}
                                                </div>
                                              </div>
                                            </div>

                                            {isExpanded && (
                                              <div className="ml-3 space-y-0.5 border-l border-dashed border-outline/10 pl-2">
                                                {(item.children || []).map((child: any) => (
                                                  <div
                                                    key={child.id}
                                                    draggable
                                                    onDragStart={(e) => handleDragStart(child.id)}
                                                    onClick={() => toggleChildTool(child.id)}
                                                    className={`group/item flex items-center gap-2 p-1 rounded-md border transition-all cursor-pointer select-none ${
                                                      activeSet.has(child.id)
                                                        ? 'bg-primary/[0.03] border-primary/20 text-on-surface'
                                                        : 'bg-transparent border-transparent text-on-surface/40 hover:text-on-surface/70'
                                                    }`}
                                                  >
                                                    <div className="min-w-0 flex-1 text-left">
                                                      <span className={`text-[10px] font-medium ${activeSet.has(child.id) ? 'text-on-surface/80' : 'text-on-surface/40'}`}>
                                                        {child.name}
                                                        <span className="font-normal text-[8.5px] text-on-surface/30 ml-1">
                                                          ({child.description ? child.description.split(/[，。]/)[0] : ''})
                                                        </span>
                                                      </span>
                                                    </div>
                                                    <div className="shrink-0 flex items-center justify-center">
                                                      <div className={`w-3 h-3 rounded border flex items-center justify-center ${
                                                        activeSet.has(child.id) ? 'border-on-surface/40 bg-on-surface/5' : 'border-on-surface/15 bg-transparent'
                                                      }`}>
                                                        {activeSet.has(child.id) && (
                                                          <svg className="w-2 h-2 text-on-surface/60 shrink-0" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="0.75" strokeLinecap="round" strokeLinejoin="round">
                                                            <path d="M2.5 6.5L5 9L10 3.5" />
                                                          </svg>
                                                        )}
                                                      </div>
                                                    </div>
                                                  </div>
                                                ))}
                                              </div>
                                            )}
                                          </div>
                                        );
                                      }

                                      const isChecked = activeSet.has(item.id);
                                      return (
                                        <div
                                          key={item.id}
                                          draggable
                                          onDragStart={(e) => handleDragStart(item.id)}
                                          onClick={() => toggleItemSelection(type, item.id)}
                                          className={`group/item flex items-start gap-2 p-1.5 rounded-md border transition-all cursor-grab active:cursor-grabbing select-none ${
                                            isChecked
                                              ? 'bg-primary/[0.04] border-primary/35 text-on-surface shadow-sm font-medium'
                                              : 'bg-transparent border-outline/5 text-on-surface/50 opacity-60 hover:opacity-100 hover:border-outline/20 hover:bg-on-surface/[0.01]'
                                          }`}
                                        >
                                          <div className="min-w-0 flex-1 text-left">
                                            <div className="flex items-center gap-1.5 min-w-0">
                                              <span className={`text-[11px] font-bold truncate leading-tight ${isChecked ? 'text-on-surface' : 'text-on-surface/50'}`}>
                                                {item.name}
                                                <span className="font-normal text-[9.5px] text-on-surface/35 ml-1.5">
                                                  ({item.description ? item.description.split(/[，。]/)[0] : '无用处'})
                                                </span>
                                              </span>
                                            </div>
                                          </div>
                                          <div className="shrink-0 flex items-center justify-center mt-0">
                                            <div className={`w-4 h-4 rounded-full border flex items-center justify-center transition-all duration-155 ${
                                              isChecked ? 'border-on-surface/50 bg-on-surface/5' : 'border-on-surface/20 bg-transparent'
                                            }`}>
                                              {isChecked && (
                                                <svg className="w-2.5 h-2.5 text-on-surface shrink-0" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="0.75" strokeLinecap="round" strokeLinejoin="round">
                                                  <path d="M2.5 6.5L5 9L10 3.5" />
                                                </svg>
                                              )}
                                            </div>
                                          </div>
                                        </div>
                                      );
                                    })
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>

                        {/* Bottom resize handle (高度) */}
                        <div
                          onMouseDown={(e) => {
                            e.preventDefault();
                            isResizingPopover.current = true;
                            popoverResizeStart.current = { y: e.clientY, h: popoverHeight, x: e.clientX, w: popoverWidth, dir: 'height' };
                          }}
                          className="h-2 shrink-0 cursor-ns-resize border-t border-outline/20 bg-surface/50 hover:bg-primary/15 transition-colors"
                          title="拖动调整高度"
                        />
                        {/* 左侧宽度拖拽手柄 */}
                        <div
                          onMouseDown={(e) => {
                            e.preventDefault(); e.stopPropagation();
                            isResizingPopover.current = true;
                            popoverResizeStart.current = { y: e.clientY, h: popoverHeight, x: e.clientX, w: popoverWidth, dir: 'width-left' };
                          }}
                          className="group absolute top-0 left-0 bottom-0 w-2 cursor-ew-resize z-10 hover:bg-primary/15 transition-colors flex items-center justify-center"
                          title="拖动调整宽度"
                        >
                          <GripVertical className="w-2.5 h-3.5 text-primary opacity-0 group-hover:opacity-90 transition-opacity pointer-events-none" />
                        </div>
                        {/* 右侧宽度拖拽手柄 */}
                        <div
                          onMouseDown={(e) => {
                            e.preventDefault(); e.stopPropagation();
                            isResizingPopover.current = true;
                            popoverResizeStart.current = { y: e.clientY, h: popoverHeight, x: e.clientX, w: popoverWidth, dir: 'width' };
                          }}
                          className="group absolute top-0 right-0 bottom-0 w-2 cursor-ew-resize z-10 hover:bg-primary/15 transition-colors flex items-center justify-center"
                          title="拖动调整宽度"
                        >
                          <GripVertical className="w-2.5 h-3.5 text-primary opacity-0 group-hover:opacity-90 transition-opacity pointer-events-none" />
                        </div>
                      </div>
                    </>
                  );
                })()}
              </div>
              {idx < arr.length - 1 && (
                <div className="w-px h-4 bg-primary/10 shrink-0" />
              )}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}
