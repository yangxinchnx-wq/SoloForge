import React from 'react';
import {
  ModelIcon as LobeModelIcon,
  XiaomiMiMo,
  SiliconCloud,
} from '@lobehub/icons';

interface ModelIconProps {
  modelName: string;
  className?: string;
  size?: number;
}

export const ModelIcon: React.FC<ModelIconProps> = ({ modelName, className = "w-4 h-4", size = 16 }) => {
  const modelId = (modelName || '').trim().toLowerCase();

  // Xiaomi: 项目里用 milm- 前缀,LobeHub 内置关键字是 mimo- /mimo-,手动桥接
  if (modelId.startsWith('milm') || modelId.startsWith('mimo') || modelId.includes('xiaomi')) {
    return <XiaomiMiMo size={size} className={className} />;
  }

  // SiliconFlow: 平台名(关键词里没有 siliconflow 关键字),直接用 SiliconCloud 组件
  if (
    modelId === 'siliconflow' ||
    modelId === 'siliconcloud' ||
    modelId.startsWith('siliconflow/') ||
    modelId.startsWith('siliconcloud/') ||
    modelId.includes('/siliconflow') ||
    modelId.includes('/siliconcloud')
  ) {
    return <SiliconCloud size={size} className={className} />;
  }

  return (
    <LobeModelIcon
      model={modelId}
      size={size}
      className={className}
      type="color"
    />
  );
};
