import type { ChildProcess } from 'node:child_process';
import { PortManager } from './PortManager';

export interface CanvasSession {
  projectId: string;
  port: number;
  flutterProcess: ChildProcess | null;
  parentHwnd: number;
  isActive: boolean;
}

export class CanvasSessionManager {
  private sessions: Map<string, CanvasSession> = new Map();
  private accessOrder: string[] = [];
  private readonly maxSessions = 3;

  createSession(projectId: string): CanvasSession {
    const existing = this.sessions.get(projectId);
    if (existing) {
      this.touchAccess(projectId);
      return existing;
    }

    if (this.sessions.size >= this.maxSessions) {
      this.evictLRU();
    }

    const session: CanvasSession = {
      projectId,
      port: 0,
      flutterProcess: null,
      parentHwnd: 0,
      isActive: false,
    };

    this.sessions.set(projectId, session);
    this.accessOrder.push(projectId);
    return session;
  }

  getSession(projectId: string): CanvasSession | undefined {
    return this.sessions.get(projectId);
  }

  switchToSession(projectId: string): void {
    const target = this.sessions.get(projectId);
    if (!target) return;

    for (const [, session] of this.sessions) {
      if (session.projectId !== projectId && session.isActive) {
        session.isActive = false;
      }
    }

    target.isActive = true;
    this.touchAccess(projectId);
  }

  destroySession(projectId: string): void {
    const session = this.sessions.get(projectId);
    if (!session) return;

    if (session.flutterProcess && !session.flutterProcess.killed) {
      session.flutterProcess.kill('SIGTERM');
      setTimeout(() => {
        if (session.flutterProcess && !session.flutterProcess.killed) {
          session.flutterProcess.kill('SIGKILL');
        }
      }, 5000);
    }

    this.sessions.delete(projectId);
    const idx = this.accessOrder.indexOf(projectId);
    if (idx !== -1) {
      this.accessOrder.splice(idx, 1);
    }
  }

  async getOrCreateSession(projectId: string): Promise<CanvasSession> {
    const existing = this.sessions.get(projectId);
    if (existing) {
      this.touchAccess(projectId);
      return existing;
    }

    if (this.sessions.size >= this.maxSessions) {
      this.evictLRU();
    }

    const port = await PortManager.allocatePort();

    const session: CanvasSession = {
      projectId,
      port,
      flutterProcess: null,
      parentHwnd: 0,
      isActive: false,
    };

    this.sessions.set(projectId, session);
    this.accessOrder.push(projectId);
    return session;
  }

  private evictLRU(): void {
    if (this.accessOrder.length === 0) return;
    const lruId = this.accessOrder[0];
    this.accessOrder.splice(0, 1);
    this.destroySession(lruId);
  }

  private touchAccess(projectId: string): void {
    const idx = this.accessOrder.indexOf(projectId);
    if (idx !== -1) {
      this.accessOrder.splice(idx, 1);
    }
    this.accessOrder.push(projectId);
  }
}
