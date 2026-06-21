import React, { useState, useEffect } from 'react';
import { GitBranch, Terminal, HardDrive, Sun, Moon, Zap } from 'lucide-react';
import { useTheme } from '../context/ThemeContext';

interface StatusBarProps {
  currentThemeId?: string;
  setCurrentThemeId?: (id: string) => void;
}

export default function StatusBar({ currentThemeId = 'gruvbox', setCurrentThemeId }: StatusBarProps) {
  const { primaryColorTargets } = useTheme();
  const applyThemeColor = !!primaryColorTargets?.statusBar;
  const [isTerminalCollapsed, setIsTerminalCollapsed] = useState(false);
  const [isDriveMenuOpen, setIsDriveMenuOpen] = useState(false);
  const [order, setOrder] = useState<string[]>(() => {
    const defaults = ['project', 'branch', 'spacer', 'memory', 'cpu', 'disk', 'progress', 'terminal', 'theme', 'encoding'];
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('soloforge_statusbar_order_v4');
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          if (Array.isArray(parsed)) {
            const filtered = parsed.filter(id => defaults.includes(id));
            const missing = defaults.filter(id => !filtered.includes(id));
            return [...filtered, ...missing];
          }
        } catch (e) {}
      }
    }
    return defaults;
  });

  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const handleDragStart = (e: React.DragEvent, index: number) => {
    setDraggedIndex(index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (draggedIndex !== index) {
      setDragOverIndex(index);
    }
  };

  const handleDragLeave = () => {
    setDragOverIndex(null);
  };

  const handleDragEnd = () => {
    setDraggedIndex(null);
    setDragOverIndex(null);
  };

  const handleDrop = (e: React.DragEvent, targetIndex: number) => {
    e.preventDefault();
    let sourceIndex = draggedIndex;
    if (sourceIndex === null) {
      try {
        const raw = e.dataTransfer.getData('text/plain');
        if (raw) {
          sourceIndex = parseInt(raw, 10);
        }
      } catch (err) {}
    }

    if (sourceIndex === null || isNaN(sourceIndex) || sourceIndex === targetIndex) {
      setDraggedIndex(null);
      setDragOverIndex(null);
      return;
    }

    const updated = [...order];
    const [movedItem] = updated.splice(sourceIndex, 1);
    updated.splice(targetIndex, 0, movedItem);

    setOrder(updated);
    if (typeof window !== 'undefined') {
      localStorage.setItem('soloforge_statusbar_order_v4', JSON.stringify(updated));
    }
    setDraggedIndex(null);
    setDragOverIndex(null);
  };

  const [metrics, setMetrics] = useState({
    cpu: 18,
    memoryUsed: '2.1 GB',
    memoryTotal: '8.0 GB',
    memoryPercent: 26,
    diskRead: 0.45,
    diskWrite: 0.12,
    drives: [
      { id: "c", name: "系统主盘 (C:)", path: "C:\\", total: 512 * 1024 * 1024 * 1024, free: 184 * 1024 * 1024 * 1024, used: 328 * 1024 * 1024 * 1024, percentage: 64 },
      { id: "d", name: "数据盘 (D:)", path: "D:\\", total: 1024 * 1024 * 1024 * 1024, free: 580 * 1024 * 1024 * 1024, used: 444 * 1024 * 1024 * 1024, percentage: 43 }
    ],
    selectedDriveIndex: 0
  });

  const handleSelectDrive = (index: number) => {
    setMetrics(prev => ({
      ...prev,
      selectedDriveIndex: index
    }));
    setIsDriveMenuOpen(false);
  };

  useEffect(() => {
    if (!isDriveMenuOpen) return;
    const handleOutsideClick = () => {
      setIsDriveMenuOpen(false);
    };
    const timer = setTimeout(() => {
      window.addEventListener('click', handleOutsideClick);
    }, 50);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('click', handleOutsideClick);
    };
  }, [isDriveMenuOpen]);

  useEffect(() => {
    let active = true;
    
    const fetchMetrics = async () => {
      try {
        const res = await fetch('/api/system-metrics');
        if (!res.ok) throw new Error('API offline');
        const data = await res.json();
        if (data && data.success && active) {
          const usedGB = (data.memory.used / (1024 * 1024 * 1024)).toFixed(2);
          const totalGB = (data.memory.total / (1024 * 1024 * 1024)).toFixed(1);
          
          let smoothed_r = 0;
          let smoothed_w = 0;

          setMetrics(prev => {
            const freshDrives = data.disk.drives && data.disk.drives.length > 0 ? data.disk.drives : prev.drives;
            const updatedIndex = prev.selectedDriveIndex < freshDrives.length ? prev.selectedDriveIndex : 0;
            
            // EWMA (Exponentially Weighted Moving Average) with alpha=0.25 (time response weight)
            const alpha = 0.25;
            const initial_r = prev.diskRead <= 0.01 ? data.disk.readSpeed : prev.diskRead;
            const initial_w = prev.diskWrite <= 0.01 ? data.disk.writeSpeed : prev.diskWrite;
            
            const calcRead = alpha * data.disk.readSpeed + (1 - alpha) * initial_r;
            const calcWrite = alpha * data.disk.writeSpeed + (1 - alpha) * initial_w;
            
            smoothed_r = Number(calcRead.toFixed(2));
            smoothed_w = Number(calcWrite.toFixed(2));

            return {
              cpu: data.cpu,
              memoryUsed: `${usedGB} GB`,
              memoryTotal: `${totalGB} GB`,
              memoryPercent: data.memory.percentage,
              diskRead: smoothed_r,
              diskWrite: smoothed_w,
              drives: freshDrives,
              selectedDriveIndex: updatedIndex
            };
          });
          
          window.dispatchEvent(new CustomEvent('soloforge-live-telemetry', { 
            detail: { 
              cpu: data.cpu, 
              memoryUsed: parseFloat(usedGB),
              memoryTotal: parseFloat(totalGB),
              memoryPercent: data.memory.percentage,
              diskRead: smoothed_r,
              diskWrite: smoothed_w,
              drives: data.disk.drives || metrics.drives,
              selectedDriveIndex: metrics.selectedDriveIndex
            } 
          }));
        }
      } catch (err) {
        // Fallback to local browser performance metrics
        const perf = (performance as any);
        if (perf && perf.memory && active) {
          const usedJSVal = perf.memory.usedJSHeapSize;
          const totalJSVal = perf.memory.totalJSHeapSize;
          const limitJSVal = perf.memory.jsHeapLimit;
          const usedJS = (usedJSVal / (1024 * 1024)).toFixed(1);
          const totalJS = (totalJSVal / (1024 * 1024)).toFixed(1);
          const jsPercent = Math.max(1, Math.round((usedJSVal / limitJSVal) * 100));
          
          const mockCpu = Math.round(12 + Math.sin(Date.now() / 6000) * 4 + Math.random() * 6);
          const mockRead = Number((0.8 + Math.sin(Date.now() / 5000) * 0.4 + Math.random() * 0.5).toFixed(2));
          const mockWrite = Number((0.3 + Math.sin(Date.now() / 7000) * 0.1 + Math.random() * 0.2).toFixed(2));
          
          let smoothed_r = 0;
          let smoothed_w = 0;

          setMetrics(prev => {
            const alpha = 0.25;
            const initial_r = prev.diskRead <= 0.01 ? mockRead : prev.diskRead;
            const initial_w = prev.diskWrite <= 0.01 ? mockWrite : prev.diskWrite;
            
            const calcRead = alpha * mockRead + (1 - alpha) * initial_r;
            const calcWrite = alpha * mockWrite + (1 - alpha) * initial_w;
            
            smoothed_r = Number(calcRead.toFixed(2));
            smoothed_w = Number(calcWrite.toFixed(2));

            return {
              cpu: mockCpu,
              memoryUsed: `${usedJS} MB`,
              memoryTotal: `${totalJS} MB`,
              memoryPercent: jsPercent,
              diskRead: smoothed_r,
              diskWrite: smoothed_w,
              drives: prev.drives,
              selectedDriveIndex: prev.selectedDriveIndex
            };
          });

          window.dispatchEvent(new CustomEvent('soloforge-live-telemetry', { 
            detail: { 
              cpu: mockCpu, 
              memoryUsed: parseFloat(usedJS),
              memoryTotal: parseFloat(totalJS),
              memoryPercent: jsPercent,
              diskRead: smoothed_r,
              diskWrite: smoothed_w
            } 
          }));
        } else if (active) {
          const mockCpu = Math.round(15 + Math.sin(Date.now() / 4000) * 8 + Math.random() * 5);
          const mockMemUsed = (2.1 + Math.sin(Date.now() / 10000) * 0.1 + Math.random() * 0.05).toFixed(2);
          const mockRead = Number((1.2 + Math.sin(Date.now() / 3000) * 0.6 + Math.random() * 0.4).toFixed(2));
          const mockWrite = Number((0.6 + Math.sin(Date.now() / 4500) * 0.3 + Math.random() * 0.2).toFixed(2));

          let smoothed_r = 0;
          let smoothed_w = 0;

          setMetrics(prev => {
            const alpha = 0.25;
            const initial_r = prev.diskRead <= 0.01 ? mockRead : prev.diskRead;
            const initial_w = prev.diskWrite <= 0.01 ? mockWrite : prev.diskWrite;
            
            const calcRead = alpha * mockRead + (1 - alpha) * initial_r;
            const calcWrite = alpha * mockWrite + (1 - alpha) * initial_w;
            
            smoothed_r = Number(calcRead.toFixed(2));
            smoothed_w = Number(calcWrite.toFixed(2));

            return {
              cpu: mockCpu,
              memoryUsed: `${mockMemUsed} GB`,
              memoryTotal: '8.0 GB',
              memoryPercent: Math.round((parseFloat(mockMemUsed) / 8) * 100),
              diskRead: smoothed_r,
              diskWrite: smoothed_w,
              drives: prev.drives,
              selectedDriveIndex: prev.selectedDriveIndex
            };
          });

          window.dispatchEvent(new CustomEvent('soloforge-live-telemetry', { 
            detail: { 
              cpu: mockCpu, 
              memoryUsed: parseFloat(mockMemUsed),
              memoryTotal: 8,
              memoryPercent: Math.round((parseFloat(mockMemUsed) / 8) * 100),
              diskRead: smoothed_r,
              diskWrite: smoothed_w
            } 
          }));
        }
      }
    };

    fetchMetrics();
    const intervalId = setInterval(fetchMetrics, 500);

    return () => {
      active = false;
      clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    const handleTerminalState = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail && typeof detail.isCollapsed === 'boolean') {
        setIsTerminalCollapsed(detail.isCollapsed);
      }
    };
    window.addEventListener('soloforge-terminal-state-changed', handleTerminalState);
    return () => {
      window.removeEventListener('soloforge-terminal-state-changed', handleTerminalState);
    };
  }, []);

  const toggleTerminalPanel = () => {
    window.dispatchEvent(new CustomEvent('soloforge-toggle-terminal'));
  };



  const renderItemContent = (itemId: string) => {
    switch (itemId) {
      case 'project':
        return (
          <div className={`flex items-center gap-1 select-none shrink-0 ${applyThemeColor ? 'text-[var(--color-primary)]' : 'text-on-surface/50'}`}>
            <span className={`w-1.5 h-1.5 rounded-full border shrink-0 ${applyThemeColor ? 'border-[var(--color-primary)]/40 bg-[var(--color-primary)]' : 'border-[var(--color-outline)]/40 bg-on-surface/10'}`} />
            <span className="hidden sm:inline">项目:</span>
            <strong className={`truncate max-w-[80px] font-bold ${applyThemeColor ? 'text-[var(--color-primary)]' : 'text-on-surface/85'}`}>BlogSystem</strong>
          </div>
        );
      case 'branch':
        return (
          <div className={`flex items-center gap-1 hover:opacity-80 transition-opacity select-none shrink-0 ${applyThemeColor ? 'text-[var(--color-primary)]' : 'text-on-surface/50'}`}>
            <GitBranch className={`w-3 h-3 stroke-[1.5] ${applyThemeColor ? 'text-[var(--color-primary)]' : 'text-on-surface/40'}`} />
            <span className="hidden sm:inline">分支:</span>
            <strong className={`font-bold ${applyThemeColor ? 'text-[var(--color-primary)]' : 'text-on-surface/75'}`}>main</strong>
          </div>
        );

      case 'memory':
        return (
          <div id="status-bar-memory" className={`flex items-center gap-1 shrink-0 select-none ${applyThemeColor ? 'text-[var(--color-primary)]/80' : 'text-on-surface/50'}`}>
            <span className="hidden sm:inline">内存:</span>
            <span className={`hidden md:inline w-[52px] text-right font-bold font-mono inline-block tabular-nums ${applyThemeColor ? 'text-[var(--color-primary)]' : 'text-on-surface/80'}`}>
              {metrics.memoryUsed}
            </span>
            <span className={`hidden md:inline ${applyThemeColor ? 'text-[var(--color-primary)]/50' : 'text-on-surface/30'}`}>/</span>
            <span className={`hidden md:inline font-mono ${applyThemeColor ? 'text-[var(--color-primary)]/70' : 'text-on-surface/50'}`}>{metrics.memoryTotal}</span>
            <span className={`text-[8.5px] rounded px-1 ml-1.5 font-mono font-bold scale-[0.85] origin-left shrink-0 ${applyThemeColor ? 'text-[var(--color-primary)] bg-[var(--color-primary)]/15 border border-[var(--color-primary)]/30' : 'text-on-surface/60 bg-[var(--color-primary)]/10 border border-[var(--color-primary)]/20'}`}>
              {metrics.memoryPercent}%
            </span>
          </div>
        );
      case 'cpu':
        return (
          <div id="status-bar-cpu" className={`flex items-center gap-1 shrink-0 select-none ${applyThemeColor ? 'text-[var(--color-primary)]/85' : 'text-on-surface/50'}`}>
            <span className="hidden sm:inline">CPU:</span>
            <span className={`w-[28px] text-right font-mono font-bold inline-block tabular-nums ${applyThemeColor ? 'text-[var(--color-primary)]' : 'text-on-surface/80'}`}>
              {metrics.cpu}%
            </span>
          </div>
        );
      case 'disk':
        const activeDrive = metrics.drives[metrics.selectedDriveIndex];
        return (
          <div className="relative shrink-0 select-none" onClick={(e) => e.stopPropagation()}>
            <div 
              id="status-bar-disk" 
              onClick={(e) => {
                e.stopPropagation();
                setIsDriveMenuOpen(!isDriveMenuOpen);
              }}
              className={`flex items-center gap-1 cursor-pointer px-1 py-0.5 rounded transition-all duration-200 shrink-0 ${applyThemeColor ? 'hover:bg-[var(--color-primary)]/10 text-[var(--color-primary)]' : 'hover:bg-white/5 hover:text-on-surface/90 text-on-surface/55'}`}
              title={`点击选择活动硬件磁盘。当前：${activeDrive?.name || ''}`}
            >
              <HardDrive className={`w-3.5 h-3.5 stroke-[1.5] shrink-0 ${applyThemeColor ? 'text-[var(--color-primary)]' : 'text-on-surface/40'}`} />
              <span className={`font-bold uppercase shrink-0 ${applyThemeColor ? 'text-[var(--color-primary)]' : 'text-on-surface/70'}`}>{activeDrive?.id || 'c'}:</span>
              
              <div className={`hidden md:flex items-center text-[8.5px] border-l pl-1.5 ml-1.5 font-mono shrink-0 select-none ${applyThemeColor ? 'border-[var(--color-primary)]/20' : 'border-on-surface/15'}`}>
                <span className={`shrink-0 font-sans ${applyThemeColor ? 'text-[var(--color-primary)]/70' : 'text-on-surface/40'}`}>读:</span>
                <span className={`w-[32px] text-right font-mono font-bold inline-block tabular-nums shrink-0 ${applyThemeColor ? 'text-[var(--color-primary)]' : 'text-on-surface/80'}`}>
                  {metrics.diskRead.toFixed(1)}
                </span>
                <span className={`shrink-0 ml-0.5 ${applyThemeColor ? 'text-[var(--color-primary)]/60' : 'text-on-surface/30'}`}>M/s</span>
                <span className={`mx-1.5 shrink-0 ${applyThemeColor ? 'text-[var(--color-primary)]/30' : 'text-on-surface/20'}`}>|</span>
                <span className={`shrink-0 font-sans ${applyThemeColor ? 'text-[var(--color-primary)]/70' : 'text-on-surface/40'}`}>写:</span>
                <span className={`w-[32px] text-right font-mono font-bold inline-block tabular-nums shrink-0 ${applyThemeColor ? 'text-[var(--color-primary)]' : 'text-on-surface/80'}`}>
                  {metrics.diskWrite.toFixed(1)}
                </span>
                <span className={`shrink-0 ml-0.5 ${applyThemeColor ? 'text-[var(--color-primary)]/60' : 'text-on-surface/30'}`}>M/s</span>
              </div>
            </div>

            {/* Disk Dropdown popup above the status bar */}
            {isDriveMenuOpen && (
              <div 
                onClick={(e) => e.stopPropagation()}
                className="absolute bottom-full mb-1.5 right-0 bg-[var(--color-surface-bright)] border border-[var(--color-outline)]/20 rounded-lg p-1.5 min-w-[200px] shadow-2xl z-30 flex flex-col gap-1 text-[10px]"
              >
                <div className="px-2 py-1 text-[8.5px] text-on-surface/40 uppercase tracking-wider font-bold border-b border-on-surface/10 mb-1 font-mono">
                  选择活动磁盘核心
                </div>
                {metrics.drives.map((drv, idx) => {
                  const isSelected = idx === metrics.selectedDriveIndex;
                  const usedSize = (drv.used / (1024 * 1024 * 1024)).toFixed(1);
                  const totalSize = (drv.total / (1024 * 1024 * 1024)).toFixed(0);
                  return (
                    <button
                      type="button"
                      key={drv.id}
                      onClick={() => handleSelectDrive(idx)}
                      className={`flex flex-col text-left px-2 py-1.5 rounded-md transition-all font-mono border ${
                        isSelected 
                          ? 'bg-[var(--color-primary)]/10 border-[var(--color-primary)]/20 text-[var(--color-primary)] font-bold' 
                          : 'text-on-surface/60 hover:bg-white/5 border-transparent'
                      }`}
                    >
                      <div className="flex justify-between items-center w-full">
                        <span className="truncate max-w-[125px] font-sans font-medium text-white/90">{drv.name}</span>
                        <span className="text-[10px] text-on-surface/40 uppercase font-mono">{drv.id}:</span>
                      </div>
                      <div className="flex items-center justify-between text-[9px] text-on-surface/35 mt-0.5 font-mono">
                        <span>{usedSize}GB / {totalSize}GB</span>
                        <span className={isSelected ? 'text-[var(--color-primary)] font-bold' : 'text-on-surface/40'}>{drv.percentage}%</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      case 'progress':
        return (
          <div id="status-bar-task-progress" className={`flex items-center gap-1.5 select-none shrink-0 ${applyThemeColor ? 'text-[var(--color-primary)]/90' : 'text-on-surface/45'}`}>
            <span className="hidden sm:inline">进度:</span>
            <div className={`w-16 h-1 rounded-full overflow-hidden border relative shrink-0 ${applyThemeColor ? 'bg-[var(--color-primary)]/10 border-[var(--color-primary)]/20' : 'bg-on-surface/5 border-on-surface/5'}`}>
              <div className="bg-[var(--color-primary)] opacity-75 h-full w-[65%]" />
            </div>
            <span className={`font-bold font-mono ${applyThemeColor ? 'text-[var(--color-primary)]' : 'text-on-surface/75'}`}>65%</span>
          </div>
        );

      case 'terminal':
        return (
          <button 
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              toggleTerminalPanel();
            }}
            className={`flex items-center gap-1 px-1.5 py-0.5 rounded transition-all cursor-pointer select-none border ${
              isTerminalCollapsed 
                ? (applyThemeColor 
                    ? 'text-[var(--color-primary)]/75 border-transparent hover:text-[var(--color-primary)] hover:bg-[var(--color-primary)]/10' 
                    : 'text-on-surface/40 border-transparent hover:text-on-surface/70 hover:bg-[#ffffff09]')
                : (applyThemeColor
                    ? 'text-[var(--color-primary)] bg-[var(--color-primary)]/15 border-[var(--color-primary)]/35 font-bold'
                    : 'text-on-surface/85 bg-white/5 border-on-surface/10 font-semibold')
            }`}
            title={isTerminalCollapsed ? "展开控制台" : "收起控制台"}
          >
            <Terminal className="w-3 h-3 stroke-[1.5]" />
            <span className="hidden sm:inline">控制台</span>
          </button>
        );
      case 'theme':
        return (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (setCurrentThemeId) {
                setCurrentThemeId(currentThemeId === 'light' ? 'dark' : 'light');
              }
            }}
            className={`flex items-center gap-1.5 px-2 py-0.5 rounded cursor-pointer transition-all border border-transparent ${applyThemeColor ? 'hover:bg-[var(--color-primary)]/10 hover:border-[var(--color-primary)]/20 hover:text-[var(--color-primary)] text-[var(--color-primary)]/80' : 'hover:bg-white/5 hover:border-on-surface/10 hover:text-on-surface text-on-surface/75'}`}
            title={`当前主题: ${currentThemeId === 'light' ? '浅色模式' : currentThemeId === 'dark' ? '深色模式' : '黄金时代'} (点击快速切换)`}
          >
            {currentThemeId === 'light' ? (
              <Sun className="w-3.5 h-3.5 text-amber-500 fill-amber-500/20" />
            ) : currentThemeId === 'dark' ? (
              <Moon className="w-3.5 h-3.5 text-blue-400 fill-blue-400/20" />
            ) : (
              <Zap className="w-3.5 h-3.5 text-primary" />
            )}
            <span className="hidden sm:inline font-sans text-[10px]">
              {currentThemeId === 'light' ? '浅色模式' : currentThemeId === 'dark' ? '深色模式' : '黄金时代'}
            </span>
          </button>
        );
      case 'encoding':
        return (
          <div className={`flex items-center gap-1 transition-colors cursor-pointer shrink-0 select-none ${applyThemeColor ? 'text-[var(--color-primary)]/70 hover:text-[var(--color-primary)]' : 'text-on-surface/40 hover:text-on-surface/70'}`}>
            <span>UTF-8</span>
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div className="relative h-[24px] bg-[var(--color-surface)] border-t border-[var(--color-outline)]/15 select-none text-[10px] text-on-surface/55 font-mono flex items-center w-full z-20 shrink-0 transition-all duration-200">
      {order.map((itemId, idx) => {
        if (itemId === 'spacer') {
          const isOver = dragOverIndex === idx;
          return (
            <div
              key="spacer"
              onDragOver={(e) => handleDragOver(e, idx)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, idx)}
              className={`flex-1 min-w-[12px] h-full transition-all duration-150 relative border-r border-[var(--color-outline)]/10 last:border-r-0 ${
                isOver ? 'bg-[var(--color-primary)]/5' : ''
              }`}
            >
              {isOver && (
                <div className="absolute left-1/2 -translate-x-1/2 top-0 bottom-0 w-[2px] bg-[var(--color-primary)] opacity-60 pointer-events-none" />
              )}
            </div>
          );
        }

        const content = renderItemContent(itemId);
        if (!content) return null;

        const isDragging = draggedIndex === idx;
        const isOver = dragOverIndex === idx;
        const isInteractive = itemId === 'terminal' || (itemId === 'disk' && isDriveMenuOpen);

        return (
          <div
            key={itemId}
            draggable={!isInteractive}
            onDragStart={(e) => handleDragStart(e, idx)}
            onDragOver={(e) => handleDragOver(e, idx)}
            onDragLeave={handleDragLeave}
            onDragEnd={handleDragEnd}
            onDrop={(e) => {
              e.stopPropagation();
              handleDrop(e, idx);
            }}
            className={`flex-none shrink-0 relative h-full flex items-center justify-center px-3.5 border-r border-[var(--color-outline)]/10 last:border-r-0 select-none transition-all duration-150 whitespace-nowrap ${
              isDragging ? 'opacity-20 bg-black/30' : ''
            } ${
              isOver ? 'bg-[var(--color-primary)]/5' : ''
            } ${
              !isInteractive ? 'cursor-grab active:cursor-grabbing hover:bg-white/5 active:bg-white/10' : ''
            }`}
            title="按住拖拽以重新安排位置"
          >
            {isOver && (
              <div className="absolute left-0 top-0 bottom-0 w-[2px] bg-[var(--color-primary)] z-20 shadow-[0_0_8px_var(--color-primary)] pointer-events-none" />
            )}
            {content}
          </div>
        );
      })}
    </div>
  );
}
