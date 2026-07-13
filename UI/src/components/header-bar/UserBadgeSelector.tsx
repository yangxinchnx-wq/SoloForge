/**
 * UserBadgeSelector — 顶部栏用户胶囊(头像 + 名字)
 *
 * 设计:
 *   - 整个胶囊是一个 div 容器(不是 button), 避免与 header 的 onHeaderMouseDown 冲突
 *   - 头像区/名字区是两个 div(也不是 button), 各自 onClick 弹出/关闭对应下拉
 *   - 下拉面板内的选项才是 button, 点击后切换并关闭
 *   - 滚轮: 在头像区/名字区上滚动可无感切换(不开下拉)
 *   - 双击名称: 进入自定义编辑模式, 输入文字回车保存到 names.txt [CUSTOM] 槽位
 *   - 选择持久化到 localStorage
 *
 * 名称优先级: customName (双击自定义) > localStorage.savedName > '问剑白玉京' > list[0]
 * names.txt 格式: "原名称1 原名称2 ... [CUSTOM] 自定义名称"
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, Plus } from '../../utils/icons';
import { useThemedSurface } from './themeColors';

const AVATARS = [
  '/头像/avatar1.svg',
  '/头像/avatar2.svg',
  '/头像/avatar3.svg',
  '/头像/avatar4.svg',
] as const;

const STORAGE_AVATAR = 'soloforge_user_avatar_idx';
const STORAGE_NAME = 'soloforge_user_name';
const STORAGE_CUSTOM_AVATAR = 'soloforge_user_custom_avatar';
const STORAGE_USE_CUSTOM_AVATAR = 'soloforge_user_use_custom_avatar';
const DEFAULT_NAME = '问剑白玉京';

// 允许上传的图片 MIME 类型白名单 (拒绝音乐、视频、可执行等)
const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'];
const MAX_AVATAR_SIZE = 2 * 1024 * 1024; // 2MB

type OpenMenu = 'avatar' | 'name' | null;

function UserBadgeSelectorImpl() {
  const { glass, isDark, rgba } = useThemedSurface();
  const [names, setNames] = useState<string[]>([]);
  const [customName, setCustomName] = useState<string>('');
  const [avatarIdx, setAvatarIdx] = useState(0);
  const [customAvatar, setCustomAvatar] = useState<string>('');
  const [useCustomAvatar, setUseCustomAvatar] = useState(false);
  const [name, setName] = useState('');
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const lastWheelRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const editValueRef = useRef('');
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── 加载名字列表 + 自定义名称 ──────────────────────────
  useEffect(() => {
    fetch(encodeURI('/名字/names.txt'))
      .then((r) => r.text())
      .then((text) => {
        // 按 [CUSTOM] 分割: 前部是原列表, 后部是自定义名称槽位
        const [origPart, customPart] = text.split(/\[CUSTOM\]/);
        const list = (origPart || '').trim().split(/\s+/).filter(Boolean);
        const custom = (customPart || '').trim();
        setNames(list);
        if (custom) setCustomName(custom);

        // 默认名称优先级: customName > localStorage.savedName > DEFAULT_NAME > list[0]
        const saved = localStorage.getItem(STORAGE_NAME);
        if (custom) {
          setName(custom);
        } else if (saved && list.includes(saved)) {
          setName(saved);
        } else if (list.includes(DEFAULT_NAME)) {
          setName(DEFAULT_NAME);
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
    const savedCustom = localStorage.getItem(STORAGE_CUSTOM_AVATAR);
    if (savedCustom) setCustomAvatar(savedCustom);
    const savedUseCustom = localStorage.getItem(STORAGE_USE_CUSTOM_AVATAR);
    if (savedUseCustom === 'true' && savedCustom) setUseCustomAvatar(true);
  }, []);

  // ── 上传自定义头像 ─────────────────────────────────────
  // 校验: 仅允许图片 MIME, ≤2MB; 拒绝音乐/视频/可执行等
  const handleAvatarUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
      alert('仅支持上传图片文件 (PNG / JPEG / WebP / GIF / SVG)');
      e.target.value = '';
      return;
    }
    if (file.size > MAX_AVATAR_SIZE) {
      alert('头像文件过大, 请控制在 2MB 以内');
      e.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      setCustomAvatar(dataUrl);
      setUseCustomAvatar(true);
      localStorage.setItem(STORAGE_CUSTOM_AVATAR, dataUrl);
      localStorage.setItem(STORAGE_USE_CUSTOM_AVATAR, 'true');
      window.dispatchEvent(new CustomEvent('soloforge-user-badge-updated'));
    };
    reader.onerror = () => alert('头像读取失败, 请重试');
    reader.readAsDataURL(file);
    e.target.value = '';
  }, []);

  const removeCustomAvatar = useCallback(() => {
    setCustomAvatar('');
    setUseCustomAvatar(false);
    localStorage.removeItem(STORAGE_CUSTOM_AVATAR);
    localStorage.removeItem(STORAGE_USE_CUSTOM_AVATAR);
    window.dispatchEvent(new CustomEvent('soloforge-user-badge-updated'));
  }, []);

  // ── 编辑模式: 自动聚焦 input ──────────────────────────
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  // ── 滚轮切换(无感, 不开下拉) ────────────────────────
  const cycleAvatar = useCallback((dir: 1 | -1) => {
    if (useCustomAvatar) {
      setUseCustomAvatar(false);
      localStorage.removeItem(STORAGE_USE_CUSTOM_AVATAR);
    }
    setAvatarIdx((prev) => {
      const next = (prev + dir + AVATARS.length) % AVATARS.length;
      localStorage.setItem(STORAGE_AVATAR, String(next));
      window.dispatchEvent(new CustomEvent('soloforge-user-badge-updated'));
      return next;
    });
  }, [useCustomAvatar]);

  // 清除 [CUSTOM] 槽位 (用户选择列表名称 / 滚轮切换时调用)
  const clearCustomSlot = useCallback(() => {
    if (!customName) return;
    setCustomName('');
    fetch('/api/names/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customName: '' }),
    }).catch((err) => console.error('[UserBadgeSelector] 清除自定义名称失败', err));
  }, [customName]);

  const cycleName = useCallback((dir: 1 | -1) => {
    setName((prev) => {
      if (names.length === 0) return prev;
      const idx = names.indexOf(prev);
      const next = names[(idx + dir + names.length) % names.length];
      localStorage.setItem(STORAGE_NAME, next);
      window.dispatchEvent(new CustomEvent('soloforge-user-badge-updated'));
      return next;
    });
    clearCustomSlot();
  }, [names, clearCustomSlot]);

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
    if (!openMenu && !isEditing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (isEditing) {
          editValueRef.current = '';
          setIsEditing(false);
        } else {
          close();
        }
      }
    };
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (rootRef.current.contains(e.target as Node)) return;
      if (isEditing) {
        // 外部点击触发保存 (blur 也会触发, 但这里兜底)
        return;
      }
      close();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [openMenu, isEditing, close]);

  // ── 选择 & 切换 ───────────────────────────────────────
  const selectAvatar = useCallback((idx: number) => {
    setAvatarIdx(idx);
    setUseCustomAvatar(false);
    localStorage.setItem(STORAGE_AVATAR, String(idx));
    localStorage.removeItem(STORAGE_USE_CUSTOM_AVATAR);
    setOpenMenu(null);
    window.dispatchEvent(new CustomEvent('soloforge-user-badge-updated'));
  }, []);

  const selectName = useCallback((n: string) => {
    setName(n);
    localStorage.setItem(STORAGE_NAME, n);
    clearCustomSlot();
    setOpenMenu(null);
    window.dispatchEvent(new CustomEvent('soloforge-user-badge-updated'));
  }, [clearCustomSlot]);

  const toggleAvatar = useCallback(
    () => setOpenMenu((o) => (o === 'avatar' ? null : 'avatar')),
    [],
  );
  const toggleName = useCallback(
    () => setOpenMenu((o) => (o === 'name' ? null : 'name')),
    [],
  );

  // ── 双击自定义编辑 ───────────────────────────────────
  const startEditing = useCallback(() => {
    setEditValue(name);
    editValueRef.current = name;
    setIsEditing(true);
    setOpenMenu(null);
  }, [name]);

  const saveEdit = useCallback(async () => {
    const trimmed = editValueRef.current.trim();
    if (!trimmed || trimmed === name) {
      setIsEditing(false);
      return;
    }
    try {
      const res = await fetch('/api/names/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customName: trimmed }),
      });
      if (res.ok) {
        setCustomName(trimmed);
        setName(trimmed);
        window.dispatchEvent(new CustomEvent('soloforge-user-badge-updated'));
      } else {
        console.error('[UserBadgeSelector] 保存自定义名称失败', res.status);
      }
    } catch (err) {
      console.error('[UserBadgeSelector] 保存自定义名称失败', err);
    }
    setIsEditing(false);
  }, [name]);

  const handleEditKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      saveEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      editValueRef.current = '';
      setIsEditing(false);
    }
  }, [saveEdit]);

  const handleEditChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setEditValue(e.target.value);
    editValueRef.current = e.target.value;
  }, []);

  // ── 单击/双击区分 (200ms 延迟检测) ────────────────────
  const handleNameClick = useCallback(() => {
    if (clickTimerRef.current) return;
    clickTimerRef.current = setTimeout(() => {
      clickTimerRef.current = null;
      toggleName();
    }, 200);
  }, [toggleName]);

  const handleNameDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    startEditing();
  }, [startEditing]);

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
          key={useCustomAvatar ? 'custom' : avatarIdx}
          src={useCustomAvatar && customAvatar ? customAvatar : AVATARS[avatarIdx]}
          alt="用户头像"
          className="w-9 h-9 rounded-full object-cover pointer-events-none"
          style={{
            boxShadow: `${isDark ? '0 2px 8px rgba(0,0,0,0.30)' : '0 2px 8px rgba(0,0,0,0.08)'}, inset 0 1px 0 ${isDark ? 'rgba(255,255,255,0.30)' : 'rgba(255,255,255,0.45)'}`,
          }}
          draggable={false}
        />
      </div>

      {/* ── 名字容器(点击弹出下拉 · 滚轮切换 · 双击自定义) ─────────── */}
      <div
        role="button"
        tabIndex={0}
        aria-haspopup="listbox"
        aria-expanded={openMenu === 'name'}
        aria-label="选择名字(滚轮可切换, 双击自定义)"
        title="点击选择 · 滚轮切换 · 双击自定义"
        onClick={handleNameClick}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleName(); } }}
        onWheel={onNameWheel}
        onDoubleClick={handleNameDoubleClick}
        className="relative z-50 flex flex-col items-start leading-none cursor-pointer rounded-lg"
      >
        <div className="flex items-center gap-1">
          {isEditing ? (
            <input
              ref={inputRef}
              type="text"
              value={editValue}
              onChange={handleEditChange}
              onKeyDown={handleEditKeyDown}
              onBlur={saveEdit}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              onWheel={(e) => e.stopPropagation()}
              className="bg-transparent outline-none border-b"
              style={{
                fontSize: 14,
                fontWeight: 700,
                color: 'var(--color-on-surface)',
                letterSpacing: '-0.005em',
                maxWidth: 160,
                borderColor: 'var(--color-primary)',
                background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
              }}
            />
          ) : (
            <span
              className="inline-block pointer-events-none"
              style={{
                fontSize: 14,
                fontWeight: 700,
                color: customName ? 'var(--color-primary)' : 'var(--color-on-surface)',
                letterSpacing: '-0.005em',
                maxWidth: 120,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {name || '—'}
            </span>
          )}
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
      </div>

      {/* ── 头像下拉框 ──────────────────────────────── */}
      <AnimatePresence>
        {openMenu === 'avatar' && (
          <motion.div
            key="panel-avatar"
            role="listbox"
            aria-label="选择头像"
            initial={{ opacity: 0, scale: 0.94, y: -3 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.94, y: -3 }}
            transition={{ duration: 0.1, ease: [0.16, 1, 0.3, 1] }}
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              ...panelStyle,
              transformOrigin: 'right top',
              zIndex: 60,
            }}
            className="absolute right-0 top-full mt-3 p-2 rounded-xl"
            style={{ ...panelStyle, transformOrigin: 'right top', zIndex: 60, width: 248 }}
          >
            <div className="flex gap-2 overflow-x-auto overflow-y-hidden scrollbar-none" style={{ maxHeight: 60 }}>
              {AVATARS.map((src, idx) => (
                <motion.button
                  key={idx}
                  type="button"
                  role="option"
                  aria-selected={avatarIdx === idx}
                  aria-label={`头像 ${idx + 1}`}
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1], delay: idx * 0.02 }}
                  onClick={() => selectAvatar(idx)}
                  whileHover={{ scale: 1.08 }}
                  whileTap={{ scale: 0.94 }}
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
              {/* 自定义头像 (已上传) */}
              {customAvatar && (
                <motion.button
                  key="custom-avatar"
                  type="button"
                  role="option"
                  aria-selected={false}
                  aria-label="自定义头像 (右键移除)"
                  title="点击应用 · 右键移除"
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1], delay: AVATARS.length * 0.02 }}
                  onClick={() => {
                    setUseCustomAvatar(true);
                    localStorage.setItem(STORAGE_USE_CUSTOM_AVATAR, 'true');
                    setOpenMenu(null);
                    window.dispatchEvent(new CustomEvent('soloforge-user-badge-updated'));
                  }}
                  onContextMenu={(e) => { e.preventDefault(); removeCustomAvatar(); }}
                  whileHover={{ scale: 1.08 }}
                  whileTap={{ scale: 0.94 }}
                  className="relative shrink-0 rounded-xl overflow-hidden cursor-pointer"
                  style={{ border: '2px solid var(--color-primary)' }}
                >
                  <img src={customAvatar} alt="自定义头像" className="w-12 h-12 object-cover" draggable={false} />
                </motion.button>
              )}
              {/* 上传按钮 — 虚线轮廓, 主题色 */}
              <motion.button
                key="upload-avatar"
                type="button"
                aria-label="上传自定义头像"
                title="上传自定义头像 (PNG / JPEG / WebP / GIF / SVG, ≤2MB)"
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1], delay: (AVATARS.length + 1) * 0.02 }}
                onClick={() => fileInputRef.current?.click()}
                whileHover={{ scale: 1.08 }}
                whileTap={{ scale: 0.94 }}
                className="relative shrink-0 rounded-xl overflow-hidden cursor-pointer w-12 h-12 flex items-center justify-center"
                style={{
                  border: `2px dashed var(--color-primary)`,
                  color: 'var(--color-primary)',
                  background: rgba('--color-primary-rgb', 0.06),
                }}
              >
                <Plus className="w-5 h-5" />
              </motion.button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                onChange={handleAvatarUpload}
                className="hidden"
              />
            </div>
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
            initial={{ opacity: 0, scale: 0.94, y: -3 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.94, y: -3 }}
            transition={{ duration: 0.1, ease: [0.16, 1, 0.3, 1] }}
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              ...panelStyle,
              transformOrigin: '20% 0%',
              zIndex: 60,
            }}
            className="absolute right-0 top-full mt-3 p-1 flex flex-col gap-0.5 max-h-64 overflow-y-auto w-max min-w-[160px] max-w-[90vw]"
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
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.1, ease: [0.22, 1, 0.36, 1], delay: Math.min(idx * 0.008, 0.08) }}
                    onClick={() => selectName(n)}
                    whileHover={{ x: 2 }}
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
