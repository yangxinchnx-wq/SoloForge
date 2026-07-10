// ─────────────────────────────────────────────────────────────────
// SoloForge Rust Core: TaskGraph Module Wrapper
// Path: rust_core/src/task_module.rs
// Description: TaskGraph 模块包装器 - 遵循 Bevy IntoSystem 包装器模式
// 设计原则：不修改原 TaskGraph 结构体，通过适配器实现 RuntimeModule
// ─────────────────────────────────────────────────────────────────

use crate::events::RuntimeEvent;
use crate::runtime::{ModuleStatus, RuntimeError, RuntimeModule};
use crate::snapshot::{
    SnapshotData, SnapshotError, SnapshotType, Snapshotable, StateSnapshot, TaskGraphSnapshotMetadata,
    TaskSnapshot,
};
use crate::task::{TaskGraph, TaskNode, TaskState};

/// TaskGraph 模块包装器
///
/// 遵循 Bevy ECS 的 IntoSystem 模式：
/// - 包装 TaskGraph 而非直接修改
/// - 实现 RuntimeModule + Snapshotable 统一接口
/// - 支持事件驱动的任务图操作
pub struct TaskGraphModule {
    /// 内部任务图实例
    graph: TaskGraph,
    /// 模块运行状态
    status: ModuleStatus,
}

impl TaskGraphModule {
    /// 创建新的 TaskGraph 模块
    pub fn new() -> Self {
        Self {
            graph: TaskGraph::new(),
            status: ModuleStatus::Uninitialized,
        }
    }

    /// 获取内部任务图的不可变引用
    pub fn graph(&self) -> &TaskGraph {
        &self.graph
    }

    /// 获取内部任务图的可变引用
    pub fn graph_mut(&mut self) -> &mut TaskGraph {
        &mut self.graph
    }
}

impl Default for TaskGraphModule {
    fn default() -> Self {
        Self::new()
    }
}

impl Snapshotable for TaskGraphModule {
    fn save(&self) -> StateSnapshot {
        let nodes: Vec<TaskSnapshot> = self.graph.iter().map(TaskSnapshot::from).collect();
        let stats = self.graph.stats();

        let metadata = TaskGraphSnapshotMetadata {
            total_nodes: stats.total,
            pending_count: stats.pending + stats.queued,
            running_count: stats.running,
            completed_count: stats.succeeded,
            failed_count: stats.failed,
        };

        let data = SnapshotData::TaskGraph { nodes, metadata };
        StateSnapshot::new(SnapshotType::Full, data, "task_graph".to_string())
    }

    fn restore(&mut self, snapshot: StateSnapshot) -> Result<(), SnapshotError> {
        match snapshot.data {
            SnapshotData::TaskGraph { nodes, .. } => {
                self.graph = TaskGraph::new();

                for node_snapshot in nodes {
                    let mut node = TaskNode::new(
                        node_snapshot.id.clone(),
                        node_snapshot.title.clone(),
                        node_snapshot.priority,
                    );
                    node.state = node_snapshot.state;
                    node.deps = node_snapshot.deps.clone();
                    node.created_at = node_snapshot.created_at;
                    node.started_at = node_snapshot.started_at;
                    node.completed_at = node_snapshot.completed_at;
                    node.result = node_snapshot.result.clone();
                    node.error = node_snapshot.error.clone();
                    node.retry_count = node_snapshot.retry_count;

                    self.graph
                        .add_node(node)
                        .map_err(|e| SnapshotError::RestoreError(e.to_string()))?;
                }

                Ok(())
            }
            _ => Err(SnapshotError::InvalidSnapshotType(
                "Expected TaskGraph snapshot data".to_string(),
            )),
        }
    }
}

impl RuntimeModule for TaskGraphModule {
    fn name(&self) -> String {
        "TaskGraph".to_string()
    }

    fn initialize(&mut self) -> Result<(), RuntimeError> {
        self.status = ModuleStatus::Ready;
        Ok(())
    }

    fn handle_event(
        &mut self,
        event: RuntimeEvent,
        payload: Option<&serde_json::Value>,
    ) -> Result<Vec<RuntimeEvent>, RuntimeError> {
        match event {
            RuntimeEvent::TaskCreated => {
                log::info!("TaskGraph received TaskCreated event");

                if let Some(payload) = payload {
                    if let Some(task_id) = payload.get("task_id").and_then(|v| v.as_str()) {
                        let title = payload
                            .get("title")
                            .and_then(|v| v.as_str())
                            .unwrap_or("Untitled Task");
                        let priority = payload
                            .get("priority")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(50) as u32;

                        let node = TaskNode::new(task_id.to_string(), title.to_string(), priority);
                        self.graph.add_node(node).map_err(|e| {
                            RuntimeError::EventProcessingError(format!(
                                "Failed to add task node: {}",
                                e
                            ))
                        })?;
                    }
                }
            }
            RuntimeEvent::TaskStarted => {
                log::info!("TaskGraph received TaskStarted event");

                if let Some(payload) = payload {
                    if let Some(task_id) = payload.get("task_id").and_then(|v| v.as_str()) {
                        if let Some(node) = self.graph.get_node_mut(task_id) {
                            let _ = node.transition_to(TaskState::Running);
                        }
                    }
                }
            }
            RuntimeEvent::TaskCompleted => {
                log::info!("TaskGraph received TaskCompleted event");

                if let Some(payload) = payload {
                    if let Some(task_id) = payload.get("task_id").and_then(|v| v.as_str()) {
                        if let Some(node) = self.graph.get_node_mut(task_id) {
                            let _ = node.transition_to(TaskState::Succeeded);
                        }
                    }
                }
            }
            RuntimeEvent::TaskFailed => {
                log::info!("TaskGraph received TaskFailed event");

                if let Some(payload) = payload {
                    if let Some(task_id) = payload.get("task_id").and_then(|v| v.as_str()) {
                        if let Some(node) = self.graph.get_node_mut(task_id) {
                            let _ = node.transition_to(TaskState::Failed);
                        }
                    }
                }
            }
            RuntimeEvent::TaskCancelled => {
                log::info!("TaskGraph received TaskCancelled event");

                if let Some(payload) = payload {
                    if let Some(task_id) = payload.get("task_id").and_then(|v| v.as_str()) {
                        if let Some(node) = self.graph.get_node_mut(task_id) {
                            let _ = node.transition_to(TaskState::Cancelled);
                        }
                    }
                }
            }
            RuntimeEvent::SystemShutdown => {
                log::info!("TaskGraph shutting down");
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

    #[test]
    fn test_task_graph_module_creation() {
        let module = TaskGraphModule::new();
        assert_eq!(module.name(), "TaskGraph");
        assert_eq!(module.get_status(), ModuleStatus::Uninitialized);
    }

    #[test]
    fn test_task_graph_module_initialize() {
        let mut module = TaskGraphModule::new();
        assert!(module.initialize().is_ok());
        assert_eq!(module.get_status(), ModuleStatus::Ready);
    }

    #[test]
    fn test_task_graph_module_handle_task_created() {
        let mut module = TaskGraphModule::new();
        module.initialize().unwrap();

        let payload = serde_json::json!({
            "task_id": "task_1",
            "title": "Test Task",
            "priority": 50
        });

        let result = module.handle_event(RuntimeEvent::TaskCreated, Some(&payload));
        assert!(result.is_ok());
        assert_eq!(module.graph().len(), 1);
    }

    #[test]
    fn test_task_graph_module_snapshot() {
        let mut module = TaskGraphModule::new();
        module.initialize().unwrap();

        let payload = serde_json::json!({
            "task_id": "task_1",
            "title": "Test Task",
            "priority": 50
        });
        module.handle_event(RuntimeEvent::TaskCreated, Some(&payload)).unwrap();

        let snapshot = module.save();
        assert_eq!(snapshot.snapshot_type, SnapshotType::Full);

        // 验证快照恢复
        let mut restored_module = TaskGraphModule::new();
        restored_module.initialize().unwrap();
        assert!(restored_module.restore(snapshot).is_ok());
        assert_eq!(restored_module.graph().len(), 1);
    }
}
