/**
 * streamAppearanceStore — 流送区外观设置 (字体颜色 + 字体大小)
 *
 * ★ 2026-07-19 新增: 用户右键流送区可调节字体颜色和大小
 *
 * 设计要点:
 * - fontColor 为空字符串时表示"跟随主题默认" (不覆盖 --color-on-surface)
 * - fontSize 单位 px, 默认 28 (最大字号, 可右键调节 10-28)
 * - 持久化到 localStorage, 跨会话保留
 * - subscribeWithSelector 允许组件精准订阅, 避免不必要重渲染
 */
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

const STORAGE_KEY = 'soloforge_streamAppearance';

interface StreamAppearanceState {
  /** 字体颜色 (hex/rgb), 空字符串 = 跟随主题默认 */
  fontColor: string;
  /** 字体大小 (px), 默认 28 */
  fontSize: number;
  // setters
  setFontColor: (v: string) => void;
  setFontSize: (v: number) => void;
  reset: () => void;
}

function loadPersisted(): { fontColor: string; fontSize: number } {
  if (typeof window === 'undefined') return { fontColor: '', fontSize: 28 };
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      const size = typeof parsed.fontSize === 'number' ? parsed.fontSize : 28;
      // ★ 迁移: 旧默认值 12/16 → 新默认值 28 (用户要求直接最大)
      return {
        fontColor: typeof parsed.fontColor === 'string' ? parsed.fontColor : '',
        fontSize: size <= 16 ? 28 : size,
      };
    }
  } catch {
    // ignore
  }
  return { fontColor: '', fontSize: 28 };
}

function persist(state: { fontColor: string; fontSize: number }) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
}

const initial = loadPersisted();

export const useStreamAppearanceStore = create<StreamAppearanceState>()(
  subscribeWithSelector((set) => ({
    fontColor: initial.fontColor,
    fontSize: initial.fontSize,

    setFontColor: (v) => {
      set({ fontColor: v });
      persist(useStreamAppearanceStore.getState());
    },
    setFontSize: (v) => {
      const clamped = Math.max(10, Math.min(28, Math.round(v)));
      set({ fontSize: clamped });
      persist(useStreamAppearanceStore.getState());
    },
    reset: () => {
      set({ fontColor: '', fontSize: 28 });
      persist(useStreamAppearanceStore.getState());
    },
  })),
);

// ── HMR ──
if (import.meta.hot) {
  import.meta.hot.accept((m) => {
    if (m) useStreamAppearanceStore.setState(m.useStreamAppearanceStore.getState(), true);
  });
}
