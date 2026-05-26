import { spawn, ChildProcess } from 'child_process';
import { createInterface, Interface } from 'readline';

export class GeminiRustSchedulerClient {
  private process: ChildProcess | null = null;
  private readlineInterface: Interface | null = null;
  private responseQueue: ((value: string) => void)[] = [];

  constructor() {}

  public initialize(): void {
    const binaryTarget = process.platform === 'win32' 
      ? 'target/debug/scheduler_daemon.exe' 
      : './target/debug/scheduler_daemon';

    this.process = spawn(binaryTarget, [], {
      cwd: 'rust_core'
    });

    if (!this.process.stdin || !this.process.stdout) {
      throw new Error("ERR_RUST_SCHEDULER_IPC: Failed to open standard IO channels.");
    }

    this.readlineInterface = createInterface({
      input: this.process.stdout,
      terminal: false
    });

    this.readlineInterface.on('line', (line: string) => {
      const resolve = this.responseQueue.shift();
      if (resolve) {
        resolve(line.trim());
      }
    });
  }

  private sendCommand(cmd: string): Promise<string> {
    return new Promise((resolve) => {
      if (!this.process || !this.process.stdin) {
        throw new Error("ERR_RUST_SCHEDULER_NOT_INITIALIZED");
      }
      this.responseQueue.push(resolve);
      this.process.stdin.write(`${cmd}\n`);
    });
  }

  // 严格对齐：推入 ID、基础权重、以及老化因子
  public async pushTask(actorId: string, priority: number, agingFactor: number = 0.0): Promise<boolean> {
    const res = await this.sendCommand(`PUSH ${actorId} ${priority} ${agingFactor}`);
    return res === 'OK_PUSH';
  }

  // 严格对齐：POP 不需要传递任何时间参数
  public async popTask(): Promise<string | null> {
    const res = await this.sendCommand('POP');
    if (res.startsWith('SUCCESS_POP ')) {
      return res.substring(12);
    }
    return null;
  }

  public async ping(): Promise<boolean> {
    const res = await this.sendCommand('PING');
    return res === 'PONG';
  }

  public shutdown(): void {
    if (this.process) {
      this.process.kill();
    }
  }
}