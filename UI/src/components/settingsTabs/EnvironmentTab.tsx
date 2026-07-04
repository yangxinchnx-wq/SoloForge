import React, { useState } from 'react';
import { Terminal } from 'lucide-react';

// 05. 沙箱环境配置
export default function EnvironmentTab() {
  const [selectedEnv, setSelectedEnv] = useState('android');
  const [installingStatus, setInstallingStatus] = useState<'idle' | 'installing' | 'completed'>('idle');
  const [installProgress, setInstallProgress] = useState(0);
  const [terminalLogs, setTerminalLogs] = useState<string[]>([]);

  const startEnvSetup = () => {
    setInstallingStatus('installing');
    setInstallProgress(0);
    setTerminalLogs(['[SYS] 正在检查本地环境依赖...', '[SYS] 正在准备沙箱目录文件夹结构...']);

    const interval = setInterval(() => {
      setInstallProgress(prev => {
        const next = prev + 15;
        if (next >= 100) {
          clearInterval(interval);
          setInstallingStatus('completed');
          setTerminalLogs(l => [
            ...l,
            `[SYS] 安装包加载已结束. (100%)`,
            `[OK] 极客环境部署成功。可独立运行！`,
            `如无需要请按回车条过`
          ]);
          return 100;
        }

        let customLog = '';
        if (next === 30) customLog = `[DOWNLOAD] 提取对应多版本套件包 (240MB)...`;
        if (next === 60) customLog = `[SETUP] 配置本地环境变量 PATH 与符号链接...`;
        if (next === 90) customLog = `[VM] 虚拟沙箱检测通过。`;

        if (customLog) {
          setTerminalLogs(l => [...l, customLog]);
        }
        return next;
      });
    }, 400);
  };

  return (
    <div className="space-y-6 animate-fadeIn">
      <div className="border-b border-[var(--color-outline)]/20 pb-3 mb-2">
        <h3 className="text-base font-bold text-[var(--color-on-surface)]">沙箱环境配置</h3>
        <p className="text-xs text-on-surface/50 mt-1">初始化及隔离独立编译进程，阻止不同版本物理依赖冲突</p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <span className="text-xs text-on-surface/50 font-semibold block">选择系统目标环境</span>
          <select
            value={selectedEnv}
            onChange={(e) => setSelectedEnv(e.target.value)}
            className="w-full text-sm p-3 bg-[var(--color-surface)] border border-[var(--color-outline)]/25 rounded-xl text-[var(--color-on-surface)] outline-none cursor-pointer focus:border-[var(--color-primary)]"
          >
            <option value="android">安卓开发套件 (Android Studio SDK & Gradle)</option>
            <option value="java">Java 运行环境 (JDK Runtime)</option>
            <option value="c">C 编译组件 (MinGW-64 简便版)</option>
            <option value="cpp">C++ 高性能引擎 (GCC 工具链)</option>
            <option value="python">Python 专业工具链 (Poetry Environment)</option>
            <option value="custom">通用自定义终端会话 (Bash Shell)</option>
          </select>
        </div>

        <div className="flex flex-col justify-end">
          <button
            onClick={startEnvSetup}
            className="w-full bg-[var(--color-primary)] hover:opacity-90 text-[var(--color-bg)] font-extrabold text-sm py-3 rounded-xl transition-all cursor-pointer active:scale-95 flex items-center justify-center gap-2 shadow-md"
          >
            <Terminal className="w-4 h-4" />
            <span>配置沙箱文件夹并打包模块</span>
          </button>
        </div>
      </div>

      {/* Progress Terminal */}
      <div className="bg-[var(--color-bg)] border border-[var(--color-outline)]/25 rounded-xl p-4 font-mono text-xs h-48 flex flex-col justify-between overflow-hidden shadow-inner">
        <div className="space-y-1 overflow-y-auto flex-1 scrollbar-none text-left">
          <span className="text-xs text-emerald-500 block border-b border-[var(--color-outline)]/10 pb-1 mb-2">SANDBOX ENVIRONMENT MONITOR v1.1.0</span>
          {terminalLogs.length === 0 ? (
            <span className="text-on-surface/30 italic">等待初始化依赖环境唤醒指令...</span>
          ) : (
            terminalLogs.map((log, idx) => (
              <div key={idx} className={log.includes('[OK]') ? 'text-emerald-500 font-bold' : log.includes('[DOWNLOAD]') ? 'text-blue-500' : 'text-on-surface/60'}>
                {log}
              </div>
            ))
          )}
        </div>

        {installingStatus === 'installing' && (
          <div className="mt-3 border-t border-[var(--color-outline)]/10 pt-2">
            <div className="flex justify-between text-xs text-on-surface/40 mb-1">
              <span>解压与下载所需依赖中...</span>
              <span>{installProgress}%</span>
            </div>
            <div className="w-full bg-[var(--color-surface-bright)] h-1.5 rounded-full overflow-hidden">
              <div className="bg-[var(--color-primary)] h-full transition-all duration-300" style={{ width: `${installProgress}%` }} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
