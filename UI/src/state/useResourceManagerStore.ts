/**
 * 资源管理器 store (工具/知识库/技能)
 *
 * 2026-07-03 阶段3.1.D 从 ChatPanel.tsx 抽出。
 * 原 14 个 useState + 多个 helper + 9 个 action handler 全部收敛到此 store。
 *
 * ChatPanel / ResourceManagerBar 通过订阅 store 获取状态与操作,
 * 不再持有任何资源管理相关的 useState。
 *
 * 注:resize 跟踪用 ref 的方式 (isResizingPopover / popoverResizeStart) 仍由组件本地 useRef 持有,
 * 因为这些是 transient imperative state,不应触发 React 重渲染。
 */

import { create } from 'zustand';
import { DEFAULT_TOOLS_MANIFEST, ToolManifestItem } from '../data/toolsManifest';

export type ResourceType = 'tools' | 'knowledge' | 'skills';
export type PopoverDir = 'height' | 'width' | 'width-left';
export interface EditingGroup {
  type: ResourceType;
  oldName: string;
  value: string;
}

interface ResourceManagerState {
  // ── 资源清单 ─────────────────────────────────────
  toolsManifest: ToolManifestItem[];
  knowledgeManifest: any[];
  skillsManifest: any[];

  // ── 当前选中 ─────────────────────────────────────
  activeTools: Set<string>;
  activeKnowledge: Set<string>;
  activeSkills: Set<string>;

  // ── 分组配置 ─────────────────────────────────────
  customGroups: Record<string, string[]>;
  groupAssignments: Record<string, string>;

  // ── UI 状态 ───────────────────────────────────────
  activeResourcePopover: ResourceType | null;
  editingGroup: EditingGroup | null;
  expandedTools: Set<string>;
  draggedItem: string | null;

  // ── Popover 尺寸 ─────────────────────────────────
  popoverHeight: number;
  popoverWidth: number;

  // ── setters (UI 控制) ────────────────────────────
  setActiveResourcePopover: (v: ResourceType | null) => void;
  setEditingGroup: (v: EditingGroup | null) => void;
  setExpandedTools: (v: Set<string>) => void;
  setDraggedItem: (v: string | null) => void;
  setPopoverHeight: (v: number) => void;
  setPopoverWidth: (v: number) => void;

  // ── helpers (依赖 state) ─────────────────────────
  isParentActiveState: (item: any) => boolean;
  getActiveParentToolCount: () => number;
  getGroupedItems: (type: ResourceType) => Record<string, any[]>;

  // ── actions ──────────────────────────────────────
  loadResources: () => Promise<void>;
  handleTogglePopover: (type: ResourceType) => void;
  toggleItemSelection: (type: ResourceType, id: string) => void;
  toggleParentTool: (parentId: string, childIds: string[]) => void;
  toggleChildTool: (childId: string) => void;
  handleAddNewGroup: (type: ResourceType) => void;
  handleRenameGroup: (type: ResourceType, oldName: string, newName: string) => void;
  handleDeleteGroup: (type: ResourceType, groupName: string) => void;
  toggleGroupSelection: (type: ResourceType, items: any[], isAllSelected: boolean) => void;
  handleDragStart: (id: string) => void;
  handleGroupDrop: (type: ResourceType, targetGroup: string, e: React.DragEvent) => void;
}

// ── 纯函数 helper (不依赖 state, 模块级) ──────────
export const isParentTool = (item: any): boolean =>
  item && Array.isArray(item.children) && item.children.length > 0;

export const getChildIds = (item: any): string[] =>
  isParentTool(item) ? item.children.map((c: any) => c.id) : [];

// ── 内部工具: 服务端/默认 manifest 合并 ──────────
const mergeToolManifests = (serverItems: any[], defaultItems: ToolManifestItem[]): ToolManifestItem[] => {
  const existingIds = new Set(serverItems.map(i => i.id));
  const merged = [...serverItems];
  for (const item of defaultItems) {
    if (!existingIds.has(item.id)) {
      merged.push(item);
    }
  }
  return merged;
};

// ── 内部工具: 确保浏览器/Windows 分组始终存在 ────
const ensureDefaultToolGroups = (groups: string[]): string[] => {
  const required = ['核心', '浏览器', 'Windows'];
  const result = [...groups];
  for (const g of required) {
    if (!result.includes(g)) result.push(g);
  }
  return result;
};

export const useResourceManagerStore = create<ResourceManagerState>((set, get) => ({
  // ── 初始状态 ─────────────────────────────────────
  toolsManifest: DEFAULT_TOOLS_MANIFEST,
  knowledgeManifest: [],
  skillsManifest: [],
  activeTools: new Set<string>(),
  activeKnowledge: new Set<string>(),
  activeSkills: new Set<string>(),
  customGroups: {
    tools: ['浏览器', 'Windows'],
    knowledge: ['未分组'],
    skills: ['未分组'],
  },
  groupAssignments: {},
  activeResourcePopover: null,
  editingGroup: null,
  expandedTools: new Set<string>(),
  draggedItem: null,
  popoverHeight: 340,
  popoverWidth: 280,

  // ── setters ─────────────────────────────────────
  setActiveResourcePopover: (v) => set({ activeResourcePopover: v }),
  setEditingGroup: (v) => set({ editingGroup: v }),
  setExpandedTools: (v) => set({ expandedTools: v }),
  setDraggedItem: (v) => set({ draggedItem: v }),
  setPopoverHeight: (v) => set({ popoverHeight: v }),
  setPopoverWidth: (v) => set({ popoverWidth: v }),

  // ── helpers ─────────────────────────────────────
  isParentActiveState: (item) => {
    if (!isParentTool(item)) return false;
    const { activeTools } = get();
    if (activeTools.has(item.id)) return true;
    return getChildIds(item).some((cid: string) => activeTools.has(cid));
  },

  getActiveParentToolCount: () => {
    const { toolsManifest, activeTools } = get();
    let count = 0;
    toolsManifest.forEach((item) => {
      if (isParentTool(item)) {
        if (
          activeTools.has(item.id) ||
          getChildIds(item).some((cid: string) => activeTools.has(cid))
        ) {
          count++;
        }
      } else {
        if (activeTools.has(item.id)) count++;
      }
    });
    return count;
  },

  getGroupedItems: (type) => {
    const { toolsManifest, knowledgeManifest, skillsManifest, customGroups, groupAssignments } = get();
    const manifest = type === 'tools' ? toolsManifest : type === 'knowledge' ? knowledgeManifest : skillsManifest;
    const groups = Array.isArray(customGroups[type]) ? customGroups[type] : ['未分组'];
    const assigned = groupAssignments || {};
    const grouped: Record<string, any[]> = {};
    groups.forEach((g) => { grouped[g] = []; });
    manifest.forEach((item: any) => {
      const g = assigned[item.id] || item.group || '未分组';
      if (grouped[g]) grouped[g].push(item);
      else grouped[g] = [item];
    });
    return grouped;
  },

  // ── actions ──────────────────────────────────────
  loadResources: async () => {
    try {
      const [toolsRes, kbRes, skillsRes, activeRes] = await Promise.all([
        fetch('/api/resources/tools/manifest').then((r) => r.json()).catch(() => ({ success: false })),
        fetch('/api/resources/knowledge/manifest').then((r) => r.json()).catch(() => ({ success: false })),
        fetch('/api/resources/skills/manifest').then((r) => r.json()).catch(() => ({ success: false })),
        fetch('/api/resources/active').then((r) => r.json()).catch(() => ({ success: false })),
      ]);

      const tManifest = toolsRes.success ? (toolsRes.items || []) : [];
      const kManifest = kbRes.success ? (kbRes.items || []) : [];
      const sManifest = skillsRes.success ? (skillsRes.items || []) : [];
      const finalTManifest = mergeToolManifests(tManifest, DEFAULT_TOOLS_MANIFEST);

      if (activeRes.success && activeRes.active) {
        let toolsGroups: string[];
        if (activeRes.active.customGroups) {
          toolsGroups = activeRes.active.customGroups.tools
            ? ensureDefaultToolGroups(activeRes.active.customGroups.tools)
            : ensureDefaultToolGroups(['未分组']);
        } else {
          toolsGroups = ensureDefaultToolGroups(
            Array.from(new Set(finalTManifest.map((i: any) => i.group || '未分组'))) as string[],
          );
        }
        const finalAssign: Record<string, string> = { ...(activeRes.active.groupAssignments || {}) };
        finalTManifest.forEach((item: any) => {
          if (item.group && !finalAssign[item.id]) finalAssign[item.id] = item.group;
        });
        const kbGroups = activeRes.active.customGroups?.knowledge?.length
          ? activeRes.active.customGroups.knowledge
          : ['未分组'];
        const skGroups = activeRes.active.customGroups?.skills?.length
          ? activeRes.active.customGroups.skills
          : ['未分组'];

        set({
          toolsManifest: finalTManifest,
          knowledgeManifest: kManifest,
          skillsManifest: sManifest,
          activeTools: new Set(activeRes.active.tools || []),
          activeKnowledge: new Set(activeRes.active.knowledge || []),
          activeSkills: new Set(activeRes.active.skills || []),
          customGroups: { tools: toolsGroups, knowledge: kbGroups, skills: skGroups },
          groupAssignments: finalAssign,
        });
      } else {
        const toolsGroups = ensureDefaultToolGroups(
          Array.from(new Set(finalTManifest.map((i: any) => i.group || '未分组'))) as string[],
        );
        const assign: Record<string, string> = {};
        finalTManifest.forEach((item: any) => { if (item.group) assign[item.id] = item.group; });
        set({
          toolsManifest: finalTManifest,
          knowledgeManifest: kManifest,
          skillsManifest: sManifest,
          customGroups: {
            tools: toolsGroups.length > 0 ? toolsGroups : ensureDefaultToolGroups(['未分组']),
            knowledge: ['未分组'],
            skills: ['未分组'],
          },
          groupAssignments: assign,
        });
      }
    } catch (err) {
      console.error('加载资源失败:', err);
    }
  },

  handleTogglePopover: (type) => {
    const { activeResourcePopover } = get();
    set({ activeResourcePopover: activeResourcePopover === type ? null : type });
  },

  toggleItemSelection: (type, id) => {
    const state = get();
    if (type === 'tools') {
      const next = new Set(state.activeTools);
      if (next.has(id)) next.delete(id); else next.add(id);
      set({ activeTools: next });
      saveActiveResources(next, state.activeKnowledge, state.activeSkills, state.customGroups, state.groupAssignments);
    } else if (type === 'knowledge') {
      const next = new Set(state.activeKnowledge);
      if (next.has(id)) next.delete(id); else next.add(id);
      set({ activeKnowledge: next });
      saveActiveResources(state.activeTools, next, state.activeSkills, state.customGroups, state.groupAssignments);
    } else {
      const next = new Set(state.activeSkills);
      if (next.has(id)) next.delete(id); else next.add(id);
      set({ activeSkills: next });
      saveActiveResources(state.activeTools, state.activeKnowledge, next, state.customGroups, state.groupAssignments);
    }
  },

  toggleParentTool: (parentId, childIds) => {
    const state = get();
    const nextSet = new Set(state.activeTools);
    if (nextSet.has(parentId)) {
      nextSet.delete(parentId);
      childIds.forEach((cid) => nextSet.delete(cid));
    } else {
      nextSet.add(parentId);
      childIds.forEach((cid) => nextSet.add(cid));
    }
    set({ activeTools: nextSet });
    saveActiveResources(nextSet, state.activeKnowledge, state.activeSkills, state.customGroups, state.groupAssignments);
  },

  toggleChildTool: (childId) => {
    const state = get();
    const nextSet = new Set(state.activeTools);
    if (nextSet.has(childId)) {
      nextSet.delete(childId);
    } else {
      nextSet.add(childId);
    }
    set({ activeTools: nextSet });
    saveActiveResources(nextSet, state.activeKnowledge, state.activeSkills, state.customGroups, state.groupAssignments);
  },

  handleAddNewGroup: (type) => {
    const state = get();
    const currentList = Array.isArray(state.customGroups[type]) ? state.customGroups[type] : [];
    const newName = `新分组 ${currentList.length + 1}`;
    const nextGroups = { ...state.customGroups, [type]: [...currentList, newName] };
    set({ customGroups: nextGroups });
    saveActiveResources(state.activeTools, state.activeKnowledge, state.activeSkills, nextGroups, state.groupAssignments);
  },

  handleRenameGroup: (type, oldName, newName) => {
    if (!newName.trim() || newName === oldName) {
      set({ editingGroup: null });
      return;
    }
    const state = get();
    const currentList = Array.isArray(state.customGroups[type]) ? state.customGroups[type] : [];
    const updatedGroups = currentList.map((g) => (g === oldName ? newName : g));
    const nextAssign = { ...state.groupAssignments };
    Object.keys(nextAssign).forEach((k) => {
      if (nextAssign[k] === oldName) nextAssign[k] = newName;
    });
    const nextGroups = { ...state.customGroups, [type]: updatedGroups };
    set({ customGroups: nextGroups, groupAssignments: nextAssign, editingGroup: null });
    saveActiveResources(state.activeTools, state.activeKnowledge, state.activeSkills, nextGroups, nextAssign);
  },

  handleDeleteGroup: (type, groupName) => {
    const state = get();
    const currentList = Array.isArray(state.customGroups[type]) ? state.customGroups[type] : [];
    if (currentList.length <= 1) return;
    const updatedGroups = currentList.filter((g) => g !== groupName);
    const fallbackGroup = updatedGroups[0] || '未分组';
    const nextAssign = { ...state.groupAssignments };
    Object.keys(nextAssign).forEach((k) => {
      if (nextAssign[k] === groupName) nextAssign[k] = fallbackGroup;
    });
    const nextGroups = { ...state.customGroups, [type]: updatedGroups };
    set({ customGroups: nextGroups, groupAssignments: nextAssign });
    saveActiveResources(state.activeTools, state.activeKnowledge, state.activeSkills, nextGroups, nextAssign);
  },

  toggleGroupSelection: (type, items, isAllSelected) => {
    const state = get();
    let nextSet: Set<string>;
    if (type === 'tools') {
      nextSet = new Set(state.activeTools);
    } else if (type === 'knowledge') {
      nextSet = new Set(state.activeKnowledge);
    } else {
      nextSet = new Set(state.activeSkills);
    }
    items.forEach((item) => {
      if (type === 'tools' && isParentTool(item)) {
        if (isAllSelected) {
          nextSet.delete(item.id);
          getChildIds(item).forEach((cid) => nextSet.delete(cid));
        } else {
          nextSet.add(item.id);
          getChildIds(item).forEach((cid) => nextSet.add(cid));
        }
      } else {
        if (isAllSelected) nextSet.delete(item.id);
        else nextSet.add(item.id);
      }
    });
    if (type === 'tools') {
      set({ activeTools: nextSet });
      saveActiveResources(nextSet, state.activeKnowledge, state.activeSkills, state.customGroups, state.groupAssignments);
    } else if (type === 'knowledge') {
      set({ activeKnowledge: nextSet });
      saveActiveResources(state.activeTools, nextSet, state.activeSkills, state.customGroups, state.groupAssignments);
    } else {
      set({ activeSkills: nextSet });
      saveActiveResources(state.activeTools, state.activeKnowledge, nextSet, state.customGroups, state.groupAssignments);
    }
  },

  handleDragStart: (id) => set({ draggedItem: id }),

  handleGroupDrop: (type, targetGroup, e) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain');
    if (!id) return;
    const state = get();
    const nextAssign = { ...state.groupAssignments, [id]: targetGroup };
    set({ groupAssignments: nextAssign, draggedItem: null });
    saveActiveResources(state.activeTools, state.activeKnowledge, state.activeSkills, state.customGroups, nextAssign);
  },
}));

// ── 模块级 helper: 持久化选中资源到后端 ─────────────
// 不放进 store 是因为它接受任意状态作为参数 (允许"先用更新后的状态调用 save"模式),
// 不强制依赖 store 当前快照。
function saveActiveResources(
  tools: Set<string>,
  knowledge: Set<string>,
  skills: Set<string>,
  groups: Record<string, string[]>,
  assign: Record<string, string>,
) {
  fetch('/api/resources/active', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tools: Array.from(tools),
      knowledge: Array.from(knowledge),
      skills: Array.from(skills),
      customGroups: groups,
      groupAssignments: assign,
    }),
  }).catch(() => {});
}

// ── HMR 边界:改 store 代码时热替换 store 实例,不触发 full page reload ──
// React 组件树保持挂载,资源清单/选中状态会重置为初始值 (后端权威数据,loadResources 即可恢复)。
if (import.meta.hot) {
  import.meta.hot.accept((m) => {
    if (m) useResourceManagerStore.setState(m.useResourceManagerStore.getState(), true);
  });
}
