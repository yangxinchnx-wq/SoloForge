# SoloForge Rust Core: spawn 子进程 -> napi-rs Native Addon 迁移方案

> 状态：方案设计 | 创建日期：2026-07-09

---

## 1. 当前架构分析

### 1.1 架构拓扑

```
┌─────────────────────────────────────────────────────┐
│  Node.js 进程 (TypeScript)                           │
│                                                      │
│  SoloForgeRustSchedulerClient                        │
│    ├── spawn("bin/scheduler.exe")                    │
│    ├── stdin.write("req_001|PUSH task1 50 0.1\n")    │
│    ├── readline(stdout) -> "req_001|OK_PUSH task1"   │
│    └── pendingRequests Map<requestId, {resolve,reject,timer}> │
└───────────────────┬─────────────────────────────────┘
                    │ stdin/stdout 管道 (文本协议)
                    ▼
┌─────────────────────────────────────────────────────┐
│  Rust 子进程 (scheduler_daemon.exe, 1.2MB)           │
│                                                      │
│  main.rs: stdin.lock().lines() 循环                  │
│    ├── 解析: request_id|<command>                    │
│    ├── process_command() -> BinaryHeap<ScoredTask>   │
│    └── println!("{}|{}", request_id, response)       │
└─────────────────────────────────────────────────────┘
```

### 1.2 当前 Rust 代码结构

```
rust_core/
├── Cargo.toml              # 已有 [lib] + [[bin]] 双目标
├── src/
│   ├── lib.rs              # 库入口，导出所有模块
│   ├── main.rs             # daemon 进程入口 (stdin/stdout 循环)
│   ├── scheduler_core.rs   # 完整调度器 (PriorityQueue + Scheduler + ResourcePool)
│   ├── scheduler/mod.rs    # 模块 re-export
│   ├── actor_queue.rs      # 旧版简单队列 (ActorQueue)
│   ├── runtime.rs          # RuntimeCore + RuntimeModule Trait
│   ├── task.rs             # TaskNode + TaskGraph DAG
│   ├── events.rs           # RuntimeEvent 枚举
│   ├── snapshot.rs         # StateSnapshot 快照
│   └── interrupt.rs        # Interrupt 中断处理
└── target/release/
    └── scheduler_daemon.exe
```

### 1.3 当前通信协议

**请求格式**: `<request_id>|<command> <args...>`

| 命令 | 参数 | 响应 |
|------|------|------|
| `PING` | 无 | `PONG` |
| `PUSH` | `<task_id> <priority> <aging_factor>` | `OK_PUSH <task_id>` |
| `POP` | 无 | `SUCCESS_POP <task_id>` 或 `NONE_POP` |
| `STATS` | 无 | `STATS {"queue_size":0,...}` |
| `VERSION` | 无 | `VERSION rust_core v1.0.0` |

### 1.4 当前痛点

1. **进程管理开销**: spawn/kill 生命周期管理、崩溃恢复、僵尸进程风险
2. **文本协议序列化/反序列化**: 每次调用涉及字符串拼接、split、parse
3. **延迟**: stdin/stdout 管道 I/O + readline 逐行解析 + 冲刷缓冲区
4. **请求匹配**: UUID 生成 + Map 查找 + 超时定时器，每个请求额外 ~0.1ms
5. **并发瓶颈**: 单进程单线程 stdin 串行处理，无法并行处理多个请求
6. **资源占用**: 常驻子进程 ~5-10MB 内存，即使空闲

### 1.5 现有 Cargo.toml 已有利条件

当前 `Cargo.toml` 已同时定义了 `[lib]` 和 `[[bin]]`:

```toml
[lib]
name = "rust_core"
path = "src/lib.rs"

[[bin]]
name = "scheduler_daemon"
path = "src/main.rs"
```

这意味着 `scheduler_core.rs` 等核心逻辑已经作为库模块存在，napi-rs 只需在其上添加一层 FFI 导出，无需重构内部结构。

---

## 2. napi-rs 迁移方案

### 2.1 目标架构

```
┌─────────────────────────────────────────────────────────┐
│  Node.js 进程 (TypeScript)                               │
│                                                          │
│  SoloForgeRustSchedulerClient                            │
│    ├── tryLoadNativeAddon()                              │
│    │     └── const native = require('./scheduler.node')  │
│    ├── native.ping()           // 直接函数调用            │
│    ├── native.pushTask(...)    // 同步/异步               │
│    ├── native.popTask()        // ~0.001ms                │
│    └── fallback: simulatedQueue (现有仿真桩)              │
└──────────────────────┬──────────────────────────────────┘
                       │ napi FFI (零拷贝)
                       ▼
┌─────────────────────────────────────────────────────────┐
│  Rust Native Addon (scheduler.node / scheduler.linux-*.node) │
│                                                          │
│  #[napi] impl SchedulerAddon {                           │
│    scheduler: PriorityQueue  // 共享内存中的调度器状态     │
│  }                                                       │
│    ├── ping() -> bool                                    │
│    ├── push_task(task_id, priority, aging_factor)        │
│    ├── pop_task() -> Option<String>                      │
│    └── get_stats() -> StatsObject                        │
└─────────────────────────────────────────────────────────┘
```

### 2.2 迁移步骤总览

| 阶段 | 内容 | 预计工时 | 风险 |
|------|------|----------|------|
| Phase 0 | 环境准备 + 依赖安装 | 0.5h | 低 |
| Phase 1 | Cargo.toml 改造 + Rust napi 导出层 | 2h | 低 |
| Phase 2 | TypeScript 客户端双模适配 | 1.5h | 中 |
| Phase 3 | 构建流水线 + CI/CD 集成 | 1h | 中 |
| Phase 4 | 测试 + 性能基准 | 1h | 低 |
| Phase 5 | 清理旧 daemon 代码 | 0.5h | 低 |

总计约 6.5 小时。

---

## 3. 具体代码改动

### 3.1 Phase 0: 环境准备

```bash
# 1. 安装 napi-rs CLI
cargo install napi-cli --version "^2"

# 2. 在 rust_core/ 目录下初始化 napi 配置
cd rust_core
napi new --name soloforge-scheduler --dylib

# 3. 安装 Node.js 构建依赖 (在项目根目录)
npm install --save-dev @napi-rs/cli @napi-rs/cli-scripts
```

### 3.2 Phase 1: Cargo.toml 改造

**文件**: `rust_core/Cargo.toml`

```toml
[package]
name = "soloforge-scheduler"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]    # 关键: cdylib 用于 Node.js native addon
name = "soloforge_scheduler"
path = "src/lib.rs"

# 保留 bin 目标用于过渡期兼容 (Phase 5 后移除)
[[bin]]
name = "scheduler_daemon"
path = "src/main.rs"

[dependencies]
# 现有依赖保留
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
log = "0.4"
env_logger = "0.11"
thiserror = "1.0"
anyhow = "1.0"

# 新增 napi 依赖
napi = { version = "2", features = ["async", "serde-json", "napi8"] }
napi-derive = "2"

[build-dependencies]
napi-build = "2"

[dev-dependencies]
tempfile = "3.0"

[profile.release]
opt-level = 3
lto = true
codegen-units = 1
strip = true       # 新增: 去除符号，减小产物体积
```

**新增文件**: `rust_core/build.rs`

```rust
extern crate napi_build;

fn main() {
    napi_build::setup();
}
```

### 3.3 Phase 1: Rust napi 导出层

**新增文件**: `rust_core/src/napi_bridge.rs`

```rust
// ─────────────────────────────────────────────────────────────────
// SoloForge Rust Core: napi-rs Bridge Layer
// Path: rust_core/src/napi_bridge.rs
// Description: 将 scheduler_core 暴露为 Node.js native addon
// ─────────────────────────────────────────────────────────────────

use napi_derive::napi;
use napi::bindgen_prelude::*;
use std::sync::Mutex;

use crate::scheduler_core::{
    Scheduler, SchedulerConfig, SchedulerState, SchedulerStats, TaskItem, TaskContext,
};

/// Node.js 端看到的调度器实例
/// napi 要求结构体可被 JS 构造，Mutex 保证线程安全
#[napi]
pub struct SchedulerAddon {
    inner: Mutex<Scheduler>,
}

/// 统计信息对象 (自动映射为 JS plain object)
#[napi(object)]
pub struct NativeSchedulerStats {
    pub total_enqueued: u32,
    pub total_dequeued: u32,
    pub total_completed: u32,
    pub total_failed: u32,
    pub total_cancelled: u32,
    pub current_queue_size: u32,
    pub current_running: u32,
    pub max_queue_size: u32,
    pub avg_wait_time_ms: u32,
}

/// 任务上下文 (dequeue 返回)
#[napi(object)]
pub struct NativeTaskContext {
    pub task_id: String,
    pub priority: u32,
    pub state: String,
    pub created_at: u32,
    pub started_at: Option<u32>,
}

/// 调度器配置 (从 JS 传入)
#[napi(object)]
pub struct NativeSchedulerConfig {
    /// 最大并发任务数, 默认 10
    pub max_concurrent: Option<u32>,
    /// 默认超时时间（毫秒）, 默认 60000
    pub default_timeout_ms: Option<u32>,
    /// 队列最大长度, 默认 10000
    pub max_queue_size: Option<u32>,
}

#[napi]
impl SchedulerAddon {
    /// 构造函数: 创建调度器实例
    #[napi(constructor)]
    pub fn new(config: Option<NativeSchedulerConfig>) -> Result<Self> {
        let cfg = config.unwrap_or(NativeSchedulerConfig {
            max_concurrent: None,
            default_timeout_ms: None,
            max_queue_size: None,
        });

        let scheduler_config = SchedulerConfig {
            max_concurrent: cfg.max_concurrent.unwrap_or(10) as usize,
            default_timeout_ms: cfg.default_timeout_ms.unwrap_or(60000) as u64,
            aging_threshold_secs: 30,
            starvation_threshold_secs: 60,
            max_queue_size: cfg.max_queue_size.unwrap_or(10000) as usize,
            deadline_scheduling: true,
        };

        let mut scheduler = Scheduler::new(scheduler_config);
        scheduler.start();

        Ok(Self {
            inner: Mutex::new(scheduler),
        })
    }

    /// PING - 健康检查
    #[napi]
    pub fn ping(&self) -> bool {
        let scheduler = self.inner.lock().unwrap();
        scheduler.is_running()
    }

    /// PUSH - 推入任务
    #[napi]
    pub fn push_task(
        &self,
        task_id: String,
        priority: u32,
        aging_factor: Option<f64>,
        deadline: Option<u32>,
    ) -> Result<bool> {
        let mut scheduler = self.inner.lock().unwrap();
        let item = TaskItem::new(
            task_id,
            priority,
            aging_factor.unwrap_or(0.0),
            deadline.unwrap_or(0) as u64,
        );
        match scheduler.enqueue(item) {
            Ok(()) => Ok(true),
            Err(_) => Ok(false),
        }
    }

    /// POP - 弹出最高优先级任务
    #[napi]
    pub fn pop_task(&self) -> Result<Option<NativeTaskContext>> {
        let mut scheduler = self.inner.lock().unwrap();
        match scheduler.dequeue() {
            Some(ctx) => Ok(Some(NativeTaskContext {
                task_id: ctx.task_id,
                priority: ctx.priority,
                state: ctx.state.name().to_string(),
                created_at: ctx.created_at as u32,
                started_at: ctx.started_at.map(|t| t as u32),
            })),
            None => Ok(None),
        }
    }

    /// STATS - 获取统计信息
    #[napi]
    pub fn get_stats(&self) -> NativeSchedulerStats {
        let scheduler = self.inner.lock().unwrap();
        let stats = scheduler.get_stats();
        NativeSchedulerStats {
            total_enqueued: stats.total_enqueued as u32,
            total_dequeued: stats.total_dequeued as u32,
            total_completed: stats.total_completed as u32,
            total_failed: stats.total_failed as u32,
            total_cancelled: stats.total_cancelled as u32,
            current_queue_size: stats.current_queue_size as u32,
            current_running: stats.current_running as u32,
            max_queue_size: stats.max_queue_size as u32,
            avg_wait_time_ms: stats.avg_wait_time_ms as u32,
        }
    }

    /// 完成任务
    #[napi]
    pub fn complete_task(&self, task_id: String, result: String) -> Result<bool> {
        let mut scheduler = self.inner.lock().unwrap();
        Ok(scheduler.queue_complete(&task_id, result).is_some())
    }

    /// 取消任务
    #[napi]
    pub fn cancel_task(&self, task_id: String) -> Result<bool> {
        let mut scheduler = self.inner.lock().unwrap();
        Ok(scheduler.queue_cancel(&task_id).is_some())
    }

    /// 获取队列大小
    #[napi]
    pub fn queue_size(&self) -> u32 {
        let scheduler = self.inner.lock().unwrap();
        scheduler.queue_size() as u32
    }

    /// 暂停调度器
    #[napi]
    pub fn pause(&self) {
        let mut scheduler = self.inner.lock().unwrap();
        scheduler.pause();
    }

    /// 恢复调度器
    #[napi]
    pub fn resume(&self) {
        let mut scheduler = self.inner.lock().unwrap();
        scheduler.resume();
    }

    /// 关闭调度器
    #[napi]
    pub fn shutdown(&self) {
        let mut scheduler = self.inner.lock().unwrap();
        scheduler.stop();
    }
}
```

**修改文件**: `rust_core/src/lib.rs` (添加 napi_bridge 模块)

```rust
// 现有模块保留不变
pub mod scheduler;
pub mod scheduler_core;
pub mod runtime;
pub mod events;
pub mod task;
pub mod snapshot;
pub mod interrupt;
pub mod actor_queue;

// 新增 napi 导出层
pub mod napi_bridge;

// 现有 re-export 保留不变
pub use scheduler::{Scheduler, TaskItem, PriorityQueue, SchedulerConfig, SchedulerStats};
pub use runtime::{RuntimeCore, RuntimeModule, RuntimeState};
pub use events::RuntimeEvent;
pub use task::{TaskNode, TaskGraph, TaskState};
pub use snapshot::{Snapshotable, StateSnapshot};
pub use interrupt::{Interrupt, InterruptAction, InterruptHandler};
pub use actor_queue::{ActorTask, ActorQueue};
```

### 3.4 Phase 2: TypeScript 客户端双模适配

**修改文件**: `src/kernel/scheduler-client.ts`

核心改动策略: 保留现有 `SoloForgeRustSchedulerClient` 类的公共 API 不变，内部优先尝试加载 native addon，失败则回退到现有的 spawn + 仿真桩模式。

```typescript
// ─────────────────────────────────────────────────────────────────
// SoloForge Kernel Layer: Rust Scheduler Client (napi-rs + spawn fallback)
// Path: src/kernel/scheduler-client.ts
// ─────────────────────────────────────────────────────────────────

import path from 'path';
import fs from 'fs';

// napi addon 类型定义 (由 @napi-rs/cli 生成)
interface NativeSchedulerAddon {
  new (config?: {
    maxConcurrent?: number;
    defaultTimeoutMs?: number;
    maxQueueSize?: number;
  }): NativeSchedulerAddon;

  ping(): boolean;
  pushTask(
    taskId: string,
    priority: number,
    agingFactor?: number,
    deadline?: number
  ): boolean;
  popTask(): { taskId: string; priority: number; state: string } | null;
  getStats(): {
    totalEnqueued: number;
    totalDequeued: number;
    totalCompleted: number;
    totalFailed: number;
    currentQueueSize: number;
    currentRunning: number;
    maxQueueSize: number;
    avgWaitTimeMs: number;
  };
  completeTask(taskId: string, result: string): boolean;
  cancelTask(taskId: string): boolean;
  queueSize(): number;
  pause(): void;
  resume(): void;
  shutdown(): void;
}

// 运行模式
type SchedulerMode = 'native' | 'spawn' | 'simulated';

interface SimTask {
  taskName: string;
  basePriority: number;
  agingFactor: number;
  enqueuedAt: number;
}

export class SoloForgeRustSchedulerClient {
  // 运行模式
  private mode: SchedulerMode = 'simulated';

  // napi addon 实例 (native 模式)
  private nativeAddon: NativeSchedulerAddon | null = null;

  // spawn 模式 (保留向后兼容)
  private process: import('child_process').ChildProcess | null = null;
  private rl: import('readline').Interface | null = null;
  private pendingRequests: Map<
    string,
    { resolve: (val: any) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  > = new Map();
  private requestCounter = 0;

  // 仿真桩 (simulated 模式)
  private simulatedQueue: SimTask[] = [];

  /**
   * 获取当前运行模式
   */
  public getMode(): SchedulerMode {
    return this.mode;
  }

  /**
   * 初始化: 按优先级尝试 native -> spawn -> simulated
   */
  public initialize(): void {
    // 优先级 1: 尝试加载 napi native addon
    if (this.tryLoadNativeAddon()) {
      this.mode = 'native';
      console.log('[RUST_NAPI] Native addon 加载成功，运行模式: native');
      return;
    }

    // 优先级 2: 尝试 spawn 子进程
    if (this.trySpawnProcess()) {
      this.mode = 'spawn';
      console.log('[RUST_IPC] 子进程模式启动成功，运行模式: spawn');
      return;
    }

    // 优先级 3: 回退到仿真桩
    this.mode = 'simulated';
    console.warn(
      '[RUST_FALLBACK] 未找到 native addon 或 Rust 二进制，使用仿真桩模式'
    );
  }

  /**
   * 尝试加载 napi native addon
   */
  private tryLoadNativeAddon(): boolean {
    try {
      // napi-rs 生成的 .node 文件路径
      // 根据平台选择正确的文件名
      const addonName = this.getAddonFileName();
      if (!addonName) return false;

      // 搜索路径优先级
      const searchPaths = [
        path.join(process.cwd(), 'rust_core', addonName),
        path.join(process.cwd(), 'bin', addonName),
        path.join(__dirname, '..', '..', 'rust_core', addonName),
      ];

      for (const addonPath of searchPaths) {
        if (fs.existsSync(addonPath)) {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const addon = require(addonPath);
          this.nativeAddon = new addon.SchedulerAddon({
            maxConcurrent: 10,
            defaultTimeoutMs: 60000,
            maxQueueSize: 10000,
          });
          return true;
        }
      }

      return false;
    } catch (err: any) {
      console.warn(`[RUST_NAPI] Native addon 加载失败: ${err.message}`);
      return false;
    }
  }

  /**
   * 根据平台返回 addon 文件名
   */
  private getAddonFileName(): string | null {
    const platform = process.platform;
    const arch = process.arch;

    // napi-rs 产物命名规则
    const triplets: Record<string, string> = {
      'win32-x64': 'soloforge-scheduler.win32-x64-msvc.node',
      'win32-arm64': 'soloforge-scheduler.win32-arm64-msvc.node',
      'darwin-x64': 'soloforge-scheduler.darwin-x64.node',
      'darwin-arm64': 'soloforge-scheduler.darwin-arm64.node',
      'linux-x64': 'soloforge-scheduler.linux-x64-gnu.node',
      'linux-arm64': 'soloforge-scheduler.linux-arm64-gnu.node',
    };

    return triplets[`${platform}-${arch}`] || null;
  }

  /**
   * 尝试 spawn 子进程 (现有逻辑)
   */
  private trySpawnProcess(): boolean {
    // ... 保留现有 initialize() 中的 spawn 逻辑 ...
    // 此处省略，与原代码完全一致
    return false;
  }

  // ─── 公共 API (模式透明) ───────────────────────────────

  public async ping(): Promise<boolean> {
    switch (this.mode) {
      case 'native':
        return this.nativeAddon!.ping();
      case 'spawn':
        // 保留现有 spawn ping 逻辑
        try {
          const response = await this.sendCommand('PING');
          return response === 'PONG';
        } catch {
          return false;
        }
      case 'simulated':
        return true;
    }
  }

  public async pushTask(
    taskName: string,
    priority: number,
    agingFactor: number = 0.0
  ): Promise<boolean> {
    switch (this.mode) {
      case 'native':
        return this.nativeAddon!.pushTask(taskName, priority, agingFactor);
      case 'spawn':
        try {
          const response = await this.sendCommand(
            `PUSH ${taskName} ${priority} ${agingFactor}`
          );
          return response.startsWith('OK_PUSH');
        } catch {
          return false;
        }
      case 'simulated':
        this.simulatedQueue.push({
          taskName,
          basePriority: priority,
          agingFactor,
          enqueuedAt: Date.now(),
        });
        return true;
    }
  }

  public async popTask(): Promise<string | null> {
    switch (this.mode) {
      case 'native': {
        const result = this.nativeAddon!.popTask();
        return result ? result.taskId : null;
      }
      case 'spawn':
        try {
          const response = await this.sendCommand('POP');
          if (response.startsWith('SUCCESS_POP ')) {
            return response.substring('SUCCESS_POP '.length);
          }
          return null;
        } catch {
          return null;
        }
      case 'simulated':
        // 保留现有仿真桩逻辑
        if (this.simulatedQueue.length === 0) return null;
        const now = Date.now();
        this.simulatedQueue.sort((a, b) => {
          const scoreA =
            a.basePriority + ((now - a.enqueuedAt) / 1000) * a.agingFactor;
          const scoreB =
            b.basePriority + ((now - b.enqueuedAt) / 1000) * b.agingFactor;
          return scoreB - scoreA;
        });
        return this.simulatedQueue.shift()!.taskName;
    }
  }

  public async getStats(): Promise<{
    queueSize: number;
    totalPush: number;
    totalPop: number;
  } | null> {
    switch (this.mode) {
      case 'native': {
        const stats = this.nativeAddon!.getStats();
        return {
          queueSize: stats.currentQueueSize,
          totalPush: stats.totalEnqueued,
          totalPop: stats.totalDequeued,
        };
      }
      case 'spawn':
        // 保留现有 spawn stats 逻辑
        try {
          const response = await this.sendCommand('STATS');
          if (response.startsWith('STATS ')) {
            const jsonStr = response.substring('STATS '.length);
            const stats = JSON.parse(jsonStr);
            return {
              queueSize: stats.queue_size || 0,
              totalPush: stats.total_push || 0,
              totalPop: stats.total_pop || 0,
            };
          }
          return null;
        } catch {
          return null;
        }
      case 'simulated':
        return {
          queueSize: this.simulatedQueue.length,
          totalPush: this.simulatedQueue.length,
          totalPop: 0,
        };
    }
  }

  public shutdown(): void {
    switch (this.mode) {
      case 'native':
        if (this.nativeAddon) {
          this.nativeAddon.shutdown();
          this.nativeAddon = null;
        }
        break;
      case 'spawn':
        if (this.rl) this.rl.close();
        if (this.process) {
          this.process.kill();
          this.process = null;
        }
        this.pendingRequests.clear();
        break;
      case 'simulated':
        this.simulatedQueue = [];
        break;
    }
    this.mode = 'simulated';
  }

  // spawn 模式辅助方法 (保留现有实现)
  private generateRequestId(): string {
    return `req_${Date.now()}_${++this.requestCounter}`;
  }

  private async sendCommand(command: string): Promise<string> {
    // 保留现有实现
    throw new Error('Not implemented in this example');
  }

  private handleDaemonResponse(line: string): void {
    // 保留现有实现
  }
}
```

### 3.5 Phase 3: 构建流水线

**新增脚本**: `package.json` 添加构建命令

```json
{
  "scripts": {
    "build:native": "napi build --manifest-path rust_core/Cargo.toml --release --platform",
    "build:native:debug": "napi build --manifest-path rust_core/Cargo.toml --platform",
    "build:native:strip": "napi build --manifest-path rust_core/Cargo.toml --release --platform --strip",
    "postinstall": "napi build --manifest-path rust_core/Cargo.toml --release --platform || echo 'Native build failed, will fallback to spawn mode'"
  }
}
```

**napi-rs 配置**: `rust_core/.napi-rs.json`

```json
{
  "binaryName": "soloforge-scheduler",
  "targets": [
    "x86_64-pc-windows-msvc",
    "x86_64-apple-darwin",
    "aarch64-apple-darwin",
    "x86_64-unknown-linux-gnu",
    "aarch64-unknown-linux-gnu"
  ],
  "packageName": "@soloforge/scheduler-native",
  "npmClient": "npm"
}
```

**CI 配置示例**: `.github/workflows/build-native.yml`

```yaml
name: Build Native Addons

on:
  push:
    tags: ['v*']
  workflow_dispatch:

jobs:
  build:
    strategy:
      matrix:
        include:
          - os: windows-latest
            target: x86_64-pc-windows-msvc
          - os: macos-latest
            target: aarch64-apple-darwin
          - os: ubuntu-latest
            target: x86_64-unknown-linux-gnu

    runs-on: ${{ matrix.os }}

    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.target }}

      - name: Install napi CLI
        run: npm install -g @napi-rs/cli

      - name: Build native addon
        run: napi build --manifest-path rust_core/Cargo.toml --release --target ${{ matrix.target }} --strip

      - name: Upload artifact
        uses: actions/upload-artifact@v4
        with:
          name: addon-${{ matrix.target }}
          path: '*.node'
```

---

## 4. 性能对比预期

### 4.1 延迟对比

| 操作 | spawn 模式 (当前) | napi native 模式 | 提升 |
|------|-------------------|------------------|------|
| PING | ~2-5ms | ~0.001-0.005ms | **400-5000x** |
| PUSH (单任务) | ~2-5ms | ~0.002-0.01ms | **200-2500x** |
| POP (单任务) | ~2-5ms | ~0.002-0.01ms | **200-2500x** |
| STATS | ~2-5ms | ~0.001-0.005ms | **400-5000x** |
| 批量 1000 PUSH+POP | ~4000-10000ms | ~5-20ms | **200-500x** |

**延迟来源分析**:

- spawn 模式: UUID 生成(~0.01ms) + stdin.write(~0.1ms) + 管道传输(~0.5ms) + Rust 解析(~0.01ms) + stdout 回传(~0.5ms) + readline 解析(~0.1ms) + Map 查找(~0.01ms) = ~1.2ms 最低
- napi 模式: 函数调用(~0.001ms) + Mutex lock(~0.001ms) + 计算(~0.001ms) = ~0.003ms

### 4.2 资源占用对比

| 指标 | spawn 模式 | napi native 模式 | 改善 |
|------|-----------|------------------|------|
| 内存 (空闲) | ~5-10MB (子进程) | ~0.5-1MB (addon) | **5-10x** |
| 内存 (满载) | ~15-30MB | ~2-5MB | **5-6x** |
| CPU (空闲) | ~0% (子进程常驻) | 0% | - |
| 进程数 | +1 | 0 | -1 |
| 启动时间 | ~50-200ms (spawn) | ~1-5ms (require) | **10-40x** |

### 4.3 吞吐量对比

| 场景 | spawn 模式 | napi native 模式 |
|------|-----------|------------------|
| 单线程顺序调用 | ~200-500 ops/s | ~100,000-300,000 ops/s |
| 并发 10 路 | ~500-1000 ops/s (受 stdin 锁) | ~500,000+ ops/s |

---

## 5. 风险评估与回滚方案

### 5.1 风险矩阵

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| napi-rs 编译失败 (特定平台) | 中 | 高 | 三模降级: native -> spawn -> simulated |
| .node 文件与 Node.js 版本不兼容 | 中 | 高 | CI 多版本矩阵测试 |
| Mutex 死锁 | 低 | 高 | 使用 `try_lock()` + 超时回退 |
| 内存泄漏 (Rust 侧) | 低 | 中 | valgrind/ASAN 测试 |
| ABI 不兼容 (napi 版本升级) | 低 | 中 | 锁定 napi = "2" 大版本 |
| 现有 spawn 模式回归 | 低 | 中 | 保留完整 spawn 代码路径 |

### 5.2 回滚方案

**即时回滚** (无需重新部署):

```typescript
// 通过环境变量控制运行模式
const FORCE_MODE = process.env.SOLOFORGE_SCHEDULER_MODE;

public initialize(): void {
  if (FORCE_MODE === 'spawn') {
    this.trySpawnProcess();
    this.mode = 'spawn';
    return;
  }
  if (FORCE_MODE === 'simulated') {
    this.mode = 'simulated';
    return;
  }
  // 默认: native -> spawn -> simulated
  // ... 正常初始化逻辑
}
```

**完整回滚** (Git revert):

由于采用"新增 napi_bridge.rs + 修改 lib.rs 添加一行 `pub mod napi_bridge`"的策略，回滚只需:
1. 删除 `rust_core/src/napi_bridge.rs`
2. 恢复 `rust_core/src/lib.rs` (删除 `pub mod napi_bridge` 行)
3. 恢复 `rust_core/Cargo.toml` (移除 napi 依赖)
4. 恢复 `src/kernel/scheduler-client.ts` 到原版

### 5.3 渐进式迁移策略

```
Week 1: 部署代码，native 模式默认关闭 (环境变量控制)
        SOLOFORGE_SCHEDULER_MODE=spawn

Week 2: 灰度开启 native 模式 (10% 流量)
        监控: 延迟 P99、错误率、内存占用

Week 3: 扩大到 50% 流量
        对比 native vs spawn 的稳定性指标

Week 4: 全量切换到 native 模式
        保留 spawn 回退能力

Week 6: 确认稳定后，可选择移除 spawn 代码 (可选)
```

---

## 6. Scheduler 需暴露的额外方法

当前 `scheduler_core.rs` 中的 `Scheduler` 结构体缺少部分方法的公开访问，napi_bridge 需要调用它们。需要在 `Scheduler` 上添加以下辅助方法:

```rust
// 在 scheduler_core.rs 的 impl Scheduler 块中添加

/// 完成任务 (委托给 PriorityQueue)
pub fn queue_complete(&mut self, task_id: &str, result: String) -> Option<TaskContext> {
    self.queue.complete(task_id, result)
}

/// 取消任务 (委托给 PriorityQueue)
pub fn queue_cancel(&mut self, task_id: &str) -> Option<TaskContext> {
    self.queue.cancel(task_id)
}

/// 获取可变队列引用 (用于高级操作)
pub fn queue_mut(&mut self) -> &mut PriorityQueue {
    &mut self.queue
}
```

---

## 7. 测试计划

### 7.1 单元测试

```rust
// rust_core/src/napi_bridge.rs 中添加
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_addon_ping() {
        let addon = SchedulerAddon::new(None).unwrap();
        assert!(addon.ping());
    }

    #[test]
    fn test_addon_push_pop() {
        let addon = SchedulerAddon::new(None).unwrap();
        assert!(addon.push_task("task1".into(), 50, Some(0.0), None).unwrap());
        let result = addon.pop_task().unwrap();
        assert!(result.is_some());
        assert_eq!(result.unwrap().task_id, "task1");
    }

    #[test]
    fn test_addon_stats() {
        let addon = SchedulerAddon::new(None).unwrap();
        let stats = addon.get_stats();
        assert_eq!(stats.total_enqueued, 0);
    }
}
```

### 7.2 集成测试

```typescript
// tests/scheduler-native.test.ts
import { SoloForgeRustSchedulerClient } from '../src/kernel/scheduler-client';

describe('Scheduler Native Mode', () => {
  let client: SoloForgeRustSchedulerClient;

  beforeEach(() => {
    client = new SoloForgeRustSchedulerClient();
    process.env.SOLOFORGE_SCHEDULER_MODE = 'native';
    client.initialize();
  });

  afterEach(() => {
    client.shutdown();
  });

  it('should initialize in native mode', () => {
    expect(client.getMode()).toBe('native');
  });

  it('should ping successfully', async () => {
    const result = await client.ping();
    expect(result).toBe(true);
  });

  it('should push and pop tasks in priority order', async () => {
    await client.pushTask('low', 10);
    await client.pushTask('high', 100);
    await client.pushTask('mid', 50);

    expect(await client.popTask()).toBe('high');
    expect(await client.popTask()).toBe('mid');
    expect(await client.popTask()).toBe('low');
  });

  it('should return null when popping empty queue', async () => {
    expect(await client.popTask()).toBeNull();
  });

  it('should report stats', async () => {
    await client.pushTask('task1', 50);
    const stats = await client.getStats();
    expect(stats).not.toBeNull();
    expect(stats!.queueSize).toBe(1);
  });
});
```

### 7.3 性能基准测试

```typescript
// tests/scheduler-benchmark.ts
async function benchmark(mode: 'native' | 'spawn') {
  process.env.SOLOFORGE_SCHEDULER_MODE = mode;
  const client = new SoloForgeRustSchedulerClient();
  client.initialize();

  const N = 10000;
  const start = performance.now();

  for (let i = 0; i < N; i++) {
    await client.pushTask(`task_${i}`, Math.floor(Math.random() * 100));
  }
  for (let i = 0; i < N; i++) {
    await client.popTask();
  }

  const elapsed = performance.now() - start;
  console.log(`[${mode}] ${N} push+pop: ${elapsed.toFixed(2)}ms (${(N * 2 / elapsed * 1000).toFixed(0)} ops/s)`);

  client.shutdown();
}
```

---

## 8. 总结

| 维度 | 当前 (spawn) | 迁移后 (napi-rs) |
|------|-------------|-----------------|
| 通信方式 | stdin/stdout 文本协议 | napi FFI 函数调用 |
| 延迟 (单次) | 2-5ms | 0.001-0.01ms |
| 内存占用 | 5-10MB (子进程) | 0.5-1MB (addon) |
| 进程模型 | 多进程 | 单进程 |
| 错误处理 | 进程崩溃 -> 需重启 | Rust panic -> 捕获异常 |
| 构建复杂度 | cargo build | cargo build + napi build |
| 跨平台分发 | 每平台一个 .exe | 每平台一个 .node |
| 回退能力 | 仿真桩 | 三级降级 (native/spawn/simulated) |

**推荐**: 立即开始 Phase 0-1 (Cargo.toml + napi_bridge.rs)，预计 2 小时可完成原型。Phase 2-3 的 TypeScript 适配可在一天内完成。整体迁移可在一周内完成，无破坏性变更风险。
