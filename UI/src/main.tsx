import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { ThemeProvider } from './context/ThemeContext';

// Suppress harmless 'ResizeObserver loop completed with undelivered notifications' browser engine warnings
if (typeof window !== 'undefined') {
  const isResizeObserverError = (msg: any): boolean => {
    if (!msg) return false;
    const str = String(msg).toLowerCase();
    return str.includes('resizeobserver') || 
           str.includes('resize observer') || 
           str.includes('loop limit') ||
           str.includes('undelivered notifications');
  };

  const ignoreResizeObserverError = (e: ErrorEvent) => {
    const msg = e.message || (e.error && e.error.message);
    if (isResizeObserverError(msg)) {
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  };

  window.addEventListener('error', ignoreResizeObserverError, true);

  // Suppress in window.onerror as well
  const originalOnError = window.onerror;
  window.onerror = function (message, source, lineno, colno, error) {
    if (isResizeObserverError(message) || (error && isResizeObserverError(error.message))) {
      return true; // Suppress reporting
    }
    if (originalOnError) {
      return originalOnError.apply(this, arguments as any);
    }
    return false;
  };

  // Suppress in unhandled promise rejections
  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    const msg = e.reason?.message || e.reason;
    if (isResizeObserverError(msg)) {
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  }, true);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>,
);
