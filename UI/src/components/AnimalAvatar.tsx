/**
 * AnimalAvatar — 纯小动物 SVG 图标库 + 用户自定义图标支持
 *
 * 功能:
 *   1. 20 个内置小动物 SVG 图标，鼠标悬停显示动物名称
 *   2. 支持用户上传自定义图标 (PNG/JPG/SVG/WebP/GIF)
 *   3. 内置格式检查器：尺寸/格式不符时自动用 canvas 重绘为 64×64 PNG
 *   4. 图标注册表持久化到 localStorage，支持删除与自动补位
 *
 * iconType 格式:
 *   - 'animal:<id>':  内置动物 (如 'animal:cat')
 *   - 'custom:<dataUrl>': 用户上传 (如 'custom:data:image/png;base64,...')
 */

import React from 'react';

// =====================================================
//  内置动物定义 (20 种)
// =====================================================

export interface BuiltinAnimal {
  id: string;
  name: string;   // 中文名，用于 hover tooltip
}

export const BUILTIN_ANIMALS: BuiltinAnimal[] = [
  { id: 'cat',      name: '猫咪' },
  { id: 'dog',      name: '小狗' },
  { id: 'fox',      name: '狐狸' },
  { id: 'panda',    name: '熊猫' },
  { id: 'owl',      name: '猫头鹰' },
  { id: 'penguin',  name: '企鹅' },
  { id: 'lion',     name: '狮子' },
  { id: 'tiger',    name: '老虎' },
  { id: 'rabbit',   name: '兔子' },
  { id: 'bear',     name: '小熊' },
  { id: 'frog',     name: '青蛙' },
  { id: 'whale',    name: '鲸鱼' },
  { id: 'butterfly',name: '蝴蝶' },
  { id: 'bird',     name: '小鸟' },
  { id: 'hamster',  name: '仓鼠' },
  { id: 'hedgehog', name: '刺猬' },
  { id: 'raccoon',  name: '浣熊' },
  { id: 'turtle',   name: '乌龟' },
  { id: 'octopus',  name: '章鱼' },
  { id: 'koala',    name: '考拉' },
  { id: 'sheep',    name: '小羊' },
  { id: 'sun',      name: '太阳' },
  { id: 'moon',     name: '月亮' },
  { id: 'corn',     name: '玉米' },
  { id: 'pig',      name: '小猪' },
  { id: 'horse',    name: '小马' },
  { id: 'cow',      name: '小牛' },
  { id: 'elephant', name: '大象' },
  { id: 'goose',    name: '大鹅' },
];

export const ANIMAL_IDS = BUILTIN_ANIMALS.map(a => a.id) as unknown as readonly string[];
export type AnimalId = typeof BUILTIN_ANIMALS[number]['id'];

const ANIMAL_NAME_MAP: Record<string, string> = Object.fromEntries(
  BUILTIN_ANIMALS.map(a => [a.id, a.name])
);

// ── 兼容旧导出 ──
export const getAnimalName = (id: string): string => ANIMAL_NAME_MAP[id] ?? id;

// =====================================================
//  配色
// =====================================================

const PALETTES: Record<string, { bg: string; fg: string; accent: string }> = {
  cat:       { bg: '#f59e0b', fg: '#1e293b', accent: '#fbbf24' },
  dog:       { bg: '#d97706', fg: '#fef3c7', accent: '#92400e' },
  fox:       { bg: '#f97316', fg: '#fff7ed', accent: '#ea580c' },
  panda:     { bg: '#0f172a', fg: '#f8fafc', accent: '#334155' },
  owl:       { bg: '#7c3aed', fg: '#f5f3ff', accent: '#a78bfa' },
  penguin:   { bg: '#1e3a5f', fg: '#f1f5f9', accent: '#fbbf24' },
  lion:      { bg: '#eab308', fg: '#422006', accent: '#facc15' },
  tiger:     { bg: '#f97316', fg: '#1c1917', accent: '#fb923c' },
  rabbit:    { bg: '#f472b6', fg: '#831843', accent: '#fbcfe8' },
  bear:      { bg: '#92400e', fg: '#fef3c7', accent: '#b45309' },
  frog:      { bg: '#16a34a', fg: '#052e16', accent: '#4ade80' },
  whale:     { bg: '#0284c7', fg: '#f0f9ff', accent: '#38bdf8' },
  butterfly: { bg: '#a855f7', fg: '#fdf4ff', accent: '#f0abfc' },
  bird:      { bg: '#0ea5e9', fg: '#f0f9ff', accent: '#7dd3fc' },
  hamster:   { bg: '#d4a574', fg: '#451a03', accent: '#fbbf24' },
  hedgehog:  { bg: '#78716c', fg: '#f5f5f4', accent: '#a8a29e' },
  raccoon:   { bg: '#52525b', fg: '#fafafa', accent: '#a1a1aa' },
  turtle:    { bg: '#15803d', fg: '#f0fdf4', accent: '#4ade80' },
  octopus:   { bg: '#be185d', fg: '#fdf2f8', accent: '#f472b6' },
  koala:     { bg: '#6b7280', fg: '#f9fafb', accent: '#9ca3af' },
  sheep:     { bg: '#e5e7eb', fg: '#374151', accent: '#9ca3af' },
  sun:       { bg: '#f59e0b', fg: '#fffbeb', accent: '#fbbf24' },
  moon:      { bg: '#4338ca', fg: '#e0e7ff', accent: '#818cf8' },
  corn:      { bg: '#eab308', fg: '#422006', accent: '#facc15' },
  pig:       { bg: '#f9a8d4', fg: '#831843', accent: '#fbcfe8' },
  horse:     { bg: '#92400e', fg: '#fef3c7', accent: '#b45309' },
  cow:       { bg: '#b8916f', fg: '#3e2723', accent: '#6d4c41' },
  elephant:  { bg: '#94a3b8', fg: '#f1f5f9', accent: '#64748b' },
  goose:     { bg: '#475569', fg: '#f1f5f9', accent: '#fb923c' },
};

// =====================================================
//  SVG 渲染
// =====================================================

const AnimalSvg: React.FC<{ id: string; size: number }> = ({ id, size }) => {
  const p = PALETTES[id] ?? PALETTES.cat;
  const s = size;

  switch (id) {
    case 'cat':
      return (
        <svg width={s} height={s} viewBox="0 0 40 40" fill="none">
          <circle cx="20" cy="22" r="14" fill={p.bg} />
          <path d="M8 10 L12 18 L16 14 Z" fill={p.bg} />
          <path d="M32 10 L28 18 L24 14 Z" fill={p.bg} />
          <circle cx="15" cy="20" r="2" fill={p.fg} />
          <circle cx="25" cy="20" r="2" fill={p.fg} />
          <path d="M18 25 Q20 27 22 25" stroke={p.fg} strokeWidth="1.5" fill="none" strokeLinecap="round" />
          <path d="M17 24 L14 23 M23 24 L26 23" stroke={p.fg} strokeWidth="0.8" strokeLinecap="round" />
        </svg>
      );
    case 'dog':
      return (
        <svg width={s} height={s} viewBox="0 0 40 40" fill="none">
          <circle cx="20" cy="22" r="14" fill={p.bg} />
          <ellipse cx="9" cy="18" rx="4" ry="6" fill={p.accent} transform="rotate(-20 9 18)" />
          <ellipse cx="31" cy="18" rx="4" ry="6" fill={p.accent} transform="rotate(20 31 18)" />
          <circle cx="15" cy="20" r="2" fill={p.fg} />
          <circle cx="25" cy="20" r="2" fill={p.fg} />
          <ellipse cx="20" cy="27" rx="3" ry="2" fill={p.fg} />
          <path d="M20 27 L20 30" stroke={p.fg} strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );
    case 'fox':
      return (
        <svg width={s} height={s} viewBox="0 0 40 40" fill="none">
          {/* 尖耳朵 */}
          <path d="M9 6 L13 16 L8 14 Z" fill={p.accent} />
          <path d="M31 6 L27 16 L32 14 Z" fill={p.accent} />
          <path d="M10 9 L12 14 L10 13 Z" fill={p.bg} />
          <path d="M30 9 L28 14 L30 13 Z" fill={p.bg} />
          {/* 圆脸 */}
          <ellipse cx="20" cy="22" rx="13" ry="12" fill={p.bg} />
          {/* 白色脸颊/吻部 */}
          <ellipse cx="20" cy="26" rx="8" ry="6" fill={p.fg} />
          {/* 眼睛 */}
          <ellipse cx="14" cy="20" rx="2" ry="2.5" fill={p.fg} />
          <ellipse cx="26" cy="20" rx="2" ry="2.5" fill={p.fg} />
          <circle cx="14" cy="20.5" r="1" fill={p.accent} />
          <circle cx="26" cy="20.5" r="1" fill={p.accent} />
          {/* 鼻子 */}
          <ellipse cx="20" cy="24" rx="2" ry="1.5" fill={p.accent} />
          {/* 嘴 */}
          <path d="M20 25.5 L20 28 M20 28 Q18 29 17 28 M20 28 Q22 29 23 28" stroke={p.accent} strokeWidth="1" fill="none" strokeLinecap="round" />
        </svg>
      );
    case 'panda':
      return (
        <svg width={s} height={s} viewBox="0 0 40 40" fill="none">
          {/* 黑色圆头 */}
          <circle cx="20" cy="22" r="14" fill={p.bg} />
          {/* 白色圆耳朵 */}
          <circle cx="10" cy="12" r="4.5" fill={p.fg} />
          <circle cx="30" cy="12" r="4.5" fill={p.fg} />
          {/* 白色脸 */}
          <ellipse cx="20" cy="23" rx="10" ry="9" fill={p.fg} />
          {/* 黑色眼斑 (经典熊猫眼) */}
          <ellipse cx="14" cy="20" rx="3" ry="4" fill={p.bg} transform="rotate(-20 14 20)" />
          <ellipse cx="26" cy="20" rx="3" ry="4" fill={p.bg} transform="rotate(20 26 20)" />
          {/* 眼珠 */}
          <circle cx="14" cy="20" r="1.5" fill={p.fg} />
          <circle cx="26" cy="20" r="1.5" fill={p.fg} />
          <circle cx="14.3" cy="19.5" r="0.5" fill={p.bg} />
          <circle cx="26.3" cy="19.5" r="0.5" fill={p.bg} />
          {/* 鼻子 */}
          <ellipse cx="20" cy="26" rx="2" ry="1.5" fill={p.bg} />
          {/* 嘴 */}
          <path d="M20 27.5 L20 29 M20 29 Q18 30 17 29.5 M20 29 Q22 30 23 29.5" stroke={p.bg} strokeWidth="1" fill="none" strokeLinecap="round" />
        </svg>
      );
    case 'owl':
      return (
        <svg width={s} height={s} viewBox="0 0 40 40" fill="none">
          <ellipse cx="20" cy="22" rx="13" ry="15" fill={p.bg} />
          <circle cx="14" cy="18" r="5" fill={p.fg} />
          <circle cx="26" cy="18" r="5" fill={p.fg} />
          <circle cx="14" cy="18" r="3" fill={p.bg} />
          <circle cx="26" cy="18" r="3" fill={p.bg} />
          <circle cx="14" cy="18" r="1.5" fill={p.fg} />
          <circle cx="26" cy="18" r="1.5" fill={p.fg} />
          <path d="M18 24 L20 28 L22 24 Z" fill={p.accent} />
          <path d="M10 8 L13 14 L7 14 Z" fill={p.bg} />
          <path d="M30 8 L33 14 L27 14 Z" fill={p.bg} />
        </svg>
      );
    case 'penguin':
      return (
        <svg width={s} height={s} viewBox="0 0 40 40" fill="none">
          <ellipse cx="20" cy="24" rx="12" ry="14" fill={p.bg} />
          <ellipse cx="20" cy="26" rx="7" ry="10" fill={p.fg} />
          <circle cx="16" cy="18" r="2" fill={p.fg} />
          <circle cx="24" cy="18" r="2" fill={p.fg} />
          <path d="M18 22 L20 25 L22 22 Z" fill={p.accent} />
          <ellipse cx="14" cy="35" rx="3" ry="2" fill={p.accent} />
          <ellipse cx="26" cy="35" rx="3" ry="2" fill={p.accent} />
        </svg>
      );
    case 'lion':
      return (
        <svg width={s} height={s} viewBox="0 0 40 40" fill="none">
          <circle cx="20" cy="22" r="16" fill={p.accent} />
          <circle cx="20" cy="22" r="11" fill={p.bg} />
          <circle cx="15" cy="20" r="2" fill={p.fg} />
          <circle cx="25" cy="20" r="2" fill={p.fg} />
          <path d="M17 26 Q20 29 23 26" stroke={p.fg} strokeWidth="1.5" fill="none" strokeLinecap="round" />
          <ellipse cx="20" cy="25" rx="2" ry="1.5" fill={p.fg} />
        </svg>
      );
    case 'tiger':
      return (
        <svg width={s} height={s} viewBox="0 0 40 40" fill="none">
          <circle cx="20" cy="22" r="14" fill={p.bg} />
          <path d="M10 16 Q12 14 14 16" stroke={p.fg} strokeWidth="2" fill="none" strokeLinecap="round" />
          <path d="M26 16 Q28 14 30 16" stroke={p.fg} strokeWidth="2" fill="none" strokeLinecap="round" />
          <path d="M8 24 Q10 22 12 24" stroke={p.fg} strokeWidth="2" fill="none" strokeLinecap="round" />
          <path d="M28 24 Q30 22 32 24" stroke={p.fg} strokeWidth="2" fill="none" strokeLinecap="round" />
          <circle cx="15" cy="20" r="2" fill={p.fg} />
          <circle cx="25" cy="20" r="2" fill={p.fg} />
          <path d="M18 26 Q20 28 22 26" stroke={p.fg} strokeWidth="1.5" fill="none" strokeLinecap="round" />
        </svg>
      );
    case 'rabbit':
      return (
        <svg width={s} height={s} viewBox="0 0 40 40" fill="none">
          <ellipse cx="14" cy="8" rx="3" ry="7" fill={p.bg} />
          <ellipse cx="26" cy="8" rx="3" ry="7" fill={p.bg} />
          <ellipse cx="14" cy="8" rx="1.5" ry="5" fill={p.accent} />
          <ellipse cx="26" cy="8" rx="1.5" ry="5" fill={p.accent} />
          <circle cx="20" cy="24" r="12" fill={p.bg} />
          <circle cx="16" cy="22" r="2" fill={p.fg} />
          <circle cx="24" cy="22" r="2" fill={p.fg} />
          <path d="M19 27 L20 29 L21 27 Z" fill={p.fg} />
        </svg>
      );
    case 'bear':
      return (
        <svg width={s} height={s} viewBox="0 0 40 40" fill="none">
          <circle cx="12" cy="14" r="4.5" fill={p.accent} />
          <circle cx="28" cy="14" r="4.5" fill={p.accent} />
          <circle cx="20" cy="24" r="13" fill={p.bg} />
          <circle cx="12" cy="14" r="2" fill={p.fg} />
          <circle cx="28" cy="14" r="2" fill={p.fg} />
          <ellipse cx="20" cy="26" rx="5" ry="4" fill={p.accent} />
          <circle cx="16" cy="22" r="1.5" fill={p.fg} />
          <circle cx="24" cy="22" r="1.5" fill={p.fg} />
          <ellipse cx="20" cy="27" rx="2" ry="1.5" fill={p.fg} />
        </svg>
      );
    case 'frog':
      return (
        <svg width={s} height={s} viewBox="0 0 40 40" fill="none">
          <ellipse cx="20" cy="26" rx="14" ry="10" fill={p.bg} />
          <circle cx="13" cy="16" r="6" fill={p.bg} />
          <circle cx="27" cy="16" r="6" fill={p.bg} />
          <circle cx="13" cy="16" r="3" fill={p.fg} />
          <circle cx="27" cy="16" r="3" fill={p.fg} />
          <circle cx="13" cy="16" r="1.5" fill={p.accent} />
          <circle cx="27" cy="16" r="1.5" fill={p.accent} />
          <path d="M14 28 Q20 32 26 28" stroke={p.fg} strokeWidth="2" fill="none" strokeLinecap="round" />
        </svg>
      );
    case 'whale':
      return (
        <svg width={s} height={s} viewBox="0 0 40 40" fill="none">
          <ellipse cx="20" cy="24" rx="15" ry="9" fill={p.bg} />
          <path d="M34 24 L38 18 L36 24 L38 30 Z" fill={p.bg} />
          <circle cx="12" cy="20" r="2" fill={p.fg} />
          <path d="M8 26 Q12 28 16 26" stroke={p.accent} strokeWidth="2" fill="none" strokeLinecap="round" />
          <path d="M10 29 Q14 31 18 29" stroke={p.accent} strokeWidth="1.5" fill="none" strokeLinecap="round" />
        </svg>
      );
    case 'butterfly':
      return (
        <svg width={s} height={s} viewBox="0 0 40 40" fill="none">
          {/* 上翅 (大圆) */}
          <path d="M19 18 Q8 6 4 12 Q2 18 8 20 Q14 21 19 18 Z" fill={p.bg} />
          <path d="M21 18 Q32 6 36 12 Q38 18 32 20 Q26 21 21 18 Z" fill={p.bg} />
          {/* 下翅 (小圆) */}
          <path d="M19 22 Q10 30 6 28 Q3 24 8 22 Q14 21 19 22 Z" fill={p.accent} />
          <path d="M21 22 Q30 30 34 28 Q37 24 32 22 Q26 21 21 22 Z" fill={p.accent} />
          {/* 翅膀斑点 */}
          <circle cx="9" cy="14" r="2" fill={p.accent} />
          <circle cx="31" cy="14" r="2" fill={p.accent} />
          <circle cx="9" cy="14" r="0.8" fill={p.fg} />
          <circle cx="31" cy="14" r="0.8" fill={p.fg} />
          <circle cx="11" cy="26" r="1.2" fill={p.bg} />
          <circle cx="29" cy="26" r="1.2" fill={p.bg} />
          {/* 身体 */}
          <ellipse cx="20" cy="20" rx="1.5" ry="9" fill={p.fg} />
          {/* 触须 */}
          <path d="M19 12 Q16 8 15 5" stroke={p.fg} strokeWidth="0.8" fill="none" strokeLinecap="round" />
          <path d="M21 12 Q24 8 25 5" stroke={p.fg} strokeWidth="0.8" fill="none" strokeLinecap="round" />
          <circle cx="15" cy="5" r="0.8" fill={p.fg} />
          <circle cx="25" cy="5" r="0.8" fill={p.fg} />
        </svg>
      );
    case 'bird':
      return (
        <svg width={s} height={s} viewBox="0 0 40 40" fill="none">
          <ellipse cx="20" cy="24" rx="12" ry="10" fill={p.bg} />
          <circle cx="20" cy="14" r="7" fill={p.bg} />
          <path d="M26 12 L32 10 L26 14 Z" fill={p.accent} />
          <circle cx="18" cy="13" r="2" fill={p.fg} />
          <path d="M14 18 L10 22 L14 20" stroke={p.accent} strokeWidth="1.5" fill="none" strokeLinecap="round" />
          <path d="M28 28 L32 32 L28 30" stroke={p.accent} strokeWidth="1.5" fill="none" strokeLinecap="round" />
        </svg>
      );
    case 'hamster':
      return (
        <svg width={s} height={s} viewBox="0 0 40 40" fill="none">
          <circle cx="20" cy="24" r="13" fill={p.bg} />
          <circle cx="11" cy="16" r="4" fill={p.accent} />
          <circle cx="29" cy="16" r="4" fill={p.accent} />
          <circle cx="11" cy="16" r="2" fill={p.fg} />
          <circle cx="29" cy="16" r="2" fill={p.fg} />
          <circle cx="15" cy="22" r="1.8" fill={p.fg} />
          <circle cx="25" cy="22" r="1.8" fill={p.fg} />
          <ellipse cx="20" cy="28" rx="3" ry="2" fill={p.accent} />
          <path d="M17 28 L14 26 M23 28 L26 26" stroke={p.fg} strokeWidth="0.8" strokeLinecap="round" />
        </svg>
      );
    case 'hedgehog':
      return (
        <svg width={s} height={s} viewBox="0 0 40 40" fill="none">
          <ellipse cx="18" cy="26" rx="13" ry="9" fill={p.bg} />
          <path d="M8 24 L6 18 M12 20 L10 14 M16 18 L15 12 M20 17 L20 11 M24 18 L25 12 M28 20 L30 14 M32 22 L34 17" stroke={p.accent} strokeWidth="2" strokeLinecap="round" />
          <ellipse cx="28" cy="26" rx="6" ry="6" fill={p.fg} />
          <circle cx="28" cy="24" r="1.5" fill={p.bg} />
          <circle cx="31" cy="26" r="1" fill={p.bg} />
        </svg>
      );
    case 'raccoon':
      return (
        <svg width={s} height={s} viewBox="0 0 40 40" fill="none">
          <circle cx="20" cy="22" r="14" fill={p.bg} />
          <ellipse cx="14" cy="20" rx="5" ry="4" fill={p.fg} />
          <ellipse cx="26" cy="20" rx="5" ry="4" fill={p.fg} />
          <circle cx="14" cy="20" r="2" fill={p.accent} />
          <circle cx="26" cy="20" r="2" fill={p.accent} />
          <ellipse cx="20" cy="28" rx="4" ry="3" fill={p.fg} />
          <path d="M8 14 L12 10 L10 16 M32 14 L28 10 L30 16" stroke={p.bg} strokeWidth="2" fill="none" strokeLinecap="round" />
        </svg>
      );
    case 'turtle':
      return (
        <svg width={s} height={s} viewBox="0 0 40 40" fill="none">
          <ellipse cx="20" cy="22" rx="13" ry="10" fill={p.bg} />
          <path d="M12 16 L16 12 L20 16 L24 12 L28 16 L24 22 L16 22 Z" fill={p.accent} />
          <ellipse cx="32" cy="20" rx="4" ry="3" fill={p.bg} />
          <circle cx="33" cy="19" r="1.2" fill={p.fg} />
          <ellipse cx="12" cy="30" rx="3" ry="2" fill={p.bg} />
          <ellipse cx="28" cy="30" rx="3" ry="2" fill={p.bg} />
        </svg>
      );
    case 'octopus':
      return (
        <svg width={s} height={s} viewBox="0 0 40 40" fill="none">
          <ellipse cx="20" cy="16" rx="11" ry="9" fill={p.bg} />
          <path d="M10 20 Q6 26 8 32 Q10 28 12 22" fill={p.bg} />
          <path d="M14 24 Q10 30 12 34 Q14 30 16 26" fill={p.bg} />
          <path d="M20 25 Q18 32 20 36 Q22 32 20 25" fill={p.bg} />
          <path d="M26 24 Q30 30 28 34 Q26 30 24 26" fill={p.bg} />
          <path d="M30 20 Q34 26 32 32 Q30 28 28 22" fill={p.bg} />
          <circle cx="16" cy="14" r="2" fill={p.fg} />
          <circle cx="24" cy="14" r="2" fill={p.fg} />
          <circle cx="16" cy="14" r="0.8" fill={p.accent} />
          <circle cx="24" cy="14" r="0.8" fill={p.accent} />
        </svg>
      );
    case 'koala':
      return (
        <svg width={s} height={s} viewBox="0 0 40 40" fill="none">
          <circle cx="11" cy="14" r="5" fill={p.accent} />
          <circle cx="29" cy="14" r="5" fill={p.accent} />
          <circle cx="11" cy="14" r="3" fill={p.fg} />
          <circle cx="29" cy="14" r="3" fill={p.fg} />
          <circle cx="20" cy="24" r="12" fill={p.bg} />
          <ellipse cx="16" cy="22" rx="2.5" ry="3" fill={p.fg} />
          <ellipse cx="24" cy="22" rx="2.5" ry="3" fill={p.fg} />
          <ellipse cx="16" cy="22" rx="1" ry="1.5" fill={p.bg} />
          <ellipse cx="24" cy="22" rx="1" ry="1.5" fill={p.bg} />
          <ellipse cx="20" cy="28" rx="3" ry="2" fill={p.fg} />
        </svg>
      );
    case 'sheep':
      return (
        <svg width={s} height={s} viewBox="0 0 40 40" fill="none">
          {/* 蓬松羊毛云朵身体 */}
          <circle cx="10" cy="20" r="5" fill={p.accent} />
          <circle cx="30" cy="20" r="5" fill={p.accent} />
          <circle cx="14" cy="14" r="5" fill={p.accent} />
          <circle cx="26" cy="14" r="5" fill={p.accent} />
          <circle cx="20" cy="12" r="5" fill={p.accent} />
          <ellipse cx="20" cy="22" rx="12" ry="10" fill={p.accent} />
          {/* 脸 */}
          <ellipse cx="20" cy="22" rx="7" ry="6" fill={p.fg} />
          {/* 耳朵 */}
          <ellipse cx="13" cy="16" rx="2" ry="3" fill={p.fg} transform="rotate(-25 13 16)" />
          <ellipse cx="27" cy="16" rx="2" ry="3" fill={p.fg} transform="rotate(25 27 16)" />
          {/* 眼睛 */}
          <circle cx="17" cy="21" r="1.2" fill={p.bg} />
          <circle cx="23" cy="21" r="1.2" fill={p.bg} />
          {/* 鼻子 */}
          <ellipse cx="20" cy="25" rx="1.5" ry="1" fill={p.bg} />
        </svg>
      );
    case 'sun':
      return (
        <svg width={s} height={s} viewBox="0 0 40 40" fill="none">
          <circle cx="20" cy="20" r="8" fill={p.accent} />
          <circle cx="20" cy="20" r="5" fill={p.fg} />
          {[0, 45, 90, 135, 180, 225, 270, 315].map(deg => {
            const rad = (deg * Math.PI) / 180;
            const x1 = 20 + Math.cos(rad) * 10;
            const y1 = 20 + Math.sin(rad) * 10;
            const x2 = 20 + Math.cos(rad) * 15;
            const y2 = 20 + Math.sin(rad) * 15;
            return <line key={deg} x1={x1} y1={y1} x2={x2} y2={y2} stroke={p.accent} strokeWidth="2.5" strokeLinecap="round" />;
          })}
        </svg>
      );
    case 'moon':
      return (
        <svg width={s} height={s} viewBox="0 0 40 40" fill="none">
          {/* 用 bg 填充月牙, 深紫色在浅/深主题下都可见 */}
          <path d="M28 8 A14 14 0 1 0 28 32 A11 11 0 1 1 28 8 Z" fill={p.bg} />
          {/* 陨石坑 */}
          <circle cx="22" cy="14" r="1.5" fill={p.accent} />
          <circle cx="18" cy="22" r="1" fill={p.accent} />
          <circle cx="24" cy="26" r="1.2" fill={p.accent} />
        </svg>
      );
    case 'corn':
      return (
        <svg width={s} height={s} viewBox="0 0 40 40" fill="none">
          {/* 外叶 */}
          <path d="M14 8 Q10 20 14 34 Q17 32 17 28 Q15 18 17 10 Z" fill={p.accent} />
          <path d="M26 8 Q30 20 26 34 Q23 32 23 28 Q25 18 23 10 Z" fill={p.accent} />
          {/* 玉米芯 */}
          <ellipse cx="20" cy="22" rx="5" ry="14" fill={p.bg} />
          {/* 玉米粒纹理 */}
          <circle cx="18" cy="14" r="1.2" fill={p.fg} opacity="0.4" />
          <circle cx="22" cy="14" r="1.2" fill={p.fg} opacity="0.4" />
          <circle cx="17" cy="18" r="1.2" fill={p.fg} opacity="0.4" />
          <circle cx="20" cy="19" r="1.2" fill={p.fg} opacity="0.4" />
          <circle cx="23" cy="18" r="1.2" fill={p.fg} opacity="0.4" />
          <circle cx="18" cy="23" r="1.2" fill={p.fg} opacity="0.4" />
          <circle cx="22" cy="23" r="1.2" fill={p.fg} opacity="0.4" />
          <circle cx="17" cy="27" r="1.2" fill={p.fg} opacity="0.4" />
          <circle cx="20" cy="28" r="1.2" fill={p.fg} opacity="0.4" />
          <circle cx="23" cy="27" r="1.2" fill={p.fg} opacity="0.4" />
          <circle cx="19" cy="31" r="1" fill={p.fg} opacity="0.4" />
          <circle cx="21" cy="31" r="1" fill={p.fg} opacity="0.4" />
        </svg>
      );
    case 'pig':
      return (
        <svg width={s} height={s} viewBox="0 0 40 40" fill="none">
          {/* 耳朵 */}
          <path d="M9 10 L13 8 L14 14 Z" fill={p.bg} />
          <path d="M31 10 L27 8 L26 14 Z" fill={p.bg} />
          {/* 头 */}
          <circle cx="20" cy="22" r="14" fill={p.bg} />
          {/* 鼻子 */}
          <ellipse cx="20" cy="27" rx="6" ry="4" fill={p.accent} />
          <circle cx="17" cy="27" r="1" fill={p.fg} />
          <circle cx="23" cy="27" r="1" fill={p.fg} />
          {/* 眼睛 */}
          <circle cx="15" cy="19" r="1.5" fill={p.fg} />
          <circle cx="25" cy="19" r="1.5" fill={p.fg} />
        </svg>
      );
    case 'horse':
      return (
        <svg width={s} height={s} viewBox="0 0 40 40" fill="none">
          {/* 脖子 */}
          <path d="M24 34 L26 22 L30 14 L32 16 L30 24 L28 34 Z" fill={p.accent} />
          {/* 头 */}
          <ellipse cx="28" cy="14" rx="5" ry="7" fill={p.bg} transform="rotate(25 28 14)" />
          {/* 耳朵 */}
          <path d="M25 8 L27 12 L24 12 Z" fill={p.bg} />
          {/* 鬃毛 */}
          <path d="M22 16 Q20 12 22 8 Q24 12 24 16 Z" fill={p.fg} />
          <path d="M20 18 Q18 14 20 10 Q22 14 22 18 Z" fill={p.fg} />
          {/* 身体 */}
          <ellipse cx="16" cy="26" rx="10" ry="7" fill={p.bg} />
          {/* 腿 */}
          <rect x="9" y="30" width="2.5" height="6" fill={p.bg} />
          <rect x="20" y="30" width="2.5" height="6" fill={p.bg} />
          {/* 眼睛 */}
          <circle cx="29" cy="13" r="1.2" fill={p.fg} />
        </svg>
      );
    case 'cow':
      return (
        <svg width={s} height={s} viewBox="0 0 40 40" fill="none">
          {/* 身体 */}
          <ellipse cx="20" cy="24" rx="14" ry="10" fill={p.bg} />
          {/* 斑块 */}
          <ellipse cx="12" cy="20" rx="3" ry="2.5" fill={p.fg} />
          <ellipse cx="26" cy="26" rx="3.5" ry="3" fill={p.fg} />
          <ellipse cx="28" cy="18" rx="2" ry="1.5" fill={p.fg} />
          {/* 耳朵 */}
          <ellipse cx="8" cy="18" rx="3" ry="2" fill={p.accent} transform="rotate(-30 8 18)" />
          <ellipse cx="32" cy="18" rx="3" ry="2" fill={p.accent} transform="rotate(30 32 18)" />
          {/* 角 */}
          <path d="M10 14 L8 8 L12 12 Z" fill={p.accent} />
          <path d="M30 14 L32 8 L28 12 Z" fill={p.accent} />
          {/* 眼睛 */}
          <circle cx="14" cy="22" r="1.2" fill={p.fg} />
          <circle cx="26" cy="22" r="1.2" fill={p.fg} />
          {/* 鼻孔 */}
          <ellipse cx="18" cy="28" rx="1" ry="1.5" fill={p.fg} />
          <ellipse cx="22" cy="28" rx="1" ry="1.5" fill={p.fg} />
        </svg>
      );
    case 'elephant':
      return (
        <svg width={s} height={s} viewBox="0 0 40 40" fill="none">
          {/* 大耳朵 */}
          <circle cx="12" cy="20" r="7" fill={p.bg} />
          <circle cx="28" cy="20" r="7" fill={p.bg} />
          {/* 头 */}
          <circle cx="20" cy="20" r="8" fill={p.bg} />
          {/* 鼻子 */}
          <path d="M20 24 Q18 28 20 32 Q22 34 20 36" stroke={p.bg} strokeWidth="3" fill="none" strokeLinecap="round" />
          {/* 眼睛 */}
          <circle cx="16" cy="18" r="1.5" fill={p.fg} />
          <circle cx="24" cy="18" r="1.5" fill={p.fg} />
          {/* 象牙 */}
          <path d="M17 26 L15 30" stroke={p.accent} strokeWidth="1.5" strokeLinecap="round" />
          <path d="M23 26 L25 30" stroke={p.accent} strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );
    case 'goose':
      return (
        <svg width={s} height={s} viewBox="0 0 40 40" fill="none">
          {/* 身体 */}
          <ellipse cx="16" cy="26" rx="11" ry="8" fill={p.bg} />
          {/* 翅膀 */}
          <path d="M10 22 Q14 18 22 22 Q20 28 12 28 Z" fill={p.fg} />
          {/* 脖子 */}
          <path d="M22 24 Q26 16 28 8 L31 9 Q29 18 26 26 Z" fill={p.bg} />
          {/* 头 */}
          <circle cx="29" cy="8" r="4" fill={p.bg} />
          {/* 喙 (橙色) */}
          <path d="M32 8 L36 10 L32 12 Z" fill={p.accent} />
          {/* 眼睛 */}
          <circle cx="30" cy="7" r="1" fill={p.fg} />
        </svg>
      );
    default:
      return (
        <svg width={s} height={s} viewBox="0 0 40 40" fill="none">
          <circle cx="20" cy="20" r="16" fill="#6366f1" />
          <text x="20" y="26" textAnchor="middle" fill="#fff" fontSize="14" fontWeight="bold">?</text>
        </svg>
      );
  }
};

// =====================================================
//  AnimalAvatar 组件
// =====================================================

export interface AnimalAvatarProps {
  id: string;
  size?: number;
  className?: string;
}

export const AnimalAvatar: React.FC<AnimalAvatarProps> = ({ id, size = 28, className }) => {
  // 内置动物
  if (ANIMAL_NAME_MAP[id]) {
    return (
      <div className={className} style={{ width: size, height: size, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <AnimalSvg id={id} size={size} />
      </div>
    );
  }
  // 未知 ID → 兜底
  return (
    <div className={className} style={{ width: size, height: size, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <AnimalSvg id="cat" size={size} />
    </div>
  );
};

export default AnimalAvatar;

// =====================================================
//  图标注册表 (localStorage 持久化)
// =====================================================

export interface IconRegistryItem {
  id: string;           // 唯一 ID: 'cat' (内置) | 'custom_<timestamp>' (上传)
  type: 'builtin' | 'custom';
  name: string;         // 显示名: '猫咪' | 'my-icon.png'
  iconType: string;     // 完整引用: 'animal:cat' | 'custom:data:image/png;base64,...'
}

const REGISTRY_KEY = 'soloforge_icon_registry';

/** 初始化/加载图标注册表 */
export function loadIconRegistry(): IconRegistryItem[] {
  try {
    const saved = localStorage.getItem(REGISTRY_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch { /* ignore */ }
  // 首次初始化: 全部内置动物
  return BUILTIN_ANIMALS.map(a => ({
    id: a.id,
    type: 'builtin' as const,
    name: a.name,
    iconType: `animal:${a.id}`,
  }));
}

/** 保存图标注册表 */
export function saveIconRegistry(items: IconRegistryItem[]): void {
  try {
    localStorage.setItem(REGISTRY_KEY, JSON.stringify(items));
  } catch (e) {
    console.error('Failed to save icon registry:', e);
  }
}

// =====================================================
//  上传图标格式检查器
// =====================================================

const VALID_MIME_TYPES = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp', 'image/gif', 'image/bmp'];
const MAX_DIMENSION = 256;
const TARGET_SIZE = 64;

export interface ProcessedIcon {
  dataUrl: string;   // 始终是 data:image/png;base64,... 格式
  name: string;
}

/**
 * 处理用户上传的图标文件:
 *  1. 检查格式 (PNG/JPG/SVG/WebP/GIF/BMP)
 *  2. 检查尺寸 (正方形, 16~256px)
 *  3. 符合规格 → 直接转为 PNG base64
 *  4. 不符合 → 用 canvas 重绘为 64×64 PNG (居中裁剪)
 */
export async function processUploadedIcon(file: File): Promise<ProcessedIcon> {
  // 1. 格式检查
  if (!VALID_MIME_TYPES.includes(file.type)) {
    // 尝试通过扩展名推断
    const ext = file.name.toLowerCase().split('.').pop() ?? '';
    const extMap: Record<string, string> = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      svg: 'image/svg+xml', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp',
    };
    if (!extMap[ext]) {
      throw new Error(`不支持的格式: ${file.type || ext}，请上传 PNG/JPG/SVG/WebP/GIF`);
    }
  }

  // 2. 加载图片
  const url = URL.createObjectURL(file);
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('图片加载失败，文件可能已损坏'));
    img.src = url;
  });
  URL.revokeObjectURL(url);

  const w = img.naturalWidth;
  const h = img.naturalHeight;

  if (w === 0 || h === 0) {
    throw new Error('图片尺寸无效');
  }

  // 3. 检查是否正方形且在合理范围内
  const isSquare = w === h;
  const isWithinRange = w >= 16 && w <= MAX_DIMENSION && h >= 16 && h <= MAX_DIMENSION;

  if (isSquare && isWithinRange) {
    // 符合格式 → 转为 PNG base64
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 不可用');
    ctx.drawImage(img, 0, 0);
    return { dataUrl: canvas.toDataURL('image/png'), name: file.name };
  }

  // 4. 不符合 → 重绘为 64×64 PNG (居中裁剪保持比例)
  const canvas = document.createElement('canvas');
  canvas.width = TARGET_SIZE;
  canvas.height = TARGET_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 不可用');

  // 透明背景填充
  ctx.clearRect(0, 0, TARGET_SIZE, TARGET_SIZE);

  // 等比缩放，居中裁剪 (cover 模式)
  const scale = Math.max(TARGET_SIZE / w, TARGET_SIZE / h);
  const sw = w * scale;
  const sh = h * scale;
  const dx = (TARGET_SIZE - sw) / 2;
  const dy = (TARGET_SIZE - sh) / 2;
  ctx.drawImage(img, dx, dy, sw, sh);

  return { dataUrl: canvas.toDataURL('image/png'), name: file.name };
}

/**
 * 向注册表添加自定义图标
 */
export function addCustomIconToRegistry(
  registry: IconRegistryItem[],
  dataUrl: string,
  name: string
): IconRegistryItem[] {
  const newItem: IconRegistryItem = {
    id: `custom_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: 'custom',
    name: name.length > 20 ? name.slice(0, 17) + '...' : name,
    iconType: `custom:${dataUrl}`,
  };
  const updated = [...registry, newItem];
  saveIconRegistry(updated);
  return updated;
}

/**
 * 从注册表删除图标
 */
export function removeIconFromRegistry(
  registry: IconRegistryItem[],
  iconId: string
): IconRegistryItem[] {
  const updated = registry.filter(item => item.id !== iconId);
  saveIconRegistry(updated);
  return updated;
}
