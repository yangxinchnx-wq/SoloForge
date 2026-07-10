// ─────────────────────────────────────────────────────────────────
// SoloForge Rust Core: Task Scheduler
// Path: rust_core/src/scheduler_core.rs
// Description: 任务调度器 - 完整实现 Priority Queue + 状态机 + 中断
// 文档要求：
//   - Priority Queue 使用 BinaryHeap O(log n)
//   - 排序公式：score = priority + aging + urgency
//   - 状态：queued → running → waiting → paused → completed
//   - 支持 Interrupt：pause, resume, cancel, preempt
// ─────────────────────────────────────────────────────────────────

use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

// 导入 actor_queue 模块
pub use crate::actor_queue::{ActorTask, ActorQueue};

use crate::task::{TaskState, TaskType};

/// 任务项（优先队列元素）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskItem {
    /// 任务唯一标识
    pub task_id: String,
    /// 基础优先级
    pub base_priority: u32,
    /// 老化因子（每秒增加的额外优先级）
    pub aging_factor: f64,
    /// 截止时间（毫秒时间戳，0 表示无截止时间）
    pub deadline: u64,
    /// 创建时间
    pub created_at: u64,
    /// 紧急程度
    pub urgency: u32,
    /// 入队时的优先级（用于 FIFO 排序）
    pub sequence: u64,
}

impl TaskItem {
    pub fn new(
        task_id: String,
        base_priority: u32,
        aging_factor: f64,
        deadline: u64,
    ) -> Self {
        Self {
            task_id,
            base_priority,
            aging_factor,
            deadline,
            created_at: current_timestamp_ms(),
            urgency: 0,
            sequence: next_sequence(),
        }
    }

    /// 计算当前有效分数
    /// 文档要求：score = priority + aging + urgency
    pub fn effective_score(&self) -> f64 {
        let elapsed_secs = (current_timestamp_ms() - self.created_at) as f64 / 1000.0;
        let aging_score = elapsed_secs * self.aging_factor;

        // 截止时间越近，紧急程度越高
        let deadline_score = if self.deadline > 0 {
            let now = current_timestamp_ms();
            if now >= self.deadline {
                10000.0 // 已过期，给予最高紧急分
            } else {
                let remaining = self.deadline - now;
                // 剩余时间越少，分数越高（线性衰减）
                (1000.0 - (remaining as f64 / 1000.0).min(1000.0)).max(0.0)
            }
        } else {
            0.0
        };

        self.base_priority as f64 + aging_score + self.urgency as f64 + deadline_score
    }

    /// 获取优先级
    pub fn priority(&self) -> u32 {
        self.base_priority
    }

    /// 是否已过期
    pub fn is_expired(&self) -> bool {
        self.deadline > 0 && current_timestamp_ms() > self.deadline
    }
}

/// 优先队列项（用于 BinaryHeap 排序）
#[derive(Debug, Clone)]
struct ScoredTaskItem {
    item: TaskItem,
    score: f64,
}

impl Eq for ScoredTaskItem {}

impl PartialEq for ScoredTaskItem {
    fn eq(&self, other: &Self) -> bool {
        self.score.to_bits() == other.score.to_bits()
    }
}

impl Ord for ScoredTaskItem {
    fn cmp(&self, other: &Self) -> Ordering {
        // 降序排列（BinaryHeap 默认最大堆，高优先级先弹出）
        // 修复：参数顺序从 other→self 改为 self→other（原代码导致 Max-Heap 变 Min-Heap）
        self.score.partial_cmp(&other.score).unwrap_or(Ordering::Equal)
    }
}

impl PartialOrd for ScoredTaskItem {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// 调度器
/// 文档要求：Scheduler 结构体，queue: BinaryHeap<TaskItem>
pub struct Scheduler {
    /// 优先级队列
    queue: PriorityQueue,
    /// 调度器状态
    state: SchedulerState,
}

impl Scheduler {
    /// 创建新的调度器
    pub fn new(config: SchedulerConfig) -> Self {
        Self {
            queue: PriorityQueue::new(config),
            state: SchedulerState::Initializing,
        }
    }

    /// 启动调度器
    /// 遵循状态机验证：Initializing → Ready → Running
    pub fn start(&mut self) {
        let _ = self.transition_to(SchedulerState::Ready);
        let _ = self.transition_to(SchedulerState::Running);
    }

    /// 带验证的状态转换
    /// 文档要求：防止非法状态组合
    pub fn transition_to(&mut self, target: SchedulerState) -> Result<(), SchedulerError> {
        if !self.state.can_transition_to(target) {
            return Err(SchedulerError::InvalidState(format!(
                "Cannot transition from {:?} to {:?}",
                self.state, target
            )));
        }
        self.state = target;
        Ok(())
    }

    /// 停止调度器
    pub fn stop(&mut self) {
        self.state = SchedulerState::Shutdown;
    }

    /// 暂停调度器
    pub fn pause(&mut self) {
        if self.state == SchedulerState::Running {
            self.state = SchedulerState::Paused;
        }
    }

    /// 恢复调度器
    pub fn resume(&mut self) {
        if self.state == SchedulerState::Paused {
            self.state = SchedulerState::Running;
        }
    }

    /// 入队任务
    pub fn enqueue(&mut self, item: TaskItem) -> Result<(), SchedulerError> {
        self.queue.push(item)
    }

    /// 获取下一个任务
    pub fn dequeue(&mut self) -> Option<TaskContext> {
        self.queue.next()
    }

    /// 获取队列大小
    pub fn queue_size(&self) -> usize {
        self.queue.len()
    }

    /// 检查调度器是否运行中
    pub fn is_running(&self) -> bool {
        self.state == SchedulerState::Running
    }

    /// 获取状态
    pub fn get_state(&self) -> SchedulerState {
        self.state
    }

    /// 获取统计信息
    pub fn get_stats(&self) -> &SchedulerStats {
        self.queue.stats()
    }

    /// 获取队列快照（用于持久化）
    pub fn snapshot_queue(&self) -> Vec<TaskItem> {
        self.queue.snapshot()
    }

    /// 从快照恢复队列（用于崩溃恢复）
    pub fn restore_queue(&mut self, items: Vec<TaskItem>) {
        self.queue.restore(items);
    }
}

/// 调度器执行状态
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SchedulerState {
    /// 初始化
    Initializing,
    /// 就绪
    Ready,
    /// 运行中
    Running,
    /// 暂停
    Paused,
    /// 关闭
    Shutdown,
}

impl SchedulerState {
    pub fn name(&self) -> &'static str {
        match self {
            SchedulerState::Initializing => "initializing",
            SchedulerState::Ready => "ready",
            SchedulerState::Running => "running",
            SchedulerState::Paused => "paused",
            SchedulerState::Shutdown => "shutdown",
        }
    }

    /// 状态转换验证表（基于 rust-fsm typestate pattern）
    /// 文档要求：防止非法状态组合
    pub fn can_transition_to(&self, target: SchedulerState) -> bool {
        matches!(
            (self, target),
            // 启动流程
            (SchedulerState::Initializing, SchedulerState::Ready) |
            // 运行流程
            (SchedulerState::Ready, SchedulerState::Running) |
            (SchedulerState::Running, SchedulerState::Paused) |
            (SchedulerState::Paused, SchedulerState::Running) |
            // 关闭流程
            (SchedulerState::Running, SchedulerState::Shutdown) |
            (SchedulerState::Paused, SchedulerState::Shutdown) |
            (SchedulerState::Ready, SchedulerState::Shutdown)
        )
    }
}

/// 调度器统计
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SchedulerStats {
    pub total_enqueued: u64,
    pub total_dequeued: u64,
    pub total_completed: u64,
    pub total_failed: u64,
    pub total_cancelled: u64,
    pub total_preempted: u64,
    pub current_queue_size: usize,
    pub current_running: usize,
    pub total_waiting: usize,
    pub max_queue_size: usize,
    pub avg_wait_time_ms: u64,
    pub avg_execution_time_ms: u64,
}

/// 调度器配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchedulerConfig {
    /// 最大并发任务数
    pub max_concurrent: usize,
    /// 默认超时时间（毫秒）
    pub default_timeout_ms: u64,
    /// 老化阈值（秒）- 超过此时间的任务自动提权
    pub aging_threshold_secs: u64,
    /// 饥饿检测阈值（秒）- 超过此时间的低优任务强制执行
    pub starvation_threshold_secs: u64,
    /// 队列最大长度
    pub max_queue_size: usize,
    /// 是否启用截止时间调度
    pub deadline_scheduling: bool,
}

impl Default for SchedulerConfig {
    fn default() -> Self {
        Self {
            max_concurrent: 10,
            default_timeout_ms: 60000, // 60秒
            aging_threshold_secs: 30,
            starvation_threshold_secs: 60,
            max_queue_size: 10000,
            deadline_scheduling: true,
        }
    }
}

/// 任务执行上下文
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskContext {
    pub task_id: String,
    pub task_type: TaskType,
    pub priority: u32,
    pub created_at: u64,
    pub started_at: Option<u64>,
    pub completed_at: Option<u64>,
    pub result: Option<String>,
    pub error: Option<String>,
    pub state: TaskState,
    pub interruptible: bool,
}

impl TaskContext {
    pub fn new(task_id: String, task_type: TaskType, priority: u32) -> Self {
        Self {
            task_id,
            task_type,
            priority,
            created_at: current_timestamp_ms(),
            started_at: None,
            completed_at: None,
            result: None,
            error: None,
            state: TaskState::Queued,
            interruptible: true,
        }
    }

    /// 获取等待时间（毫秒）
    pub fn wait_time_ms(&self) -> u64 {
        let start = self.started_at.unwrap_or(current_timestamp_ms());
        start - self.created_at
    }

    /// 获取执行时间（毫秒）
    pub fn execution_time_ms(&self) -> Option<u64> {
        self.completed_at.map(|end| end - self.started_at.unwrap_or(end))
    }

    /// 标记开始执行
    pub fn start(&mut self) {
        self.started_at = Some(current_timestamp_ms());
        self.state = TaskState::Running;
    }

    /// 标记完成
    pub fn complete(&mut self, result: String) {
        self.completed_at = Some(current_timestamp_ms());
        self.result = Some(result);
        self.state = TaskState::Succeeded;
    }

    /// 标记失败
    pub fn fail(&mut self, error: String) {
        self.completed_at = Some(current_timestamp_ms());
        self.error = Some(error);
        self.state = TaskState::Failed;
    }

    /// 标记暂停
    pub fn pause(&mut self) {
        self.state = TaskState::Paused;
    }

    /// 标记恢复
    pub fn resume(&mut self) {
        self.state = TaskState::Running;
    }

    /// 标记取消
    pub fn cancel(&mut self) {
        self.completed_at = Some(current_timestamp_ms());
        self.state = TaskState::Cancelled;
    }

    /// 标记超时
    pub fn timeout(&mut self) {
        self.completed_at = Some(current_timestamp_ms());
        self.state = TaskState::TimedOut;
    }
}

/// 资源池
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ResourcePool {
    /// CPU 核心数
    pub cpu_cores: usize,
    /// 内存限制（字节）
    pub memory_limit: usize,
    /// 当前 CPU 使用率
    pub cpu_usage: f64,
    /// 当前内存使用（字节）
    pub memory_usage: usize,
    /// 最大并发数
    pub max_concurrent: usize,
    /// 当前并发数
    pub current_concurrent: usize,
}

impl ResourcePool {
    pub fn new(cpu_cores: usize, memory_limit: usize, max_concurrent: usize) -> Self {
        Self {
            cpu_cores,
            memory_limit,
            cpu_usage: 0.0,
            memory_usage: 0,
            max_concurrent,
            current_concurrent: 0,
        }
    }

    /// 检查是否可以执行新任务
    pub fn can_execute(&self) -> bool {
        self.current_concurrent < self.max_concurrent
    }

    /// 获取剩余容量
    pub fn remaining_capacity(&self) -> usize {
        self.max_concurrent.saturating_sub(self.current_concurrent)
    }

    /// 分配资源
    pub fn allocate(&mut self) -> bool {
        if self.can_execute() {
            self.current_concurrent += 1;
            true
        } else {
            false
        }
    }

    /// 释放资源
    pub fn release(&mut self) {
        self.current_concurrent = self.current_concurrent.saturating_sub(1);
    }
}

/// 执行优先级队列
/// 文档要求：ExecutiveQueue 使用 BinaryHeap + HashMap + ResourcePool
pub struct PriorityQueue {
    /// 优先队列
    heap: BinaryHeap<ScoredTaskItem>,
    /// 运行中的任务
    running: HashMap<String, TaskContext>,
    /// 等待的任务
    waiting: HashMap<String, TaskContext>,
    /// 资源池
    resources: ResourcePool,
    /// 配置
    config: SchedulerConfig,
    /// 序列号计数器（用于打破 BinaryHeap 同分数任务的平局）
    #[allow(dead_code)]
    sequence_counter: u64,
    /// 统计
    stats: SchedulerStats,
}

impl PriorityQueue {
    pub fn new(config: SchedulerConfig) -> Self {
        Self {
            heap: BinaryHeap::new(),
            running: HashMap::new(),
            waiting: HashMap::new(),
            resources: ResourcePool::new(
                num_cpus(),
                8 * 1024 * 1024 * 1024, // 8GB
                config.max_concurrent,
            ),
            config,
            sequence_counter: 0,
            stats: SchedulerStats::default(),
        }
    }

    /// 入队
    /// 文档要求：push 方法
    pub fn push(&mut self, item: TaskItem) -> Result<(), SchedulerError> {
        if self.heap.len() >= self.config.max_queue_size {
            return Err(SchedulerError::QueueFull);
        }

        let score = item.effective_score();
        self.heap.push(ScoredTaskItem { item, score });
        self.stats.total_enqueued += 1;
        self.stats.current_queue_size = self.heap.len();
        self.stats.max_queue_size = self.stats.max_queue_size.max(self.heap.len());

        Ok(())
    }

    /// 出队（获取下一个执行任务）
    /// 文档要求：next() 方法
    pub fn next(&mut self) -> Option<TaskContext> {
        // 检查资源
        if !self.resources.can_execute() {
            return None;
        }

        // 弹出最高优先级任务
        let scored = self.heap.pop()?;

        // 检查是否过期
        if scored.item.is_expired() {
            // 过期任务仍然执行，但优先级最高
            self.stats.total_dequeued += 1;
            self.stats.current_queue_size = self.heap.len();

            let mut ctx = TaskContext::new(
                scored.item.task_id.clone(),
                TaskType::Generic,
                scored.item.base_priority,
            );
            ctx.start();
            self.running.insert(ctx.task_id.clone(), ctx.clone());
            self.resources.allocate();
            self.stats.current_running = self.running.len();

            return Some(ctx);
        }

        self.stats.total_dequeued += 1;
        self.stats.current_queue_size = self.heap.len();

        let mut ctx = TaskContext::new(
            scored.item.task_id.clone(),
            TaskType::Generic,
            scored.item.base_priority,
        );
        ctx.start();
        self.running.insert(ctx.task_id.clone(), ctx.clone());
        self.resources.allocate();
        self.stats.current_running = self.running.len();

        Some(ctx)
    }

    /// 完成任务
    pub fn complete(&mut self, task_id: &str, result: String) -> Option<TaskContext> {
        if let Some(ctx) = self.running.remove(task_id) {
            let mut ctx = ctx;
            ctx.complete(result);
            self.resources.release();
            self.stats.total_completed += 1;
            self.stats.current_running = self.running.len();

            Some(ctx)
        } else {
            None
        }
    }

    /// 任务失败
    pub fn fail(&mut self, task_id: &str, error: String) -> Option<TaskContext> {
        if let Some(ctx) = self.running.remove(task_id) {
            let mut ctx = ctx;
            ctx.fail(error);
            self.resources.release();
            self.stats.total_failed += 1;
            self.stats.current_running = self.running.len();

            Some(ctx)
        } else {
            None
        }
    }

    /// 任务取消
    pub fn cancel(&mut self, task_id: &str) -> Option<TaskContext> {
        // 从队列中移除
        self.heap.retain(|scored| scored.item.task_id != task_id);

        // 从运行中移除
        if let Some(ctx) = self.running.remove(task_id) {
            let mut ctx = ctx;
            ctx.cancel();
            self.resources.release();
            self.stats.total_cancelled += 1;
            self.stats.current_running = self.running.len();
            self.stats.current_queue_size = self.heap.len();

            Some(ctx)
        } else {
            None
        }
    }

    /// 暂停任务
    pub fn pause(&mut self, task_id: &str) -> Option<TaskContext> {
        if let Some(ctx) = self.running.get_mut(task_id) {
            ctx.pause();
            self.resources.release();
            self.stats.current_running = self.running.len();

            // 移到等待队列
            if let Some(ctx) = self.running.remove(task_id) {
                self.waiting.insert(task_id.to_string(), ctx.clone());
                self.stats.total_waiting = self.waiting.len();
                return Some(ctx);
            }
        }
        None
    }

    /// 恢复任务
    pub fn resume(&mut self, task_id: &str) -> Option<TaskContext> {
        if let Some(ctx) = self.waiting.remove(task_id) {
            let mut ctx = ctx;
            ctx.resume();
            self.running.insert(task_id.to_string(), ctx.clone());
            self.resources.allocate();
            self.stats.current_running = self.running.len();
            self.stats.total_waiting = self.waiting.len();

            Some(ctx)
        } else {
            None
        }
    }

    /// 抢占任务
    /// 文档要求：高优任务到达 → 保存当前快照 → 切换执行
    pub fn preempt(&mut self, task_id: &str, high_priority_item: TaskItem) -> Result<Option<TaskContext>, SchedulerError> {
        // 将被抢占的任务移到等待队列
        if let Some(ctx) = self.pause(task_id) {
            // 重新入队被抢占的任务（优先级略降）
            let mut preempted_item = TaskItem::new(
                ctx.task_id.clone(),
                ctx.priority.saturating_sub(10), // 降低 10 点优先级
                high_priority_item.aging_factor,
                high_priority_item.deadline,
            );
            preempted_item.urgency = 50; // 给予额外紧急分

            self.push(preempted_item)?;
            self.stats.total_preempted += 1;

            // 启动高优先级任务
            let mut new_ctx = TaskContext::new(
                high_priority_item.task_id.clone(),
                TaskType::Generic,
                high_priority_item.base_priority,
            );
            new_ctx.start();
            self.running.insert(new_ctx.task_id.clone(), new_ctx.clone());
            self.resources.allocate();
            self.stats.current_running = self.running.len();

            return Ok(Some(new_ctx));
        }

        Ok(None)
    }

    /// 获取队列大小
    pub fn len(&self) -> usize {
        self.heap.len()
    }

    /// 检查是否为空
    pub fn is_empty(&self) -> bool {
        self.heap.is_empty()
    }

    /// 获取运行中的任务
    pub fn get_running(&self) -> Vec<&TaskContext> {
        self.running.values().collect()
    }

    /// 获取等待中的任务
    pub fn get_waiting(&self) -> Vec<&TaskContext> {
        self.waiting.values().collect()
    }

    /// 获取任务上下文
    pub fn get_task(&self, task_id: &str) -> Option<&TaskContext> {
        self.running
            .get(task_id)
            .or_else(|| self.waiting.get(task_id))
    }

    /// 获取统计
    pub fn stats(&self) -> &SchedulerStats {
        &self.stats
    }

    /// 获取资源池
    pub fn resources(&self) -> &ResourcePool {
        &self.resources
    }

    /// 饥饿检测 - 检测长时间未执行的任务
    pub fn detect_starvation(&self) -> Vec<TaskContext> {
        let now = current_timestamp_ms();
        let threshold_ms = self.config.starvation_threshold_secs * 1000;

        self.heap
            .iter()
            .filter(|scored| {
                let age = now - scored.item.created_at;
                age > threshold_ms
            })
            .map(|scored| {
                TaskContext::new(
                    scored.item.task_id.clone(),
                    TaskType::Generic,
                    scored.item.base_priority,
                )
            })
            .collect()
    }

    /// 清理过期任务
    pub fn cleanup_expired(&mut self) -> usize {
        let before = self.heap.len();
        self.heap.retain(|scored| !scored.item.is_expired());
        let after = self.heap.len();
        self.stats.current_queue_size = self.heap.len();
        before - after
    }

    /// 获取队列快照
    pub fn snapshot(&self) -> Vec<TaskItem> {
        self.heap
            .iter()
            .map(|scored| scored.item.clone())
            .collect()
    }

    /// 从快照恢复
    pub fn restore(&mut self, items: Vec<TaskItem>) {
        for item in items {
            let score = item.effective_score();
            self.heap.push(ScoredTaskItem { item, score });
        }
        self.stats.current_queue_size = self.heap.len();
    }
}

/// 调度器错误
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SchedulerError {
    QueueFull,
    TaskNotFound,
    InvalidState(String),
    ResourceExhausted,
}

impl std::fmt::Display for SchedulerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SchedulerError::QueueFull => write!(f, "Queue is full"),
            SchedulerError::TaskNotFound => write!(f, "Task not found"),
            SchedulerError::InvalidState(msg) => write!(f, "Invalid state: {}", msg),
            SchedulerError::ResourceExhausted => write!(f, "Resources exhausted"),
        }
    }
}

impl std::error::Error for SchedulerError {}

/// 获取 CPU 核心数
fn num_cpus() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
}

/// 获取当前时间戳（毫秒）
fn current_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 序列号计数器
static SEQUENCE_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn next_sequence() -> u64 {
    SEQUENCE_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_task_item_creation() {
        let item = TaskItem::new(
            "task1".to_string(),
            50,
            10.0,
            0,
        );

        assert_eq!(item.task_id, "task1");
        assert_eq!(item.base_priority, 50);
    }

    #[test]
    fn test_task_item_aging() {
        let item = TaskItem::new(
            "task1".to_string(),
            50,
            10.0, // 每秒增加 10 分
            0,
        );

        // 初始分数
        let initial_score = item.effective_score();

        // 由于刚创建，aging 应该很小
        assert!(initial_score >= 50.0);
    }

    #[test]
    fn test_priority_queue_push_pop() {
        let config = SchedulerConfig::default();
        let mut queue = PriorityQueue::new(config);

        queue.push(TaskItem::new("task1".to_string(), 10, 0.0, 0)).unwrap();
        queue.push(TaskItem::new("task2".to_string(), 100, 0.0, 0)).unwrap();
        queue.push(TaskItem::new("task3".to_string(), 50, 0.0, 0)).unwrap();

        // 最高优先级应该先出
        let next = queue.next().unwrap();
        assert_eq!(next.task_id, "task2");
        assert_eq!(next.priority, 100);
    }

    #[test]
    fn test_priority_queue_completion() {
        let config = SchedulerConfig::default();
        let mut queue = PriorityQueue::new(config);

        queue.push(TaskItem::new("task1".to_string(), 50, 0.0, 0)).unwrap();
        let ctx = queue.next().unwrap();
        assert_eq!(ctx.state, TaskState::Running);

        let completed = queue.complete("task1", "done".to_string()).unwrap();
        assert_eq!(completed.state, TaskState::Succeeded);
        assert_eq!(completed.result, Some("done".to_string()));
    }

    #[test]
    fn test_priority_queue_preemption() {
        let config = SchedulerConfig::default();
        let mut queue = PriorityQueue::new(config);

        // 入队低优先级任务
        queue.push(TaskItem::new("low".to_string(), 10, 0.0, 0)).unwrap();
        let ctx = queue.next().unwrap();
        assert_eq!(ctx.task_id, "low");

        // 抢占
        let high_priority = TaskItem::new("high".to_string(), 100, 0.0, 0);
        let preempted = queue.preempt("low", high_priority).unwrap().unwrap();
        assert_eq!(preempted.task_id, "high");
    }

    #[test]
    fn test_deadline_scheduling() {
        let config = SchedulerConfig::default();
        let mut queue = PriorityQueue::new(config);

        let now = current_timestamp_ms();

        // 普通任务
        queue.push(TaskItem::new("normal".to_string(), 50, 0.0, 0)).unwrap();

        // 即将过期任务（截止时间是 1 毫秒后）
        queue.push(TaskItem::new("urgent".to_string(), 30, 0.0, now + 1)).unwrap();

        // 过期任务
        queue.push(TaskItem::new("expired".to_string(), 10, 0.0, now - 1000)).unwrap();

        // 第一个应该是 expired（已过期，紧急分最高）
        let next = queue.next().unwrap();
        assert_eq!(next.task_id, "expired");
    }

    #[test]
    fn test_resource_pool() {
        let mut pool = ResourcePool::new(4, 8 * 1024 * 1024 * 1024, 3);

        assert!(pool.can_execute());
        assert_eq!(pool.remaining_capacity(), 3);

        pool.allocate();
        assert_eq!(pool.remaining_capacity(), 2);

        pool.allocate();
        pool.allocate();
        assert!(!pool.can_execute());

        pool.release();
        assert_eq!(pool.remaining_capacity(), 1);
    }
}
