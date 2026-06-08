// ─────────────────────────────────────────────────────────────────
// SoloForge 前端入口
// ─────────────────────────────────────────────────────────────────

import React from 'react';
import ReactDOM from 'react-dom/client';
import { ThemeProvider } from './themes';
import { App } from './App';
import './themes/global.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </React.StrictMode>,
);
