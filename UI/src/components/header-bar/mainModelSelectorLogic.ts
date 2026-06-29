/**
 * MainModelSelector — 纯逻辑层
 *
 * 拆出这个文件的目的:
 *   1. 单测无需 import 整个 React 组件 (避免 ModelIcon 传递触发 @lobehub/ui 重依赖链)
 *   2. 纯函数可独立在 Node / Web Worker 中使用
 *
 * 与 React 组件 (MainModelSelector.tsx) 共享同一份导出, 组件只 import 这边。
 */

export function computeAvailableModels(
  raw: readonly string[] | null | undefined,
): { list: string[]; fallback: string | null } {
  const seen = new Set<string>();
  const list: string[] = [];
  for (const m of raw || []) {
    if (typeof m !== 'string') continue;
    const trimmed = m.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    list.push(trimmed);
  }
  return { list, fallback: list[0] ?? null };
}

export function pickModel(
  list: readonly string[],
  mainModel: string,
  selected: string,
): { next: string; changed: boolean } {
  if (!list.includes(selected)) {
    return { next: mainModel, changed: false };
  }
  return { next: selected, changed: selected !== mainModel };
}
