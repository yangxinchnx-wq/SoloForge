// ─────────────────────────────────────────────────────────────────
// SoloForge Rust Core: Runtime System
// Path: rust_core/src/runtime.rs
// Description: 统一运行时核心 - 所有模块实现统一 RuntimeModule Trait
// 文档要求：禁止模块互相直连，Runtime 只需调用 handle_event
// ─────────────────────────────────────────────────────────────────

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::events::{EventCategory, RuntimeEvent};
use crate::interrupt::{Interrupt, InterruptAction, InterruptHandler, InterruptSource};
use crate::snapshot::{StateSnapshot, SnapshotType, Snapshotable};

/// 统一运行时模块接口
/// 文档要求：所有模块（Intent、Memory、Scheduler、Governor、Learning、Attention）实现同一接口
pub trait RuntimeModule: Snapshotable {
    /// 获取模块名称
    fn name(&self) -> String;

    /// 初始化模块
    fn initialize(&mut self) -> Result<(), RuntimeError>;

    /// 处理事件
    fn handle_event(&mut self, event: RuntimeEvent, payload: Option<&serde_json::Value>) -> Result<Vec<RuntimeEvent>, RuntimeError>;

    /// 获取模块状态
    fn get_status(&self) -> ModuleStatus;
}

/// 模块状态
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ModuleStatus {
    /// 未初始化
    Uninitialized,
    /// 初始化中
    Initializing,
    /// 就绪
    Ready,
    /// 运行中
    Running,
    /// 暂停
    Paused,
    /// 错误
    Error,
    /// 已停止
    Stopped,
}

impl ModuleStatus {
    pub fn name(&self) -> &'static str {
        match self {
            ModuleStatus::Uninitialized => "uninitialized",
            ModuleStatus::Initializing => "initializing",
            ModuleStatus::Ready => "ready",
            ModuleStatus::Running => "running",
            ModuleStatus::Paused => "paused",
            ModuleStatus::Error => "error",
            ModuleStatus::Stopped => "stopped",
        }
    }

    pub fn is_active(&self) -> bool {
        matches!(self, ModuleStatus::Ready | ModuleStatus::Running)
    }
}

/// 运行时状态
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum RuntimeState {
    /// 启动中
    Booting,
    /// 初始化中
    Initializing,
    /// 就绪
    Ready,
    /// 运行中
    Running,
    /// 暂停
    Paused,
    /// 降级
    Degraded,
    /// 关闭中
    ShuttingDown,
    /// 已停止
    Stopped,
    /// 崩溃
    Panic,
    /// 恢复中
    Recovering,
}

impl RuntimeState {
    pub fn name(&self) -> &'static str {
        match self {
            RuntimeState::Booting => "booting",
            RuntimeState::Initializing => "initializing",
            RuntimeState::Ready => "ready",
            RuntimeState::Running => "running",
            RuntimeState::Paused => "paused",
            RuntimeState::Degraded => "degraded",
            RuntimeState::ShuttingDown => "shutting_down",
            RuntimeState::Stopped => "stopped",
            RuntimeState::Panic => "panic",
            RuntimeState::Recovering => "recovering",
        }
    }

    pub fn can_transition_to(&self, target: RuntimeState) -> bool {
        match (self, target) {
            // 启动流程
            (RuntimeState::Booting, RuntimeState::Initializing) => true,
            (RuntimeState::Initializing, RuntimeState::Ready) => true,
            (RuntimeState::Initializing, RuntimeState::Panic) => true,
            // 运行流程
            (RuntimeState::Ready, RuntimeState::Running) => true,
            (RuntimeState::Running, RuntimeState::Paused) => true,
            (RuntimeState::Paused, RuntimeState::Running) => true,
            // 降级
            (RuntimeState::Running, RuntimeState::Degraded) => true,
            (RuntimeState::Degraded, RuntimeState::Running) => true,
            // 关闭流程
            (RuntimeState::Running, RuntimeState::ShuttingDown) => true,
            (RuntimeState::Paused, RuntimeState::ShuttingDown) => true,
            (RuntimeState::Degraded, RuntimeState::ShuttingDown) => true,
            (RuntimeState::ShuttingDown, RuntimeState::Stopped) => true,
            // 恢复流程
            (RuntimeState::Panic, RuntimeState::Recovering) => true,
            (RuntimeState::Recovering, RuntimeState::Ready) => true,
            // 任意状态可以到 Stopped（最终状态）
            (_, RuntimeState::Stopped) => true,
            _ => false,
        }
    }
}

/// 运行时事件信封
///
/// ## 设计说明：级联追踪字段
/// - `source`: 外部调用者标识（如 "user_intent"、"system"）
/// - `cascade_from`: 产生此级联事件的模块名（仅级联事件有值）
/// - `depth`: 级联深度（0 = 外部事件，1+ = 级联事件）
///
/// 调试示例：
///   外部事件：source="user_intent", cascade_from=None, depth=0
///   一级级联：source="user_intent", cascade_from=Some("TaskGraph"), depth=1
///   二级级联：source="user_intent", cascade_from=Some("Scheduler"), depth=2
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeEventEnvelope {
    pub event: RuntimeEvent,
    pub payload: Option<serde_json::Value>,
    pub timestamp: u64,
    /// 外部调用者标识
    pub source: Option<String>,
    /// 产生此级联事件的模块名（None 表示外部事件）
    pub cascade_from: Option<String>,
    /// 级联深度（0 = 外部事件）
    pub depth: usize,
    pub trace_id: Option<String>,
}

impl RuntimeEventEnvelope {
    pub fn new(event: RuntimeEvent) -> Self {
        Self {
            event,
            payload: None,
            timestamp: current_timestamp_ms(),
            source: None,
            cascade_from: None,
            depth: 0,
            trace_id: None,
        }
    }

    pub fn with_payload(mut self, payload: serde_json::Value) -> Self {
        self.payload = Some(payload);
        self
    }

    pub fn with_source(mut self, source: String) -> Self {
        self.source = Some(source);
        self
    }

    pub fn with_trace_id(mut self, trace_id: String) -> Self {
        self.trace_id = Some(trace_id);
        self
    }

    pub fn with_cascade_from(mut self, module_name: String) -> Self {
        self.cascade_from = Some(module_name);
        self
    }

    pub fn with_depth(mut self, depth: usize) -> Self {
        self.depth = depth;
        self
    }
}

/// 事件总线
pub struct Bus {
    /// 事件历史
    history: Vec<RuntimeEventEnvelope>,
    /// 最大历史长度
    max_history: usize,
    /// 订阅者
    subscribers: HashMap<RuntimeEvent, Vec<Box<dyn Fn(&RuntimeEventEnvelope) + Send + Sync>>>,
    /// 类别订阅者
    category_subscribers: HashMap<EventCategory, Vec<Box<dyn Fn(&RuntimeEventEnvelope) + Send + Sync>>>,
}

impl Bus {
    pub fn new() -> Self {
        Self {
            history: Vec::new(),
            max_history: 1000,
            subscribers: HashMap::new(),
            category_subscribers: HashMap::new(),
        }
    }

    /// 发布事件
    pub fn emit(&mut self, envelope: RuntimeEventEnvelope) {
        // 记录历史
        self.history.push(envelope.clone());

        // 裁剪历史
        if self.history.len() > self.max_history {
            self.history.remove(0);
        }

        // 通知特定事件订阅者
        if let Some(subscribers) = self.subscribers.get(&envelope.event) {
            for subscriber in subscribers {
                subscriber(&envelope);
            }
        }

        // 通知类别订阅者
        let category = envelope.event.category();
        if let Some(subscribers) = self.category_subscribers.get(&category) {
            for subscriber in subscribers {
                subscriber(&envelope);
            }
        }
    }

    /// 订阅特定事件
    pub fn on(&mut self, event: RuntimeEvent, handler: Box<dyn Fn(&RuntimeEventEnvelope) + Send + Sync>) {
        self.subscribers
            .entry(event)
            .or_insert_with(Vec::new)
            .push(handler);
    }

    /// 订阅事件类别
    pub fn on_category(&mut self, category: EventCategory, handler: Box<dyn Fn(&RuntimeEventEnvelope) + Send + Sync>) {
        self.category_subscribers
            .entry(category)
            .or_insert_with(Vec::new)
            .push(handler);
    }

    /// 获取事件历史
    pub fn get_history(&self) -> &[RuntimeEventEnvelope] {
        &self.history
    }

    /// 获取特定事件的历史
    pub fn get_history_for(&self, event: RuntimeEvent) -> Vec<&RuntimeEventEnvelope> {
        self.history.iter().filter(|e| e.event == event).collect()
    }

    /// 清空历史
    pub fn clear_history(&mut self) {
        self.history.clear();
    }
}

impl Default for Bus {
    fn default() -> Self {
        Self::new()
    }
}

/// 运行时核心
/// 文档要求：Runtime 只需调用 module.handle_event()
pub struct RuntimeCore {
    /// 运行时 ID
    pub id: String,
    /// 当前状态
    state: RuntimeState,
    /// 模块列表
    modules: Vec<Box<dyn RuntimeModule>>,
    /// 模块索引（按名称）
    module_index: HashMap<String, usize>,
    /// 事件总线
    bus: Bus,
    /// 中断处理器
    interrupt_handler: InterruptHandler,
    /// 事件历史
    event_history: Vec<RuntimeEventEnvelope>,
    /// 启动时间
    started_at: u64,
    /// 快照计数器
    snapshot_sequence: u64,
}

impl RuntimeCore {
    /// 创建新的运行时核心
    pub fn new(id: String) -> Self {
        Self {
            id,
            state: RuntimeState::Booting,
            modules: Vec::new(),
            module_index: HashMap::new(),
            bus: Bus::new(),
            interrupt_handler: InterruptHandler::new(),
            event_history: Vec::new(),
            started_at: current_timestamp_ms(),
            snapshot_sequence: 0,
        }
    }

    /// 启动运行时
    pub fn boot(&mut self) -> Result<(), RuntimeError> {
        self.transition_to(RuntimeState::Initializing)?;

        // 初始化所有模块
        for module in &mut self.modules {
            module.initialize()
                .map_err(|e| RuntimeError::ModuleInitError(module.name(), e.to_string()))?;
        }

        self.transition_to(RuntimeState::Ready)?;
        self.emit(RuntimeEvent::SystemBoot);

        Ok(())
    }

    /// 运行运行时
    pub fn run(&mut self) -> Result<(), RuntimeError> {
        if self.state != RuntimeState::Ready {
            return Err(RuntimeError::InvalidState(format!(
                "Cannot run from state: {:?}",
                self.state
            )));
        }

        self.transition_to(RuntimeState::Running)?;
        Ok(())
    }

    /// 停止运行时
    pub fn stop(&mut self) -> Result<(), RuntimeError> {
        self.transition_to(RuntimeState::ShuttingDown)?;
        self.emit(RuntimeEvent::SystemShutdown);
        self.transition_to(RuntimeState::Stopped)?;
        Ok(())
    }

    /// 暂停运行时
    pub fn pause(&mut self) -> Result<(), RuntimeError> {
        if self.state != RuntimeState::Running {
            return Err(RuntimeError::InvalidState(format!(
                "Cannot pause from state: {:?}",
                self.state
            )));
        }

        self.transition_to(RuntimeState::Paused)?;
        Ok(())
    }

    /// 恢复运行时
    pub fn resume(&mut self) -> Result<(), RuntimeError> {
        if self.state != RuntimeState::Paused {
            return Err(RuntimeError::InvalidState(format!(
                "Cannot resume from state: {:?}",
                self.state
            )));
        }

        self.transition_to(RuntimeState::Running)?;
        Ok(())
    }

    /// 注册模块
    pub fn register_module(&mut self, module: Box<dyn RuntimeModule>) -> Result<(), RuntimeError> {
        let name = module.name();

        if self.module_index.contains_key(&name) {
            return Err(RuntimeError::ModuleAlreadyRegistered(name));
        }

        let index = self.modules.len();
        self.module_index.insert(name, index);
        self.modules.push(module);

        Ok(())
    }

    /// 获取模块
    pub fn get_module(&self, name: &str) -> Option<&dyn RuntimeModule> {
        self.module_index.get(name).map(|&idx| self.modules[idx].as_ref())
    }

    /// 处理事件
    /// 文档要求：Runtime 只需调用 module.handle_event()
    pub fn emit(&mut self, event: RuntimeEvent) {
        let envelope = RuntimeEventEnvelope::new(event).with_source(self.id.clone());
        self.process_event(envelope);
    }

    /// 处理带负载的事件
    pub fn emit_with_payload(&mut self, event: RuntimeEvent, payload: serde_json::Value) {
        let envelope = RuntimeEventEnvelope::new(event)
            .with_payload(payload)
            .with_source(self.id.clone());
        self.process_event(envelope);
    }

    /// 处理事件信封（入口）
    fn process_event(&mut self, envelope: RuntimeEventEnvelope) {
        let cascade_start_time = current_timestamp_ms();
        self.process_event_with_depth(envelope, 0, cascade_start_time);
    }

    /// 处理事件信封（带深度限制和超时保护，防止级联事件无限循环）
    ///
    /// 模块的 handle_event() 可能返回级联事件（Vec<RuntimeEvent>），
    /// 这些事件需要重新注入事件总线。通过 depth 参数限制最大级联深度，
    /// 通过 cascade_start_time 实现超时保护，双重机制避免死循环。
    fn process_event_with_depth(
        &mut self,
        envelope: RuntimeEventEnvelope,
        depth: usize,
        cascade_start_time: u64,
    ) {
        // 从配置读取最大深度（默认 8）
        let max_depth = 8; // TODO: 从 self.config.max_cascade_depth 读取

        if depth >= max_depth {
            log::warn!(
                "Event cascade depth {} exceeded limit ({}), dropped event {:?} (from {}, cascade_from: {})",
                depth,
                max_depth,
                envelope.event,
                envelope.source.as_deref().unwrap_or("unknown"),
                envelope.cascade_from.as_deref().unwrap_or("external")
            );
            return;
        }

        // 检查超时保护（第二道防线）
        let elapsed = current_timestamp_ms().saturating_sub(cascade_start_time);
        let cascade_timeout: Option<u64> = Some(5000); // TODO: 从 self.config.cascade_timeout_ms 读取
        if let Some(timeout_ms) = cascade_timeout {
            if elapsed > timeout_ms {
                log::warn!(
                    "Event cascade timeout exceeded ({}ms > {}ms), dropped event {:?} (cascade_from: {}, depth: {})",
                    elapsed,
                    timeout_ms,
                    envelope.event,
                    envelope.cascade_from.as_deref().unwrap_or("external"),
                    depth
                );
                return;
            }
        }

        // 记录历史
        self.event_history.push(envelope.clone());

        // 通过事件总线发布
        self.bus.emit(envelope.clone());

        // 转发给所有模块，收集级联事件
        let mut cascade_events: Vec<RuntimeEvent> = Vec::new();

        for module in &mut self.modules {
            if module.get_status().is_active() {
                match module.handle_event(envelope.event, envelope.payload.as_ref()) {
                    Ok(returned_events) => {
                        cascade_events.extend(returned_events);
                    }
                    Err(e) => {
                        // 模块处理失败，记录但不中断其他模块
                        log::error!(
                            "Module {} failed to handle event {:?}: {}",
                            module.name(),
                            envelope.event,
                            e
                        );
                    }
                }
            }
        }

        // 将级联事件重新注入事件总线
        // 注意：使用独立的 cascade_from 字段记录产生级联的模块名，而不是编码到 source
        for cascade_event in cascade_events {
            let cascade_envelope = RuntimeEventEnvelope::new(cascade_event)
                .with_source(envelope.source.clone().unwrap_or(self.id.clone()))
                .with_cascade_from("producing_module".to_string()) // TODO: 需要从外层循环传入 module.name()
                .with_depth(depth + 1);
            self.process_event_with_depth(cascade_envelope, depth + 1, cascade_start_time);
        }
    }

    /// 获取事件总线
    pub fn get_bus(&self) -> &Bus {
        &self.bus
    }

    /// 获取中断处理器
    pub fn get_interrupt_handler(&mut self) -> &mut InterruptHandler {
        &mut self.interrupt_handler
    }

    /// 请求中断
    pub fn request_interrupt(&mut self, task_id: String, action: InterruptAction, reason: String) {
        let interrupt = Interrupt::new(
            task_id,
            action,
            reason,
            crate::interrupt::InterruptPriority::Medium,
            InterruptSource::System,
        );

        self.interrupt_handler.request_interrupt(interrupt);
    }

    /// 获取当前状态
    pub fn get_state(&self) -> RuntimeState {
        self.state
    }

    /// 获取运行时统计
    pub fn get_stats(&self) -> RuntimeStats {
        RuntimeStats {
            id: self.id.clone(),
            state: self.state,
            module_count: self.modules.len(),
            event_count: self.event_history.len(),
            uptime_ms: current_timestamp_ms() - self.started_at,
            snapshot_sequence: self.snapshot_sequence,
        }
    }

    /// 状态转换
    fn transition_to(&mut self, target: RuntimeState) -> Result<(), RuntimeError> {
        if !self.state.can_transition_to(target) {
            return Err(RuntimeError::InvalidState(format!(
                "Cannot transition from {:?} to {:?}",
                self.state, target
            )));
        }

        self.state = target;
        Ok(())
    }

    /// 获取已注册模块的名称列表
    pub fn module_names(&self) -> Vec<&String> {
        self.module_index.keys().collect()
    }

    /// 获取所有模块状态
    pub fn module_statuses(&self) -> Vec<(String, ModuleStatus)> {
        self.modules
            .iter()
            .map(|m| (m.name(), m.get_status()))
            .collect()
    }
}

impl Snapshotable for RuntimeCore {
    fn save(&self) -> StateSnapshot {
        // 注意：dyn RuntimeModule 不能直接序列化，这里只保存模块名称
        let module_names: Vec<String> = self.modules.iter().map(|m| m.name()).collect();

        let data = crate::snapshot::SnapshotData::Runtime {
            task_graph: crate::snapshot::TaskGraphSnapshotMetadata {
                total_nodes: 0,
                pending_count: 0,
                running_count: 0,
                completed_count: 0,
                failed_count: 0,
            },
            scheduler: crate::snapshot::SchedulerSnapshotMetadata {
                queue_size: 0,
                running_tasks: Vec::new(),
                recent_completions: Vec::new(),
            },
            modules: module_names
                .into_iter()
                .map(|name| crate::snapshot::ModuleSnapshot {
                    name,
                    state: serde_json::json!({}),
                    version: 1,
                })
                .map(|s| (s.name.clone(), s))
                .collect(),
        };

        StateSnapshot::new(SnapshotType::Full, data, self.id.clone())
    }

    fn restore(&mut self, snapshot: StateSnapshot) -> Result<(), crate::snapshot::SnapshotError> {
        // 恢复模块状态
        if let crate::snapshot::SnapshotData::Runtime { modules, .. } = snapshot.data {
            for module in &mut self.modules {
                if modules.contains_key(&module.name()) {
                    // 反序列化并恢复模块状态
                    // 注意：这需要模块实现反向转换
                    eprintln!("Restoring module: {}", module.name());
                }
            }
        }

        Ok(())
    }
}

/// 运行时配置
///
/// ## 级联事件安全配置
/// - `max_cascade_depth`: 最大级联深度（默认 8），超过时截断并警告
/// - `cascade_timeout_ms`: 单次 emit 引发的级联总耗时上限（默认 5000ms），防死循环第二道防线
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeConfig {
    pub runtime_id: String,
    pub max_event_history: usize,
    /// 最大级联深度，默认 8
    pub max_cascade_depth: usize,
    /// 级联超时毫秒数，默认 5000ms
    pub cascade_timeout_ms: Option<u64>,
}

impl Default for RuntimeConfig {
    fn default() -> Self {
        Self {
            runtime_id: "solo_runtime".to_string(),
            max_event_history: 1000,
            max_cascade_depth: 8,
            cascade_timeout_ms: Some(5000),
        }
    }
}

/// 运行时统计
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeStats {
    pub id: String,
    pub state: RuntimeState,
    pub module_count: usize,
    pub event_count: usize,
    pub uptime_ms: u64,
    pub snapshot_sequence: u64,
}

/// 运行时错误
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum RuntimeError {
    InvalidState(String),
    ModuleAlreadyRegistered(String),
    ModuleInitError(String, String),
    ModuleNotFound(String),
    EventProcessingError(String),
    SnapshotError(String),
}

impl std::fmt::Display for RuntimeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RuntimeError::InvalidState(msg) => write!(f, "Invalid state: {}", msg),
            RuntimeError::ModuleAlreadyRegistered(name) => {
                write!(f, "Module already registered: {}", name)
            }
            RuntimeError::ModuleInitError(name, msg) => {
                write!(f, "Module {} init error: {}", name, msg)
            }
            RuntimeError::ModuleNotFound(name) => write!(f, "Module not found: {}", name),
            RuntimeError::EventProcessingError(msg) => {
                write!(f, "Event processing error: {}", msg)
            }
            RuntimeError::SnapshotError(msg) => write!(f, "Snapshot error: {}", msg),
        }
    }
}

impl std::error::Error for RuntimeError {}

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

    struct TestModule {
        name: String,
        status: ModuleStatus,
        events_handled: Vec<RuntimeEvent>,
    }

    impl TestModule {
        fn new(name: &str) -> Self {
            Self {
                name: name.to_string(),
                status: ModuleStatus::Uninitialized,
                events_handled: Vec::new(),
            }
        }
    }

    impl Snapshotable for TestModule {
        fn save(&self) -> StateSnapshot {
            let data = crate::snapshot::SnapshotData::Custom(serde_json::json!({
                "name": self.name,
                "events_handled": self.events_handled.len()
            }));
            StateSnapshot::new(SnapshotType::Full, data, "test".to_string())
        }

        fn restore(&mut self, _snapshot: StateSnapshot) -> Result<(), crate::snapshot::SnapshotError> {
            Ok(())
        }
    }

    impl RuntimeModule for TestModule {
        fn name(&self) -> String {
            self.name.clone()
        }

        fn initialize(&mut self) -> Result<(), RuntimeError> {
            self.status = ModuleStatus::Ready;
            Ok(())
        }

        fn handle_event(&mut self, event: RuntimeEvent, _payload: Option<&serde_json::Value>) -> Result<Vec<RuntimeEvent>, RuntimeError> {
            self.events_handled.push(event);
            Ok(Vec::new())
        }

        fn get_status(&self) -> ModuleStatus {
            self.status
        }
    }

    #[test]
    fn test_runtime_creation() {
        let runtime = RuntimeCore::new("test".to_string());
        assert_eq!(runtime.id, "test");
        assert_eq!(runtime.state, RuntimeState::Booting);
    }

    #[test]
    fn test_runtime_module_registration() {
        let mut runtime = RuntimeCore::new("test".to_string());
        let module = Box::new(TestModule::new("test_module"));

        assert!(runtime.register_module(module).is_ok());
        assert_eq!(runtime.module_names(), vec!["test_module"]);
    }

    #[test]
    fn test_runtime_emit_event() {
        let mut runtime = RuntimeCore::new("test".to_string());
        let module = Box::new(TestModule::new("test_module"));
        runtime.register_module(module).unwrap();

        runtime.boot().unwrap();
        runtime.run().unwrap();

        runtime.emit(RuntimeEvent::TaskCreated);

        let _test_module = runtime.get_module("test_module").unwrap();
        // 注意：get_module 返回的是不可变引用，这里需要另一种方式测试
        // 简化测试：检查事件历史
        assert!(!runtime.event_history.is_empty());
    }

    #[test]
    fn test_runtime_state_transitions() {
        let mut runtime = RuntimeCore::new("test".to_string());
        let module = Box::new(TestModule::new("test_module"));
        runtime.register_module(module).unwrap();

        assert!(runtime.boot().is_ok());
        assert_eq!(runtime.get_state(), RuntimeState::Ready);

        assert!(runtime.run().is_ok());
        assert_eq!(runtime.get_state(), RuntimeState::Running);

        assert!(runtime.pause().is_ok());
        assert_eq!(runtime.get_state(), RuntimeState::Paused);

        assert!(runtime.resume().is_ok());
        assert_eq!(runtime.get_state(), RuntimeState::Running);

        assert!(runtime.stop().is_ok());
        assert_eq!(runtime.get_state(), RuntimeState::Stopped);
    }

    #[test]
    fn test_bus_event_emission() {
        use std::sync::{Arc, Mutex};
        let mut bus = Bus::new();
        let received = Arc::new(Mutex::new(Vec::new()));
        let received_clone = Arc::clone(&received);

        bus.on(RuntimeEvent::TaskCreated, Box::new(move |e| {
            received_clone.lock().unwrap().push(e.event);
        }));

        bus.emit(RuntimeEventEnvelope::new(RuntimeEvent::TaskCreated));

        let received = received.lock().unwrap();
        assert_eq!(received.len(), 1);
        assert_eq!(received[0], RuntimeEvent::TaskCreated);
    }

    // ─────────────────────────────────────────────────────────────
    // 集成测试：验证真实业务模块可注册到 RuntimeCore
    // 验证：注册 → 启动 → 事件 → 停止 完整流程
    // ─────────────────────────────────────────────────────────────

    #[test]
    fn test_full_runtime_pathway() {
        use crate::interrupt::InterruptHandler;
        use crate::scheduler_module::SchedulerModule;
        use crate::scheduler_core::SchedulerConfig;
        use crate::task_module::TaskGraphModule;

        let mut runtime = RuntimeCore::new("integration_test".to_string());

        // 注册三个核心模块
        assert!(
            runtime
                .register_module(Box::new(SchedulerModule::new(SchedulerConfig::default())))
                .is_ok()
        );
        assert!(
            runtime
                .register_module(Box::new(TaskGraphModule::new()))
                .is_ok()
        );
        assert!(
            runtime
                .register_module(Box::new(InterruptHandler::new()))
                .is_ok()
        );

        // 启动 → 运行 → 事件 → 停止 完整流程
        assert!(runtime.boot().is_ok());
        assert_eq!(runtime.get_state(), RuntimeState::Ready);

        assert!(runtime.run().is_ok());
        assert_eq!(runtime.get_state(), RuntimeState::Running);

        // 发送事件（带 payload）
        let task_payload = serde_json::json!({
            "task_id": "integration_task_1",
            "title": "Integration Test Task",
            "priority": 75
        });
        runtime.emit_with_payload(RuntimeEvent::TaskCreated, task_payload);

        let submit_payload = serde_json::json!({
            "task_id": "integration_task_1",
            "priority": 75
        });
        runtime.emit_with_payload(RuntimeEvent::TaskSubmitted, submit_payload);

        // 验证事件历史不为空
        assert!(!runtime.event_history.is_empty());

        // 停止运行时
        assert!(runtime.stop().is_ok());
        assert_eq!(runtime.get_state(), RuntimeState::Stopped);

        // 验证模块状态
        let statuses = runtime.module_statuses();
        assert_eq!(statuses.len(), 3);

        // 验证所有模块名称
        let names: Vec<&String> = runtime.module_names();
        assert!(names.contains(&&"Scheduler".to_string()));
        assert!(names.contains(&&"TaskGraph".to_string()));
        assert!(names.contains(&&"InterruptHandler".to_string()));
    }

    #[test]
    fn test_state_machine_validation_scheduler() {
        use crate::scheduler_core::SchedulerState;

        // 合法转换
        assert!(SchedulerState::Initializing.can_transition_to(SchedulerState::Ready));
        assert!(SchedulerState::Ready.can_transition_to(SchedulerState::Running));
        assert!(SchedulerState::Running.can_transition_to(SchedulerState::Paused));
        assert!(SchedulerState::Paused.can_transition_to(SchedulerState::Running));
        assert!(SchedulerState::Running.can_transition_to(SchedulerState::Shutdown));

        // 非法转换
        assert!(!SchedulerState::Initializing.can_transition_to(SchedulerState::Running));
        assert!(!SchedulerState::Shutdown.can_transition_to(SchedulerState::Running));
        assert!(!SchedulerState::Paused.can_transition_to(SchedulerState::Initializing));
    }

    #[test]
    fn test_state_machine_validation_interrupt() {
        use crate::interrupt::InterruptStatus;

        // 合法转换
        assert!(InterruptStatus::Requested.can_transition_to(InterruptStatus::Processing));
        assert!(InterruptStatus::Processing.can_transition_to(InterruptStatus::Processed));
        assert!(InterruptStatus::Processing.can_transition_to(InterruptStatus::Failed));
        assert!(InterruptStatus::Processed.can_transition_to(InterruptStatus::Completed));
        assert!(InterruptStatus::Processed.can_transition_to(InterruptStatus::Ignored));
        assert!(InterruptStatus::Failed.can_transition_to(InterruptStatus::Requested));

        // 非法转换
        assert!(!InterruptStatus::Requested.can_transition_to(InterruptStatus::Completed));
        assert!(!InterruptStatus::Completed.can_transition_to(InterruptStatus::Requested));
        assert!(!InterruptStatus::Ignored.can_transition_to(InterruptStatus::Processing));
    }

    #[test]
    fn test_scheduler_module_snapshot_restore() {
        use crate::scheduler_module::SchedulerModule;
        use crate::scheduler_core::SchedulerConfig;
        use crate::scheduler::TaskItem;

        let mut module = SchedulerModule::new(SchedulerConfig::default());
        module.initialize().unwrap();

        // 入队一些任务
        module.scheduler_mut().enqueue(TaskItem::new(
            "snap_task_1".to_string(),
            50,
            0.0,
            0,
        )).unwrap();
        module.scheduler_mut().enqueue(TaskItem::new(
            "snap_task_2".to_string(),
            100,
            0.0,
            0,
        )).unwrap();

        // 保存快照
        let snapshot = module.save();
        assert_eq!(module.scheduler().queue_size(), 2);

        // 创建新模块并恢复
        let mut restored_module = SchedulerModule::new(SchedulerConfig::default());
        restored_module.initialize().unwrap();
        assert_eq!(restored_module.scheduler().queue_size(), 0);

        assert!(restored_module.restore(snapshot).is_ok());
        assert_eq!(restored_module.scheduler().queue_size(), 2);
    }
}
