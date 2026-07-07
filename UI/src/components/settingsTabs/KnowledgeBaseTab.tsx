/**
 * 09. 知识库 — 案例库 + 自定义库管理
 *
 * Master-Detail 布局:
 *   左栏: 库名列表 (案例库 pinned + 自定义库)
 *   右栏: 选中库的内容 (案例库=案例列表, 自定义库=暂无内容)
 */
import React, { useState, useEffect, useCallback } from 'react';
import {
  Trash2, RefreshCw, Database, Plus, Check, X, Eye, EyeOff,
  Bookmark, FolderOpen,
} from '../../utils/icons';
import * as DndKitCore from '@dnd-kit/core';
import * as DndKitSortable from '@dnd-kit/sortable';
import * as DndKitModifiers from '@dnd-kit/modifiers';
import { CSS } from '@dnd-kit/utilities';

const { DndContext, DragOverlay, closestCenter, PointerSensor, useSensor, useSensors } = DndKitCore;
const { SortableContext, verticalListSortingStrategy, arrayMove, useSortable } = DndKitSortable;
const { restrictToVerticalAxis } = DndKitModifiers;

// ── 类型 ────────────────────────────────────────────────
interface CaseItem {
  id: string;
  userMessage: string;
  assistantResponse: string;
  feedback: string;
  feedbackComment?: string;
  chatId?: string;
  agentId: string;
  domain?: string;
  included: number;
  createdAt?: string;
}
type FilterType = 'all' | 'positive' | 'negative';

interface CustomLibrary {
  id: string;
  name: string;
  createdAt: string;
}

const CUSTOM_LIBS_KEY = 'soloforge_custom_libraries';
const CASE_LIB_ID = '__builtin_case_lib__';

// ── SortableLibCard ─────────────────────────────────────
// 与 ProviderCard.tsx 完全对齐的拖拽卡片结构
// ─────────────────────────────────────────────────────────
interface SortableLibCardProps {
  lib: CustomLibrary;
  isSelected: boolean;
  isEditing: boolean;
  isConfirming: boolean;
  editingName: string;
  onSelect: (id: string) => void;
  onStartRename: (lib: CustomLibrary) => void;
  onConfirmRename: () => void;
  onCancelRename: () => void;
  onConfirmDelete: (id: string) => void;
  onCancelDelete: () => void;
  onDeleteClick: (id: string) => void;
  onEditingNameChange: (val: string) => void;
  onEditingKeyDown: (e: React.KeyboardEvent) => void;
}

const SortableLibCard = React.memo(function SortableLibCard({
  lib,
  isSelected,
  isEditing,
  isConfirming,
  editingName,
  onSelect,
  onStartRename,
  onConfirmRename,
  onCancelRename,
  onConfirmDelete,
  onCancelDelete,
  onDeleteClick,
  onEditingNameChange,
  onEditingKeyDown,
}: SortableLibCardProps) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id: lib.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: isDragging ? 'none' : (transition ?? 'transform 200ms cubic-bezier(0.22, 1, 0.36, 1)'),
    visibility: isDragging ? 'hidden' : 'visible',
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...(isEditing ? {} : listeners)}
      onClick={(e) => {
        if (isDragging) { e.preventDefault(); e.stopPropagation(); return; }
        onSelect(lib.id);
      }}
      className={`group flex items-center gap-2 px-2.5 py-2 rounded-xl text-xs font-semibold cursor-pointer active:cursor-grabbing border transition-colors duration-200 ${
        isSelected
          ? 'bg-[var(--color-primary)]/10 border-[var(--color-primary)]/20 text-[var(--color-on-surface)] font-black'
          : 'bg-transparent border-transparent text-[var(--color-on-surface)]/75 hover:bg-[var(--color-surface-bright)]/40 hover:text-[var(--color-on-surface)] hover:border-[var(--color-primary)]/30'
      }`}
    >
      {isEditing ? (
        <div className="flex items-center gap-1 flex-1 min-w-0">
          <input
            type="text"
            value={editingName}
            onChange={(e) => onEditingNameChange(e.target.value)}
            onKeyDown={onEditingKeyDown}
            autoFocus
            className="flex-1 min-w-0 text-[12px] px-1.5 py-0.5 bg-bg border border-primary rounded text-on-surface outline-none"
          />
          <button onClick={onConfirmRename} className="shrink-0 text-emerald-500 hover:text-emerald-400">
            <Check className="w-3 h-3" />
          </button>
          <button onClick={onCancelRename} className="shrink-0 text-on-surface/40 hover:text-on-surface">
            <X className="w-3 h-3" />
          </button>
        </div>
      ) : (
        <>
          <FolderOpen className="w-3.5 h-3.5 text-primary/60 shrink-0 pointer-events-none" />
          <span
            className={`flex-1 text-[12px] font-semibold truncate pointer-events-none ${isSelected ? 'text-on-surface' : 'text-on-surface/70'}`}
            onDoubleClick={(e) => { e.stopPropagation(); onStartRename(lib); }}
            title="双击重命名"
          >
            {lib.name}
          </span>

          {/* 操作按钮 */}
          {isConfirming ? (
            <div className="flex items-center gap-1 shrink-0 pointer-events-auto">
              <button
                onClick={(e) => { e.stopPropagation(); onConfirmDelete(lib.id); }}
                className="text-[8px] bg-rose-500 text-bg px-1.5 py-0.5 rounded hover:opacity-80"
              >
                确认
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onCancelDelete(); }}
                className="text-on-surface/40 hover:text-on-surface"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0 pointer-events-auto">
              <button
                onClick={(e) => { e.stopPropagation(); onStartRename(lib); }}
                onPointerDown={(e) => { e.stopPropagation(); }}
                className="text-on-surface/30 hover:text-on-surface p-0.5"
                title="重命名"
              >
                <span className="text-[10px]">✏️</span>
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onDeleteClick(lib.id); }}
                onPointerDown={(e) => { e.stopPropagation(); }}
                className="text-on-surface/30 hover:text-rose-500 p-0.5"
                title="删除"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
});

export default function KnowledgeBaseTab() {
  // ── 当前选中的库 ────────────────────────────────────
  const [selectedLibId, setSelectedLibId] = useState(CASE_LIB_ID);

  // ── 案例库状态 ──────────────────────────────────────
  const [cases, setCases] = useState<CaseItem[]>([]);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState<FilterType>('all');
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedCaseId, setExpandedCaseId] = useState<string | null>(null);
  const PAGE_SIZE = 50;

  // ── 自定义库状态 ────────────────────────────────────
  const [customLibs, setCustomLibs] = useState<CustomLibrary[]>([]);
  const [newLibName, setNewLibName] = useState('');
  const [editingLibId, setEditingLibId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // ── 拖拽状态 ────────────────────────────────────────
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  );

  const handleDragStart = useCallback((event: DndKitCore.DragStartEvent) => {
    setActiveDragId(String(event.active.id));
  }, []);

  const handleDragEnd = useCallback((event: DndKitCore.DragEndEvent) => {
    const { active, over } = event;
    setActiveDragId(null);
    if (!over || active.id === over.id) return;
    const oldIndex = customLibs.findIndex(l => l.id === active.id);
    const newIndex = customLibs.findIndex(l => l.id === over.id);
    if (oldIndex !== -1 && newIndex !== -1) {
      const reordered = arrayMove(customLibs, oldIndex, newIndex);
      persistCustomLibs(reordered);
    }
  }, [customLibs]);

  // ── 案例库数据 ──────────────────────────────────────
  const fetchCases = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: '0' });
      if (filter !== 'all') params.set('feedback', filter);
      const res = await fetch(`/api/java-agent/api/feedback/cases?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setCases(data.cases || []);
      setTotal(data.total || 0);
    } catch (e: any) {
      setError(e.message || '加载失败');
      setCases([]);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { if (selectedLibId === CASE_LIB_ID) fetchCases(); }, [fetchCases, selectedLibId]);

  const loadMore = async () => {
    if (loadingMore || cases.length >= total) return;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(cases.length) });
      if (filter !== 'all') params.set('feedback', filter);
      const res = await fetch(`/api/java-agent/api/feedback/cases?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setCases(prev => [...prev, ...(data.cases || [])]);
    } catch (e: any) {
      setError(`加载更多失败: ${e.message}`);
    } finally {
      setLoadingMore(false);
    }
  };

  const handleDeleteCase = async (id: string) => {
    try {
      const res = await fetch(`/api/java-agent/api/feedback/cases/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setCases(prev => prev.filter(c => c.id !== id));
      setTotal(prev => Math.max(0, prev - 1));
    } catch (e: any) {
      setError(`删除失败: ${e.message}`);
    }
  };

  const toggleCaseIncluded = async (id: string, current: number) => {
    const next = current === 1 ? 0 : 1;
    try {
      const res = await fetch(`/api/java-agent/api/feedback/cases/${id}/included?included=${next}`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setCases(prev => prev.map(c => c.id === id ? { ...c, included: next } : c));
    } catch (e: any) {
      setError(`切换失败: ${e.message}`);
    }
  };

  // ── 自定义库管理 ────────────────────────────────────
  useEffect(() => {
    try {
      const saved = localStorage.getItem(CUSTOM_LIBS_KEY);
      if (saved) setCustomLibs(JSON.parse(saved));
    } catch { /* ignore */ }
  }, []);

  const persistCustomLibs = (libs: CustomLibrary[]) => {
    setCustomLibs(libs);
    localStorage.setItem(CUSTOM_LIBS_KEY, JSON.stringify(libs));
  };

  const handleCreateLib = () => {
    const name = newLibName.trim();
    if (!name) return;
    const newLib: CustomLibrary = {
      id: `lib_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name,
      createdAt: new Date().toISOString(),
    };
    persistCustomLibs([...customLibs, newLib]);
    setNewLibName('');
    setSelectedLibId(newLib.id);
  };

  const handleStartRename = (lib: CustomLibrary) => {
    setEditingLibId(lib.id);
    setEditingName(lib.name);
  };

  const handleConfirmRename = () => {
    if (!editingLibId) return;
    const name = editingName.trim();
    if (!name) { setEditingLibId(null); return; }
    persistCustomLibs(customLibs.map(l => l.id === editingLibId ? { ...l, name } : l));
    setEditingLibId(null);
    setEditingName('');
  };

  const handleCancelRename = () => {
    setEditingLibId(null);
    setEditingName('');
  };

  const handleDeleteLib = (id: string) => {
    persistCustomLibs(customLibs.filter(l => l.id !== id));
    setConfirmDeleteId(null);
    if (selectedLibId === id) setSelectedLibId(CASE_LIB_ID);
  };

  const positiveCount = cases.filter(c => c.feedback === 'positive').length;
  const negativeCount = cases.filter(c => c.feedback === 'negative').length;

  // ── 渲染 ────────────────────────────────────────────
  return (
    <div className="flex gap-3 animate-fadeIn" style={{ height: 'calc(100vh - 200px)', minHeight: 400 }}>

      {/* ── 左栏: 库名列表 ──────────────────────────── */}
      <div className="w-[170px] shrink-0 bg-bg border border-outline/20 rounded-xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-3 py-2 border-b border-outline/20 flex items-center justify-between">
          <span className="text-[11px] font-semibold text-on-surface/60">知识库</span>
          <span className="text-[9px] text-on-surface/30">{customLibs.length + 1} 个</span>
        </div>

        {/* 库列表 */}
        <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5">
          {/* 内置案例库 */}
          <button
            onClick={() => setSelectedLibId(CASE_LIB_ID)}
            className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-xl text-left transition-colors duration-200 ${
              selectedLibId === CASE_LIB_ID
                ? 'bg-primary/10 border border-primary/20 text-on-surface shadow-sm'
                : 'border border-transparent hover:bg-primary/5 hover:border-primary/10 text-on-surface/70'
            }`}
          >
            <Bookmark className="w-3.5 h-3.5 text-primary shrink-0" />
            <span className="flex-1 text-[12px] font-semibold truncate">案例库</span>
            <span className="text-[9px] text-on-surface/30 shrink-0">{total}</span>
            <span className="text-[8px] text-emerald-500 bg-emerald-500/10 px-1 py-0.5 rounded shrink-0">内置</span>
          </button>

          {/* 新建库 (紧随案例库下方) */}
          <div className="px-1 pt-1 pb-0.5 flex gap-1">
            <input
              type="text"
              placeholder="新建库..."
              value={newLibName}
              onChange={(e) => setNewLibName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreateLib(); }}
              className="flex-1 min-w-0 text-[11px] px-2 py-1 bg-bg border border-outline/30 rounded-lg text-on-surface outline-none focus:border-primary"
            />
            <button
              onClick={handleCreateLib}
              disabled={!newLibName.trim()}
              className="shrink-0 bg-primary text-bg rounded-lg px-2 py-1 text-[11px] font-bold hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Plus className="w-3 h-3" />
            </button>
          </div>

          {/* 分割线 */}
          {customLibs.length > 0 && <div className="border-t border-outline/15 mx-1 my-1" />}

          {/* 自定义库 — 可拖拽排序 (仅垂直, 不超出自定义库区域) */}
          <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[restrictToVerticalAxis]} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
            <SortableContext items={customLibs.map(l => l.id)} strategy={verticalListSortingStrategy}>
              <div className={`space-y-0.5 ${activeDragId ? 'is-dimming' : ''}`}>
                {customLibs.map(lib => {
                  const isEditing = editingLibId === lib.id;
                  const isConfirming = confirmDeleteId === lib.id;
                  const isSelected = selectedLibId === lib.id;

                  return (
                    <SortableLibCard
                      key={lib.id}
                      lib={lib}
                      isSelected={isSelected}
                      isEditing={isEditing}
                      isConfirming={isConfirming}
                      editingName={isEditing ? editingName : ''}
                      onSelect={setSelectedLibId}
                      onStartRename={handleStartRename}
                      onConfirmRename={handleConfirmRename}
                      onCancelRename={handleCancelRename}
                      onConfirmDelete={handleDeleteLib}
                      onCancelDelete={() => setConfirmDeleteId(null)}
                      onDeleteClick={setConfirmDeleteId}
                      onEditingNameChange={setEditingName}
                      onEditingKeyDown={(e) => {
                        if (e.key === 'Enter') handleConfirmRename();
                        if (e.key === 'Escape') handleCancelRename();
                      }}
                    />
                  );
                })}
              </div>
            </SortableContext>
            <DragOverlay dropAnimation={null} zIndex={9999}>
              {activeDragId ? (() => {
                const dragLib = customLibs.find(l => l.id === activeDragId);
                if (!dragLib) return null;
                const isDragSelected = selectedLibId === dragLib.id;
                return (
                  <div className="cursor-grabbing" style={{ pointerEvents: 'none' }}>
                    <div
                      className={`flex items-center gap-2 px-2.5 py-2 rounded-xl text-xs font-semibold border bg-surface ${
                        isDragSelected
                          ? 'bg-[var(--color-primary)]/10 border-[var(--color-primary)]/20 text-[var(--color-on-surface)] font-black'
                          : 'bg-surface border-transparent text-[var(--color-on-surface)]/75'
                      }`}
                      style={{
                        boxShadow: '0 18px 40px rgba(0,0,0,0.18), 0 4px 12px rgba(0,0,0,0.08), 0 0 0 1px rgba(255,255,255,0.06)',
                        filter: 'drop-shadow(0 0 6px rgba(0,0,0,0.05))',
                      }}
                    >
                      <FolderOpen className="w-3.5 h-3.5 text-primary/60 shrink-0" />
                      <span className={`flex-1 text-[12px] font-semibold truncate ${isDragSelected ? 'text-on-surface' : 'text-on-surface/70'}`}>
                        {dragLib.name}
                      </span>
                    </div>
                  </div>
                );
              })() : null}
            </DragOverlay>
          </DndContext>
        </div>
      </div>

      {/* ── 右栏: 内容区 ──────────────────────────── */}
      <div className="flex-1 min-w-0 bg-surface border border-outline/20 rounded-xl flex flex-col overflow-hidden">
        <div key={selectedLibId} className="sf-anim sf-anim-slide-up flex-1 flex flex-col min-h-0">
        {selectedLibId === CASE_LIB_ID ? (
          /* 案例库内容 */
          <>
            {/* Header */}
            <div className="px-4 py-2.5 border-b border-outline/20 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2">
                <Bookmark className="w-4 h-4 text-primary shrink-0" />
                <span className="text-sm font-bold text-on-surface">案例库</span>
                <span className="text-[10px] text-on-surface/40 px-1.5 py-0.5 rounded bg-bg border border-outline/20">{total} 条</span>
                <span className="text-[9px] text-emerald-500">内置</span>
              </div>
              <button
                onClick={fetchCases}
                disabled={loading}
                className="flex items-center gap-1 px-2 py-1 rounded-lg bg-surface border border-outline/30 text-[11px] text-on-surface/60 hover:text-primary hover:border-primary/30 transition-all"
              >
                <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
                刷新
              </button>
            </div>

            {/* 描述 */}
            <div className="px-4 pt-2 shrink-0">
              <p className="text-[10px] text-on-surface/40">案例库自动收集 👍/👎 反馈供 Agent 检索参考</p>
            </div>

            {/* 过滤 */}
            <div className="px-4 pt-2 pb-1 flex items-center gap-1 shrink-0">
              {(['all', 'positive', 'negative'] as FilterType[]).map(f => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`px-2 py-0.5 rounded text-[10px] font-medium transition-all ${
                    filter === f
                      ? 'bg-primary/15 text-primary'
                      : 'text-on-surface/50 hover:text-on-surface/80'
                  }`}
                >
                  {f === 'all' ? `全部 ${total}` : f === 'positive' ? `正向 ${positiveCount}` : `负向 ${negativeCount}`}
                </button>
              ))}
            </div>

            {/* Error */}
            {error && (
              <div className="mx-4 mt-1 p-2 rounded-lg bg-rose-500/10 border border-rose-500/30 text-[11px] text-rose-500 shrink-0">
                {error}
                <button onClick={() => setError(null)} className="ml-2 underline">关闭</button>
              </div>
            )}

            {/* 案例列表 */}
            <div className="flex-1 overflow-y-auto px-4 pt-1 pb-2">
              {loading && cases.length === 0 ? (
                <div className="text-center py-8 text-[11px] text-on-surface/40">加载中…</div>
              ) : cases.length === 0 ? (
                <div className="text-center py-8 text-[11px] text-on-surface/40">
                  暂无案例。用户在聊天中点 👍/👎 后自动入库。
                </div>
              ) : (
                <div className="space-y-1">
                  {cases.map(c => (
                    <div
                      key={c.id}
                      className={`flex items-start gap-2 p-2 rounded-lg transition-all cursor-pointer ${
                        c.included === 0 ? 'opacity-50' : 'hover:bg-primary/5'
                      }`}
                      onClick={() => setExpandedCaseId(expandedCaseId === c.id ? null : c.id)}
                    >
                      {/* 👍/👎 */}
                      <span className={`shrink-0 mt-0.5 text-sm ${c.feedback === 'positive' ? 'text-emerald-500' : 'text-rose-500'}`}>
                        {c.feedback === 'positive' ? '👍' : '👎'}
                      </span>

                      {/* 内容 */}
                      <div className="flex-1 min-w-0">
                        <div className="text-[11px] text-on-surface font-medium truncate">
                          <span className="text-on-surface/40">问: </span>
                          {c.userMessage || '(空)'}
                        </div>
                        <div className="text-[10px] text-on-surface/50 truncate mt-0.5">
                          <span className="text-on-surface/30">答: </span>
                          {c.assistantResponse || '(空)'}
                        </div>
                        <div className="flex items-center gap-2 mt-0.5 text-[9px] text-on-surface/25">
                          <span>{c.agentId}</span>
                          {c.createdAt && <span>· {c.createdAt.slice(0, 16).replace('T', ' ')}</span>}
                          {c.included === 0 && <span className="text-amber-500">已排除</span>}
                        </div>

                        {/* 展开详情 */}
                        {expandedCaseId === c.id && (
                          <div className="mt-2 pt-2 border-t border-outline/20 space-y-1.5">
                            <div>
                              <div className="text-[8px] uppercase tracking-wider text-on-surface/30 font-semibold mb-0.5">用户消息</div>
                              <div className="text-[11px] text-on-surface whitespace-pre-wrap break-words">{c.userMessage || '(空)'}</div>
                            </div>
                            <div>
                              <div className="text-[8px] uppercase tracking-wider text-on-surface/30 font-semibold mb-0.5">助手回复</div>
                              <div className="text-[11px] text-on-surface whitespace-pre-wrap break-words max-h-32 overflow-y-auto">{c.assistantResponse || '(空)'}</div>
                            </div>
                          </div>
                        )}
                      </div>

                      {/* 操作 */}
                      <div className="flex items-center gap-0.5 shrink-0" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => toggleCaseIncluded(c.id, c.included)}
                          title={c.included === 1 ? '排除检索' : '纳入检索'}
                          className={`p-1 rounded transition-all ${
                            c.included === 1 ? 'text-emerald-500 hover:bg-emerald-500/10' : 'text-on-surface/30 hover:bg-surface'
                          }`}
                        >
                          {c.included === 1 ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                        </button>
                        <button
                          onClick={() => handleDeleteCase(c.id)}
                          title="删除"
                          className="p-1 rounded text-on-surface/30 hover:text-rose-500 hover:bg-rose-500/10 transition-all"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  ))}

                  {/* 加载更多 */}
                  {cases.length < total && (
                    <button
                      onClick={loadMore}
                      disabled={loadingMore}
                      className="w-full py-1.5 rounded-lg border border-outline/30 text-[10px] text-on-surface/50 hover:text-primary hover:border-primary/30 transition-all"
                    >
                      {loadingMore ? '加载中…' : `加载更多 (已显示 ${cases.length}/${total})`}
                    </button>
                  )}
                </div>
              )}
            </div>
          </>
        ) : (
          /* 自定义库内容 */
          <>
            <div className="px-4 py-2.5 border-b border-outline/20 shrink-0">
              <div className="flex items-center gap-2">
                <FolderOpen className="w-4 h-4 text-primary/60 shrink-0" />
                <span className="text-sm font-bold text-on-surface">
                  {customLibs.find(l => l.id === selectedLibId)?.name || '自定义库'}
                </span>
              </div>
            </div>
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <Database className="w-8 h-8 mx-auto mb-2 text-on-surface/15" />
                <p className="text-[11px] text-on-surface/30">暂无内容</p>
              </div>
            </div>
          </>
        )}
        </div>
      </div>
    </div>
  );
}
