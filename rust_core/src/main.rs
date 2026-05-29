// ─────────────────────────────────────────────────────────────────
// SoloForge Rust Core: Scheduler Daemon
// Path: rust_core/src/main.rs
// Description: 调度器守护进程 - 完整的 IPC 服务
// 文档要求：支持 PUSH、POP、PING 及完整调度功能
// ─────────────────────────────────────────────────────────────────

use std::collections::BinaryHeap;
use std::cmp::Ordering;
use std::io::{self, BufRead, Write};
use std::time::Instant;

use rust_core::actor_queue::ActorTask;

/// Scored task for BinaryHeap
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
        // BinaryHeap 是最大堆，score 大的应该先弹出
        // 所以 self.score > other.score 时返回 Greater
        self.score.partial_cmp(&other.score).unwrap_or(Ordering::Equal)
    }
}
impl PartialOrd for ScoredTask {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// 队列状态
struct QueueState {
    heap: BinaryHeap<ScoredTask>,
    stats: QueueStats,
}

impl QueueState {
    fn new() -> Self {
        Self {
            heap: BinaryHeap::new(),
            stats: QueueStats::default(),
        }
    }
}

#[derive(Debug, Default)]
struct QueueStats {
    total_push: u64,
    total_pop: u64,
    total_ping: u64,
}

/// 处理命令
fn process_command(
    line: &str,
    state: &mut QueueState,
) -> String {
    let parts: Vec<&str> = line.trim().split_whitespace().collect();
    if parts.is_empty() {
        return "ERR_EMPTY_COMMAND".to_string();
    }

    match parts[0] {
        // PING - 健康检查
        "PING" => {
            state.stats.total_ping += 1;
            "PONG".to_string()
        }

        // PUSH - 推入任务
        // 格式: PUSH <task_id> <priority> <aging_factor>
        "PUSH" => {
            if parts.len() < 4 {
                return "ERR_BAD_ARGS".to_string();
            }

            let task_id = parts[1].to_string();
            let base_priority: u32 = parts[2].parse().unwrap_or(0);
            let aging_factor: f64 = parts[3].parse().unwrap_or(0.0);

            let task = ActorTask {
                id: task_id.clone(),
                base_priority,
                created_at: Instant::now(),
                aging_factor,
            };

            // 计算初始分数（无老化）
            let initial_score = base_priority as f64;
            state.heap.push(ScoredTask {
                task,
                score: initial_score,
            });
            state.stats.total_push += 1;

            format!("OK_PUSH {}", task_id)
        }

        // POP - 弹出最高优先级任务
        "POP" => {
            if state.heap.is_empty() {
                return "NONE_POP".to_string();
            }

            // 弹出并重新计算所有任务的分数（老化）
            let tasks: Vec<ActorTask> = state.heap.drain().map(|st| st.task).collect();
            let now = Instant::now();

            let mut new_heap = BinaryHeap::new();
            for task in tasks {
                let elapsed_secs = now.duration_since(task.created_at).as_secs_f64();
                let aged_score = task.base_priority as f64 + (elapsed_secs * task.aging_factor);
                new_heap.push(ScoredTask {
                    task,
                    score: aged_score,
                });
            }

            // 再次弹出（现在队列按老化后的分数排序）
            if let Some(scored) = new_heap.pop() {
                state.heap = new_heap;
                state.stats.total_pop += 1;
                format!("SUCCESS_POP {}", scored.task.id)
            } else {
                "NONE_POP".to_string()
            }
        }

        // STATS - 获取统计信息
        "STATS" => {
            let json = serde_json::json!({
                "total_push": state.stats.total_push,
                "total_pop": state.stats.total_pop,
                "total_ping": state.stats.total_ping,
                "queue_size": state.heap.len(),
            });
            format!("STATS {}", json)
        }

        // VERSION - 版本信息
        "VERSION" => {
            "VERSION rust_core v1.0.0".to_string()
        }

        // 未知命令
        _ => {
            format!("ERR_UNKNOWN_COMMAND: {}", parts[0])
        }
    }
}

/// 处理带请求 ID 的命令
/// 输入格式: <request_id>|<command>
/// 输出格式: <request_id>|<response>
fn process_request(line: &str, state: &mut QueueState) -> Option<String> {
    let parts: Vec<&str> = line.splitn(2, '|').collect();
    if parts.len() < 2 {
        return None; // 无效格式，忽略
    }

    let request_id = parts[0];
    let command = parts[1];

    let response = process_command(command, state);
    Some(format!("{}|{}", request_id, response))
}

fn main() {
    // 初始化日志
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    log::info!("SoloForge Rust Scheduler Daemon 启动中...");

    // 创建状态
    let mut state = QueueState::new();

    // 设置标准输入输出
    let stdin = io::stdin();
    let mut stdout = io::stdout();

    log::info!("Scheduler Daemon 就绪，等待命令...");

    for line in stdin.lock().lines() {
        let raw_line = match line {
            Ok(l) => l,
            Err(_) => break,
        };

        // 尝试解析带请求 ID 的格式
        if let Some(response) = process_request(&raw_line, &mut state) {
            // 输出响应
            println!("{}", response);

            // 强制冲刷字节，击穿 Windows 管道缓存锁
            if let Err(e) = stdout.flush() {
                log::error!("Flush 失败: {}", e);
            }
        }
    }

    log::info!("Scheduler Daemon 关闭");
}
