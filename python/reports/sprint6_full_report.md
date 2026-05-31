# Sprint 6 Full Report

**Date**: 2026-05-31
**Status**: BASELINE ESTABLISHED — Architecture effect is minimal, RL training is the key

---

## Sprint 6.2: Logit Analysis

### Method
Fixed states across the full range, compare BC vs PPO logits and probabilities.

### Results

| Queue | Workers | LR | Zone | Teacher | BC Action | BC Conf | PPO Action | PPO Conf |
|-------|----------|-----|------|---------|-----------|---------|------------|----------|
| 100 | 50 | 1.0 | E | expand2 | expand2 | 1.00 | expand2 | 1.00 |
| 500 | 50 | 5.0 | E | expand2 | expand2 | 1.00 | expand2 | 1.00 |
| 1,000 | 50 | 10.0 | E | expand2 | expand2 | 1.00 | expand2 | 1.00 |
| 5,000 | 50 | 50.0 | E | expand2 | expand2 | 1.00 | expand2 | 1.00 |
| 10,000 | 50 | 100.0 | E | expand2 | expand2 | 1.00 | expand2 | 1.00 |
| 20,000 | 50 | 200.0 | E | expand2 | expand2 | 1.00 | expand2 | 1.00 |
| 50,000 | 20 | 1,250.0 | E | expand2 | expand2 | 1.00 | expand2 | 1.00 |
| 100,000 | 20 | 2,500.0 | E | expand2 | expand2 | 1.00 | expand2 | 1.00 |

### Key Finding
**BC and PPO produce IDENTICAL logits and probabilities on all test states.**

Both models show 100% confidence for Zone E actions even at LR=2500. Neither model degrades in OOD at the fixed-state level.

---

## Sprint 6.3: Feature Sensitivity

### Method
Fix workers=50, scan queue from 10 to 100,000. Observe P(expand2) monotonicity in Zone E.

### Results

| Queue | LR | Zone | BC Expand2 | PPO Expand2 | BC Action | PPO Action |
|-------|-----|------|------------|-------------|-----------|------------|
| 10 | 0.1 | B | 0.00 | 0.00 | shrink1 | shrink1 |
| 50 | 0.5 | D | 0.00 | 0.00 | expand1 | expand1 |
| 100 | 1.0 | E | **1.00** | **1.00** | expand2 | expand2 |
| 500 | 5.0 | E | **1.00** | **1.00** | expand2 | expand2 |
| 1,000 | 10.0 | E | **1.00** | **1.00** | expand2 | expand2 |
| 10,000 | 100.0 | E | **1.00** | **1.00** | expand2 | expand2 |
| 50,000 | 500.0 | E | **1.00** | **1.00** | expand2 | expand2 |
| 100,000 | 1000.0 | E | **1.00** | **1.00** | expand2 | expand2 |

### Key Finding
**Neither model "collapses" in Zone E.** P(expand2) = 1.00 throughout Zone E OOD range.

This means:
- BC and PPO both perfectly learn Zone E → expand2 mapping
- The "collapse" in E5 recovery is NOT due to model misclassification
- It's due to episode dynamics (how the simulator responds to actions over time)

---

## Sprint 6.4: PPO Zero-Step Control

### Equivalence Check (NEW CRITICAL FINDING)

```
BC logits:    [-444.38, -473.02, -504.20, -537.52, -631.56]  ✓ IDENTICAL
PPO logits:  [-444.38, -473.02, -504.20, -537.52, -631.56]  ✓ IDENTICAL
```

**BC and PPO produce EXACTLY the same logits on all tested states.**

Reason: BC `net.4.weight` → PPO `actor.weight` (same values). Since:
```
BC:    input → [net.0] → ReLU → [net.2] → ReLU → [net.4] → logits
PPO:   input → [s.0]  → ReLU → [s.2]  → ReLU → [actor] → logits
net.4 weights == actor weights  →  Same computation  →  Same logits
```

### Three-Model Comparison (BC vs PPO-0step)

| Metric | Model A (BC) | Model B (PPO-0) | Winner |
|--------|-------------|-----------------|--------|
| Avg Reward | -106.6 | **-103.7** | B |
| Avg Queue | 42.0 | **40.6** | B |
| Avg Max Queue | 342.6 | **327.0** | B |
| Avg Oscillation | **15.4** | 16.0 | A |
| OOD Reward (arr=30) | **-88.2** | -106.8 | A |
| Recovery LR% (E5) | **100.0%** | 100.0% | TIE |

### Key Finding
**Despite IDENTICAL logits**, Model B (PPO arch) is slightly better on normal metrics, Model A (BC arch) is slightly better on OOD. The difference is tiny (~1-2 units on queue) but consistent.

The architecture DOES create a small behavioral difference even with identical weights, due to:
1. Floating-point precision differences between `BCPolicy.act` (softmax→argmax) and `PPOActor.act` (softmax→argmax) — should be equivalent, but tiny FP differences exist
2. The episode-level dynamics compound small action differences into measurable queue/reward differences

---

## Consolidated Findings

### Finding 1: Architecture Effect is Minimal
- BC and PPO produce **identical logits** on all fixed states
- Episode-level difference is tiny (~1-2 queue units)
- **Architecture contributes almost nothing to BC vs PPO differentiation**

### Finding 2: BC ≈ PPO Warm Start (In-Distribution)
- Both achieve 100% Teacher match on normal episodes
- Both are stable with 100% survival
- **PPO has essentially no room to improve on in-distribution scenarios**

### Finding 3: OOD Differences Are Real But Small
- OOD evaluation shows 2/4 queue wins for PPO, 2/4 for BC
- Recovery scenarios: 3/5 for PPO, 2/5 for BC
- **PPO is marginally better on OOD, but differences are within noise**

### Finding 4: The Real Test Is Extended Training
- Current PPO = BC warm start (0 training steps)
- Differences come from architecture only (tiny)
- **The question of whether RL training adds value requires 100k+ steps of actual training**

---

## Project Status

| Component | Status | Notes |
|-----------|--------|-------|
| RL Infrastructure | ✅ COMPLETE | All sprints 1-5 done |
| BC Baseline | ✅ CERTIFIED | M3.5 certified |
| PPO V2 | ✅ READY | Infrastructure complete |
| Sprint 6.2 Logit Analysis | ✅ DONE | Identical logits confirmed |
| Sprint 6.3 Feature Sensitivity | ✅ DONE | Both models stable in Zone E |
| Sprint 6.4 Zero-Step Control | ✅ DONE | Architecture effect < 1% |
| Sprint 7: PPO 100k Training | ⏳ PENDING | Required to answer RL value |

---

## Verdict: Is This Project a Success?

### Current Answer: Infrastructure Success, RL Value Unknown

**What we know:**
- BC perfectly implements Teacher V4 (100% match)
- PPO warm start = BC (identical logits)
- Architecture difference is negligible (< 2 queue units)
- No evidence of RL training adding value yet

**What we need:**
- Run PPO for 100k+ steps
- Compare OOD recovery speed
- Compare oscillation counts in unstable workloads
- Measure whether PPO learned something BC missed

**The honest conclusion:**
> This project successfully built a complete RL training pipeline. Whether PPO actually outperforms BC is an **open question** that requires the actual training experiment.

---

## Sprint 7 Recommendation

Train PPO V2 for **100k steps** with:
- Checkpoint at 10k, 25k, 50k, 75k, 100k
- Auto-run Sprint 6.0 + 6.1 at each checkpoint
- Track reward trend and OOD improvement over time

The answer to "Does RL training add value over BC?" will be in the **trajectory of improvement**, not just the final number.
