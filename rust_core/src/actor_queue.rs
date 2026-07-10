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
        self.score.to_bits() == other.score.to_bits()
    }
}

impl Ord for ScoredTask {
    fn cmp(&self, other: &Self) -> Ordering {
        // 修复：参数顺序从 other→self 改为 self→other（原代码导致 Max-Heap 变 Min-Heap）
        self.score.partial_cmp(&other.score).unwrap_or(Ordering::Equal)
    }
}

impl PartialOrd for ScoredTask {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

pub struct ActorQueue {
    heap: BinaryHeap<ScoredTask>,
}

impl ActorQueue {
    pub fn new() -> Self {
        Self { heap: BinaryHeap::new() }
    }

    pub fn push(&mut self, task: ActorTask) {
        let initial_score = task.base_priority as f64;
        self.heap.push(ScoredTask { task, score: initial_score });
    }

    /// 统一化单次遍历 Aging 演化机制
    pub fn pop(&mut self) -> Option<ActorTask> {
        if self.heap.is_empty() {
            return None;
        }
        let now = Instant::now();

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
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn test_base_priority_sorting_nominal() {
        let mut queue = ActorQueue::new();
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

        let first_pop = queue.pop().unwrap();
        assert_eq!(first_pop.id, "task_high_priority");

        let second_pop = queue.pop().unwrap();
        assert_eq!(second_pop.id, "task_low_priority");
    }

    #[test]
    fn test_dynamic_aging_starvation_prevention() {
        let mut queue = ActorQueue::new();
        let now = Instant::now();

        let task_a = ActorTask {
            id: "arrogant_task_a".to_string(),
            base_priority: 50,
            created_at: now,
            aging_factor: 0.0,
        };

        let backdated_time = now.checked_sub(Duration::from_millis(100)).unwrap();
        let task_b = ActorTask {
            id: "patient_task_b".to_string(),
            base_priority: 5,
            created_at: backdated_time,
            aging_factor: 1000.0,
        };

        queue.push(task_a);
        queue.push(task_b);

        let active_pop = queue.pop().unwrap();
        assert_eq!(active_pop.id, "patient_task_b");

        let residual_pop = queue.pop().unwrap();
        assert_eq!(residual_pop.id, "arrogant_task_a");
    }

    #[test]
    fn test_empty_queue_graceful_none() {
        let mut queue = ActorQueue::new();
        assert!(queue.pop().is_none());
    }
}
