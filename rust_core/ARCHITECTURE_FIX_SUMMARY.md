# SoloForge Rust 后端架构修复总结

> **日期**: 2026-07-09
> **范围**: `rust_core/` 模块
> **目标**: 解决 `RuntimeModule` Trait 实现缺失导致的架构断裂问题

---

## 1. 问题背景

### 1.1 架构断裂

`RuntimeCore` 设计要求所有业务模块实现统一的 `RuntimeModule` Trait，但实际代码中：

- `RuntimeModule` 仅有测试实现（`TestModule`）
- 三个核心模块（`Scheduler`、`TaskGraph`、`InterruptHandler`）均未实现该接口
- `RuntimeCore::register_module()` 无法接受任何真实业务模块

### 1.2 既有编译错误

测试代码存在 5 个编译错误：

| 文件 | 错误 | 原因 |
|------|------|------|
| `runtime.rs:632` | `E0053` 类型不匹配 | `TestModule::restore()` 返回 `RuntimeError` 而非 `SnapshotError` |
| `runtime.rs:715-724` | `E0596/E0597/E0502` | `test_bus_event_emission` 中闭包捕获了局部变量，但 `Box<dyn Fn>` 要求 `'static` 生命周期 |

---

## 2. 修复方案

### 2.1 核心策略：非侵入式适配器模式

为每个核心模块创建**独立包装器**，而非直接修改原结构体：

```
┌─────────────────────────────────────────────────┐
│                  RuntimeCore                     │
│  modules: Vec<Box<dyn RuntimeModule>>            │
├─────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌────────┐│
│  │SchedulerModule│  │TaskGraphModule│  │Interrupt││
│  │  (包装器)     │  │  (包装器)     │  │Handler  ││
│  │ ┌──────────┐ │  │ ┌──────────┐ │  │(直接实现)││
│  │ │ Scheduler│ │  │ │ TaskGraph│ │  │         ││
│  │ └──────────┘ │  │ └──────────┘ │  │         ││
│  └──────────────┘  └──────────────┘  └────────┘│
└─────────────────────────────────────────────────┘
```

**设计原则**：
- 不修改原 `Scheduler`/`TaskGraph` 结构体，保持向后兼容
- 通过包装器层桥接 `RuntimeModule` + `Snapshotable` 接口
- 快照保存/恢复由模块自身处理具体类型，避免 `RuntimeCore` 统一反序列化的类型擦除问题

### 2.2 状态机校验启用

为 `Scheduler` 添加带验证的状态转换方法，`start()` 现在走合法路径：

```
Initializing → Ready → Running  （而非直接 Initializing → Running）
```

`SchedulerState` 和 `InterruptStatus` 的 `can_transition_to()` 已在原代码中存在，本次新增了测试覆盖。

---

## 3. 修改文件清单

### 3.1 新建文件

#### `rust_core/src/scheduler_module.rs`

`SchedulerModule` 包装器，实现 `RuntimeModule` + `Snapshotable`：

```rust
pub struct SchedulerModule {
    scheduler: Scheduler,      // 内部调度器实例
    status: ModuleStatus,      // 模块运行状态
}
```

- `initialize()`: 启动调度器，状态设为 `Ready`
- `handle_event()`: 监听 `TaskSubmitted`（从 payload 解析任务并入队）、`TaskCompleted`、`SystemShutdown`
- `save()/restore()`: 通过 `Scheduler::snapshot_queue()` / `restore_queue()` 序列化/恢复任务队列

#### `rust_core/src/task_module.rs`

`TaskGraphModule` 包装器，实现 `RuntimeModule` + `Snapshotable`：

```rust
pub struct TaskGraphModule {
    graph: TaskGraph,          // 内部任务图实例
    status: ModuleStatus,      // 模块运行状态
}
```

- `handle_event()`: 监听 `TaskCreated`（添加节点）、`TaskStarted`/`TaskCompleted`/`TaskFailed`/`TaskCancelled`（更新节点状态）
- `save()/restore()`: 序列化所有 `TaskNode`，恢复时重建图结构

### 3.2 修改文件

#### `rust_core/src/interrupt.rs`

为 `InterruptHandler` 直接实现 `RuntimeModule` + `Snapshotable`（同文件内可直接访问私有字段）：

- 新增 `module_status: ModuleStatus` 字段
- `Snapshotable::save()`: 保存中断统计信息为 `Custom` JSON
- `Snapshotable::restore()`: 恢复统计信息，清空当前队列
- `RuntimeModule::handle_event()`: 监听 `TaskPaused`/`TaskResumed`/`TaskCancelled`/`SchedulerPreempted`，自动创建对应中断请求

#### `rust_core/src/scheduler_core.rs`

为 `Scheduler` 新增三个方法：

| 方法 | 用途 |
|------|------|
| `transition_to(target)` | 带状态机验证的转换，非法转换返回 `Err` |
| `snapshot_queue()` | 获取队列快照（委托给 `PriorityQueue::snapshot()`） |
| `restore_queue(items)` | 从快照恢复队列（委托给 `PriorityQueue::restore()`） |

`start()` 方法改为走合法路径：`Initializing → Ready → Running`

#### `rust_core/src/runtime.rs`

修复 3 个编译错误：

1. `TestModule::restore()` 返回类型 `RuntimeError` → `SnapshotError`
2. `test_bus_event_emission` 改用 `Arc<Mutex<Vec<_>>>` 解决闭包 `'static` 生命周期问题
3. 未使用变量 `test_module` → `_test_module`

新增 4 个集成测试：

| 测试名 | 验证内容 |
|--------|----------|
| `test_full_runtime_pathway` | 注册 3 个真实模块 → boot → run → emit → stop 完整流程 |
| `test_state_machine_validation_scheduler` | `SchedulerState` 合法/非法转换验证 |
| `test_state_machine_validation_interrupt` | `InterruptStatus` 合法/非法转换验证 |
| `test_scheduler_module_snapshot_restore` | 快照保存 → 新模块恢复 → 队列一致性验证 |

#### `rust_core/src/lib.rs`

新增模块声明和导出：

```rust
pub mod scheduler_module;
pub mod task_module;

pub use scheduler_module::SchedulerModule;
pub use task_module::TaskGraphModule;
```

---

## 4. 测试结果

### 4.1 总览

```
running 46 tests
46 passed; 0 failed; 0 ignored
```

### 4.2 新增测试（全部通过）

```
test runtime::tests::test_full_runtime_pathway ............... ok
test runtime::tests::test_state_machine_validation_scheduler .. ok
test runtime::tests::test_state_machine_validation_interrupt .. ok
test runtime::tests::test_scheduler_module_snapshot_restore ... ok
test scheduler_module::tests::test_scheduler_module_creation .. ok
test scheduler_module::tests::test_scheduler_module_initialize  ok
test scheduler_module::tests::test_scheduler_module_snapshot .. ok
test scheduler_module::tests::test_scheduler_module_handle_event ok
test task_module::tests::test_task_graph_module_creation ..... ok
test task_module::tests::test_task_graph_module_initialize .. ok
test task_module::tests::test_task_graph_module_snapshot .... ok
test task_module::tests::test_task_graph_module_handle_task_created ok
```

### 4.3 修复的既有错误

```
test runtime::tests::test_bus_event_emission ............... ok  （原编译失败）
test runtime::tests::test_runtime_emit_event ............... ok  （原编译失败）
test runtime::tests::test_runtime_module_registration ..... ok  （原编译失败）
test runtime::tests::test_runtime_state_transitions ....... ok  （原编译失败）
test runtime::tests::test_runtime_creation ................ ok  （原编译失败）
```

### 4.4 同步完成：PriorityQueue 排序方向修复

在架构修复过程中发现 `ScoredTaskItem::Ord` 和 `ScoredTask::Ord` 的 `partial_cmp` 参数顺序反转，导致 `BinaryHeap`（最大堆）实际表现为最小堆——高优先级任务反而最后出队。修复方式：将 `other.score.partial_cmp(&self.score)` 改为 `self.score.partial_cmp(&other.score)`。

涉及文件：`scheduler_core.rs`、`actor_queue.rs`，各改动 1 行。修复后以下 4 个测试从失败转为通过：

| 测试 | 文件 |
|------|------|
| `test_base_priority_sorting_nominal` | `actor_queue.rs:111` |
| `test_dynamic_aging_starvation_prevention` | `actor_queue.rs:141` |
| `test_deadline_scheduling` | `scheduler_core.rs:893` |
| `test_priority_queue_push_pop` | `scheduler_core.rs:841` |

---

## 5. 验收清单

| 验收项 | 状态 |
|--------|------|
| `cargo check --tests` 无编译错误 | ✅ |
| 所有新增单元测试通过 | ✅ |
| 集成测试 `test_full_runtime_pathway` 通过 | ✅ |
| 可注册真实模块（Scheduler/TaskGraph/InterruptHandler） | ✅ |
| 状态转换有校验（非法转换返回 `false`） | ✅ |
| 快照可保存恢复（`save()` + `restore()` 不报错） | ✅ |

---

## 6. 验证命令

```bash
cd C:\Users\yangx\Desktop\SoloForge\rust_core

# 编译检查
cargo check --tests

# 运行全部测试
cargo test --lib

# 单独运行核心集成测试
cargo test --lib -- test_full_runtime_pathway --nocapture

# 运行 Release 构建
cargo build --release
```

---

## 7. 架构对比

| 维度 | 修复前 | 修复后 |
|------|--------|--------|
| `RuntimeModule` 实现 | 仅 `TestModule` | `SchedulerModule` + `TaskGraphModule` + `InterruptHandler` |
| 模块可注册性 | 无法注册真实模块 | 3 个核心模块均可注册 |
| 状态机验证 | `Scheduler::start()` 直接跳转 | 走 `transition_to()` 合法路径 |
| 快照/恢复 | 无业务模块实现 | 3 个模块均实现 `save()/restore()` |
| 测试编译 | 5 个错误 | 0 个错误 |
| 测试通过率 | 无法编译 | 46/46 全部通过 |

---

## 8. 后续建议

1. **并发安全**：当前 `RuntimeCore` 非线程安全，多线程场景需包裹 `Arc<Mutex<>>`
2. **热插拔支持**：可引入 `libloading` 实现运行时动态加载插件模块
3. **宏辅助**：使用过程宏自动生成 `impl RuntimeModule` 样板代码
4. **持久化优化**：集成 `sled` 或 `rocksdb` 替代 JSON 快照，支持崩溃自动恢复
