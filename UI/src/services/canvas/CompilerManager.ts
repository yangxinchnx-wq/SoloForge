import { spawn, type ChildProcess } from 'node:child_process';

export class CompilerManager {
  private compilers: Map<string, ChildProcess> = new Map();
  private idleTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private compileResolvers: Map<string, { resolve: (value: boolean) => void; reject: (reason: unknown) => void }> = new Map();
  private readonly idleTimeoutMs = 60000;

  startCompiler(sessionId: string, dartSdkPath: string, entryPoint: string): ChildProcess {
    this.stopCompiler(sessionId);

    const compilerPath = `${dartSdkPath}/bin/snapshots/frontend_server.dart.snapshot`;
    const proc = spawn('dart', [compilerPath, '--sdk-root', `${dartSdkPath}/flutter_patched_sdk`, '--target=flutter', '--incremental', entryPoint], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.compilers.set(sessionId, proc);
    this.resetIdleTimer(sessionId);

    proc.on('exit', () => {
      this.compilers.delete(sessionId);
      this.clearIdleTimer(sessionId);
      const pending = this.compileResolvers.get(sessionId);
      if (pending) {
        pending.resolve(false);
        this.compileResolvers.delete(sessionId);
      }
    });

    proc.on('error', (err) => {
      const pending = this.compileResolvers.get(sessionId);
      if (pending) {
        pending.reject(err);
        this.compileResolvers.delete(sessionId);
      }
    });

    return proc;
  }

  compile(sessionId: string): Promise<boolean> {
    const proc = this.compilers.get(sessionId);
    if (!proc || !proc.stdin || !proc.stdout) {
      return Promise.resolve(false);
    }

    this.resetIdleTimer(sessionId);

    return new Promise<boolean>((resolve, reject) => {
      const existing = this.compileResolvers.get(sessionId);
      if (existing) {
        existing.resolve(false);
      }
      this.compileResolvers.set(sessionId, { resolve, reject });

      proc.stdin.write('compile\n');

      const onData = (data: Buffer) => {
        const output = data.toString();
        if (output.includes('debuc') || output.includes('error')) {
          proc.stdout?.removeListener('data', onData);
          this.compileResolvers.delete(sessionId);
          resolve(false);
        } else if (output.includes('compiler')) {
          proc.stdout?.removeListener('data', onData);
          this.compileResolvers.delete(sessionId);
          resolve(true);
        }
      };

      proc.stdout.on('data', onData);

      setTimeout(() => {
        proc.stdout?.removeListener('data', onData);
        if (this.compileResolvers.get(sessionId)?.resolve === resolve) {
          this.compileResolvers.delete(sessionId);
          resolve(false);
        }
      }, 30000);
    });
  }

  stopCompiler(sessionId: string): void {
    this.clearIdleTimer(sessionId);

    const proc = this.compilers.get(sessionId);
    if (proc) {
      if (!proc.killed) {
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (!proc.killed) {
            proc.kill('SIGKILL');
          }
        }, 5000);
      }
      this.compilers.delete(sessionId);
    }

    const pending = this.compileResolvers.get(sessionId);
    if (pending) {
      pending.resolve(false);
      this.compileResolvers.delete(sessionId);
    }
  }

  private resetIdleTimer(sessionId: string): void {
    this.clearIdleTimer(sessionId);
    const timer = setTimeout(() => {
      this.stopCompiler(sessionId);
    }, this.idleTimeoutMs);
    this.idleTimers.set(sessionId, timer);
  }

  private clearIdleTimer(sessionId: string): void {
    const timer = this.idleTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(sessionId);
    }
  }
}
