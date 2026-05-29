// ─────────────────────────────────────────────────────────────────
// SoloForge Rust Core: Interrupt System
// Path: rust_core/src/interrupt.rs
// Description: 中断系统 - 任务运行到一半用户插话时必须支持中断
// 文档要求：pause, resume, cancel, preempt 四种中断类型
// ─────────────────────────────────────────────────────────────────

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

/// 中断动作枚举
/// 文档要求：四种中断类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum InterruptAction {
    /// 暂停当前任务，可恢复
    Pause,
    /// 恢复已暂停的任务
    Resume,
    /// 取消当前任务
    Cancel,
    /// 更高优先级任务抢占
    Preempt,
}

impl InterruptAction {
    pub fn name(&self) -> &'static str {
        match self {
            InterruptAction::Pause => "pause",
            InterruptAction::Resume => "resume",
            InterruptAction::Cancel => "cancel",
            InterruptAction::Preempt => "preempt",
        }
    }
}

/// 中断优先级
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum InterruptPriority {
    Low,
    Medium,
    High,
    Critical,
}

impl InterruptPriority {
    pub fn level(&self) -> u32 {
        match self {
            InterruptPriority::Low => 1,
            InterruptPriority::Medium => 2,
            InterruptPriority::High => 3,
            InterruptPriority::Critical => 4,
        }
    }
}

/// 中断状态
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum InterruptStatus {
    /// 请求已创建
    Requested,
    /// 正在处理
    Processing,
    /// 已处理
    Processed,
    /// 已完成
    Completed,
    /// 失败
    Failed,
    /// 忽略（任务已完成）
    Ignored,
}

impl InterruptStatus {
    pub fn name(&self) -> &'static str {
        match self {
            InterruptStatus::Requested => "requested",
            InterruptStatus::Processing => "processing",
            InterruptStatus::Processed => "processed",
            InterruptStatus::Completed => "completed",
            InterruptStatus::Failed => "failed",
            InterruptStatus::Ignored => "ignored",
        }
    }
}

/// 中断请求
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Interrupt {
    /// 中断 ID
    pub id: String,
    /// 被中断的任务 ID
    pub task_id: String,
    /// 中断动作
    pub action: InterruptAction,
    /// 中断原因
    pub reason: String,
    /// 优先级
    pub priority: InterruptPriority,
    /// 状态
    pub status: InterruptStatus,
    /// 创建时间戳
    pub created_at: u64,
    /// 处理时间戳
    pub processed_at: Option<u64>,
    /// 完成时间戳
    pub completed_at: Option<u64>,
    /// 执行者（谁发起的中断）
    pub source: InterruptSource,
    /// 原始优先级任务的 ID（用于 preempt）
    pub preempted_by: Option<String>,
    /// 错误信息
    pub error: Option<String>,
}

impl Interrupt {
    /// 创建新的中断请求
    pub fn new(
        task_id: String,
        action: InterruptAction,
        reason: String,
        priority: InterruptPriority,
        source: InterruptSource,
    ) -> Self {
        Self {
            id: generate_interrupt_id(),
            task_id,
            action,
            reason,
            priority,
            status: InterruptStatus::Requested,
            created_at: current_timestamp_ms(),
            processed_at: None,
            completed_at: None,
            source,
            preempted_by: None,
            error: None,
        }
    }

    /// 创建抢占中断
    pub fn preempt(task_id: String, high_priority_task_id: String, source: InterruptSource) -> Self {
        let mut interrupt = Self::new(
            task_id,
            InterruptAction::Preempt,
            format!("Preempted by high priority task: {}", high_priority_task_id),
            InterruptPriority::Critical,
            source,
        );
        interrupt.preempted_by = Some(high_priority_task_id);
        interrupt
    }

    /// 处理中断
    pub fn process(&mut self) {
        self.status = InterruptStatus::Processing;
        self.processed_at = Some(current_timestamp_ms());
    }

    /// 完成中断
    pub fn complete(&mut self) {
        self.status = InterruptStatus::Completed;
        self.completed_at = Some(current_timestamp_ms());
    }

    /// 标记失败
    pub fn fail(&mut self, error: String) {
        self.status = InterruptStatus::Failed;
        self.error = Some(error);
        self.completed_at = Some(current_timestamp_ms());
    }

    /// 忽略中断
    pub fn ignore(&mut self) {
        self.status = InterruptStatus::Ignored;
        self.completed_at = Some(current_timestamp_ms());
    }

    /// 获取持续时间（毫秒）
    pub fn duration_ms(&self) -> Option<u64> {
        self.completed_at.map(|end| end - self.created_at)
    }
}

/// 中断源
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum InterruptSource {
    User,
    UI,
    System,
    Scheduler,
    Governor,
}

impl InterruptSource {
    pub fn name(&self) -> &'static str {
        match self {
            InterruptSource::User => "user",
            InterruptSource::UI => "ui",
            InterruptSource::System => "system",
            InterruptSource::Scheduler => "scheduler",
            InterruptSource::Governor => "governor",
        }
    }
}

/// 中断处理器
pub struct InterruptHandler {
    /// 待处理的中断队列（按优先级排序）
    pending_interrupts: Vec<Interrupt>,
    /// 正在处理的中断
    processing: HashMap<String, Interrupt>,
    /// 已完成的中断历史
    completed_history: Vec<Interrupt>,
    /// 中断统计
    stats: InterruptStats,
}

impl InterruptHandler {
    /// 创建新的中断处理器
    pub fn new() -> Self {
        Self {
            pending_interrupts: Vec::new(),
            processing: HashMap::new(),
            completed_history: Vec::new(),
            stats: InterruptStats::default(),
        }
    }

    /// 请求中断
    pub fn request_interrupt(&mut self, interrupt: Interrupt) {
        // 按优先级插入（高优先级在前）
        let pos = self
            .pending_interrupts
            .binary_search_by(|existing| {
                existing.priority.level().cmp(&interrupt.priority.level()).reverse()
            })
            .unwrap_or_else(|e| e);

        self.pending_interrupts.insert(pos, interrupt);
        self.stats.total_requested += 1;
    }

    /// 获取下一个待处理的中断
    pub fn next_interrupt(&mut self) -> Option<Interrupt> {
        if self.pending_interrupts.is_empty() {
            return None;
        }

        // 按优先级获取最高优先级的中断
        let interrupt = self.pending_interrupts.remove(0);
        self.processing.insert(interrupt.id.clone(), interrupt.clone());
        Some(interrupt)
    }

    /// 处理中断
    pub fn handle_interrupt(&mut self, interrupt_id: &str) -> Option<&Interrupt> {
        if let Some(interrupt) = self.processing.get_mut(interrupt_id) {
            interrupt.process();
            self.stats.total_processed += 1;
            Some(interrupt)
        } else {
            None
        }
    }

    /// 完成中断
    pub fn complete_interrupt(&mut self, interrupt_id: &str, success: bool) {
        if let Some(interrupt) = self.processing.remove(interrupt_id) {
            let mut completed = interrupt;
            if success {
                completed.complete();
                self.stats.total_completed += 1;
            } else {
                completed.fail("Interrupt handling failed".to_string());
                self.stats.total_failed += 1;
            }
            self.completed_history.push(completed);
        }
    }

    /// 忽略中断
    pub fn ignore_interrupt(&mut self, interrupt_id: &str) {
        if let Some(mut interrupt) = self.processing.remove(interrupt_id) {
            interrupt.ignore();
            self.stats.total_ignored += 1;
            self.completed_history.push(interrupt);
        } else if let Some(pos) = self.pending_interrupts.iter().position(|i| i.id == interrupt_id) {
            let mut interrupt = self.pending_interrupts.remove(pos);
            interrupt.ignore();
            self.stats.total_ignored += 1;
            self.completed_history.push(interrupt);
        }
    }

    /// 取消待处理的中断
    pub fn cancel_pending(&mut self, task_id: &str) -> usize {
        let original_len = self.pending_interrupts.len();
        self.pending_interrupts.retain(|i| i.task_id != task_id);
        original_len - self.pending_interrupts.len()
    }

    /// 获取待处理的中断数量
    pub fn pending_count(&self) -> usize {
        self.pending_interrupts.len()
    }

    /// 获取正在处理的中断数量
    pub fn processing_count(&self) -> usize {
        self.processing.len()
    }

    /// 检查任务是否有待处理的中断
    pub fn has_pending_interrupt(&self, task_id: &str) -> bool {
        self.pending_interrupts.iter().any(|i| i.task_id == task_id)
    }

    /// 获取任务的所有中断历史
    pub fn get_history_for_task(&self, task_id: &str) -> Vec<&Interrupt> {
        self.completed_history
            .iter()
            .filter(|i| i.task_id == task_id)
            .collect()
    }

    /// 获取统计信息
    pub fn get_stats(&self) -> &InterruptStats {
        &self.stats
    }

    /// 获取最近的中断历史
    pub fn recent_history(&self, limit: usize) -> Vec<&Interrupt> {
        self.completed_history
            .iter()
            .rev()
            .take(limit)
            .collect()
    }

    /// 清理历史记录
    pub fn clear_history(&mut self, keep_count: usize) {
        if self.completed_history.len() > keep_count {
            self.completed_history = self.completed_history
                .split_off(self.completed_history.len() - keep_count);
        }
    }
}

impl Default for InterruptHandler {
    fn default() -> Self {
        Self::new()
    }
}

/// 中断统计
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct InterruptStats {
    pub total_requested: usize,
    pub total_processed: usize,
    pub total_completed: usize,
    pub total_failed: usize,
    pub total_ignored: usize,
}

/// 中断决策
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InterruptDecision {
    pub should_interrupt: bool,
    pub action: InterruptAction,
    pub reason: String,
    pub preemption_required: bool,
}

impl InterruptDecision {
    pub fn interrupt(action: InterruptAction, reason: &str) -> Self {
        Self {
            should_interrupt: true,
            action,
            reason: reason.to_string(),
            preemption_required: matches!(action, InterruptAction::Preempt),
        }
    }

    pub fn no_interrupt(reason: &str) -> Self {
        Self {
            should_interrupt: false,
            action: InterruptAction::Cancel, // 占位值
            reason: reason.to_string(),
            preemption_required: false,
        }
    }
}

/// 中断评估器
pub struct InterruptEvaluator {
    /// 系统负载阈值
    load_warning_threshold: f64,
    load_critical_threshold: f64,
}

impl InterruptEvaluator {
    pub fn new() -> Self {
        Self {
            load_warning_threshold: 0.7,
            load_critical_threshold: 0.9,
        }
    }

    /// 评估是否需要中断
    pub fn evaluate(
        &self,
        current_task_priority: u32,
        new_task_priority: u32,
        current_load: f64,
    ) -> InterruptDecision {
        // 高负载情况
        if current_load >= self.load_critical_threshold {
            return InterruptDecision::interrupt(
                InterruptAction::Preempt,
                "System overload, preempting for critical task",
            );
        }

        // 新任务优先级显著高于当前任务
        if new_task_priority > current_task_priority {
            let priority_diff = new_task_priority - current_task_priority;
            if priority_diff >= 20 {
                return InterruptDecision::interrupt(
                    InterruptAction::Preempt,
                    "Higher priority task arrived",
                );
            } else if priority_diff >= 10 {
                return InterruptDecision::interrupt(
                    InterruptAction::Pause,
                    "Higher priority task waiting",
                );
            }
        }

        // 用户请求取消
        // 这种情况下需要用户通过 request_interrupt 方法传入

        InterruptDecision::no_interrupt("No interrupt required")
    }

    /// 设置负载阈值
    pub fn set_load_thresholds(&mut self, warning: f64, critical: f64) {
        self.load_warning_threshold = warning;
        self.load_critical_threshold = critical;
    }
}

impl Default for InterruptEvaluator {
    fn default() -> Self {
        Self::new()
    }
}

/// 生成中断 ID
fn generate_interrupt_id() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("intr_{}", timestamp)
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
    fn test_interrupt_creation() {
        let interrupt = Interrupt::new(
            "task1".to_string(),
            InterruptAction::Cancel,
            "User requested".to_string(),
            InterruptPriority::High,
            InterruptSource::User,
        );

        assert_eq!(interrupt.task_id, "task1");
        assert_eq!(interrupt.action, InterruptAction::Cancel);
        assert_eq!(interrupt.status, InterruptStatus::Requested);
    }

    #[test]
    fn test_preempt_interrupt() {
        let interrupt = Interrupt::preempt("task1".to_string(), "task2".to_string(), InterruptSource::Scheduler);

        assert_eq!(interrupt.action, InterruptAction::Preempt);
        assert_eq!(interrupt.preempted_by, Some("task2".to_string()));
    }

    #[test]
    fn test_interrupt_handler_request() {
        let mut handler = InterruptHandler::new();

        handler.request_interrupt(Interrupt::new(
            "task1".to_string(),
            InterruptAction::Pause,
            "Test".to_string(),
            InterruptPriority::Medium,
            InterruptSource::System,
        ));

        assert_eq!(handler.pending_count(), 1);
    }

    #[test]
    fn test_interrupt_priority_order() {
        let mut handler = InterruptHandler::new();

        handler.request_interrupt(Interrupt::new(
            "task1".to_string(),
            InterruptAction::Cancel,
            "Low priority".to_string(),
            InterruptPriority::Low,
            InterruptSource::User,
        ));

        handler.request_interrupt(Interrupt::new(
            "task2".to_string(),
            InterruptAction::Cancel,
            "Critical".to_string(),
            InterruptPriority::Critical,
            InterruptSource::User,
        ));

        handler.request_interrupt(Interrupt::new(
            "task3".to_string(),
            InterruptAction::Pause,
            "High priority".to_string(),
            InterruptPriority::High,
            InterruptSource::User,
        ));

        let next = handler.next_interrupt().unwrap();
        assert_eq!(next.task_id, "task2"); // Critical 应该先处理
    }

    #[test]
    fn test_interrupt_evaluator_overload() {
        let evaluator = InterruptEvaluator::new();

        let decision = evaluator.evaluate(50, 80, 0.95);
        assert!(decision.should_interrupt);
        assert_eq!(decision.action, InterruptAction::Preempt);
    }

    #[test]
    fn test_interrupt_evaluator_no_interrupt() {
        let evaluator = InterruptEvaluator::new();

        let decision = evaluator.evaluate(50, 45, 0.5);
        assert!(!decision.should_interrupt);
    }
}
