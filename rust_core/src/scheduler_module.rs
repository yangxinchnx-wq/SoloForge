// ─────────────────────────────────────────────────────────────────
// SoloForge Rust Core: Scheduler Module Wrapper
// Path: rust_core/src/scheduler_module.rs
// Description: Scheduler 模块包装器 - 遵循 Bevy IntoSystem 包装器模式
// 设计原则：不修改原 Scheduler 结构体，通过适配器实现 RuntimeModule
// ─────────────────────────────────────────────────────────────────

use crate::events::RuntimeEvent;
use crate::runtime::{ModuleStatus, RuntimeError, RuntimeModule};
use crate::scheduler_core::{Scheduler, SchedulerConfig};
use crate::snapshot::{SnapshotData, SnapshotError, SnapshotType, Snapshotable, StateSnapshot};

/// Scheduler 模块包装器
///
/// 遵循 Bevy ECS 的 IntoSystem 模式：
/// - 不直接修改 Scheduler 结构体
/// - 通过包装器层实现 RuntimeModule + Snapshotable
/// - 保持原有 API 不变，实现零侵入扩展
pub struct SchedulerModule {
    /// 内部调度器实例
    scheduler: Scheduler,
    /// 模块运行状态
    status: ModuleStatus,
}

impl SchedulerModule {
    /// 创建新的 Scheduler 模块
    pub fn new(config: SchedulerConfig) -> Self {
        Self {
            scheduler: Scheduler::new(config),
            status: ModuleStatus::Uninitialized,
        }
    }

    /// 获取内部调度器的不可变引用
    pub fn scheduler(&self) -> &Scheduler {
        &self.scheduler
    }

    /// 获取内部调度器的可变引用
    pub fn scheduler_mut(&mut self) -> &mut Scheduler {
        &mut self.scheduler
    }
}

impl Snapshotable for SchedulerModule {
    fn save(&self) -> StateSnapshot {
        let queue = self.scheduler.snapshot_queue();
        let stats = self.scheduler.get_stats();

        let data = SnapshotData::Scheduler {
            queue,
            running_count: stats.current_running,
            completed_count: stats.total_completed as usize,
        };

        StateSnapshot::new(SnapshotType::Full, data, "scheduler".to_string())
    }

    fn restore(&mut self, snapshot: StateSnapshot) -> Result<(), SnapshotError> {
        match snapshot.data {
            SnapshotData::Scheduler { queue, .. } => {
                self.scheduler.restore_queue(queue);
                Ok(())
            }
            _ => Err(SnapshotError::InvalidSnapshotType(
                "Expected Scheduler snapshot data".to_string(),
            )),
        }
    }
}

impl RuntimeModule for SchedulerModule {
    fn name(&self) -> String {
        "Scheduler".to_string()
    }

    fn initialize(&mut self) -> Result<(), RuntimeError> {
        self.scheduler.start();
        self.status = ModuleStatus::Ready;
        Ok(())
    }

    fn handle_event(
        &mut self,
        event: RuntimeEvent,
        payload: Option<&serde_json::Value>,
    ) -> Result<Vec<RuntimeEvent>, RuntimeError> {
        match event {
            RuntimeEvent::TaskSubmitted => {
                log::info!("Scheduler received TaskSubmitted event");

                // 尝试从 payload 解析任务信息并入队
                if let Some(payload) = payload {
                    if let Some(task_id) = payload.get("task_id").and_then(|v| v.as_str()) {
                        let priority = payload
                            .get("priority")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(50) as u32;

                        let task_item = crate::scheduler::TaskItem::new(
                            task_id.to_string(),
                            priority,
                            0.5,
                            0,
                        );

                        self.scheduler.enqueue(task_item).map_err(|e| {
                            RuntimeError::EventProcessingError(format!(
                                "Failed to enqueue task: {}",
                                e
                            ))
                        })?;
                    }
                }
            }
            RuntimeEvent::TaskCompleted => {
                log::info!("Scheduler received TaskCompleted event");
            }
            RuntimeEvent::TaskCancelled => {
                log::info!("Scheduler received TaskCancelled event");
            }
            RuntimeEvent::SystemBoot => {
                log::info!("Scheduler received SystemBoot event");
            }
            RuntimeEvent::SystemShutdown => {
                log::info!("Scheduler shutting down");
                self.scheduler.stop();
                self.status = ModuleStatus::Stopped;
            }
            _ => {}
        }

        Ok(Vec::new())
    }

    fn get_status(&self) -> ModuleStatus {
        self.status
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scheduler_core::SchedulerState;

    #[test]
    fn test_scheduler_module_creation() {
        let module = SchedulerModule::new(SchedulerConfig::default());
        assert_eq!(module.name(), "Scheduler");
        assert_eq!(module.get_status(), ModuleStatus::Uninitialized);
    }

    #[test]
    fn test_scheduler_module_initialize() {
        let mut module = SchedulerModule::new(SchedulerConfig::default());
        assert!(module.initialize().is_ok());
        assert_eq!(module.get_status(), ModuleStatus::Ready);
        assert_eq!(module.scheduler().get_state(), SchedulerState::Running);
    }

    #[test]
    fn test_scheduler_module_snapshot() {
        let mut module = SchedulerModule::new(SchedulerConfig::default());
        module.initialize().unwrap();

        let snapshot = module.save();
        // 验证快照可以正确创建
        assert_eq!(snapshot.snapshot_type, SnapshotType::Full);
    }

    #[test]
    fn test_scheduler_module_handle_event() {
        let mut module = SchedulerModule::new(SchedulerConfig::default());
        module.initialize().unwrap();

        let payload = serde_json::json!({
            "task_id": "test_task_1",
            "priority": 100
        });

        let result = module.handle_event(RuntimeEvent::TaskSubmitted, Some(&payload));
        assert!(result.is_ok());
        assert_eq!(module.scheduler().queue_size(), 1);
    }
}
