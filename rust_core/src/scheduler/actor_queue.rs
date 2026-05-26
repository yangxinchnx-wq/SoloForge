use std::collections::BinaryHeap;
use std::cmp::Ordering;
use std::time::Instant;

#[derive(Debug, Clone)]
pub struct ActorTask {
    pub id: String,
    pub base_priority: u32,
    pub created_at: Instant,
    pub aging_factor: f64,
}

#[derive(Debug)]
struct ScoredTask {
    task: ActorTask,
    score: f64,
}

impl Eq for ScoredTask {}
impl PartialEq for ScoredTask {
    fn eq(&self, other: &Self) -> bool {
        // 安全处理浮点数等值判定，防止 NaN 触发 panic
        self.score.to_bits() == other.score.to_bits()
    }
}

impl Ord for ScoredTask {
    fn cmp(&self, other: &Self) -> Ordering {
        // 降序排列（BinaryHeap 默认是最大堆，由此实现高优先级先弹出）
        self.score.partial_cmp(&other.score).unwrap_or(Ordering::Equal)
    }
}

impl PartialOrd for ScoredTask {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

pub struct GeminiActorQueue {
    heap: BinaryHeap<ScoredTask>,
}

impl GeminiActorQueue {
    pub fn new() -> Self {
        Self { heap: BinaryHeap::new() }
    }

    pub fn push(&mut self, task: ActorTask) {
        let initial_score = task.base_priority as f64;
        self.heap.push(ScoredTask { task, score: initial_score });
    }

    /// ✅ 统一化单次遍历 Aging 演化机制
    pub fn pop(&mut self) -> Option<ActorTask> {
        if self.heap.is_empty() {
            return None;
        }
        let now = Instant::now();
        
        // 将旧堆中所有元素弹出，并在单次单向迭代中完成动态老化分数演化
        let tasks: Vec<ActorTask> = self.heap.drain().map(|st| st.task).collect();
        let mut reallocated_heap = BinaryHeap::with_capacity(tasks.len());
        
        for task in tasks {
            let elapsed_time = now.duration_since(task.created_at).as_secs_f64();
            let dynamically_aged_score = task.base_priority as f64 + (elapsed_time * task.aging_factor);
            reallocated_heap.push(ScoredTask {
                task,
                score: dynamically_aged_score,
            });
        }
        
        self.heap = reallocated_heap;
        self.heap.pop().map(|st| st.task)
    }

    pub fn len(&self) -> usize {
        self.heap.len()
    }

    pub fn is_empty(&self) -> bool {
        self.heap.is_empty()
    }
}// ─────────────────────────────────────────────────────────────────
// SoloForge Rust Core Test Module: Companion Behavioral Assertions
// Append to: rust_core/src/scheduler/actor_queue.rs
// ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn test_base_priority_sorting_nominal() {
        let mut queue = GeminiActorQueue::new();
        let now = Instant::now();

        let task_low = ActorTask {
            id: "task_low_priority".to_string(),
            base_priority: 10,
            created_at: now,
            aging_factor: 0.0,
        };
        let task_high = ActorTask {
            id: "task_high_priority".to_string(),
            base_priority: 100,
            created_at: now,
            aging_factor: 0.0,
        };

        queue.push(task_low);
        queue.push(task_high);

        // 断言 1：在无时间流逝、老化因子均为 0 的初始稳态下，高基础权重的任务必须率先弹出
        let first_pop = queue.pop().unwrap();
        assert_eq!(first_pop.id, "task_high_priority");

        // 断言 2：剩下的低权重任务随后弹出
        let second_pop = queue.pop().unwrap();
        assert_eq!(second_pop.id, "task_low_priority");
    }

    #[test]
    fn test_dynamic_aging_starvation_prevention() {
        let mut queue = GeminiActorQueue::new();
        let now = Instant::now();

        // 任务 A：基础权重很高（50 分），但完全没有老化能力（不合群，易造成其他任务死锁）
        let task_a = ActorTask {
            id: "arrogant_task_a".to_string(),
            base_priority: 50,
            created_at: now,
            aging_factor: 0.0,
        };

        // 任务 B：初始基础权重极低（仅 5 分），但老化系数极高（每过一秒增加 1000 分的分流权重）
        // 🛡️ 安全实践：通过物理倒卷时间戳（100 毫秒前创建），极其确定地让它在当前时间轴上发生老化演化
        let backdated_time = now.checked_sub(Duration::from_millis(100)).unwrap();
        let task_b = ActorTask {
            id: "patient_task_b".to_string(),
            base_priority: 5,
            created_at: backdated_time,
            aging_factor: 1000.0, // 历经 0.1 秒老化，预期得分增量：0.1 * 1000 = 100 分。最终分：5 + 100 = 105 分
        };

        queue.push(task_a);
        queue.push(task_b);

        // ★ 核心断言：虽然任务 B 的初始基础权重只有 5，远低于 A 的 50
        // 但由于其在队列中饱受了 100ms 的“饥饿熬炼”，其动态综合分（105）已成功反超 A（50）
        // 队列弹出时，必须第一优先级把任务 B 吐出来！
        let active_pop = queue.pop().unwrap();
        assert_eq!(active_pop.id, "patient_task_b");

        let residual_pop = queue.pop().unwrap();
        assert_eq!(residual_pop.id, "arrogant_task_a");
    }

    #[test]
    fn test_empty_queue_graceful_none() {
        let mut queue = GeminiActorQueue::new();
        // 断言：空队列持续弹出时不应该发生 panic，必须优雅返回 None 选项
        assert!(queue.pop().is_none());
    }
}