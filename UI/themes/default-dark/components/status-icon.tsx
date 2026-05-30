// ─────────────────────────────────────────────────────────────────
// SoloForge StatusIcon Component
// 状态图标组件
// ─────────────────────────────────────────────────────────────────

import React from 'react';
import { useTheme } from './theme-context';

type StatusType = 'success' | 'error' | 'warning' | 'info' | 'loading' | 'offline' | 'online';

interface StatusIconProps {
  status: StatusType;
  size?: number;
  className?: string;
  showLabel?: boolean;
}

const STATUS_ICON_MAP: Record<StatusType, string> = {
  'success': 'success.svg',
  'error': 'error.svg',
  'warning': 'warning.svg',
  'info': 'info.svg',
  'loading': 'loading.svg',
  'offline': 'offline.svg',
  'online': 'online.svg'
};

const STATUS_LABELS: Record<StatusType, string> = {
  'success': '成功',
  'error': '错误',
  'warning': '警告',
  'info': '信息',
  'loading': '加载中',
  'offline': '离线',
  'online': '在线'
};

export function StatusIcon({ status, size = 20, className, showLabel = false }: StatusIconProps) {
  const { iconsPath } = useTheme();

  const iconFile = STATUS_ICON_MAP[status];

  return (
    <div
      className={className}
      style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
    >
      {iconFile ? (
        <img
          src={`${iconsPath}/status/${iconFile}`}
          alt={status}
          width={size}
          height={size}
          style={{ objectFit: 'contain' }}
        />
      ) : (
        <span style={{ fontSize: size }}>{status === 'loading' ? '⏳' : '⚪'}</span>
      )}
      {showLabel && <span>{STATUS_LABELS[status]}</span>}
    </div>
  );
}

export default StatusIcon;
