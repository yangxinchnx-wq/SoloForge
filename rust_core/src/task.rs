// ─────────────────────────────────────────────────────────────────
// SoloForge Rust Core: Task DAG (Directed Acyclic Graph)
// Path: rust_core/src/task.rs
// Description: 图结构任务调度 - 不要 Vec<Task>，必须图结构
// 文档要求：TaskNode 必须包含 id, title, state, priority, deps
// ─────────────────────────────────────────────────────────────────

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};

/// 任务状态枚举（统一状态机）
/// 文档要求：禁止自定义状态字符串绕过统一状态体系
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum TaskState {
    /// 等待调度
    Pending,
    /// 排队等待执行
    Queued,
    /// 正在规划
    Planning,
    /// 正在执行
    Running,
    /// 等待确认
    WaitingConfirm,
    /// 等待依赖完成
    WaitingDependency,
    /// 重试中
    Retrying,
    /// 执行成功
    Succeeded,
    /// 执行失败
    Failed,
    /// 被取消
    Cancelled,
    /// 部分成功
    PartialSuccess,
    /// 超时
    TimedOut,
    /// 暂停
    Paused,
}

impl TaskState {
    pub fn name(&self) -> &'static str {
        match self {
            TaskState::Pending => "pending",
            TaskState::Queued => "queued",
            TaskState::Planning => "planning",
            TaskState::Running => "running",
            TaskState::WaitingConfirm => "waiting_confirm",
            TaskState::WaitingDependency => "waiting_dependency",
            TaskState::Retrying => "retrying",
            TaskState::Succeeded => "succeeded",
            TaskState::Failed => "failed",
            TaskState::Cancelled => "cancelled",
            TaskState::PartialSuccess => "partial_success",
            TaskState::TimedOut => "timed_out",
            TaskState::Paused => "paused",
        }
    }

    /// 是否为终态
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            TaskState::Succeeded
                | TaskState::Failed
                | TaskState::Cancelled
                | TaskState::PartialSuccess
                | TaskState::TimedOut
        )
    }

    /// 是否可以转换到目标状态
    pub fn can_transition_to(&self, target: TaskState) -> bool {
        match (self, target) {
            // 标准状态流转
            (TaskState::Pending, TaskState::Queued) => true,
            (TaskState::Pending, TaskState::Cancelled) => true,
            (TaskState::Queued, TaskState::Planning) => true,
            (TaskState::Queued, TaskState::Running) => true,
            (TaskState::Queued, TaskState::Cancelled) => true,
            (TaskState::Planning, TaskState::Running) => true,
            (TaskState::Planning, TaskState::Failed) => true,
            (TaskState::Planning, TaskState::Cancelled) => true,
            (TaskState::Running, TaskState::WaitingConfirm) => true,
            (TaskState::Running, TaskState::WaitingDependency) => true,
            (TaskState::Running, TaskState::Retrying) => true,
            (TaskState::Running, TaskState::Succeeded) => true,
            (TaskState::Running, TaskState::Failed) => true,
            (TaskState::Running, TaskState::Paused) => true,
            (TaskState::Running, TaskState::Cancelled) => true,
            (TaskState::Running, TaskState::TimedOut) => true,
            (TaskState::WaitingConfirm, TaskState::Running) => true,
            (TaskState::WaitingConfirm, TaskState::Cancelled) => true,
            (TaskState::WaitingDependency, TaskState::Running) => true,
            (TaskState::WaitingDependency, TaskState::Cancelled) => true,
            (TaskState::Retrying, TaskState::Running) => true,
            (TaskState::Retrying, TaskState::Failed) => true,
            (TaskState::Retrying, TaskState::Cancelled) => true,
            (TaskState::Paused, TaskState::Running) => true,
            (TaskState::Paused, TaskState::Cancelled) => true,
            (TaskState::Failed, TaskState::Retrying) => true,
            // 任意状态都可以到 Cancelled（用户可停止）
            (_, TaskState::Cancelled) => true,
            _ => false,
        }
    }
}

/// 任务节点
/// 文档要求：必须包含 id, title, state, priority, deps
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskNode {
    /// 任务唯一标识
    pub id: String,
    /// 任务标题
    pub title: String,
    /// 任务描述
    pub description: Option<String>,
    /// 当前状态
    pub state: TaskState,
    /// 优先级（数值越大优先级越高）
    pub priority: u32,
    /// 依赖的任务 ID 列表
    pub deps: Vec<String>,
    /// 超时时间（毫秒，0 表示不超时）
    pub timeout_ms: u64,
    /// 重试次数
    pub retry_count: u32,
    /// 最大重试次数
    pub max_retries: u32,
    /// 创建时间戳
    pub created_at: u64,
    /// 开始执行时间戳
    pub started_at: Option<u64>,
    /// 完成时间戳
    pub completed_at: Option<u64>,
    /// 执行结果
    pub result: Option<String>,
    /// 错误信息
    pub error: Option<String>,
    /// 父任务 ID
    pub parent_id: Option<String>,
    /// 根任务 ID
    pub root_id: Option<String>,
    /// 追踪 ID（用于全链路追踪）
    pub trace_id: Option<String>,
    /// 源（谁创建了这个任务）
    pub source: TaskSource,
    /// 任务类型
    pub task_type: TaskType,
}

impl TaskNode {
    pub fn new(id: String, title: String, priority: u32) -> Self {
        Self {
            id,
            title,
            description: None,
            state: TaskState::Pending,
            priority,
            deps: Vec::new(),
            timeout_ms: 0,
            retry_count: 0,
            max_retries: 3,
            created_at: current_timestamp_ms(),
            started_at: None,
            completed_at: None,
            result: None,
            error: None,
            parent_id: None,
            root_id: None,
            trace_id: None,
            source: TaskSource::System,
            task_type: TaskType::Generic,
        }
    }

    /// 添加依赖
    pub fn add_dep(&mut self, dep_id: String) {
        if !self.deps.contains(&dep_id) {
            self.deps.push(dep_id);
        }
    }

    /// 是否可以执行（所有依赖都已完成）
    pub fn can_execute(&self, completed_deps: &HashSet<String>) -> bool {
        self.deps.iter().all(|dep| completed_deps.contains(dep))
    }

    /// 是否超时
    pub fn is_timed_out(&self) -> bool {
        if self.timeout_ms == 0 {
            return false;
        }
        if let Some(started) = self.started_at {
            let elapsed = current_timestamp_ms() - started;
            elapsed > self.timeout_ms
        } else {
            false
        }
    }

    /// 是否可以重试
    pub fn can_retry(&self) -> bool {
        self.retry_count < self.max_retries
    }

    /// 转换状态
    pub fn transition_to(&mut self, new_state: TaskState) -> Result<(), TaskTransitionError> {
        if !self.state.can_transition_to(new_state) {
            return Err(TaskTransitionError {
                from_state: self.state,
                to_state: new_state,
            });
        }
        self.state = new_state;
        Ok(())
    }
}

/// 任务转换错误
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskTransitionError {
    pub from_state: TaskState,
    pub to_state: TaskState,
}

/// 任务源
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum TaskSource {
    User,
    UI,
    Scheduler,
    Model,
    Tool,
    Plugin,
    System,
}

impl TaskSource {
    pub fn name(&self) -> &'static str {
        match self {
            TaskSource::User => "user",
            TaskSource::UI => "ui",
            TaskSource::Scheduler => "scheduler",
            TaskSource::Model => "model",
            TaskSource::Tool => "tool",
            TaskSource::Plugin => "plugin",
            TaskSource::System => "system",
        }
    }
}

/// 任务类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum TaskType {
    /// 根会话任务
    ConversationRoot,
    /// 规划器生成
    PlannerGenerate,
    /// 主模型运行
    ModelPrimaryRun,
    /// 副模型运行
    ModelSecondaryRun,
    /// 工具调用
    ToolCall,
    /// 技能调用
    SkillCall,
    /// 文件读取
    FileRead,
    /// 文件写入
    FileWrite,
    /// 预览刷新
    PreviewRefresh,
    /// 环境设置
    EnvironmentSetup,
    /// 下载运行
    DownloadRun,
    /// 记忆提取
    MemoryExtract,
    /// 知识搜索
    KnowledgeSearch,
    /// 频道发送
    ChannelSend,
    /// 审计记录
    AuditRecord,
    /// 通用任务
    Generic,
}

impl TaskType {
    pub fn name(&self) -> &'static str {
        match self {
            TaskType::ConversationRoot => "conversation.root",
            TaskType::PlannerGenerate => "planner.generate",
            TaskType::ModelPrimaryRun => "model.primary.run",
            TaskType::ModelSecondaryRun => "model.secondary.run",
            TaskType::ToolCall => "tool.call",
            TaskType::SkillCall => "skill.call",
            TaskType::FileRead => "file.read",
            TaskType::FileWrite => "file.write",
            TaskType::PreviewRefresh => "preview.refresh",
            TaskType::EnvironmentSetup => "environment.setup",
            TaskType::DownloadRun => "download.run",
            TaskType::MemoryExtract => "memory.extract",
            TaskType::KnowledgeSearch => "knowledge.search",
            TaskType::ChannelSend => "channel.send",
            TaskType::AuditRecord => "audit.record",
            TaskType::Generic => "generic",
        }
    }

    /// 是否为高风险任务
    pub fn is_high_risk(&self) -> bool {
        matches!(
            self,
            TaskType::FileWrite | TaskType::EnvironmentSetup | TaskType::ChannelSend
        )
    }

    /// 是否可以并发
    pub fn can_concurrent(&self) -> bool {
        matches!(
            self,
            TaskType::ModelSecondaryRun | TaskType::ToolCall | TaskType::KnowledgeSearch
        )
    }

    /// 是否需要串行化
    pub fn needs_serialization(&self) -> bool {
        matches!(self, TaskType::FileWrite)
    }
}

/// 任务依赖图
/// 文档要求：必须使用图结构，不要 Vec<Task>
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskGraph {
    /// 任务节点映射
    nodes: HashMap<String, TaskNode>,
    /// 反向依赖索引（谁依赖这个任务）
    dependents: HashMap<String, Vec<String>>,
}

impl TaskGraph {
    pub fn new() -> Self {
        Self {
            nodes: HashMap::new(),
            dependents: HashMap::new(),
        }
    }

    /// 添加任务节点
    pub fn add_node(&mut self, node: TaskNode) -> Result<(), TaskGraphError> {
        let node_id = node.id.clone();

        // 检查是否已存在
        if self.nodes.contains_key(&node_id) {
            return Err(TaskGraphError::NodeAlreadyExists(node_id));
        }

        // 验证依赖是否存在
        for dep_id in &node.deps {
            if !self.nodes.contains_key(dep_id) && dep_id != &node_id {
                // 依赖节点不存在，先添加为待定
                // 将在 add_node_with_deps 时处理
            }
        }

        // 添加节点
        self.nodes.insert(node_id.clone(), node);

        // 更新反向索引
        let deps = self.nodes.get_mut(&node_id).unwrap().deps.clone();
        for dep_id in deps {
            self.dependents
                .entry(dep_id)
                .or_insert_with(Vec::new)
                .push(node_id.clone());
        }

        Ok(())
    }

    /// 添加节点及其依赖
    pub fn add_node_with_deps(&mut self, node: TaskNode) -> Result<(), TaskGraphError> {
        // 先添加所有依赖节点（如果不存在）
        for dep_id in &node.deps {
            if !self.nodes.contains_key(dep_id) {
                // 创建占位节点
                let placeholder = TaskNode::new(dep_id.clone(), format!("Dependency: {}", dep_id), 0);
                self.nodes.insert(dep_id.clone(), placeholder);
                self.dependents.insert(dep_id.clone(), Vec::new());
            }
        }

        // 添加主节点
        self.add_node(node)
    }

    /// 获取任务节点
    pub fn get_node(&self, id: &str) -> Option<&TaskNode> {
        self.nodes.get(id)
    }

    /// 获取可变任务节点
    pub fn get_node_mut(&mut self, id: &str) -> Option<&mut TaskNode> {
        self.nodes.get_mut(id)
    }

    /// 获取所有就绪执行的任务
    /// 文档要求：ready_tasks() 方法
    pub fn ready_tasks(&self) -> Vec<&TaskNode> {
        let completed_deps = self
            .nodes
            .iter()
            .filter(|(_, node)| node.state.is_terminal())
            .map(|(id, _)| id.clone())
            .collect::<HashSet<_>>();

        self.nodes
            .values()
            .filter(|node| {
                node.state == TaskState::Pending || node.state == TaskState::Queued
            })
            .filter(|node| node.can_execute(&completed_deps))
            .collect()
    }

    /// 获取就绪任务的排序列表（按优先级降序）
    pub fn ready_tasks_sorted(&self) -> Vec<&TaskNode> {
        let mut ready = self.ready_tasks();
        ready.sort_by(|a, b| b.priority.cmp(&a.priority));
        ready
    }

    /// 获取根任务
    pub fn root_tasks(&self) -> Vec<&TaskNode> {
        self.nodes
            .values()
            .filter(|node| node.parent_id.is_none())
            .collect()
    }

    /// 获取子任务
    pub fn children(&self, parent_id: &str) -> Vec<&TaskNode> {
        self.nodes
            .values()
            .filter(|node| node.parent_id.as_deref() == Some(parent_id))
            .collect()
    }

    /// 获取依赖此任务的所有任务
    pub fn dependents_of(&self, task_id: &str) -> Vec<&TaskNode> {
        self.dependents
            .get(task_id)
            .map(|ids| {
                ids.iter()
                    .filter_map(|id| self.nodes.get(id))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// 检测循环依赖
    pub fn detect_cycles(&self) -> Result<(), TaskGraphError> {
        let mut visited = HashSet::new();
        let mut recursion_stack = HashSet::new();

        for node_id in self.nodes.keys() {
            if !visited.contains(node_id) {
                if self.has_cycle_dfs(node_id, &mut visited, &mut recursion_stack) {
                    return Err(TaskGraphError::CyclicDependency(node_id.clone()));
                }
            }
        }

        Ok(())
    }

    fn has_cycle_dfs(
        &self,
        node_id: &str,
        visited: &mut HashSet<String>,
        recursion_stack: &mut HashSet<String>,
    ) -> bool {
        visited.insert(node_id.to_string());
        recursion_stack.insert(node_id.to_string());

        if let Some(node) = self.nodes.get(node_id) {
            for dep_id in &node.deps {
                if !visited.contains(dep_id) {
                    if self.has_cycle_dfs(dep_id, visited, recursion_stack) {
                        return true;
                    }
                } else if recursion_stack.contains(dep_id) {
                    return true;
                }
            }
        }

        recursion_stack.remove(node_id);
        false
    }

    /// 拓扑排序
    pub fn topological_sort(&self) -> Result<Vec<&TaskNode>, TaskGraphError> {
        self.detect_cycles()?;

        let mut in_degree: HashMap<String, usize> = HashMap::new();
        let mut result = Vec::new();
        let mut queue: VecDeque<String> = VecDeque::new();

        // 计算入度
        for (id, node) in &self.nodes {
            let deps_count = node.deps.iter().filter(|d| self.nodes.contains_key(*d)).count();
            in_degree.insert(id.clone(), deps_count);
        }

        // 入度为0的节点入队
        for (id, degree) in &in_degree {
            if *degree == 0 {
                queue.push_back(id.clone());
            }
        }

        // BFS 拓扑排序
        while let Some(node_id) = queue.pop_front() {
            if let Some(node) = self.nodes.get(&node_id) {
                result.push(node);
            }

            if let Some(dependents) = self.dependents.get(&node_id) {
                for dependent_id in dependents {
                    if let Some(degree) = in_degree.get_mut(dependent_id) {
                        *degree -= 1;
                        if *degree == 0 {
                            queue.push_back(dependent_id.clone());
                        }
                    }
                }
            }
        }

        // 如果结果数量不等于节点数量，说明有环
        if result.len() != self.nodes.len() {
            return Err(TaskGraphError::CyclicDependency(String::new()));
        }

        Ok(result)
    }

    /// 获取任务统计
    pub fn stats(&self) -> TaskGraphStats {
        let mut stats = TaskGraphStats::default();

        for node in self.nodes.values() {
            match node.state {
                TaskState::Pending => stats.pending += 1,
                TaskState::Queued => stats.queued += 1,
                TaskState::Planning => stats.planning += 1,
                TaskState::Running => stats.running += 1,
                TaskState::WaitingConfirm | TaskState::WaitingDependency => stats.waiting += 1,
                TaskState::Retrying => stats.retrying += 1,
                TaskState::Succeeded => stats.succeeded += 1,
                TaskState::Failed => stats.failed += 1,
                TaskState::Cancelled => stats.cancelled += 1,
                TaskState::PartialSuccess => stats.partial_success += 1,
                TaskState::TimedOut => stats.timed_out += 1,
                TaskState::Paused => stats.paused += 1,
            }
        }

        stats.total = self.nodes.len();
        stats
    }

    /// 获取节点数量
    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    /// 检查是否为空
    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    /// 迭代所有节点
    pub fn iter(&self) -> impl Iterator<Item = &TaskNode> {
        self.nodes.values()
    }

    /// 获取所有节点
    pub fn all_nodes(&self) -> Vec<&TaskNode> {
        self.nodes.values().collect()
    }
}

impl Default for TaskGraph {
    fn default() -> Self {
        Self::new()
    }
}

/// 任务图错误
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum TaskGraphError {
    NodeAlreadyExists(String),
    NodeNotFound(String),
    CyclicDependency(String),
    InvalidTransition(String),
}

impl std::fmt::Display for TaskGraphError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TaskGraphError::NodeAlreadyExists(id) => {
                write!(f, "Node already exists: {}", id)
            }
            TaskGraphError::NodeNotFound(id) => write!(f, "Node not found: {}", id),
            TaskGraphError::CyclicDependency(id) => {
                write!(f, "Cyclic dependency detected at: {}", id)
            }
            TaskGraphError::InvalidTransition(msg) => write!(f, "Invalid transition: {}", msg),
        }
    }
}

impl std::error::Error for TaskGraphError {}

/// 任务图统计
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TaskGraphStats {
    pub total: usize,
    pub pending: usize,
    pub queued: usize,
    pub planning: usize,
    pub running: usize,
    pub waiting: usize,
    pub retrying: usize,
    pub succeeded: usize,
    pub failed: usize,
    pub cancelled: usize,
    pub partial_success: usize,
    pub timed_out: usize,
    pub paused: usize,
}

/// 获取当前时间戳（毫秒）
fn current_timestamp_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_task_node_creation() {
        let task = TaskNode::new("task1".to_string(), "Test Task".to_string(), 10);
        assert_eq!(task.id, "task1");
        assert_eq!(task.state, TaskState::Pending);
        assert_eq!(task.priority, 10);
    }

    #[test]
    fn test_task_state_transition() {
        let mut task = TaskNode::new("task1".to_string(), "Test".to_string(), 10);
        assert!(task.transition_to(TaskState::Queued).is_ok());
        assert!(task.transition_to(TaskState::Running).is_ok());
        assert!(task.transition_to(TaskState::Succeeded).is_ok());
        assert!(task.transition_to(TaskState::Running).is_err()); // 不能从终态回来
    }

    #[test]
    fn test_task_graph_add_node() {
        let mut graph = TaskGraph::new();
        let task = TaskNode::new("task1".to_string(), "Test".to_string(), 10);
        assert!(graph.add_node(task).is_ok());
        assert_eq!(graph.len(), 1);
    }

    #[test]
    fn test_task_graph_with_deps() {
        let mut graph = TaskGraph::new();
        let mut task1 = TaskNode::new("task1".to_string(), "Task 1".to_string(), 10);
        let mut task2 = TaskNode::new("task2".to_string(), "Task 2".to_string(), 5);
        task2.add_dep("task1".to_string());

        graph.add_node(task1).unwrap();
        graph.add_node_with_deps(task2).unwrap();

        assert_eq!(graph.len(), 2);
        assert!(graph.get_node("task2").unwrap().deps.contains(&"task1".to_string()));
    }

    #[test]
    fn test_ready_tasks() {
        let mut graph = TaskGraph::new();

        let task1 = TaskNode::new("task1".to_string(), "Task 1".to_string(), 10);
        let mut task2 = TaskNode::new("task2".to_string(), "Task 2".to_string(), 5);
        task2.add_dep("task1".to_string());

        graph.add_node(task1).unwrap();
        graph.add_node(task2).unwrap();

        let ready = graph.ready_tasks();
        assert_eq!(ready.len(), 1);
        assert_eq!(ready[0].id, "task1");
    }

    #[test]
    fn test_cycle_detection() {
        let mut graph = TaskGraph::new();

        let mut task1 = TaskNode::new("task1".to_string(), "Task 1".to_string(), 10);
        let mut task2 = TaskNode::new("task2".to_string(), "Task 2".to_string(), 5);
        task1.add_dep("task2".to_string());
        task2.add_dep("task1".to_string());

        graph.add_node(task1).unwrap();
        graph.add_node(task2).unwrap();

        assert!(graph.detect_cycles().is_err());
    }

    #[test]
    fn test_topological_sort() {
        let mut graph = TaskGraph::new();

        let mut task1 = TaskNode::new("task1".to_string(), "Task 1".to_string(), 10);
        let mut task2 = TaskNode::new("task2".to_string(), "Task 2".to_string(), 5);
        let mut task3 = TaskNode::new("task3".to_string(), "Task 3".to_string(), 3);

        task2.add_dep("task1".to_string());
        task3.add_dep("task2".to_string());

        graph.add_node(task1).unwrap();
        graph.add_node(task2).unwrap();
        graph.add_node(task3).unwrap();

        let sorted = graph.topological_sort().unwrap();
        assert_eq!(sorted.len(), 3);

        // task1 应该在 task2 前面
        let task1_pos = sorted.iter().position(|t| t.id == "task1").unwrap();
        let task2_pos = sorted.iter().position(|t| t.id == "task2").unwrap();
        let task3_pos = sorted.iter().position(|t| t.id == "task3").unwrap();

        assert!(task1_pos < task2_pos);
        assert!(task2_pos < task3_pos);
    }
}
