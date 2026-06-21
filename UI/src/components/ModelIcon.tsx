import React from 'react';
import { ModelIcon as LobeModelIcon } from '@lobehub/icons';
// @ts-ignore
import xiaomiLogoImg from '../assets/xiaomi.webp';
// @ts-ignore
import claudeLogoImg from '../assets/claude.webp';
// @ts-ignore
import siliconflowLogoImg from '../assets/siliconflow.svg';

interface ModelIconProps {
  modelName: string;
  className?: string;
  size?: number;
}

const isSiliconFlow = (name: string): boolean => {
  const lower = (name || '').trim().toLowerCase();
  return (
    lower === 'siliconflow' ||
    lower === 'siliconcloud' ||
    lower.includes('siliconflow') ||
    lower.includes('siliconcloud') ||
    lower.includes('silicon-flow')
  );
};

const isXiaomi = (name: string): boolean => {
  const lower = (name || '').trim().toLowerCase();
  return (
    lower === 'xiaomi' ||
    lower === 'xiaomimimo' ||
    lower.includes('xiaomi') ||
    lower.startsWith('milm')
  );
};

const isClaude = (name: string): boolean => {
  const lower = (name || '').trim().toLowerCase();
  return lower.includes('claude') || lower === 'anthropic';
};

export const ModelIcon: React.FC<ModelIconProps> = ({ modelName, className = "w-4 h-4", size = 16 }) => {
  const modelId = (modelName || '').trim().toLowerCase();

  if (isXiaomi(modelName)) {
    return (
      <img
        src={xiaomiLogoImg}
        alt="Xiaomi MiMo"
        className={`${className} object-contain inline-block shrink-0 rounded-md`}
        style={{ width: size, height: size }}
        referrerPolicy="no-referrer"
      />
    );
  }

  if (isClaude(modelName)) {
    return (
      <img
        src={claudeLogoImg}
        alt="Claude"
        className={`${className} object-contain inline-block shrink-0 rounded-md`}
        style={{ width: size, height: size }}
        referrerPolicy="no-referrer"
      />
    );
  }

  if (isSiliconFlow(modelName)) {
    return (
      <img
        src={siliconflowLogoImg}
        alt="SiliconFlow"
        className={`${className} object-contain inline-block shrink-0 rounded-md`}
        style={{ width: size, height: size }}
        referrerPolicy="no-referrer"
      />
    );
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
