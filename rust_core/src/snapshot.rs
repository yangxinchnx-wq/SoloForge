// ─────────────────────────────────────────────────────────────────
// SoloForge Rust Core: Snapshot System
// Path: rust_core/src/snapshot.rs
// Description: 快照与恢复机制
// 文档要求：Snapshot Trait，Task 快照内容：{ queue, stack, memory }
// 写入位置：storage/snapshot/
// ─────────────────────────────────────────────────────────────────

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::task::{TaskGraph, TaskNode, TaskState};
use crate::scheduler::TaskItem;

/// 快照接口
/// 文档要求：所有可快照对象实现 Snapshotable Trait
pub trait Snapshotable {
    fn save(&self) -> StateSnapshot;
    fn restore(&mut self, snapshot: StateSnapshot) -> Result<(), SnapshotError>;
}

/// 状态快照
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateSnapshot {
    /// 快照 ID
    pub id: String,
    /// 快照类型
    pub snapshot_type: SnapshotType,
    /// 创建时间戳
    pub created_at: u64,
    /// 快照数据（JSON）
    pub data: SnapshotData,
    /// 元数据
    pub metadata: SnapshotMetadata,
}

/// 快照类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SnapshotType {
    /// 完整快照
    Full,
    /// 增量快照
    Incremental,
    /// 检查点快照
    Checkpoint,
    /// 崩溃恢复快照
    CrashRecovery,
}

/// 快照数据
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum SnapshotData {
    /// 任务图快照
    TaskGraph {
        nodes: Vec<TaskSnapshot>,
        metadata: TaskGraphSnapshotMetadata,
    },
    /// 调度器快照
    Scheduler {
        queue: Vec<TaskItem>,
        running_count: usize,
        completed_count: usize,
    },
    /// 运行时快照
    Runtime {
        task_graph: TaskGraphSnapshotMetadata,
        scheduler: SchedulerSnapshotMetadata,
        modules: HashMap<String, ModuleSnapshot>,
    },
    /// 自定义数据
    Custom(serde_json::Value),
}

/// 任务快照
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskSnapshot {
    pub id: String,
    pub title: String,
    pub state: TaskState,
    pub priority: u32,
    pub deps: Vec<String>,
    pub created_at: u64,
    pub started_at: Option<u64>,
    pub completed_at: Option<u64>,
    pub result: Option<String>,
    pub error: Option<String>,
    pub retry_count: u32,
}

impl From<&TaskNode> for TaskSnapshot {
    fn from(node: &TaskNode) -> Self {
        Self {
            id: node.id.clone(),
            title: node.title.clone(),
            state: node.state,
            priority: node.priority,
            deps: node.deps.clone(),
            created_at: node.created_at,
            started_at: node.started_at,
            completed_at: node.completed_at,
            result: node.result.clone(),
            error: node.error.clone(),
            retry_count: node.retry_count,
        }
    }
}

/// 任务图快照元数据
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskGraphSnapshotMetadata {
    pub total_nodes: usize,
    pub pending_count: usize,
    pub running_count: usize,
    pub completed_count: usize,
    pub failed_count: usize,
}

/// 调度器快照元数据
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchedulerSnapshotMetadata {
    pub queue_size: usize,
    pub running_tasks: Vec<String>,
    pub recent_completions: Vec<String>,
}

/// 模块快照
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModuleSnapshot {
    pub name: String,
    pub state: serde_json::Value,
    pub version: u32,
}

/// 快照元数据
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotMetadata {
    /// 快照版本
    pub version: u32,
    /// 运行时 ID
    pub runtime_id: String,
    /// 序列号
    pub sequence: u64,
    /// 快照大小（字节）
    pub size_bytes: usize,
    /// 校验和
    pub checksum: Option<String>,
    /// 是否完整
    pub is_complete: bool,
}

impl StateSnapshot {
    /// 创建新快照
    pub fn new(snapshot_type: SnapshotType, data: SnapshotData, runtime_id: String) -> Self {
        let now = current_timestamp_ms();
        Self {
            id: generate_snapshot_id(),
            snapshot_type,
            created_at: now,
            data,
            metadata: SnapshotMetadata {
                version: 1,
                runtime_id,
                sequence: 0,
                size_bytes: 0,
                checksum: None,
                is_complete: true,
            },
        }
    }

    /// 计算快照大小
    pub fn calculate_size(&mut self) {
        let json = serde_json::to_string(&self.data).unwrap_or_default();
        self.metadata.size_bytes = json.len();
    }

    /// 计算校验和
    pub fn calculate_checksum(&mut self) {
        let json = serde_json::to_string(&self.data).unwrap_or_default();
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let mut hasher = DefaultHasher::new();
        json.hash(&mut hasher);
        self.metadata.checksum = Some(format!("{:x}", hasher.finish()));
    }

    /// 验证校验和
    pub fn verify_checksum(&self) -> bool {
        if let Some(checksum) = &self.metadata.checksum {
            let json = serde_json::to_string(&self.data).unwrap_or_default();
            use std::collections::hash_map::DefaultHasher;
            use std::hash::{Hash, Hasher};
            let mut hasher = DefaultHasher::new();
            json.hash(&mut hasher);
            format!("{:x}", hasher.finish()) == *checksum
        } else {
            true
        }
    }
}

/// 快照管理器
pub struct SnapshotManager {
    /// 快照存储目录（预留，为未来持久化存储做准备）
    #[allow(dead_code)]
    storage_dir: String,
    /// 快照目录
    snapshot_dir: String,
    /// 最新快照 ID
    latest_snapshot_id: Option<String>,
    /// 快照计数器
    sequence: u64,
}

impl SnapshotManager {
    /// 创建新的快照管理器
    pub fn new(storage_dir: &str) -> Self {
        let snapshot_dir = format!("{}/snapshot", storage_dir);
        Self {
            storage_dir: storage_dir.to_string(),
            snapshot_dir,
            latest_snapshot_id: None,
            sequence: 0,
        }
    }

    /// 初始化存储目录
    pub fn initialize(&self) -> Result<(), SnapshotError> {
        if !Path::new(&self.snapshot_dir).exists() {
            fs::create_dir_all(&self.snapshot_dir)
                .map_err(|e| SnapshotError::StorageError(e.to_string()))?;
        }
        Ok(())
    }

    /// 保存任务图快照
    pub fn save_task_graph(
        &mut self,
        graph: &TaskGraph,
        runtime_id: &str,
        snapshot_type: SnapshotType,
    ) -> Result<String, SnapshotError> {
        let nodes: Vec<TaskSnapshot> = graph.iter().map(TaskSnapshot::from).collect();
        let stats = graph.stats();

        let metadata = TaskGraphSnapshotMetadata {
            total_nodes: stats.total,
            pending_count: stats.pending + stats.queued,
            running_count: stats.running,
            completed_count: stats.succeeded,
            failed_count: stats.failed,
        };

        let data = SnapshotData::TaskGraph { nodes, metadata };
        let mut snapshot = StateSnapshot::new(snapshot_type, data, runtime_id.to_string());
        snapshot.metadata.sequence = self.sequence;
        snapshot.calculate_size();
        snapshot.calculate_checksum();

        let filename = format!("{}/task_graph_{}.json", self.snapshot_dir, snapshot.id);
        let json = serde_json::to_string_pretty(&snapshot)
            .map_err(|e| SnapshotError::SerializationError(e.to_string()))?;

        fs::write(&filename, &json)
            .map_err(|e| SnapshotError::StorageError(e.to_string()))?;

        self.latest_snapshot_id = Some(snapshot.id.clone());
        self.sequence += 1;

        Ok(snapshot.id)
    }

    /// 加载最新快照
    pub fn load_latest(&self) -> Result<StateSnapshot, SnapshotError> {
        if let Some(id) = &self.latest_snapshot_id {
            self.load(id)
        } else {
            // 查找最新的快照文件
            self.load_latest_from_disk()
        }
    }

    /// 从磁盘加载最新快照
    fn load_latest_from_disk(&self) -> Result<StateSnapshot, SnapshotError> {
        let entries = fs::read_dir(&self.snapshot_dir)
            .map_err(|e| SnapshotError::StorageError(e.to_string()))?;

        let mut latest_file: Option<(SystemTime, String)> = None;

        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map(|e| e == "json").unwrap_or(false) {
                if let Ok(metadata) = entry.metadata() {
                    let modified = metadata.modified().unwrap_or(UNIX_EPOCH);
                    let filename = path.to_string_lossy().to_string();
                    match latest_file {
                        Some((existing_time, _)) if modified > existing_time => {
                            latest_file = Some((modified, filename));
                        }
                        None => {
                            latest_file = Some((modified, filename));
                        }
                        _ => {}
                    }
                }
            }
        }

        if let Some((_, filename)) = latest_file {
            self.load_from_file(&filename)
        } else {
            Err(SnapshotError::NoSnapshotFound)
        }
    }

    /// 从文件加载快照
    fn load_from_file(&self, filename: &str) -> Result<StateSnapshot, SnapshotError> {
        let content = fs::read_to_string(filename)
            .map_err(|e| SnapshotError::StorageError(e.to_string()))?;

        let snapshot: StateSnapshot = serde_json::from_str(&content)
            .map_err(|e| SnapshotError::DeserializationError(e.to_string()))?;

        if !snapshot.verify_checksum() {
            return Err(SnapshotError::ChecksumMismatch);
        }

        Ok(snapshot)
    }

    /// 加载指定 ID 的快照
    pub fn load(&self, id: &str) -> Result<StateSnapshot, SnapshotError> {
        let filename = format!("{}/task_graph_{}.json", self.snapshot_dir, id);
        self.load_from_file(&filename)
    }

    /// 恢复任务图
    pub fn restore_task_graph(&self, snapshot: &StateSnapshot) -> Result<TaskGraph, SnapshotError> {
        match &snapshot.data {
            SnapshotData::TaskGraph { nodes, .. } => {
                let mut graph = TaskGraph::new();
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

                    graph.add_node(node).map_err(|e| SnapshotError::RestoreError(e.to_string()))?;
                }
                Ok(graph)
            }
            _ => Err(SnapshotError::InvalidSnapshotType(
                "Expected TaskGraph snapshot".to_string(),
            )),
        }
    }

    /// 列出所有快照
    pub fn list_snapshots(&self) -> Result<Vec<SnapshotInfo>, SnapshotError> {
        let entries = fs::read_dir(&self.snapshot_dir)
            .map_err(|e| SnapshotError::StorageError(e.to_string()))?;

        let mut snapshots = Vec::new();

        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map(|e| e == "json").unwrap_or(false) {
                if let Ok(metadata) = entry.metadata() {
                    let modified = metadata.modified().unwrap_or(UNIX_EPOCH);
                    let filename = path.file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();
                    let id = filename
                        .strip_prefix("task_graph_")
                        .and_then(|s| s.strip_suffix(".json"))
                        .unwrap_or(&filename)
                        .to_string();

                    snapshots.push(SnapshotInfo {
                        id,
                        filename: path.to_string_lossy().to_string(),
                        modified_at: modified,
                        size_bytes: metadata.len(),
                    });
                }
            }
        }

        snapshots.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
        Ok(snapshots)
    }

    /// 删除旧快照
    pub fn cleanup_old_snapshots(&self, keep_count: usize) -> Result<usize, SnapshotError> {
        let snapshots = self.list_snapshots()?;
        let _to_delete = snapshots.len().saturating_sub(keep_count);
        let mut deleted = 0;

        for snapshot in snapshots.iter().skip(keep_count) {
            if fs::remove_file(&snapshot.filename).is_ok() {
                deleted += 1;
            }
        }

        Ok(deleted)
    }

    /// 获取最新快照 ID
    pub fn get_latest_id(&self) -> Option<&str> {
        self.latest_snapshot_id.as_deref()
    }

    /// 检查快照目录是否存在
    pub fn exists(&self) -> bool {
        Path::new(&self.snapshot_dir).exists()
    }
}

/// 快照信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotInfo {
    pub id: String,
    pub filename: String,
    pub modified_at: SystemTime,
    pub size_bytes: u64,
}

/// 快照错误
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SnapshotError {
    StorageError(String),
    SerializationError(String),
    DeserializationError(String),
    InvalidSnapshotType(String),
    NoSnapshotFound,
    ChecksumMismatch,
    RestoreError(String),
}

impl std::fmt::Display for SnapshotError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SnapshotError::StorageError(msg) => write!(f, "Storage error: {}", msg),
            SnapshotError::SerializationError(msg) => write!(f, "Serialization error: {}", msg),
            SnapshotError::DeserializationError(msg) => write!(f, "Deserialization error: {}", msg),
            SnapshotError::InvalidSnapshotType(msg) => write!(f, "Invalid snapshot type: {}", msg),
            SnapshotError::NoSnapshotFound => write!(f, "No snapshot found"),
            SnapshotError::ChecksumMismatch => write!(f, "Checksum mismatch"),
            SnapshotError::RestoreError(msg) => write!(f, "Restore error: {}", msg),
        }
    }
}

impl std::error::Error for SnapshotError {}

/// 生成快照 ID
fn generate_snapshot_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("snap_{}", timestamp)
}

/// 获取当前时间戳（毫秒）
fn current_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_snapshot_creation() {
        let data = SnapshotData::Custom(serde_json::json!({"test": true}));
        let snapshot = StateSnapshot::new(
            SnapshotType::Full,
            data,
            "test_runtime".to_string(),
        );

        assert_eq!(snapshot.snapshot_type, SnapshotType::Full);
        assert_eq!(snapshot.metadata.runtime_id, "test_runtime");
    }

    #[test]
    fn test_snapshot_checksum() {
        let data = SnapshotData::Custom(serde_json::json!({"value": 42}));
        let mut snapshot = StateSnapshot::new(
            SnapshotType::Full,
            data,
            "test".to_string(),
        );

        snapshot.calculate_checksum();
        assert!(snapshot.verify_checksum());

        // 修改数据后校验和应该不匹配
        if let SnapshotData::Custom(ref mut val) = snapshot.data {
            *val = serde_json::json!({"value": 100});
        }
        assert!(!snapshot.verify_checksum());
    }

    #[test]
    fn test_task_snapshot_from_task_node() {
        let mut task = TaskNode::new("task1".to_string(), "Test Task".to_string(), 10);
        task.state = TaskState::Running;
        task.started_at = Some(1000);

        let snapshot = TaskSnapshot::from(&task);
        assert_eq!(snapshot.id, "task1");
        assert_eq!(snapshot.state, TaskState::Running);
    }
}
