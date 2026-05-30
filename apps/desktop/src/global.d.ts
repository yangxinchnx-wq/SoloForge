// ─────────────────────────────────────────────────────────────────
// Global Type Declarations
// ─────────────────────────────────────────────────────────────────

import type { ElectronAPI } from './types';

declare global {
  interface Window {
    soloforge: ElectronAPI;
  }
}

export {};
