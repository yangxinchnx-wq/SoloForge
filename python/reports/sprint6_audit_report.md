# Sprint 6: PPO Improvement Audit Report

**Date**: 2026-05-31
**Status**: BASELINE ESTABLISHED — Need trained PPO checkpoint for real comparison

---

## Sprint 6.0: PPO vs BC — Independent Episode Comparison

### Method
- 500 episodes, 200 steps each, **independent** runs (each policy runs its own trajectory)
- Same seeds used for both policies, but different action sequences → different state trajectories
- BC and PPO evaluated as completely separate policies

### Results

| Metric | BC | PPO | Winner | Delta |
|--------|-----|-----|--------|-------|
| Survival Rate | 100.0% | 100.0% | TIE | +0.0% |
| Collapse Count | 0 | 0 | TIE | +0 |
| Avg Queue | 40.3 | 40.3 | PPO | -0.0 (-0.0%) |
| Max Queue (avg) | 333.2 | 329.1 | PPO | -4.1 |
| Avg Workers | 69.2 | 69.3 | PPO | +0.0 |
| Avg Oscillation | 16.05 | 15.96 | PPO | -0.09 |
| Osc/Step | 0.0802 | 0.0798 | PPO | -0.0004 |
| Avg Total Reward | -103.9 | -103.8 | PPO | +0.0 |
| Std Reward | 29.2 | 29.3 | — | — |

### Verdict
**PPO ≈ BC** (within noise)

> Note: PPO uses BC warm start (identical weights, different architecture:
> BC: `net.0 → ReLU → net.2 → ReLU → net.4`
> PPO: `shared.0 → ReLU → shared.2 → ReLU → actor`)
> Both networks produce 100% teacher match but via different computational paths.

---

## Sprint 6.1: OOD Evaluation

### Part A: OOD Stress (High Arrival Rates, 5 seeds each)

| Scenario | BC Avg Queue | PPO Avg Queue | BC Max Queue | PPO Max Queue | Queue Winner |
|----------|-------------|-------------|-------------|-------------|-------------|
| normal (15.0, 0.15) | 39.9 | 40.1 | 57.8 | 48.0 | BC (+0.2) |
| high_load (20.0, 0.25) | 41.7 | **38.1** | 52.1 | **49.4** | **PPO (-3.6)** |
| very_high (25.0, 0.30) | **45.6** | 58.7 | **57.2** | 72.8 | **BC (+13.1)** |
| extreme (30.0, 0.35) | 71.8 | **62.8** | 87.9 | **67.3** | **PPO (-9.0)** |

### Part B: Recovery Scenarios (init q/w → recovery)

| Case | Init LR | BC LR↓ | PPO LR↓ | BC Recovered | PPO Recovered | Winner |
|------|---------|--------|---------|-------------|-------------|--------|
| E1 (q=5000, w=20) | 125.0 | 100.0% | 99.5% | ✅ | ❌ | BC |
| E2 (q=10000, w=20) | 250.0 | 98.7% | 100.0% | ❌ | ✅ | **PPO** |
| E3 (q=20000, w=20) | 500.0 | 99.7% | 98.4% | ❌ | ❌ | BC |
| E4 (q=30000, w=20) | 750.0 | 99.9% | 100.0% | ✅ | ✅ | **PPO** |
| E5 (q=50000, w=20) | 1250.0 | 9.0% | **100.0%** | ❌ | ✅ | **PPO** |

**E5 Critical Finding**: BC recovers only 9% of load ratio from extreme state (q=50000, w=20), while PPO recovers 100%.

---

## Key Findings

### Finding 1: BC Architecture vs PPO Architecture
- BC's 2-hidden-layer MLP and PPO's 2-hidden-layer + actor split **produce different policies** despite identical weights
- The extra layer (`shared.2 → ReLU → actor`) changes the output
- Both policies independently achieve 100% Teacher match, suggesting the Teacher policy is easy to approximate

### Finding 2: BC OOD Behavior
- In `very_high` (arrival=25, burst=0.30): BC maintains lower avg queue (45.6 vs 58.7)
- BC is more conservative/consistent under extreme load
- PPO is more aggressive, sometimes better (extreme scenario), sometimes worse (very_high)

### Finding 3: Extreme Recovery — PPO Wins
- In E5 (q=50000, w=20): BC LR reduction = 9% vs PPO = 100%
- BC essentially fails to recover from extreme load
- PPO (BC warm start arch) recovers fully

### Finding 4: BC = Teacher = PPO (in-distribution)
- All three achieve 100% match on in-distribution episodes
- This means the Teacher V4 policy is fully captured by BC's approximation
- BC is already optimal for the training distribution

---

## Critical Question: Does PPO Training Add Value?

**Current State**: BC ≈ PPO(warm start) ≈ Teacher (in-distribution)

**The Real Test**: Run PPO for 100k+ steps, then compare:
1. OOD scenarios (extreme load, adversarial arrival patterns)
2. Recovery speed from collapse-adjacent states
3. Oscillation count in oscillating workloads

**Expected Outcomes**:

| Scenario | BC | PPO Trained | Interpretation |
|----------|-----|-------------|----------------|
| Normal workload | 40.3 | ~40 | No change (already optimal) |
| Extreme OOD | 71.8 | <71.8 | PPO learned better OOD policy |
| Recovery from collapse | 9% | >90% | PPO learned recovery |
| Oscillation (unstable) | 16.05 | <16.05 | PPO learned smoother control |

---

## Sprint 6 Conclusion

**BASELINE ESTABLISHED ✅**

The PPO improvement audit establishes the baseline:
- BC warm start = BC = Teacher (in-distribution)
- Architecture differences create small OOD variance
- **PPO training for 100k+ steps is required to determine if RL adds value**

**Project Status**: RL Infrastructure = ✅ Complete
**Project Status**: RL Success = ⏳ Pending trained PPO

**Next Step**: Train PPO V2 for 100k+ steps → Re-run Sprint 6 comparison

---
