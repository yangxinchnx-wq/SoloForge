/**
 * AnimalAvatar — 轻量内联 SVG 动物头像库
 *
 * 用于模型服务商配置中，当 @lobehub/icons 无匹配图标时的自定义头像。
 * 每个头像是纯 SVG path，无外链依赖，支持 size / color 自适应。
 *
 * 使用方式:
 *   <AnimalAvatar id="cat" size={28} />
 *   <AnimalAvatar id="fox" size={22} className="shrink-0" />
 */

import React from 'react';

export interface AnimalAvatarProps {
  id: string;
  size?: number;
  className?: string;
}

export const ANIMAL_IDS = [
  'cat', 'dog', 'fox', 'panda', 'owl', 'penguin',
  'lion', 'tiger', 'rabbit', 'bear', 'frog', 'whale',
] as const;

export type AnimalId = typeof ANIMAL_IDS[number];

// 每个 avatar 的配色方案
const PALETTES: Record<AnimalId, { bg: string; fg: string; accent: string }> = {
  cat:     { bg: '#f59e0b', fg: '#1e293b', accent: '#fbbf24' },
  dog:     { bg: '#d97706', fg: '#fef3c7', accent: '#92400e' },
  fox:     { bg: '#ea580c', fg: '#fff7ed', accent: '#c2410c' },
  panda:   { bg: '#1e293b', fg: '#f1f5f9', accent: '#64748b' },
  owl:     { bg: '#7c3aed', fg: '#f5f3ff', accent: '#a78bfa' },
  penguin: { bg: '#1e3a5f', fg: '#f1f5f9', accent: '#fbbf24' },
  lion:    { bg: '#eab308', fg: '#422006', accent: '#facc15' },
  tiger:   { bg: '#f97316', fg: '#1c1917', accent: '#fb923c' },
  rabbit:  { bg: '#f472b6', fg: '#831843', accent: '#fbcfe8' },
  bear:    { bg: '#92400e', fg: '#fef3c7', accent: '#b45309' },
  frog:    { bg: '#16a34a', fg: '#052e16', accent: '#4ade80' },
  whale:   { bg: '#0284c7', fg: '#f0f9ff', accent: '#38bdf8' },
};

/** 简化的动物 SVG path —— 每个动物用几何图形组合，风格统一 */
const AnimalSvg: React.FC<{ id: AnimalId; size: number }> = ({ id, size }) => {
  const p = PALETTES[id];
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
          <path d="M20 25 L20 27" stroke={p.fg} strokeWidth="1" strokeLinecap="round" />
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
          <path d="M20 8 L30 18 L28 30 L20 34 L12 30 L10 18 Z" fill={p.bg} />
          <path d="M14 14 L20 22 L26 14 L24 10 L20 12 L16 10 Z" fill={p.fg} />
          <circle cx="16" cy="22" r="1.5" fill={p.fg} />
          <circle cx="24" cy="22" r="1.5" fill={p.fg} />
          <path d="M18 28 L20 30 L22 28" stroke={p.fg} strokeWidth="1.5" fill="none" strokeLinecap="round" />
        </svg>
      );
    case 'panda':
      return (
        <svg width={s} height={s} viewBox="0 0 40 40" fill="none">
          <circle cx="20" cy="22" r="14" fill={p.fg} />
          <circle cx="11" cy="14" r="4" fill={p.bg} />
          <circle cx="29" cy="14" r="4" fill={p.bg} />
          <ellipse cx="15" cy="20" rx="3" ry="3.5" fill={p.bg} />
          <ellipse cx="25" cy="20" rx="3" ry="3.5" fill={p.bg} />
          <circle cx="15" cy="20" r="1.5" fill={p.fg} />
          <circle cx="25" cy="20" r="1.5" fill={p.fg} />
          <ellipse cx="20" cy="27" rx="2.5" ry="2" fill={p.bg} />
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
          {/* mane */}
          <circle cx="20" cy="22" r="16" fill={p.accent} />
          {/* face */}
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
          {/* stripes */}
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
    default:
      return (
        <svg width={s} height={s} viewBox="0 0 40 40" fill="none">
          <circle cx="20" cy="20" r="16" fill="#6366f1" />
          <text x="20" y="26" textAnchor="middle" fill="#fff" fontSize="14" fontWeight="bold">?</text>
        </svg>
      );
  }
};

export const AnimalAvatar: React.FC<AnimalAvatarProps> = ({ id, size = 28, className }) => {
  const animalId = (ANIMAL_IDS as readonly string[]).includes(id) ? (id as AnimalId) : 'cat';
  return (
    <div className={className} style={{ width: size, height: size, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <AnimalSvg id={animalId} size={size} />
    </div>
  );
};

export default AnimalAvatar;
