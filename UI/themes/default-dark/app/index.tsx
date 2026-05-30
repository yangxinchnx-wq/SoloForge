// ─────────────────────────────────────────────────────────────────
// SoloForge React Entry Point
// 主入口文件
// ─────────────────────────────────────────────────────────────────

import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { ThemeProvider } from '../../components/theme-context';

import './styles.css';

// 等待 Electron API 初始化
function waitForSoloforge(maxAttempts = 50): Promise<boolean> {
  return new Promise((resolve) => {
    let attempts = 0;
    const check = () => {
      attempts++;
      if ((window as any).soloforge) {
        resolve(true);
      } else if (attempts < maxAttempts) {
        setTimeout(check, 100);
      } else {
        console.warn('[Renderer] Electron API not found, running in standalone mode');
        resolve(false);
      }
    };
    check();
  });
}

// 初始化应用
async function init() {
  const hasElectron = await waitForSoloforge();

  const root = ReactDOM.createRoot(document.getElementById('root')!);

  root.render(
    <React.StrictMode>
      <ThemeProvider initialTheme="default-dark">
        <App hasElectron={hasElectron} />
      </ThemeProvider>
    </React.StrictMode>
  );

  console.log('[Renderer] SoloForge 初始化完成', { hasElectron });
}

init();
