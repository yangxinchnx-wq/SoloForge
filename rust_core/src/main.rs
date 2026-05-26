use std::io::{self, BufRead, Write};
use std::time::Instant;
// 🔍 铁证对齐：使用你真实的 GeminiActorQueue 和 ActorTask 结构体
use rust_core::{GeminiActorQueue, ActorTask};

fn main() {
    let mut queue = GeminiActorQueue::new();
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    
    for line in stdin.lock().lines() {
        let raw_line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        
        let parts: Vec<&str> = raw_line.trim().split_whitespace().collect();
        if parts.is_empty() { continue; }
        
        match parts[0] {
            "PUSH" => {
                // 接收参数：PUSH <actor_id> <base_priority> <aging_factor>
                if parts.len() >= 4 {
                    let actor_id = parts[1].to_string();
                    let base_priority = parts[2].parse::<u32>().unwrap_or(0);
                    let aging_factor = parts[3].parse::<f64>().unwrap_or(0.0);

                    // 构造你定义好的真实 ActorTask 载荷
                    let task = ActorTask {
                        id: actor_id,
                        base_priority,
                        created_at: Instant::now(),
                        aging_factor,
                    };
                    queue.push(task);
                    println!("OK_PUSH");
                } else { println!("ERR_BAD_ARGS"); }
            }
            "POP" => {
                // 🔍 纠正盲猜：你真实的 pop() 方法依靠内部 Instant::now() 演化，不需要外部传参！
                match queue.pop() {
                    Some(task) => println!("SUCCESS_POP {}", task.id),
                    None => println!("NONE_POP"),
                }
            }
            "PING" => {
                println!("PONG");
            }
            _ => {
                println!("ERR_UNKNOWN_COMMAND");
            }
        }
        
        // 强制冲刷字节，击穿 Windows 管道缓存锁
        let _ = stdout.flush();
    }
}