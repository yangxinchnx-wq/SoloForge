/**
 * streamAppearanceStore — 流送区外观设置 (字体颜色 + 字体大小)
 *
 * ★ 2026-07-19 新增: 用户右键流送区可调节字体颜色和大小
 *
 * 设计要点:
 * - fontColor 为空字符串时表示"跟随主题默认" (不覆盖 --color-on-surface)
 * - fontSize 单位 px, 默认 10 (与流送区原始 text-[10px] 一致)
 * - 持久化到 localStorage, 跨会话保留
 * - subscribeWithSelector 允许组件精准订阅, 避免不必要重渲染
 */
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

const STORAGE_KEY = 'soloforge_streamAppearance';

interface StreamAppearanceState {
  /** 字体颜色 (hex/rgb), 空字符串 = 跟随主题默认 */
  fontColor: string;
  /** 字体大小 (px), 默认 10 */
  fontSize: number;
  // setters
  setFontColor: (v: string) => void;
  setFontSize: (v: number) => void;
  reset: () => void;
}

function loadPersisted(): { fontColor: string; fontSize: number } {
  if (typeof window === 'undefined') return { fontColor: '', fontSize: 10 };
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      return {
        fontColor: typeof parsed.fontColor === 'string' ? parsed.fontColor : '',
        fontSize: typeof parsed.fontSize === 'number' ? parsed.fontSize : 10,
      };
    }
  } catch {
    // ignore
  }
  return { fontColor: '', fontSize: 10 };
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
      const clamped = Math.max(8, Math.min(18, Math.round(v)));
      set({ fontSize: clamped });
      persist(useStreamAppearanceStore.getState());
    },
    reset: () => {
      set({ fontColor: '', fontSize: 10 });
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
