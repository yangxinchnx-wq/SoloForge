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

const DEFAULT_AVATARS = [
  '/头像/avatar1.svg',
  '/头像/avatar2.svg',
  '/头像/avatar3.svg',
  '/头像/avatar4.svg',
];

const AVATAR_DIR = 'UI/public/头像';
const AVATAR_BASE_URL = '/头像';

const STORAGE_AVATAR = 'soloforge_user_avatar_idx';
const STORAGE_NAME = 'soloforge_user_name';
const STORAGE_CUSTOM_AVATAR = 'soloforge_user_custom_avatar';
const STORAGE_USE_CUSTOM_AVATAR = 'soloforge_user_use_custom_avatar';
const DEFAULT_NAME = '问剑白玉京';

// 允许上传的图片 MIME 类型白名单 (拒绝音乐、视频、可执行等)
const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'];
const MAX_AVATAR_SIZE = 2 * 1024 * 1024; // 2MB

type OpenMenu = 'avatar' | 'name' | null;

// ── 下拉动画 variants (复用协同副模型 SecondaryModelSelector 的方案) ──
// 柔和推出: y 大位移 + opacity 同步淡入 + scale 微调
//   - 开启: 380ms ease-out-expo, 慢启动消除突兀, 长尾缓停丝滑
//   - 关闭: 140ms 快速收起
const panelVariants = {
  hidden: {
    opacity: 0,
    scale: 0.94,
    y: 20,
    transition: {
      duration: 0.14,
      ease: [0.4, 0, 1, 1] as [number, number, number, number],
    },
  },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: {
      duration: 0.38,
      ease: [0.16, 1, 0.3, 1] as [number, number, number, number],
    },
  },
};

const contentVariants = {
  hidden: { opacity: 1 },
  visible: {
    opacity: 1,
    transition: { duration: 0 },
  },
};

const backdropVariants = {
  hidden: { opacity: 0, transition: { duration: 0.18, ease: [0.4, 0, 1, 1] as [number, number, number, number] } },
  visible: { opacity: 1, transition: { duration: 0.22, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] } },
};

// 名字下拉框专用: 比面板标准动画快一倍 (开启 190ms / 关闭 70ms)
const fastPanelVariants = {
  hidden: {
    opacity: 0,
    scale: 0.94,
    y: 10,
    transition: {
      duration: 0.07,
      ease: [0.4, 0, 1, 1] as [number, number, number, number],
    },
  },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: {
      duration: 0.19,
      ease: [0.16, 1, 0.3, 1] as [number, number, number, number],
    },
  },
};

function UserBadgeSelectorImpl() {
  const { glass, isDark, rgba } = useThemedSurface();
  const [names, setNames] = useState<string[]>([]);
  const [customName, setCustomName] = useState<string>('');
  const [avatars, setAvatars] = useState<string[]>(DEFAULT_AVATARS);
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

  // ── 动态加载头像列表 ────────────────────────────────
  useEffect(() => {
    fetch(`/api/files/list?dir=${encodeURIComponent(AVATAR_DIR)}`)
      .then((r) => r.json())
      .then((data) => {
        if (data?.success && Array.isArray(data.files)) {
          const IMAGE_EXTS = ['.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'];
          const imageFiles = data.files
            .filter((f: any) => f.type === 'file' && IMAGE_EXTS.some(ext => f.name.toLowerCase().endsWith(ext)))
            .sort((a: any, b: any) => a.name.localeCompare(b.name))
            .map((f: any) => `${AVATAR_BASE_URL}/${f.name}`);
          if (imageFiles.length > 0) setAvatars(imageFiles);
        }
      })
      .catch(() => {});
  }, []);

  // ── 恢复头像选择 ──────────────────────────────────────
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_AVATAR);
    if (saved !== null) {
      const idx = parseInt(saved, 10);
      if (idx >= 0 && idx < avatars.length) setAvatarIdx(idx);
    }
    const savedCustom = localStorage.getItem(STORAGE_CUSTOM_AVATAR);
    if (savedCustom) setCustomAvatar(savedCustom);
    const savedUseCustom = localStorage.getItem(STORAGE_USE_CUSTOM_AVATAR);
    if (savedUseCustom === 'true' && savedCustom) setUseCustomAvatar(true);
  }, [avatars]);

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
      const next = (prev + dir + avatars.length) % avatars.length;
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

  // ── 单击/双击区分 (120ms 延迟检测) ────────────────────
  const handleNameClick = useCallback(() => {
    if (clickTimerRef.current) return;
    clickTimerRef.current = setTimeout(() => {
      clickTimerRef.current = null;
      toggleName();
    }, 120);
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
      className={`relative flex items-center gap-3 h-11 pl-1.5 pr-4 mr-12 ${openMenu ? 'z-50' : 'z-10'}`}
      style={capsuleStyle}
    >
      {/* ── 头像容器(点击弹出下拉 · 滚轮切换) ─────────── */}
      <div
        role="button"
        tabIndex={0}
        aria-haspopup="listbox"
        aria-expanded={openMenu === 'avatar'}
        aria-label="选择头像(滚轮可切换)"
        onClick={toggleAvatar}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleAvatar(); } }}
        onWheel={onAvatarWheel}
        className="relative z-50 shrink-0 cursor-pointer overflow-hidden"
        style={{
          width: 36,
          height: 36,
          borderRadius: 10,
          boxShadow: [
            'inset 0 0 0 0.5px rgba(0,0,0,0.20)',
            `0 0 6px ${isDark ? 'rgba(0,0,0,0.18)' : 'rgba(0,0,0,0.06)'}`,
            '2px 3px 5px rgba(0,0,0,0.08)',
          ].join(', '),
        }}
      >
        <img
          key={useCustomAvatar ? 'custom' : avatarIdx}
          src={useCustomAvatar && customAvatar ? customAvatar : avatars[avatarIdx] ?? avatars[0]}
          alt="用户头像"
          className="w-9 h-9 object-cover pointer-events-none"
          title={useCustomAvatar ? '自定义头像 (上传)' : `UI/public/头像/${(avatars[avatarIdx] ?? avatars[0]).split('/').pop()}\n点击选择 · 滚轮切换`}
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

      {/* ── 头像下拉框 (复用协同副模型动画方案) ──────────────────────────────── */}
      <AnimatePresence>
        {openMenu === 'avatar' && (
          <>
            {/* 透明 backdrop 承载 click-outside */}
            <motion.div
              key="backdrop-avatar"
              variants={backdropVariants}
              initial="hidden"
              animate="visible"
              exit="hidden"
              className="fixed inset-0 z-40 cursor-default"
              onClick={() => setOpenMenu(null)}
            />
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
                transform: 'translateZ(0)',
                backfaceVisibility: 'hidden',
                WebkitBackfaceVisibility: 'hidden',
                zIndex: 50,
              }}
              className="absolute right-0 top-full mt-3.5 p-2 flex gap-2 w-max rounded-2xl shadow-[0_24px_64px_rgba(0,0,0,0.15)]"
            >
              <motion.div variants={contentVariants} className="flex gap-2">
                {avatars.map((src, idx) => {
                  const fileName = src.split('/').pop() ?? src;
                  const tooltip = `UI/public/头像/${fileName}\n点击选择 · 拖拽上传自定义头像`;
                  return (
                  <button
                    key={idx}
                    type="button"
                    role="option"
                    aria-selected={avatarIdx === idx}
                    aria-label={`头像 ${idx + 1}`}
                    title={tooltip}
                    onClick={() => selectAvatar(idx)}
                    className="relative shrink-0 overflow-hidden cursor-pointer transition-transform duration-200 hover:scale-110 active:scale-95"
                  >
                    <img src={src} alt={`头像 ${idx + 1}`} className="w-12 h-12 object-cover" draggable={false} />
                  </button>
                  );
                })}
                {/* 自定义头像 (已上传) */}
                {customAvatar && (
                  <button
                    key="custom-avatar"
                    type="button"
                    role="option"
                    aria-selected={false}
                    aria-label="自定义头像 (右键移除)"
                    title="点击应用 · 右键移除"
                    onClick={() => {
                      setUseCustomAvatar(true);
                      localStorage.setItem(STORAGE_USE_CUSTOM_AVATAR, 'true');
                      setOpenMenu(null);
                      window.dispatchEvent(new CustomEvent('soloforge-user-badge-updated'));
                    }}
                    onContextMenu={(e) => { e.preventDefault(); removeCustomAvatar(); }}
                    className="relative shrink-0 overflow-hidden cursor-pointer transition-transform duration-200 hover:scale-110 active:scale-95"
                  >
                    <img src={customAvatar} alt="自定义头像" className="w-12 h-12 object-cover" draggable={false} />
                  </button>
                )}
                {/* 上传按钮 */}
                <button
                  key="upload-avatar"
                  type="button"
                  aria-label="上传自定义头像"
                  title="上传自定义头像 (PNG / JPEG / WebP / GIF / SVG, ≤2MB)"
                  onClick={() => fileInputRef.current?.click()}
                  className="relative shrink-0 overflow-hidden cursor-pointer w-12 h-12 flex items-center justify-center transition-transform duration-200 hover:scale-110 active:scale-95"
                  style={{
                    color: 'var(--color-primary)',
                    background: rgba('--color-primary-rgb', 0.06),
                  }}
                >
                  <Plus className="w-5 h-5" />
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                  onChange={handleAvatarUpload}
                  className="hidden"
                />
              </motion.div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* ── 名字下拉框 (复用协同副模型动画方案) ──────────────────────────────── */}
      <AnimatePresence>
        {openMenu === 'name' && (
          <>
            {/* 透明 backdrop 承载 click-outside */}
            <motion.div
              key="backdrop-name"
              variants={backdropVariants}
              initial="hidden"
              animate="visible"
              exit="hidden"
              className="fixed inset-0 z-40 cursor-default"
              onClick={() => setOpenMenu(null)}
            />
            <motion.div
              key="panel-name"
              role="listbox"
              aria-label="选择名字"
              variants={fastPanelVariants}
              initial="hidden"
              animate="visible"
              exit="hidden"
              onMouseDown={(e) => e.stopPropagation()}
              style={{
                ...panelStyle,
                transformOrigin: '20% 0%',
                willChange: 'clip-path, transform, opacity',
                transform: 'translateZ(0)',
                backfaceVisibility: 'hidden',
                WebkitBackfaceVisibility: 'hidden',
                zIndex: 50,
              }}
              className="absolute right-0 top-full mt-3.5 p-1 flex flex-col gap-0.5 max-h-64 overflow-y-auto w-max min-w-[160px] max-w-[90vw] rounded-2xl shadow-[0_24px_64px_rgba(0,0,0,0.15)]"
            >
              <motion.div variants={contentVariants} className="flex flex-col gap-0.5">
                {names.length === 0 ? (
                  <div className="px-3 py-4 text-center text-[11px] text-on-surface/55 select-none">
                    名字加载中…
                  </div>
                ) : (
                  names.map((n, idx) => {
                    const isSelected = name === n;
                    return (
                      <button
                        key={idx}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        onClick={() => selectName(n)}
                        className={`relative w-full text-left px-3 py-2 rounded-lg text-xs font-semibold flex items-center justify-between select-none cursor-pointer hover:bg-primary/10 transition-colors duration-200 hover:translate-x-0.5 ${
                          isSelected
                            ? 'text-primary font-bold'
                            : 'text-[var(--color-on-surface)]/80 hover:text-[var(--color-on-surface)]'
                        }`}
                      >
                        <span>{n}</span>
                        {isSelected && (
                          <span className="w-1.5 h-1.5 rounded-full bg-primary" />
                        )}
                      </button>
                    );
                  })
                )}
              </motion.div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

export const UserBadgeSelector = memo(UserBadgeSelectorImpl);
UserBadgeSelector.displayName = 'UserBadgeSelector';
