// ─────────────────────────────────────────────────────────────────
// SoloForge Rust Core Library
// Path: rust_core/src/lib.rs
// Description: 统一运行时协议 - Rust Core Trait 定义
// 文档要求：禁止模块互相直连，所有模块实现统一 RuntimeModule Trait
// ─────────────────────────────────────────────────────────────────

pub mod scheduler;
pub mod scheduler_core; // 主调度器实现
pub mod scheduler_module; // Scheduler 模块包装器（Bevy IntoSystem 模式）
pub mod runtime;
pub mod events;
pub mod task;
pub mod task_module; // TaskGraph 模块包装器（Bevy IntoSystem 模式）
pub mod snapshot;
pub mod interrupt;
pub mod actor_queue; // Actor 队列（向后兼容）

// 导出公共接口
pub use scheduler::{Scheduler, TaskItem, PriorityQueue, SchedulerConfig, SchedulerStats};
pub use scheduler_module::SchedulerModule;
pub use runtime::{RuntimeCore, RuntimeModule, RuntimeState};
pub use events::RuntimeEvent;
pub use task::{TaskNode, TaskGraph, TaskState};
pub use task_module::TaskGraphModule;
pub use snapshot::{Snapshotable, StateSnapshot};
pub use interrupt::{Interrupt, InterruptAction, InterruptHandler};

// 向后兼容：导出 actor_queue 模块的公共类型
pub use actor_queue::{ActorTask, ActorQueue};
