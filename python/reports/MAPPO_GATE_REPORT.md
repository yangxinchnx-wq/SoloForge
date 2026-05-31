# MAPPO Gate Protocol — Evaluation Report

**Date**: 2026-05-31
**Status**: FAIL (250/300)
**Network**: `marl_service/models/policy.pt`

---

## ❌ Gate 1: Collaboration Emergence

**Score**: 50/100
**Passed**: False

**Evidence**:
```json
{
  "value_divergence": 1.488883903777599,
  "value_variance": 6.039311832088859e-06,
  "value_trend": 0.00035016973018653363,
  "actor_isolated": true,
  "critic_centralized": true,
  "mean_global_value": 0.2984087933182717,
  "mean_local_estimate": 1.7872926970958707,
  "n_agents": 3,
  "n_episodes": 50
}
```

**Summary**: 价值差异=1.4889, 趋势=+0.0004, 方差=0.000006

---

## ✅ Gate 2: Action Consistency

**Score**: 100/100
**Passed**: True

**Evidence**:
```json
{
  "reward_drop_pct": -0.09222139901616291,
  "entropy_delta": 3.316900730143679e-05,
  "collapse_delta": 0.0,
  "clean_reward": 71.71068915653234,
  "noisy_reward": 71.77682175731663,
  "clean_entropy": 1.7877015761137007,
  "noisy_entropy": 1.7877347451210022,
  "noise_ratio": 0.1
}
```

**Summary**: 奖励下降=-0.1%, 熵增=0.0000, 崩溃率增=0.0%

---

## ✅ Gate 3: Convergence Baseline

**Score**: 100/100
**Passed**: True

**Evidence**:
```json
{
  "loss_trend": -0.4082417330018066,
  "max_value": 7.114940404891968,
  "reward_trend": -0.03726773788535425,
  "mean_entropy": 1.7720468976348638,
  "mean_reward": 24.461416841030122,
  "std_reward": 1.8233583624355865,
  "early_loss": 32.04608268737793,
  "late_loss": 18.963534355163574,
  "n_episodes": 50
}
```

**Summary**: loss趋势=-0.41%, 奖励趋势=-3.7%, max_value=7.11

---

## Overall Verdict

❌ **Some gates failed: Gate 1: Collaboration Emergence**

Action required before production deployment:
  - Gate 1: Collaboration Emergence: 价值差异=1.4889, 趋势=+0.0004, 方差=0.000006

---

## Architecture Alignment

| Layer | Component | Status |
|-------|-----------|--------|
| Decentralized Actor | local_obs_dim=5, action_dim=6 | ✅ Verified |
| Centralized Critic | global_state_dim=5 | ✅ Verified |
| MAPPO (CTDE) | Actor isolates, Critic centralizes | ✅ Verified |
| Warm Start | BC-compatible checkpoint | ⚠️ N/A |

## Relationship with Governor RL

```
governor_rl (completed):
    PPO V2 → BC ≈ Teacher → PPO has no room to improve
    Gate 5: Level C (40/100) → BC V3.1 as production policy

marl_service (this evaluation):
    MAPPO: Multi-agent extension of same PPO framework
    Key difference: Centralized Critic learns joint value
    New challenge: Agent collaboration emergence
```

The governor_rl findings confirm that the base training
infrastructure is sound. MAPPO Gate Protocol verifies that
the multi-agent extension preserves this foundation.
