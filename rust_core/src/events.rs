// ─────────────────────────────────────────────────────────────────
// SoloForge Rust Core: Runtime Events Enum
// Path: rust_core/src/events.rs
// Description: 统一事件枚举 - 禁止使用字符串事件
// 文档要求：禁止字符串事件，否则后期地狱
// ─────────────────────────────────────────────────────────────────

use serde::{Deserialize, Serialize};

/// 统一运行时事件枚举
/// 文档要求：禁止字符串事件 - 必须使用枚举类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum RuntimeEvent {
    // Intent 相关
    IntentCreated,
    IntentParsed,
    IntentClassification,

    // Goal 相关
    GoalCreated,
    GoalDecomposed,
    GoalCompleted,

    // Task 相关
    TaskCreated,
    TaskSubmitted,
    TaskQueued,
    TaskDequeued,
    TaskStarted,
    TaskPaused,
    TaskResumed,
    TaskWaiting,
    TaskCompleted,
    TaskFailed,
    TaskCancelled,
    TaskTimedOut,

    // Memory 相关
    MemoryAdded,
    MemoryRetrieved,
    MemoryConsolidated,
    MemoryDecayed,

    // Reflection 相关
    ReflectionCreated,
    ReflectionAnalyzed,

    // Decision 相关
    DecisionMade,
    DecisionEvaluated,
    DecisionRolledBack,

    // Planning 相关
    PlanningStarted,
    PlanningCompleted,
    PlanGenerated,

    // Attention 相关
    AttentionShifted,
    AttentionFocused,

    // Governor 相关
    GovernorBudgetExceeded,
    GovernorLoadWarning,
    GovernorLoadCritical,
    GovernorLoadOverload,

    // Scheduler 相关
    SchedulerEnqueued,
    SchedulerDequeued,
    SchedulerPreempted,
    SchedulerInterrupted,

    // Snapshot 相关
    SnapshotSaved,
    SnapshotRestored,
    SnapshotFailed,

    // System 相关
    SystemBoot,
    SystemShutdown,
    SystemError,
    SystemRecovered,
}

impl RuntimeEvent {
    /// 获取事件名称（用于日志和调试）
    pub fn name(&self) -> &'static str {
        match self {
            RuntimeEvent::IntentCreated => "IntentCreated",
            RuntimeEvent::IntentParsed => "IntentParsed",
            RuntimeEvent::IntentClassification => "IntentClassification",
            RuntimeEvent::GoalCreated => "GoalCreated",
            RuntimeEvent::GoalDecomposed => "GoalDecomposed",
            RuntimeEvent::GoalCompleted => "GoalCompleted",
            RuntimeEvent::TaskCreated => "TaskCreated",
            RuntimeEvent::TaskSubmitted => "TaskSubmitted",
            RuntimeEvent::TaskQueued => "TaskQueued",
            RuntimeEvent::TaskDequeued => "TaskDequeued",
            RuntimeEvent::TaskStarted => "TaskStarted",
            RuntimeEvent::TaskPaused => "TaskPaused",
            RuntimeEvent::TaskResumed => "TaskResumed",
            RuntimeEvent::TaskWaiting => "TaskWaiting",
            RuntimeEvent::TaskCompleted => "TaskCompleted",
            RuntimeEvent::TaskFailed => "TaskFailed",
            RuntimeEvent::TaskCancelled => "TaskCancelled",
            RuntimeEvent::TaskTimedOut => "TaskTimedOut",
            RuntimeEvent::MemoryAdded => "MemoryAdded",
            RuntimeEvent::MemoryRetrieved => "MemoryRetrieved",
            RuntimeEvent::MemoryConsolidated => "MemoryConsolidated",
            RuntimeEvent::MemoryDecayed => "MemoryDecayed",
            RuntimeEvent::ReflectionCreated => "ReflectionCreated",
            RuntimeEvent::ReflectionAnalyzed => "ReflectionAnalyzed",
            RuntimeEvent::DecisionMade => "DecisionMade",
            RuntimeEvent::DecisionEvaluated => "DecisionEvaluated",
            RuntimeEvent::DecisionRolledBack => "DecisionRolledBack",
            RuntimeEvent::PlanningStarted => "PlanningStarted",
            RuntimeEvent::PlanningCompleted => "PlanningCompleted",
            RuntimeEvent::PlanGenerated => "PlanGenerated",
            RuntimeEvent::AttentionShifted => "AttentionShifted",
            RuntimeEvent::AttentionFocused => "AttentionFocused",
            RuntimeEvent::GovernorBudgetExceeded => "GovernorBudgetExceeded",
            RuntimeEvent::GovernorLoadWarning => "GovernorLoadWarning",
            RuntimeEvent::GovernorLoadCritical => "GovernorLoadCritical",
            RuntimeEvent::GovernorLoadOverload => "GovernorLoadOverload",
            RuntimeEvent::SchedulerEnqueued => "SchedulerEnqueued",
            RuntimeEvent::SchedulerDequeued => "SchedulerDequeued",
            RuntimeEvent::SchedulerPreempted => "SchedulerPreempted",
            RuntimeEvent::SchedulerInterrupted => "SchedulerInterrupted",
            RuntimeEvent::SnapshotSaved => "SnapshotSaved",
            RuntimeEvent::SnapshotRestored => "SnapshotRestored",
            RuntimeEvent::SnapshotFailed => "SnapshotFailed",
            RuntimeEvent::SystemBoot => "SystemBoot",
            RuntimeEvent::SystemShutdown => "SystemShutdown",
            RuntimeEvent::SystemError => "SystemError",
            RuntimeEvent::SystemRecovered => "SystemRecovered",
        }
    }

    /// 获取事件分类
    pub fn category(&self) -> EventCategory {
        match self {
            RuntimeEvent::IntentCreated | RuntimeEvent::IntentParsed | RuntimeEvent::IntentClassification => {
                EventCategory::Intent
            }
            RuntimeEvent::GoalCreated | RuntimeEvent::GoalDecomposed | RuntimeEvent::GoalCompleted => {
                EventCategory::Goal
            }
            RuntimeEvent::TaskCreated | RuntimeEvent::TaskSubmitted | RuntimeEvent::TaskQueued
            | RuntimeEvent::TaskDequeued | RuntimeEvent::TaskStarted | RuntimeEvent::TaskPaused
            | RuntimeEvent::TaskResumed | RuntimeEvent::TaskWaiting | RuntimeEvent::TaskCompleted
            | RuntimeEvent::TaskFailed | RuntimeEvent::TaskCancelled | RuntimeEvent::TaskTimedOut => {
                EventCategory::Task
            }
            RuntimeEvent::MemoryAdded | RuntimeEvent::MemoryRetrieved
            | RuntimeEvent::MemoryConsolidated | RuntimeEvent::MemoryDecayed => {
                EventCategory::Memory
            }
            RuntimeEvent::ReflectionCreated | RuntimeEvent::ReflectionAnalyzed => {
                EventCategory::Reflection
            }
            RuntimeEvent::DecisionMade | RuntimeEvent::DecisionEvaluated | RuntimeEvent::DecisionRolledBack => {
                EventCategory::Decision
            }
            RuntimeEvent::PlanningStarted | RuntimeEvent::PlanningCompleted | RuntimeEvent::PlanGenerated => {
                EventCategory::Planning
            }
            RuntimeEvent::AttentionShifted | RuntimeEvent::AttentionFocused => {
                EventCategory::Attention
            }
            RuntimeEvent::GovernorBudgetExceeded | RuntimeEvent::GovernorLoadWarning
            | RuntimeEvent::GovernorLoadCritical | RuntimeEvent::GovernorLoadOverload => {
                EventCategory::Governor
            }
            RuntimeEvent::SchedulerEnqueued | RuntimeEvent::SchedulerDequeued
            | RuntimeEvent::SchedulerPreempted | RuntimeEvent::SchedulerInterrupted => {
                EventCategory::Scheduler
            }
            RuntimeEvent::SnapshotSaved | RuntimeEvent::SnapshotRestored | RuntimeEvent::SnapshotFailed => {
                EventCategory::Snapshot
            }
            RuntimeEvent::SystemBoot | RuntimeEvent::SystemShutdown
            | RuntimeEvent::SystemError | RuntimeEvent::SystemRecovered => {
                EventCategory::System
            }
        }
    }
}

/// 事件分类
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum EventCategory {
    Intent,
    Goal,
    Task,
    Memory,
    Reflection,
    Decision,
    Planning,
    Attention,
    Governor,
    Scheduler,
    Snapshot,
    System,
}

/// 事件级别
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum EventLevel {
    Debug,
    Info,
    Warning,
    Error,
    Critical,
}

impl RuntimeEvent {
    pub fn level(&self) -> EventLevel {
        match self {
            RuntimeEvent::SystemError | RuntimeEvent::GovernorLoadOverload | RuntimeEvent::SnapshotFailed => {
                EventLevel::Critical
            }
            RuntimeEvent::TaskFailed | RuntimeEvent::TaskTimedOut | RuntimeEvent::GovernorLoadCritical => {
                EventLevel::Error
            }
            RuntimeEvent::TaskPaused | RuntimeEvent::GovernorLoadWarning
            | RuntimeEvent::GovernorBudgetExceeded | RuntimeEvent::SchedulerPreempted => {
                EventLevel::Warning
            }
            RuntimeEvent::SystemBoot | RuntimeEvent::GoalCompleted | RuntimeEvent::TaskCompleted
            | RuntimeEvent::MemoryAdded | RuntimeEvent::SnapshotSaved => {
                EventLevel::Info
            }
            _ => EventLevel::Debug,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_event_name() {
        assert_eq!(RuntimeEvent::TaskCreated.name(), "TaskCreated");
        assert_eq!(RuntimeEvent::MemoryAdded.name(), "MemoryAdded");
        assert_eq!(RuntimeEvent::SystemBoot.name(), "SystemBoot");
    }

    #[test]
    fn test_event_category() {
        assert_eq!(RuntimeEvent::TaskCreated.category(), EventCategory::Task);
        assert_eq!(RuntimeEvent::MemoryAdded.category(), EventCategory::Memory);
    }

    #[test]
    fn test_event_level() {
        assert_eq!(RuntimeEvent::SystemError.level(), EventLevel::Critical);
        assert_eq!(RuntimeEvent::TaskCompleted.level(), EventLevel::Info);
    }
}
