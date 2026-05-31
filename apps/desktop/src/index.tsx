// ─────────────────────────────────────────────────────────────────
// SoloForge Frontend Entry
// 加载 UI/themes/default-dark/app 中的真实 UI 组件
// ─────────────────────────────────────────────────────────────────

import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from '../../../UI/themes/default-dark/app/App';
import { ThemeProvider } from '../../../UI/themes/default-dark/components/theme-context';

import '../../../UI/themes/default-dark/app/styles.css';

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
