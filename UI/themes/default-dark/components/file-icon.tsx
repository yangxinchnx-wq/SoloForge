// ─────────────────────────────────────────────────────────────────
// SoloForge FileIcon Component
// 文件类型图标组件 - 自动根据扩展名加载对应图标
// ─────────────────────────────────────────────────────────────────

import React, { useMemo } from 'react';
import { useTheme } from './theme-context';

interface FileIconProps {
  filename: string;
  size?: number;
  className?: string;
}

// 文件扩展名到图标的映射
const EXTENSION_MAP: Record<string, string> = {
  // 文档
  'pdf': 'pdf11.svg',
  'doc': 'word.svg',
  'docx': 'word1.svg',
  'txt': 'txt.svg',
  'md': 'office-txt.svg',

  // 表格
  'xls': 'xls1.svg',
  'xlsx': 'excel.svg',
  'csv': 'csv1.svg',

  // 演示
  'ppt': 'ppt.svg',
  'pptx': 'ppt1.svg',

  // 图片
  'jpg': 'jpg1.svg',
  'jpeg': 'jpg1.svg',
  'png': 'png1.svg',
  'gif': 'image-gif.svg',
  'svg': 'image-pic.svg',

  // 视频
  'mp4': 'mp4.svg',
  'avi': 'video.svg',
  'mov': 'video (1).svg',

  // 音频
  'mp3': 'mp3.svg',
  'wav': 'music.svg',

  // 代码
  'js': 'js.svg',
  'ts': 'js.svg',
  'tsx': 'js.svg',
  'jsx': 'js.svg',
  'css': 'css.svg',
  'html': 'code.svg',
  'py': 'code.svg',
  'rs': 'code.svg',

  // 压缩包
  'zip': 'zip.svg',
  'rar': 'rar.svg',
  '7z': '压缩包.svg',

  // 办公套件
  'wps': 'wps1.svg',
  'et': 'office-els.svg',
  'dps': 'office-ppt.svg',

  // 移动应用
  'apk': 'apk.svg',
  'ipa': 'ipa.svg',

  // 其他
  'exe': 'exe.svg',
  'link': '链接.svg',
  'folder': 'folder.svg',
  'default': 'file.svg'
};

export function FileIcon({ filename, size = 24, className }: FileIconProps) {
  const { iconsPath } = useTheme();

  const iconFile = useMemo(() => {
    // 提取扩展名
    const ext = filename.split('.').pop()?.toLowerCase() || '';

    // 查找对应的图标文件
    for (const [key, value] of Object.entries(EXTENSION_MAP)) {
      if (ext === key) {
        return value;
      }
    }

    // 返回默认图标
    return EXTENSION_MAP['default'];
  }, [filename]);

  // 直接使用文件名作为 key 来加载 SVG
  const iconKey = iconFile.replace('.svg', '');

  return (
    <img
      src={`${iconsPath}/file-types/${iconFile}`}
      alt={filename}
      width={size}
      height={size}
      className={className}
      style={{ objectFit: 'contain' }}
    />
  );
}

export default FileIcon;
