// ─────────────────────────────────────────────────────────────────
// 启动画面 Splash Screen
// ─────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';

interface Props {
  duration?: number;
}

export function Splash({ duration = 1200 }: Props) {
  const [hide, setHide] = useState(false);
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const t1 = setTimeout(() => setPhase(1), 200);
    const t2 = setTimeout(() => setPhase(2), 600);
    const t3 = setTimeout(() => setHide(true), duration);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, [duration]);

  if (hide) return null;

  return (
    <div
      className={`fixed inset-0 z-[100] flex items-center justify-center bg-bg transition-opacity duration-500 ${
        phase === 2 ? 'opacity-0' : 'opacity-100'
      }`}
    >
      <div className="text-center">
        {/* Logo */}
        <div className={`relative inline-block mb-6 transition-all duration-700 ${phase >= 1 ? 'scale-100' : 'scale-50'}`}>
          <div className="absolute inset-0 blur-2xl bg-primary/30 rounded-full" />
          <div className="relative w-20 h-20 rounded-2xl bg-gradient-to-br from-primary to-accent flex items-center justify-center shadow-2xl">
            <span className="material-symbols-outlined filled text-white" style={{ fontSize: 40 }}>token</span>
          </div>
        </div>

        {/* 标题 */}
        <h1 className={`text-3xl font-display font-bold text-text mb-1 transition-all duration-700 ${phase >= 1 ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'}`}>
          SoloForge
        </h1>
        <p className={`text-xs text-text-secondary transition-all duration-700 delay-100 ${phase >= 1 ? 'opacity-100' : 'opacity-0'}`}>
          分布式 MARL 智能体治理 OS
        </p>

        {/* 进度条 */}
        <div className={`mt-8 w-48 mx-auto transition-opacity duration-500 ${phase >= 1 ? 'opacity-100' : 'opacity-0'}`}>
          <div className="h-0.5 bg-surface-high rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-primary to-accent"
              style={{
                animation: 'shimmer 1.2s linear infinite',
                backgroundSize: '200% 100%',
              }}
            />
          </div>
          <div className="mt-2 text-[10px] text-text-secondary font-mono">
            {phase === 0 ? '正在初始化...' : phase === 1 ? '加载模块...' : '准备就绪'}
          </div>
        </div>
      </div>
    </div>
  );
}
