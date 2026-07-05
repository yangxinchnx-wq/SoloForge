/**
 * UserBadgeSelector — 顶部栏用户胶囊(头像 + 名字 + 在线点)
 *
 * 设计:
 *   - 整个胶囊是一个 div 容器(不是 button), 避免与 header 的 onHeaderMouseDown 冲突
 *   - 头像区/名字区是两个 div(也不是 button), 各自 onClick 弹出/关闭对应下拉
 *   - 下拉面板内的选项才是 button, 点击后切换并关闭
 *   - 滚轮: 在头像区/名字区上滚动可无感切换(不开下拉)
 *   - 选择持久化到 localStorage
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown } from '../../utils/icons';
import { useThemedSurface } from './themeColors';

const AVATARS = [
  '/头像/avatar1.svg',
  '/头像/avatar2.svg',
  '/头像/avatar3.svg',
  '/头像/avatar4.svg',
] as const;

const STORAGE_AVATAR = 'soloforge_user_avatar_idx';
const STORAGE_NAME = 'soloforge_user_name';

const panelVariants = {
  hidden: {
    clipPath: 'ellipse(0% 0% at 50% 0%)',
    opacity: 0,
    scale: 0.92,
    transition: { duration: 0.16, ease: [0.4, 0, 1, 1] as [number, number, number, number] },
  },
  visible: {
    clipPath: 'ellipse(150% 150% at 50% 0%)',
    opacity: 1,
    scale: 1,
    transition: {
      duration: 0.28,
      ease: [0.16, 1, 0.3, 1] as [number, number, number, number],
      staggerChildren: 0.02,
      delayChildren: 0.04,
    },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: -4 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.16, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] },
  },
};

type OpenMenu = 'avatar' | 'name' | null;

function UserBadgeSelectorImpl() {
  const { glass, isDark, rgba, statusDotBorder } = useThemedSurface();
  const [names, setNames] = useState<string[]>([]);
  const [avatarIdx, setAvatarIdx] = useState(0);
  const [name, setName] = useState('');
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const lastWheelRef = useRef(0);

  // ── 加载名字列表 ──────────────────────────────────────
  useEffect(() => {
    fetch(encodeURI('/名字/names.txt'))
      .then((r) => r.text())
      .then((text) => {
        const list = text.trim().split(/\s+/).filter(Boolean);
        setNames(list);
        const saved = localStorage.getItem(STORAGE_NAME);
        if (saved && list.includes(saved)) {
          setName(saved);
        } else if (list.length > 0) {
          setName(list[0]);
        }
      })
      .catch(() => setNames([]));
  }, []);

  // ── 恢复头像选择 ──────────────────────────────────────
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_AVATAR);
    if (saved !== null) {
      const idx = parseInt(saved, 10);
      if (idx >= 0 && idx < AVATARS.length) setAvatarIdx(idx);
    }
  }, []);

  // ── 滚轮切换(无感, 不开下拉) ────────────────────────
  const cycleAvatar = useCallback((dir: 1 | -1) => {
    setAvatarIdx((prev) => {
      const next = (prev + dir + AVATARS.length) % AVATARS.length;
      localStorage.setItem(STORAGE_AVATAR, String(next));
      return next;
    });
  }, []);

  const cycleName = useCallback((dir: 1 | -1) => {
    setName((prev) => {
      if (names.length === 0) return prev;
      const idx = names.indexOf(prev);
      const next = names[(idx + dir + names.length) % names.length];
      localStorage.setItem(STORAGE_NAME, next);
      return next;
    });
  }, [names]);

  const onAvatarWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const now = Date.now();
    if (now - lastWheelRef.current < 120) return;
    lastWheelRef.current = now;
    cycleAvatar(e.deltaY > 0 ? 1 : -1);
  }, [cycleAvatar]);

  const onNameWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const now = Date.now();
    if (now - lastWheelRef.current < 120) return;
    lastWheelRef.current = now;
    cycleName(e.deltaY > 0 ? 1 : -1);
  }, [cycleName]);

  // ── Esc + 外部点击关闭 ────────────────────────────────
  const close = useCallback(() => setOpenMenu(null), []);
  useEffect(() => {
    if (!openMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (rootRef.current.contains(e.target as Node)) return;
      close();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [openMenu, close]);

  // ── 选择 & 切换 ───────────────────────────────────────
  const selectAvatar = useCallback((idx: number) => {
    setAvatarIdx(idx);
    localStorage.setItem(STORAGE_AVATAR, String(idx));
    setOpenMenu(null);
  }, []);

  const selectName = useCallback((n: string) => {
    setName(n);
    localStorage.setItem(STORAGE_NAME, n);
    setOpenMenu(null);
  }, []);

  const toggleAvatar = useCallback(
    () => setOpenMenu((o) => (o === 'avatar' ? null : 'avatar')),
    [],
  );
  const toggleName = useCallback(
    () => setOpenMenu((o) => (o === 'name' ? null : 'name')),
    [],
  );

  // ── 样式 ──────────────────────────────────────────────
  const capsuleStyle: React.CSSProperties = {
    background: glass.brightSurfaceGradient,
    backdropFilter: 'blur(10px)',
    WebkitBackdropFilter: 'blur(10px)',
    border: `1.5px solid ${rgba('--color-primary-rgb', glass.hairlineHoverAlpha)}`,
    boxShadow: [
      `inset 0 1px 0 ${isDark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.55)'}`,
      `0 0 14px ${rgba('--color-primary-rgb', isDark ? 0.14 : 0.12)}`,
      `0 0 0 1px ${rgba('--color-primary-rgb', isDark ? 0.08 : 0.06)}`,
    ].join(', '),
  };

  const panelStyle: React.CSSProperties = {
    background: isDark ? 'var(--color-surface-bright)' : 'var(--color-surface)',
    border: `1px solid ${rgba('--color-primary-rgb', glass.hairlineAlpha)}`,
    borderRadius: 14,
    boxShadow: `${glass.ambientShadow}, ${glass.tightShadow}, inset 0 1px 0 ${isDark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.55)'}`,
  };

  return (
    <div
      ref={rootRef}
      className={`relative flex items-center gap-3 h-11 pl-1.5 pr-4 mr-12 rounded-full ${openMenu ? 'z-50' : 'z-10'}`}
      style={capsuleStyle}
    >
      {/* ── 头像容器(点击弹出下拉 · 滚轮切换) ─────────── */}
      <div
        role="button"
        tabIndex={0}
        aria-haspopup="listbox"
        aria-expanded={openMenu === 'avatar'}
        aria-label="选择头像(滚轮可切换)"
        title="点击选择 · 滚轮切换"
        onClick={toggleAvatar}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleAvatar(); } }}
        onWheel={onAvatarWheel}
        className="relative z-50 shrink-0 cursor-pointer rounded-full"
        style={{ width: 36, height: 36 }}
      >
        <img
          key={avatarIdx}
          src={AVATARS[avatarIdx]}
          alt="用户头像"
          className="w-9 h-9 rounded-full object-cover pointer-events-none"
          style={{
            boxShadow: `${isDark ? '0 2px 8px rgba(0,0,0,0.30)' : '0 2px 8px rgba(0,0,0,0.08)'}, inset 0 1px 0 ${isDark ? 'rgba(255,255,255,0.30)' : 'rgba(255,255,255,0.45)'}`,
          }}
          draggable={false}
        />
        {/* 在线状态点 */}
        <span
          className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full pointer-events-none"
          style={{
            background: '#22c55e',
            border: `2px solid ${statusDotBorder}`,
            boxShadow: '0 0 0 1px rgba(34,197,94,0.35)',
          }}
        />
      </div>

      {/* ── 名字容器(点击弹出下拉 · 滚轮切换) ─────────── */}
      <div
        role="button"
        tabIndex={0}
        aria-haspopup="listbox"
        aria-expanded={openMenu === 'name'}
        aria-label="选择名字(滚轮可切换)"
        title="点击选择 · 滚轮切换"
        onClick={toggleName}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleName(); } }}
        onWheel={onNameWheel}
        className="relative z-50 flex flex-col items-start leading-none cursor-pointer rounded-lg"
      >
        <div className="flex items-center gap-1">
          <span
            className="inline-block pointer-events-none"
            style={{
              fontSize: 14,
              fontWeight: 700,
              color: 'var(--color-on-surface)',
              letterSpacing: '-0.005em',
              maxWidth: 120,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {name || '—'}
          </span>
          <motion.span
            aria-hidden="true"
            initial={false}
            animate={{ rotate: openMenu === 'name' ? 180 : 0 }}
            transition={{ type: 'spring', stiffness: 500, damping: 30 }}
            className="flex items-center justify-center shrink-0 pointer-events-none"
          >
            <ChevronDown className="w-3 h-3 text-on-surface/40" />
          </motion.span>
        </div>
        <span
          className="font-mono pointer-events-none"
          style={{
            fontSize: 9,
            fontWeight: 600,
            letterSpacing: '0.10em',
            textTransform: 'uppercase',
            color: '#22c55e',
            marginTop: 3,
          }}
        >
          online
        </span>
      </div>

      {/* ── 头像下拉框 ──────────────────────────────── */}
      <AnimatePresence>
        {openMenu === 'avatar' && (
          <motion.div
            key="panel-avatar"
            role="listbox"
            aria-label="选择头像"
            variants={panelVariants}
            initial="hidden"
            animate="visible"
            exit="hidden"
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              ...panelStyle,
              transformOrigin: '50% 0%',
              willChange: 'clip-path, transform, opacity',
              backfaceVisibility: 'hidden',
              WebkitBackfaceVisibility: 'hidden',
              zIndex: 60,
            }}
            className="absolute left-0 top-full mt-3 p-2 flex gap-2"
          >
            {AVATARS.map((src, idx) => (
              <motion.button
                key={idx}
                type="button"
                role="option"
                aria-selected={avatarIdx === idx}
                aria-label={`头像 ${idx + 1}`}
                variants={itemVariants}
                onClick={() => selectAvatar(idx)}
                whileHover={{ scale: 1.08 }}
                whileTap={{ scale: 0.94 }}
                transition={{ type: 'spring', stiffness: 700, damping: 28 }}
                className="relative shrink-0 rounded-xl overflow-hidden cursor-pointer"
                style={{
                  border: avatarIdx === idx
                    ? `2px solid var(--color-primary)`
                    : `2px solid transparent`,
                  boxShadow: avatarIdx === idx
                    ? `0 0 0 2px ${rgba('--color-primary-rgb', 0.25)}`
                    : 'none',
                }}
              >
                <img src={src} alt={`头像 ${idx + 1}`} className="w-12 h-12 object-cover" draggable={false} />
              </motion.button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── 名字下拉框 ──────────────────────────────── */}
      <AnimatePresence>
        {openMenu === 'name' && (
          <motion.div
            key="panel-name"
            role="listbox"
            aria-label="选择名字"
            variants={panelVariants}
            initial="hidden"
            animate="visible"
            exit="hidden"
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              ...panelStyle,
              transformOrigin: '50% 0%',
              willChange: 'clip-path, transform, opacity',
              backfaceVisibility: 'hidden',
              WebkitBackfaceVisibility: 'hidden',
              zIndex: 60,
            }}
            className="absolute left-0 top-full mt-3 p-1 flex flex-col gap-0.5 max-h-64 overflow-y-auto"
          >
            {names.length === 0 ? (
              <div className="px-3 py-4 text-center text-[11px] text-on-surface/55 select-none">
                名字加载中…
              </div>
            ) : (
              names.map((n, idx) => {
                const isSelected = name === n;
                return (
                  <motion.button
                    key={idx}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    variants={itemVariants}
                    onClick={() => selectName(n)}
                    whileHover={{ x: 2 }}
                    transition={{ type: 'spring', stiffness: 700, damping: 30 }}
                    className={`relative w-full text-left px-3 py-2 rounded-lg text-xs font-semibold flex items-center justify-between select-none cursor-pointer hover:bg-primary/10 ${
                      isSelected
                        ? 'text-primary font-bold'
                        : 'text-[var(--color-on-surface)]/80 hover:text-[var(--color-on-surface)]'
                    }`}
                  >
                    <span>{n}</span>
                    {isSelected && (
                      <motion.span
                        initial={{ scale: 0 }}
                        animate={{ scale: 1 }}
                        transition={{ type: 'spring', stiffness: 700, damping: 24 }}
                        className="w-1.5 h-1.5 rounded-full bg-primary"
                      />
                    )}
                  </motion.button>
                );
              })
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export const UserBadgeSelector = memo(UserBadgeSelectorImpl);
UserBadgeSelector.displayName = 'UserBadgeSelector';
