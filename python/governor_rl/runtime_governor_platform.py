# python/governor_rl/runtime_governor_platform.py
import os
import json
import random
import numpy as np
import torch
import torch.nn as nn
import torch.optim as optim
from torch.distributions.categorical import Categorical
from typing import Tuple, Dict, Any
import sqlite3
import argparse
from datetime import datetime

# ====================== CONFIG ======================
class Config:
    OBS_DIM = 10
    ACTION_DIM = 6
    TOTAL_TIMESTEPS = 30000
    LEARNING_RATE = 3e-4
    NUM_STEPS = 128
    BATCH_SIZE = 32
    PPO_EPOCHS = 4
    GAMMA = 0.99
    GAE_LAMBDA = 0.95
    CLIP_COEF = 0.2
    ENT_COEF = 0.01
    VF_COEF = 0.5
    MAX_GRAD_NORM = 0.5


# ====================== SQLITE REPLAY BUFFER ======================
class SQLiteReplayBuffer:
    def __init__(self, db_path: str = 'datasets/runtime_training.db'):
        self.db_path = db_path
        os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)
        self._init_db()

    def _init_db(self):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS telemetry_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    tick INTEGER,
                    obs_json TEXT,
                    action INTEGER,
                    reward REAL,
                    next_obs_json TEXT,
                    done INTEGER,
                    chaos_scenario TEXT,
                    timestamp TEXT
                )
            """)
            conn.commit()

    def save_transition(self, tick: int, obs: np.ndarray, action: int, reward: float,
                       next_obs: np.ndarray, done: bool, chaos: str):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("""
                INSERT INTO telemetry_history
                (tick, obs_json, action, reward, next_obs_json, done, chaos_scenario, timestamp)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                tick, json.dumps(obs.tolist()), int(action), float(reward),
                json.dumps(next_obs.tolist()), 1 if done else 0, chaos,
                datetime.utcnow().isoformat()
            ))
            conn.commit()

    def load_offline_trajectories(self, limit: int = 5000):
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                "SELECT * FROM telemetry_history ORDER BY id DESC LIMIT ?", (limit,)
            ).fetchall()
        return [dict(row) for row in rows]


# ====================== RUNTIME ENV (Gymnasium 风格) ======================
class RuntimeEnv:
    def __init__(self):
        self.reset()

    def reset(self) -> np.ndarray:
        self.tick = 0
        self.state = {
            "cpu_usage": 0.35, "memory_pressure": 0.30, "queue_depth": 25,
            "agent_count": 8, "token_pressure": 0.22, "projection_lag": 0.08,
            "scheduler_congestion": 0.12, "attention_collapse": 0.0,
            "starvation_penalty_count": 0
        }
        return self._get_observation()

    def _get_observation(self) -> np.ndarray:
        return np.array([
            self.state["cpu_usage"], self.state["memory_pressure"],
            self.state["queue_depth"] / 300.0, self.state["agent_count"] / 50.0,
            self.state["token_pressure"], self.state["projection_lag"],
            self.state["scheduler_congestion"], self.state["attention_collapse"],
            self.state["starvation_penalty_count"] / 15.0,
            (self.state["queue_depth"] * self.state["cpu_usage"]) / 100.0
        ], dtype=np.float32)

    def step(self, action_idx: int) -> Tuple[np.ndarray, float, bool, str, Dict[str, Any]]:
        self.tick += 1
        chaos = self._inject_chaos()
        unnecessary_downgrade = False

        # Apply Action
        if action_idx == 1:   # spawn_agent
            self.state["agent_count"] = min(50, self.state["agent_count"] + 2)
        elif action_idx == 2: # pause_background
            self.state["cpu_usage"] = max(0.1, self.state["cpu_usage"] - 0.22)
        elif action_idx == 3: # switch_small_model
            if self.state["cpu_usage"] < 0.50:
                unnecessary_downgrade = True
            self.state["token_pressure"] = max(0.0, self.state["token_pressure"] - 0.35)
        elif action_idx == 4: # reduce_context
            self.state["memory_pressure"] = max(0.05, self.state["memory_pressure"] - 0.28)
        elif action_idx == 5: # enable_gc
            self.state["memory_pressure"] = max(0.05, self.state["memory_pressure"] - 0.40)

        # Natural Dynamics + Chaos
        self._apply_dynamics(chaos)

        reward = self._calculate_reward(unnecessary_downgrade)
        terminated = self.tick >= 300 or self.state["queue_depth"] >= 290 or self.state["cpu_usage"] >= 0.98

        return self._get_observation(), reward, terminated, chaos, {"unnecessary_downgrade": unnecessary_downgrade}

    def _inject_chaos(self) -> str:
        if random.random() < 0.22:
            return random.choice(["QUEUE_BURST", "TOKEN_STORM", "AGENT_EXPLOSION", "EVENT_FLOOD"])
        return "NORMAL"

    def _apply_dynamics(self, chaos: str):
        self.state["queue_depth"] += int(self.state["agent_count"] * 1.6)
        self.state["cpu_usage"] = min(0.99, self.state["cpu_usage"] + self.state["agent_count"] * 0.012)
        self.state["token_pressure"] = min(1.0, self.state["token_pressure"] + self.state["agent_count"] * 0.015)

        if chaos == "QUEUE_BURST":
            self.state["queue_depth"] += 110
        elif chaos == "TOKEN_STORM":
            self.state["token_pressure"] = min(1.0, self.state["token_pressure"] + 0.3)
        elif chaos == "AGENT_EXPLOSION":
            self.state["agent_count"] = min(50, self.state["agent_count"] + 10)
        elif chaos == "EVENT_FLOOD":
            self.state["queue_depth"] += 60
            self.state["projection_lag"] = min(1.0, self.state["projection_lag"] + 0.2)

        # Simulator internal auto-drain logic (吞吐处理耗散)
        drain = random.randint(18, 35) if self.state["cpu_usage"] < 0.85 else random.randint(3, 10)
        self.state["queue_depth"] = max(0, self.state["queue_depth"] - drain)

    def _calculate_reward(self, unnecessary_downgrade: bool) -> float:
        throughput = max(0, 80 - self.state["queue_depth"] * 0.55)
        penalties = (
            self.state["token_pressure"] * 16 +
            ((self.state["cpu_usage"] - 0.72) ** 2) * 95 +
            self.state["memory_pressure"] * 24 +
            self.state["projection_lag"] * 32 +
            (18 if unnecessary_downgrade else 0)
        )
        return float(throughput - penalties)


# ====================== AGENT & TRAINING LOOP ======================
class GovernorAgent(nn.Module):
    def __init__(self):
        super().__init__()
        self.shared = nn.Sequential(
            nn.Linear(Config.OBS_DIM, 128), nn.Tanh(),
            nn.Linear(128, 64), nn.Tanh()
        )
        self.actor = nn.Linear(64, Config.ACTION_DIM)
        self.critic = nn.Linear(64, 1)
        self._init_weights()

    def _init_weights(self):
        for m in self.modules():
            if isinstance(m, nn.Linear):
                torch.nn.init.orthogonal_(m.weight, gain=np.sqrt(2))
                torch.nn.init.constant_(m.bias, 0.0)

    def get_action_and_value(self, x, action=None):
        hidden = self.shared(x)
        logits = self.actor(hidden)
        probs = Categorical(logits=logits)
        if action is None:
            action = probs.sample()
        return action, probs.log_prob(action), probs.entropy(), self.critic(hidden)

    def get_value(self, x):
        return self.critic(self.shared(x))


def main():
    parser = argparse.ArgumentParser(description="SoloForge Runtime PPO Governor Platform")
    parser.add_argument('--sqlite-db', default='datasets/runtime_training.db')
    parser.add_argument('--mode', choices=['train', 'shadow'], default='train')
    args = parser.parse_args()

    replay_buffer = SQLiteReplayBuffer(args.sqlite_db)
    env = RuntimeEnv()
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    agent = GovernorAgent().to(device)
    optimizer = optim.Adam(agent.parameters(), lr=Config.LEARNING_RATE, eps=1e-5)

    print(f"SoloForge Runtime PPO Governor Platform 已启动 | Mode: {args.mode} | Device: {device}")

    # Rollout Buffers
    obs_buf = torch.zeros((Config.NUM_STEPS, Config.OBS_DIM), device=device)
    actions_buf = torch.zeros(Config.NUM_STEPS, device=device)
    logprobs_buf = torch.zeros(Config.NUM_STEPS, device=device)
    rewards_buf = torch.zeros(Config.NUM_STEPS, device=device)
    dones_buf = torch.zeros(Config.NUM_STEPS, device=device)
    values_buf = torch.zeros(Config.NUM_STEPS, device=device)

    next_obs = torch.tensor(env.reset(), device=device)
    next_done = torch.zeros(1, device=device)
    global_step = 0

    while global_step < Config.TOTAL_TIMESTEPS:
        # 1. 轨迹交互与重放缓冲沉淀
        for step in range(Config.NUM_STEPS):
            global_step += 1
            obs_buf[step] = next_obs
            dones_buf[step] = next_done

            with torch.no_grad():
                action, logprob, _, value = agent.get_action_and_value(next_obs)
                values_buf[step] = value.flatten()

            actions_buf[step] = action
            logprobs_buf[step] = logprob

            next_obs_np, reward, done, chaos, info = env.step(action.item())
            rewards_buf[step] = torch.tensor(reward, device=device)

            # 保持主宇宙完全隔离，全量冷轨迹沉淀至本地 SQLite 训练源
            replay_buffer.save_transition(
                env.tick, next_obs.cpu().numpy(), action.item(),
                reward, next_obs_np, done, chaos
            )

            next_obs = torch.tensor(next_obs_np, device=device)
            next_done = torch.tensor([done], device=device, dtype=torch.float32)

            if done:
                next_obs = torch.tensor(env.reset(), device=device)

        # 2. GAE 广义优势估计计算
        with torch.no_grad():
            next_value = agent.get_value(next_obs).reshape(-1)
            advantages = torch.zeros_like(rewards_buf, device=device)
            lastgaelam = 0
            for t in reversed(range(Config.NUM_STEPS)):
                if t == Config.NUM_STEPS - 1:
                    nextnonterminal = 1.0 - next_done.item()
                    nextvalues = next_value
                else:
                    nextnonterminal = 1.0 - dones_buf[t + 1].item()
                    nextvalues = values_buf[t + 1]
                delta = rewards_buf[t] + Config.GAMMA * nextvalues * nextnonterminal - values_buf[t]
                advantages[t] = lastgaelam = delta + Config.GAMMA * Config.GAE_LAMBDA * nextnonterminal * lastgaelam
            returns = advantages + values_buf

        # 展平批次向量，准备梯度迭代
        b_obs = obs_buf.reshape((-1, Config.OBS_DIM))
        b_logprobs = logprobs_buf.reshape(-1)
        b_actions = actions_buf.reshape(-1)
        b_advantages = advantages.reshape(-1)
        b_returns = returns.reshape(-1)
        b_values = values_buf.reshape(-1)

        # 3. PPO Minibatch 策略裁剪与价值双重约束更新
        b_inds = np.arange(Config.NUM_STEPS)
        for epoch in range(Config.PPO_EPOCHS):
            np.random.shuffle(b_inds)
            for start in range(0, Config.NUM_STEPS, Config.BATCH_SIZE):
                end = start + Config.BATCH_SIZE
                mb_inds = b_inds[start:end]

                _, newlogprob, entropy, newvalue = agent.get_action_and_value(
                    b_obs[mb_inds], b_actions[mb_inds].long()
                )
                logratio = newlogprob - b_logprobs[mb_inds]
                ratio = logratio.exp()

                # 优势值批次标准化 (Minibatch Normalization)
                mb_advantages = b_advantages[mb_inds]
                mb_advantages = (mb_advantages - mb_advantages.mean()) / (mb_advantages.std() + 1e-8)

                # Actor 损失裁剪限制 (Policy Clipping Loss)
                pg_loss1 = -mb_advantages * ratio
                pg_loss2 = -mb_advantages * torch.clamp(ratio, 1.0 - Config.CLIP_COEF, 1.0 + Config.CLIP_COEF)
                pg_loss = torch.max(pg_loss1, pg_loss2).mean()

                # Critic 价值裁剪控制 (Value Function Clipping)
                newvalue = newvalue.view(-1)
                v_loss_unclipped = (newvalue - b_returns[mb_inds]) ** 2
                v_clipped = b_values[mb_inds] + torch.clamp(
                    newvalue - b_values[mb_inds],
                    -Config.CLIP_COEF,
                    Config.CLIP_COEF,
                )
                v_loss_clipped = (v_clipped - b_returns[mb_inds]) ** 2
                v_loss_max = torch.max(v_loss_unclipped, v_loss_clipped)
                v_loss = 0.5 * v_loss_max.mean()

                # 熵正则化增益计算
                entropy_loss = entropy.mean()
                loss = pg_loss - Config.ENT_COEF * entropy_loss + v_loss * Config.VF_COEF

                optimizer.zero_grad()
                loss.backward()
                nn.utils.clip_grad_norm_(agent.parameters(), Config.MAX_GRAD_NORM)
                optimizer.step()

        if global_step % 1280 == 0:
            print(f"Step {global_step:05d} | Avg Reward: {rewards_buf.mean().item():.3f} | Value Loss: {v_loss.item():.4f}")

    # 保存权重冷沉淀
    os.makedirs("policy/checkpoints", exist_ok=True)
    torch.save(agent.state_dict(), "policy/checkpoints/runtime_ppo_governor.pt")
    print("Runtime PPO Governor 训练完成，模型已导出。")


if __name__ == "__main__":
    main()
