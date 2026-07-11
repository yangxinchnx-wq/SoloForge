import { execSync } from 'node:child_process';

const SW_HIDE = 0;
const SW_SHOW = 5;
const SW_SHOWNA = 8;
const WM_CLOSE = 0x0010;

interface WindowHandle {
  hwnd: number;
  process: number;
}

function validateNumericInput(value: number, paramName: string): void {
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new Error(`[CanvasWindowManager] Invalid ${paramName}: must be non-negative integer, got ${value}`);
  }
}

function validateSessionId(sessionId: string): void {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) {
    throw new Error(`[CanvasWindowManager] Invalid sessionId: must match ^[a-zA-Z0-9_-]{1,128}$`);
  }
}

export class CanvasWindowManager {
  private sessionWindows: Map<string, WindowHandle> = new Map();

  execPs(script: string): string {
    try {
      const result = execSync(
        `powershell -NoProfile -Command "${script.replace(/"/g, '\\"')}"`,
        { timeout: 5000, encoding: 'utf-8' }
      );
      return (result || '').trim();
    } catch {
      return '';
    }
  }

  embedWindow(flutterHwnd: number, electronHwnd: number): void {
    validateNumericInput(flutterHwnd, 'flutterHwnd');
    validateNumericInput(electronHwnd, 'electronHwnd');

    this.execPs(
      `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
'@; [Win32]::SetParent(${flutterHwnd}, ${electronHwnd}); [Win32]::SetWindowPos(${flutterHwnd}, 0, 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0004)`
    );
  }

  resizeCanvas(sessionId: string, width: number, height: number): void {
    validateSessionId(sessionId);
    validateNumericInput(width, 'width');
    validateNumericInput(height, 'height');

    const entry = this.sessionWindows.get(sessionId);
    if (!entry) return;
    this.execPs(
      `Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
}
'@; [Win32]::SetWindowPos(${entry.hwnd}, 0, 0, 0, ${width}, ${height}, 0x0002 -bor 0x0004 -bor 0x0040)`
    );
  }

  showCanvas(sessionId: string): void {
    validateSessionId(sessionId);

    const entry = this.sessionWindows.get(sessionId);
    if (!entry) return;
    this.execPs(
      `Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
'@; [Win32]::ShowWindow(${entry.hwnd}, ${SW_SHOWNA})`
    );
  }

  hideCanvas(sessionId: string): void {
    validateSessionId(sessionId);

    const entry = this.sessionWindows.get(sessionId);
    if (!entry) return;
    this.execPs(
      `Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
'@; [Win32]::ShowWindow(${entry.hwnd}, ${SW_HIDE})`
    );
  }

  destroyCanvas(sessionId: string): void {
    validateSessionId(sessionId);

    const entry = this.sessionWindows.get(sessionId);
    if (!entry) return;
    this.execPs(
      `Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern int PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
}
'@; [Win32]::PostMessage(${entry.hwnd}, ${WM_CLOSE}, 0, 0)`
    );
    this.sessionWindows.delete(sessionId);
  }

  registerWindow(sessionId: string, hwnd: number, processPid?: number): void {
    validateSessionId(sessionId);
    validateNumericInput(hwnd, 'hwnd');
    if (processPid !== undefined) {
      validateNumericInput(processPid, 'processPid');
    }
    this.sessionWindows.set(sessionId, { hwnd, process: processPid || 0 });
  }

  unregisterWindow(sessionId: string): void {
    this.sessionWindows.delete(sessionId);
  }
}
