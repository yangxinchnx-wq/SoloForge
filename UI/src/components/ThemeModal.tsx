import React, { useEffect, useRef, useState, useMemo } from 'react';
import { X, Palette, Check, Sun, Moon, Zap, CloudSnow, Heart, RefreshCw, PanelBottom, Menu, Sliders, MessageSquare, FileCode, Settings } from '../utils/icons';
import { THEME_PRESETS, SYNTAX_THEMES, useStaticTheme } from '../context/ThemeContext';

interface ThemeModalProps {
  onClose: () => void;
  primaryColor: string;
  setPrimaryColor: (color: string) => void;
  currentThemeId: string;
  setCurrentThemeId: (id: string) => void;
  primaryColorTargets: {
    activityBar: boolean;
    skillBar: boolean;
    header: boolean;
    chatPanel: boolean;
    editorAndExplorer: boolean;
    statusBar: boolean;
  };
  setPrimaryColorTargets: React.Dispatch<React.SetStateAction<{
    activityBar: boolean;
    skillBar: boolean;
    header: boolean;
    chatPanel: boolean;
    editorAndExplorer: boolean;
    statusBar: boolean;
  }>>;
}

// 1. Move static variables and utility calculators outside the component to prevent allocations on every render
const PRESET_COLORS = [
  '#ffde82', // SoloForge Gold
  '#3b82f6', // Cyber Blue
  '#a855f7', // Mystic Purple
  '#10b981', // Jade Green
  '#f97316', // Neon Orange
  '#ff79c6', // Pink Sweet
  '#88c0d0', // Frosted Ice
  '#14b8a6', // Soft Teal
  '#eab308', // Amber Yellow
  '#ec4899', // Hot Pink
  '#6366f1'  // Indigo
];

const LOWERCASE_PRESET_COLORS = PRESET_COLORS.map(c => c.toLowerCase());

const getRGBString = (color: string): string => {
  let cleanHex = color.trim().replace('#', '');
  if (cleanHex.length === 3) {
    cleanHex = cleanHex.split('').map(char => char + char).join('');
  }
  if (cleanHex.length !== 6) return 'RGB(---, ---, ---)';
  const num = parseInt(cleanHex, 16);
  return `RGB(${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255})`;
};

const getHSLString = (color: string): string => {
  let cleanHex = color.trim().replace('#', '');
  if (cleanHex.length === 3) {
    cleanHex = cleanHex.split('').map(char => char + char).join('');
  }
  if (cleanHex.length !== 6) return 'HSL(---, --%, --%)';
  const num = parseInt(cleanHex, 16);
  const r = ((num >> 16) & 255) / 255;
  const g = ((num >> 8) & 255) / 255;
  const b = (num & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0, l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return `HSL(${Math.round(h * 360)}°, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`;
};

// 2. Memoize those heavy theme card lists to prevent rendering costs when dragging/typing colors
interface PresetThemeListProps {
  currentThemeId: string;
  setCurrentThemeId: (id: string) => void;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}

const PresetThemeList = React.memo(({ 
  currentThemeId, 
  setCurrentThemeId, 
  scrollRef 
}: PresetThemeListProps) => {
  const getThemeIcon = (id: string) => {
    switch (id) {
      case 'gruvbox':
        return <Palette className="w-4 h-4 text-[#fabd2f]" />;
      case 'dark':
        return <Moon className="w-4 h-4 text-[#388bfd]" />;
      case 'light':
        return <Sun className="w-4 h-4 text-[#e67e22]" />;
      case 'cyberpunk':
        return <Zap className="w-4 h-4 text-[#ff007f]" />;
      case 'nord':
        return <CloudSnow className="w-4 h-4 text-[#88c0d0]" />;
      case 'sakura':
        return <Heart className="w-4 h-4 text-[#ff79c6]" />;
      default:
        // 2026-07-03: Wand2 已禁用 (魔法/AI 装饰语义), 改用 Palette (调色板, 主题场景首选)
        return <Palette className="w-4 h-4 text-primary" />;
    }
  };

  return (
    <div 
      ref={scrollRef}
      className="flex gap-3.5 overflow-x-auto pb-3.5 pt-1.5 px-0.5 scrollbar-thin scrollbar-thumb-white/10 hover:scrollbar-thumb-primary/20 scrollbar-track-transparent snap-x snap-mandatory"
    >
      {THEME_PRESETS.map((preset) => {
        const isSelected = currentThemeId === preset.id;
        return (
          <button
            key={preset.id}
            onClick={() => {
              setCurrentThemeId(preset.id);
            }}
            className={`snap-start snap-always shrink-0 w-[155px] p-3 rounded-2xl border text-left transition-all duration-300 relative overflow-hidden flex flex-col gap-3 group active:scale-95 cursor-pointer ${
              isSelected 
                ? 'border-primary bg-primary/[0.04] shadow-[0_4px_25px_rgba(0,0,0,0.3)]' 
                : 'border-outline/25 bg-bg/40 text-on-surface/70 hover:text-on-surface hover:border-outline/50 hover:bg-surface-bright/40'
            }`}
          >
            {isSelected && (
              <div className="absolute -right-6 -bottom-6 w-20 h-20 bg-primary/5 rounded-full blur-xl pointer-events-none" />
            )}

            <div className="w-full h-[40px] rounded-lg p-1.5 flex flex-col gap-1.5 transition-all duration-300 group-hover:opacity-90 overflow-hidden relative" style={{ backgroundColor: preset.bg }}>
              <div className="flex items-center justify-between">
                <div className="flex gap-1">
                  <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: preset.primary }} />
                  <span className="w-1.5 h-1.5 rounded-full opacity-60" style={{ backgroundColor: preset.onSurface }} />
                  <span className="w-1.5 h-1.5 rounded-full opacity-30" style={{ backgroundColor: preset.outline }} />
                </div>
                <span className="text-[7px] font-mono opacity-20 truncate" style={{ color: preset.onSurface }}>app.tsx</span>
              </div>
              
              <div className="p-1 rounded flex flex-col gap-1 border border-white/[0.03]" style={{ backgroundColor: preset.surface }}>
                <div className="w-3/4 h-1 rounded" style={{ backgroundColor: preset.primary, opacity: 0.8 }} />
                <div className="w-1/2 h-1 rounded" style={{ backgroundColor: preset.onSurface, opacity: 0.4 }} />
              </div>
            </div>

            <div className="flex flex-col gap-1 w-full z-10">
              <div className="flex items-center gap-1.5 truncate">
                {getThemeIcon(preset.id)}
                <span className="text-[11px] font-bold tracking-tight text-on-surface/90 group-hover:text-on-surface truncate">{preset.name.split(' (')[0]}</span>
              </div>
              <span className="text-[9px] text-on-surface/40 font-mono truncate">{preset.id.toUpperCase()}</span>
            </div>

            <div className="flex items-center justify-between w-full pt-1.5 border-t border-white/[0.04] z-10">
              <div className="flex items-center gap-1">
                <div className="w-2.5 h-2.5 rounded-full border border-white/5 shadow-inner" style={{ backgroundColor: preset.bg }} title="背景" />
                <div className="w-2.5 h-2.5 rounded-full border border-white/5 shadow-inner" style={{ backgroundColor: preset.surface }} title="面板" />
                <div className="w-2.5 h-2.5 rounded-full border border-white/5 shadow-inner" style={{ backgroundColor: preset.primary }} title="主色" />
              </div>
              {isSelected ? (
                <span className="flex items-center justify-center w-4 h-4 rounded-full bg-primary text-black">
                  <Check className="w-2.5 h-2.5 stroke-[3.5]" />
                </span>
              ) : (
                <span className="w-1.5 h-1.5 rounded-full bg-on-surface/20 group-hover:bg-on-surface/40 transition-colors" />
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
});

PresetThemeList.displayName = 'PresetThemeList';

export default function ThemeModal({ 
  onClose, 
  primaryColor, 
  setPrimaryColor, 
  currentThemeId, 
  setCurrentThemeId,
  primaryColorTargets,
  setPrimaryColorTargets
}: ThemeModalProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  
  const handleToggleTarget = (key: keyof typeof primaryColorTargets) => {
    setPrimaryColorTargets(prev => ({
      ...prev,
      [key]: !prev[key]
    }));
  };
  const { syntaxThemeId, setSyntaxThemeId } = useStaticTheme();
  const activeTheme = THEME_PRESETS.find(t => t.id === currentThemeId) || THEME_PRESETS[0];
  
  // 3. Local colors are updated instantly for reactive UI & fast CSS update, 
  // and debounced parent updates are stored via setPrimaryColor
  const [localColor, setLocalColor] = useState(primaryColor);
  const [inputValue, setInputValue] = useState(primaryColor.toUpperCase());
  const updateColorTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    setLocalColor(primaryColor);
    setInputValue(primaryColor.toUpperCase());
  }, [primaryColor]);

  useEffect(() => {
    return () => {
      if (updateColorTimeoutRef.current) {
        clearTimeout(updateColorTimeoutRef.current);
      }
    };
  }, []);

  const handleColorChange = (newColor: string) => {
    const cleanColor = newColor.toLowerCase();
    setLocalColor(cleanColor);
    
    if (typeof document !== 'undefined') {
      document.documentElement.style.setProperty('--color-primary', cleanColor);
    }
    
    if (updateColorTimeoutRef.current) {
      clearTimeout(updateColorTimeoutRef.current);
    }
    updateColorTimeoutRef.current = setTimeout(() => {
      setPrimaryColor(cleanColor);
    }, 100);
  };

  // Dragging and resizing states matching a premium floating dock panel
  const [size, setSize] = useState({ width: 440, height: 580 });
  const [position, setPosition] = useState({ x: 120, y: 80 });

  // Dynamically position in the center when the component is initially mounted
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const initX = Math.max(20, (window.innerWidth - 440) / 2);
      const initY = Math.max(25, (window.innerHeight - 580) / 2);
      setPosition({ x: initX, y: initY });
    }
  }, []);

  const handleMouseDown = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const isInteractive = target.closest('button, input, textarea, select, [role="button"], a') !== null;
    const isScrollable = target.closest('.overflow-x-auto, .overflow-y-auto') !== null;

    if (isInteractive || isScrollable) {
      return;
    }

    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const startPosX = position.x;
    const startPosY = position.y;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;
      
      const nextX = Math.max(0, Math.min(window.innerWidth - size.width, startPosX + deltaX));
      const nextY = Math.max(0, Math.min(window.innerHeight - size.height, startPosY + deltaY));
      
      setPosition({ x: nextX, y: nextY });
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  type Corner = 'tl' | 'tr' | 'bl' | 'br';

  const handleResizeStart = (corner: Corner, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const startX = e.clientX;
    const startY = e.clientY;
    const startWidth = size.width;
    const startHeight = size.height;
    const startPosX = position.x;
    const startPosY = position.y;

    const minWidth = 380;
    const minHeight = 440;
    const maxWidth = 800;
    const maxHeight = 900;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;

      let nextWidth = startWidth;
      let nextHeight = startHeight;
      let nextX = startPosX;
      let nextY = startPosY;

      if (corner === 'br') {
        nextWidth = Math.max(minWidth, Math.min(maxWidth, startWidth + deltaX));
        nextHeight = Math.max(minHeight, Math.min(maxHeight, startHeight + deltaY));
      } else if (corner === 'bl') {
        const potentialWidth = startWidth - deltaX;
        nextWidth = Math.max(minWidth, Math.min(maxWidth, potentialWidth));
        nextHeight = Math.max(minHeight, Math.min(maxHeight, startHeight + deltaY));
        if (potentialWidth >= minWidth && potentialWidth <= maxWidth) {
          nextX = startPosX + deltaX;
        }
      } else if (corner === 'tr') {
        nextWidth = Math.max(minWidth, Math.min(maxWidth, startWidth + deltaX));
        const potentialHeight = startHeight - deltaY;
        nextHeight = Math.max(minHeight, Math.min(maxHeight, potentialHeight));
        if (potentialHeight >= minHeight && potentialHeight <= maxHeight) {
          nextY = startPosY + deltaY;
        }
      } else if (corner === 'tl') {
        const potentialWidth = startWidth - deltaX;
        nextWidth = Math.max(minWidth, Math.min(maxWidth, potentialWidth));
        const potentialHeight = startHeight - deltaY;
        nextHeight = Math.max(minHeight, Math.min(maxHeight, potentialHeight));
        if (potentialWidth >= minWidth && potentialWidth <= maxWidth) {
          nextX = startPosX + deltaX;
        }
        if (potentialHeight >= minHeight && potentialHeight <= maxHeight) {
          nextY = startPosY + deltaY;
        }
      }

      setSize({ width: nextWidth, height: nextHeight });
      setPosition({ x: nextX, y: nextY });
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  useEffect(() => {
    setInputValue(localColor.toUpperCase());
  }, [localColor]);

  const handleHexInputChange = (val: string) => {
    setInputValue(val.toUpperCase());

    let cleanVal = val.trim();
    if (cleanVal && !cleanVal.startsWith('#')) {
      cleanVal = '#' + cleanVal;
    }

    const isHex = /^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{6}$/.test(cleanVal);
    if (isHex) {
      handleColorChange(cleanVal.toLowerCase());
    }
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, [onClose]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const handleWheel = (e: WheelEvent) => {
      if (e.deltaY !== 0) {
        e.preventDefault();
        el.scrollBy({
          left: e.deltaY * 1.5,
          behavior: 'smooth'
        });
      }
    };

    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', handleWheel);
    };
  }, []);

  // 4. Cache RGB and HSL formatting via useMemo to avoid parsing hex patterns on every loop
  const rgbString = useMemo(() => getRGBString(localColor), [localColor]);
  const hslString = useMemo(() => getHSLString(localColor), [localColor]);

  // Check if custom color gradient button should be active/selected
  const isCustomColorSelected = useMemo(() => {
    return !LOWERCASE_PRESET_COLORS.includes(localColor.toLowerCase());
  }, [localColor]);

  return (
    <div
      className="fixed inset-0 z-[1000] text-on-surface font-sans select-none overflow-hidden animate-fadeIn cursor-pointer"
      style={{ backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', backgroundColor: 'rgba(0, 0, 0, 0.45)' }}
      onClick={onClose}
    >
      <div
        style={{
          position: 'absolute',
          left: `${position.x}px`,
          top: `${position.y}px`,
          width: `${size.width}px`,
          height: `${size.height}px`,
          backgroundColor: activeTheme.surface,
          borderColor: activeTheme.outline,
        }}
        className="sf-anim sf-anim-fade-scale pointer-events-auto border rounded-2xl shadow-[0_16px_50px_rgba(0,0,0,0.85)] overflow-hidden flex flex-col cursor-default relative backdrop-blur-md bg-opacity-95 z-[1001]"
        onMouseDown={handleMouseDown}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 4 Corner Resizers for Custom Size Manipulation */}
        <div 
          onMouseDown={(e) => handleResizeStart('tl', e)}
          className="absolute top-0 left-0 w-6 h-6 cursor-nwse-resize z-50 group/corner select-none"
          title="拖拽左上角调整大小"
        >
          <div className="absolute top-1.5 left-1.5 w-3 h-3 border-t-2 border-l-2 border-primary/45 group-hover/corner:border-primary group-hover/corner:scale-110 transition-all pointer-events-none rounded-tl-sm" />
        </div>
        <div 
          onMouseDown={(e) => handleResizeStart('tr', e)}
          className="absolute top-0 right-0 w-6 h-6 cursor-nesw-resize z-50 group/corner select-none"
          title="拖拽右上角调整大小"
        >
          <div className="absolute top-1.5 right-1.5 w-3 h-3 border-t-2 border-r-2 border-primary/45 group-hover/corner:border-primary group-hover/corner:scale-110 transition-all pointer-events-none rounded-tr-sm" />
        </div>
        <div 
          onMouseDown={(e) => handleResizeStart('bl', e)}
          className="absolute bottom-0 left-0 w-6 h-6 cursor-nesw-resize z-50 group/corner select-none"
          title="拖拽左下角调整大小"
        >
          <div className="absolute bottom-1.5 left-1.5 w-3 h-3 border-b-2 border-l-2 border-primary/45 group-hover/corner:border-primary group-hover/corner:scale-110 transition-all pointer-events-none rounded-bl-sm" />
        </div>
        <div 
          onMouseDown={(e) => handleResizeStart('br', e)}
          className="absolute bottom-0 right-0 w-6 h-6 cursor-nwse-resize z-50 group/corner select-none"
          title="拖拽右下角调整大小"
        >
          <div className="absolute bottom-1.5 right-1.5 w-3 h-3 border-b-2 border-r-2 border-primary/45 group-hover/corner:border-primary group-hover/corner:scale-110 transition-all pointer-events-none rounded-br-sm" />
        </div>

        {/* Modal Header */}
        <div 
          style={{ backgroundColor: activeTheme.bg, borderColor: `${activeTheme.outline}33` }}
          className="flex items-center justify-between p-4 px-5 border-b select-none shrink-0 bg-opacity-80"
        >
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-primary/15 border border-primary/30 flex items-center justify-center">
              <Palette className="text-primary w-4.5 h-4.5" />
            </div>
            <div>
              <h2 className="text-xs font-bold text-on-surface tracking-wide">主题中心</h2>
            </div>
          </div>
          <button 
            onClick={onClose} 
            className="p-1.5 hover:bg-surface-bright border border-outline/30 rounded-lg transition-colors cursor-pointer text-on-surface/60 hover:text-on-surface flex items-center justify-center"
            title="关闭窗口"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Modal Content - Concentrated Theme Settings with Scroll Container Support */}
        <div className="p-5 space-y-5 text-left flex-grow overflow-y-auto min-h-0 scrollbar-thin scrollbar-thumb-white/10 hover:scrollbar-thumb-primary/20">
          
          {/* Preset Theme Selection Cards (Memoized PresetThemeList avoids any lag when custom color palette state updates!) */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-[#ffde82]/70 tracking-wide font-bold flex items-center gap-1.5">
                全局预设
              </span>
              <span className="text-[9px] text-on-surface/30 font-mono">← 左右滑动切换 →</span>
            </div>
            
            <PresetThemeList
              currentThemeId={currentThemeId}
              setCurrentThemeId={setCurrentThemeId}
              scrollRef={scrollRef}
            />
          </div>

          {/* Preset Primary Metallic/Accent colors */}
          <div className="space-y-2.5">
            <span className="text-[11px] text-primary/80 tracking-wide font-bold block">
              全局主色调
            </span>
            <div className="flex flex-col gap-3 bg-bg/40 border border-outline/20 p-3.5 rounded-xl">
              <div className="flex flex-wrap gap-2.5">
                {PRESET_COLORS.map((color, idx) => {
                  const isSel = localColor.toLowerCase() === color.toLowerCase();
                  return (
                    <button 
                      key={idx} 
                      className={`w-7 h-7 rounded-full border-2 transition-all transform hover:scale-110 cursor-pointer relative flex items-center justify-center ${
                        isSel ? 'border-white scale-105 shadow-[0_0_8px_rgba(255,255,255,0.4)]' : 'border-transparent'
                      }`}
                      style={{ backgroundColor: color }}
                      onClick={() => handleColorChange(color)}
                    >
                      {isSel && <Check className="w-3.5 h-3.5 text-black font-extrabold stroke-[3.5]" />}
                    </button>
                  );
                })}
                
                {/* Custom Color Selector (Color Wheel Gradient) */}
                <div 
                  className="relative w-7 h-7 rounded-full border-2 transition-all transform hover:scale-110 cursor-pointer flex items-center justify-center overflow-hidden bg-[conic-gradient(from_0deg,red,orange,yellow,green,blue,purple,red)] shadow-[0_2px_8px_rgba(0,0,0,0.5)]"
                  style={{
                    borderColor: isCustomColorSelected ? 'white' : 'transparent',
                    boxShadow: isCustomColorSelected ? '0 0 10px rgba(255,255,255,0.4)' : 'none'
                  }}
                >
                  <input 
                    type="color" 
                    id="root-theme-color-input"
                    value={localColor.startsWith('#') && localColor.length === 7 ? localColor : '#ffde82'} 
                    onChange={(e) => handleColorChange(e.target.value)}
                    className="absolute inset-0 opacity-0 w-full h-full cursor-pointer z-20"
                    title="自定义调色盘"
                  />
                  {isCustomColorSelected && (
                    <Check className="w-3.5 h-3.5 text-black font-extrabold stroke-[3.5] z-10 drop-shadow-[0_1px_1px_rgba(255,255,255,0.6)]" />
                  )}
                </div>
              </div>
              
              {/* Custom Color Text Input and Multi-color Scheme Translator */}
              <div className="flex flex-col gap-3 border-t border-outline/25 pt-3">
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-on-surface/40 font-mono">自定义输入 16 进制颜色代码 (Hex):</span>
                    <div className="flex items-center gap-1.5">
                      <div className="w-2.5 h-2.5 rounded border border-white/10 shadow-inner" style={{ backgroundColor: localColor }} />
                      <span className="text-[9px] text-[#ffde82]/85 font-mono tracking-widest">{localColor.toUpperCase()}</span>
                    </div>
                  </div>
                  
                  <div className="relative flex items-center">
                    <span className="absolute left-3 text-on-surface/40 font-mono text-xs select-none">#</span>
                    <input 
                      type="text"
                      value={inputValue.replace('#', '')}
                      onChange={(e) => handleHexInputChange(e.target.value)}
                      placeholder={localColor.replace('#', '').toUpperCase()}
                      className="w-full bg-bg/60 border border-outline/30 focus:border-primary/50 focus:outline-none rounded-xl py-2 pl-7 pr-3 text-on-surface/90 text-xs font-mono tracking-wider font-semibold placeholder-on-surface/30 shadow-inner"
                      maxLength={7}
                    />
                  </div>
                </div>

                {/* Multilingual / Color Scheme Mapping & Description */}
                <div className="bg-bg/50 border border-outline/20 p-3 rounded-lg space-y-2">
                  <div className="flex items-center justify-between text-[9px] font-mono text-on-surface/40 border-b border-outline/20 pb-1.5 font-semibold">
                    <span className="flex items-center gap-1">RGB 值: <span className="text-[#3b82f6]/95">{rgbString}</span></span>
                    <span className="flex items-center gap-1">HSL 值: <span className="text-[#a855f7]/95">{hslString}</span></span>
                  </div>
                  <p className="text-[9.5px] text-on-surface/40 leading-relaxed font-sans">
                    💡 <strong>说明</strong>: 此处支持输入 1-6 位 Hex 颜色编码（系统在达到 3 位 or 6 位时自动生效）。在此方案下，底层的色彩引擎将同步把十六进制 Hex 自动解构编译为 <strong>RGB 基色方案</strong>（用于背光和高亮像素混合）以及 <strong>HSL 亮相方案</strong>（用于多通道自适应磨砂玻璃及透明容器投影），在所有全局组件中完成色彩统一应用。
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Code Editor Independent Syntax Theme Selection Section */}
          <div className="space-y-3 pt-3 border-t border-outline/25">
            <span className="text-[11px] text-primary/80 tracking-wide font-bold flex items-center gap-1.5">
              <FileCode className="w-3.5 h-3.5" />
              <span>编辑器独立语法着色主题 (Syntax Theme)</span>
            </span>
            <div className="bg-bg/40 border border-outline/20 p-3.5 rounded-xl space-y-3 font-sans">
              <span className="text-[10px] text-on-surface/50 leading-relaxed block border-b border-outline/10 pb-2">
                💡 这里支持您为内置的代码编辑器独立指定着色风格，使其不受全局 UI 亮暗色调的约束：
              </span>
              
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2.5">
                {SYNTAX_THEMES.map((theme) => {
                  const isSel = syntaxThemeId === theme.id;
                  return (
                    <button
                      type="button"
                      key={theme.id}
                      onClick={() => setSyntaxThemeId(theme.id)}
                      className={`relative p-2.5 rounded-lg border text-left flex flex-col justify-between h-20 transition-all cursor-pointer ${
                        isSel
                          ? 'border-primary bg-primary/10 shadow-[0_0_8px_rgba(var(--color-primary-rgb),0.25)]'
                          : 'border-outline/25 bg-neutral-900/45 hover:bg-neutral-900/70'
                      }`}
                      style={{ backgroundColor: theme.id !== 'auto' ? theme.surface : undefined }}
                    >
                      {/* Name & Selected Status Tick */}
                      <div className="flex items-center justify-between w-full">
                        <span className="text-[10px] font-bold text-on-surface/90 truncate mr-1">
                          {theme.name}
                        </span>
                        {isSel && (
                          <div className="w-3.5 h-3.5 rounded-full bg-primary flex items-center justify-center shrink-0">
                            <Check className="w-2.5 h-2.5 text-black font-extrabold stroke-[3.5]" />
                          </div>
                        )}
                      </div>

                      {/* Preview Colors Row */}
                      <div className="flex items-center gap-1.5 mt-1.5">
                        <div 
                          className="w-3 h-3 rounded-full border border-white/5 shrink-0" 
                          style={{ backgroundColor: theme.id === 'auto' ? '#18181b' : theme.bg }} 
                          title="背景底色"
                        />
                        {theme.id !== 'auto' ? (
                          <div className="flex items-center gap-1">
                            <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: theme.syntaxString }} title="字符串" />
                            <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: theme.syntaxType }} title="类型声明" />
                            <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: theme.syntaxNumber }} title="数字常量" />
                          </div>
                        ) : (
                          <span className="text-[8px] text-on-surface/40 leading-none">自适应同步</span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Custom Accent Application Switches Section */}
          <div className="space-y-3 pt-3 border-t border-outline/25">
            <span className="text-[11px] text-[var(--color-primary)]/70 tracking-wide font-bold flex items-center gap-1.5">
              主色调应用范围
            </span>
            <div className="bg-bg/40 border border-outline/20 p-3.5 rounded-xl space-y-3 font-sans">
              <span className="text-[10px] text-on-surface/50 leading-relaxed block border-b border-outline/10 pb-2">
                💡 请选择界面中哪些主要部分需要应用您自定义的主色调：
              </span>
              
              {/* Item 1: 左侧工具栏导航 */}
              <div className="flex items-center justify-between py-1 border-b border-outline/10 gap-4">
                <div>
                  <span className="text-[11px] font-bold text-on-surface/90 flex items-center gap-1.5 min-w-0">
                    <Menu className="w-3.5 h-3.5 opacity-70 shrink-0" />
                    <span>左侧工具栏导航</span>
                  </span>
                  <span className="text-[9px] text-on-surface/40 leading-normal block mt-0.5">控制资源管理器、历史对话、代码编辑器、搜索、插件等选项卡</span>
                </div>
                <button
                  type="button"
                  onClick={() => handleToggleTarget('activityBar')}
                  className={`w-9 h-5 rounded-full p-0.5 transition-all duration-200 outline-none flex items-center shrink-0 cursor-pointer ${
                    primaryColorTargets.activityBar ? 'bg-primary' : 'bg-outline/30'
                  }`}
                >
                  <div 
                    className={`w-4 h-4 rounded-full bg-black shadow transform transition-transform duration-200 ${
                      primaryColorTargets.activityBar ? 'translate-x-4' : 'translate-x-0'
                    }`} 
                  />
                </button>
              </div>

              {/* Item 2: 快捷技能辅助栏 */}
              <div className="flex items-center justify-between py-1 border-b border-outline/10 gap-4">
                <div>
                  <span className="text-[11px] font-bold text-on-surface/90 flex items-center gap-1.5 min-w-0">
                    <Palette className="w-3.5 h-3.5 opacity-70 shrink-0" />
                    <span>快捷技能辅助栏</span>
                  </span>
                  <span className="text-[9px] text-on-surface/40 leading-normal block mt-0.5">同步 Chat 面板底部的技能、记忆、上传文件、工具、标签及知识库图标二极管色调</span>
                </div>
                <button
                  type="button"
                  onClick={() => handleToggleTarget('skillBar')}
                  className={`w-9 h-5 rounded-full p-0.5 transition-all duration-200 outline-none flex items-center shrink-0 cursor-pointer ${
                    primaryColorTargets.skillBar ? 'bg-primary' : 'bg-outline/30'
                  }`}
                >
                  <div 
                    className={`w-4 h-4 rounded-full bg-black shadow transform transition-transform duration-200 ${
                      primaryColorTargets.skillBar ? 'translate-x-4' : 'translate-x-0'
                    }`} 
                  />
                </button>
              </div>

              {/* Item 3: 顶栏控制台 */}
              <div className="flex items-center justify-between py-1 border-b border-outline/10 gap-4">
                <div>
                  <span className="text-[11px] font-bold text-on-surface/90 flex items-center gap-1.5 min-w-0">
                    <Sliders className="w-3.5 h-3.5 opacity-70 shrink-0" />
                    <span>顶栏控制台</span>
                  </span>
                  <span className="text-[9px] text-on-surface/40 leading-normal block mt-0.5">控制主/副模型下拉开关、模型权重配置及标签管理器的主色调背光</span>
                </div>
                <button
                  type="button"
                  onClick={() => handleToggleTarget('header')}
                  className={`w-9 h-5 rounded-full p-0.5 transition-all duration-200 outline-none flex items-center shrink-0 cursor-pointer ${
                    primaryColorTargets.header ? 'bg-primary' : 'bg-outline/30'
                  }`}
                >
                  <div 
                    className={`w-4 h-4 rounded-full bg-black shadow transform transition-transform duration-200 ${
                      primaryColorTargets.header ? 'translate-x-4' : 'translate-x-0'
                    }`} 
                  />
                </button>
              </div>

              {/* Item 4: 对话工作区 */}
              <div className="flex items-center justify-between py-1 border-b border-outline/10 gap-4">
                <div>
                  <span className="text-[11px] font-bold text-on-surface/90 flex items-center gap-1.5 min-w-0">
                    <MessageSquare className="w-3.5 h-3.5 opacity-70 shrink-0" />
                    <span>对话工作区</span>
                  </span>
                  <span className="text-[9px] text-on-surface/40 leading-normal block mt-0.5">控制文本框高亮轮廓、发送图标按钮微动动画及模式切换面板</span>
                </div>
                <button
                  type="button"
                  onClick={() => handleToggleTarget('chatPanel')}
                  className={`w-9 h-5 rounded-full p-0.5 transition-all duration-200 outline-none flex items-center shrink-0 cursor-pointer ${
                    primaryColorTargets.chatPanel ? 'bg-primary' : 'bg-outline/30'
                  }`}
                >
                  <div 
                    className={`w-4 h-4 rounded-full bg-black shadow transform transition-transform duration-200 ${
                      primaryColorTargets.chatPanel ? 'translate-x-4' : 'translate-x-0'
                    }`} 
                  />
                </button>
              </div>

              {/* Item 5: 编辑器与文件浏览器 */}
              <div className="flex items-center justify-between py-1 border-b border-outline/10 gap-4">
                <div>
                  <span className="text-[11px] font-bold text-on-surface/90 flex items-center gap-1.5 min-w-0">
                    <FileCode className="w-3.5 h-3.5 opacity-70 shrink-0" />
                    <span>编辑器与文件浏览器</span>
                  </span>
                  <span className="text-[9px] text-on-surface/40 leading-normal block mt-0.5">控制活动编辑卡边界线、聚焦标尺标线、文件管理器选中行及面包屑导航</span>
                </div>
                <button
                  type="button"
                  onClick={() => handleToggleTarget('editorAndExplorer')}
                  className={`w-9 h-5 rounded-full p-0.5 transition-all duration-200 outline-none flex items-center shrink-0 cursor-pointer ${
                    primaryColorTargets.editorAndExplorer ? 'bg-primary' : 'bg-outline/30'
                  }`}
                >
                  <div 
                    className={`w-4 h-4 rounded-full bg-black shadow transform transition-transform duration-200 ${
                      primaryColorTargets.editorAndExplorer ? 'translate-x-4' : 'translate-x-0'
                    }`} 
                  />
                </button>
              </div>

              {/* Item 6: 底部状态栏 */}
              <div className="flex items-center justify-between py-1 gap-4">
                <div>
                  <span className="text-[11px] font-bold text-on-surface/90 flex items-center gap-1.5 min-w-0">
                    <PanelBottom className="w-3.5 h-3.5 opacity-70 shrink-0" />
                    <span>底部状态栏</span>
                  </span>
                  <span className="text-[9px] text-on-surface/40 leading-normal block mt-0.5">控制底部控制台状态灯、信息流看板数据项及编码标志的主色调背光</span>
                </div>
                <button
                  type="button"
                  onClick={() => handleToggleTarget('statusBar')}
                  className={`w-9 h-5 rounded-full p-0.5 transition-all duration-200 outline-none flex items-center shrink-0 cursor-pointer ${
                    primaryColorTargets.statusBar ? 'bg-primary' : 'bg-outline/30'
                  }`}
                >
                  <div 
                    className={`w-4 h-4 rounded-full bg-black shadow transform transition-transform duration-200 ${
                      primaryColorTargets.statusBar ? 'translate-x-4' : 'translate-x-0'
                    }`} 
                  />
                </button>
              </div>

            </div>
          </div>

        </div>

        {/* Modal Footer with quick preview confirmation */}
        <div 
          style={{ backgroundColor: activeTheme.bg, borderColor: `${activeTheme.outline}33` }}
          className="p-3.5 border-t flex justify-between items-center text-[10px] text-on-surface/40 font-mono px-5 shrink-0"
        >
          <div className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-[10px] text-on-surface/50 font-sans">更改已自动保存并应用</span>
          </div>
          {(() => {
            const currentPreset = THEME_PRESETS.find(p => p.id === currentThemeId);
            const isCustomized = currentPreset && currentPreset.primary.toLowerCase() !== primaryColor.toLowerCase();
            return isCustomized ? (
              <button 
                onClick={() => {
                  if (currentPreset) {
                    setPrimaryColor(currentPreset.primary);
                  }
                }}
                className="px-3 py-1.5 rounded-lg bg-primary/10 hover:bg-primary/20 border border-primary/35 text-primary text-[10.5px] font-bold transition-all cursor-pointer active:scale-95 flex items-center gap-1.5 hover:shadow-sm"
                title="重置恢复当前预设的原厂配色"
              >
                <RefreshCw className="w-3 h-3 transition-transform duration-500 hover:rotate-180" />
                恢复默认色
              </button>
            ) : (
              <span className="text-[10.5px] font-sans text-on-surface/30 select-none">
                已应用预设原色
              </span>
            );
          })()}
        </div>
      </div>
    </div>
  );
}
