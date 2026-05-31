# SoloForge Governor RL — Lessons Learned

**Project**: SoloForge Governor RL
**Closed**: 2026-05-31
**Status**: CLOSED (Level C — Gate 5)
**Production Policy**: BC V3.1

---

## Lesson 1: Dataset Quality > Algorithm Complexity

**What we believed**: Better algorithms (BC → PPO) would yield better results.

**What we found**: The largest gains came from fixing the Teacher policy and relabeling the dataset, not from algorithm upgrades.

**What to do next time**:
```
Fix the data first.
Then choose the algorithm.
Never use a complex algorithm to compensate for bad data.
```

---

## Lesson 2: Audit the Reward Function Before Training

**What we believed**: The reward function was correct by design.

**What we found**: Sprint 5.2 reward validation revealed that `expand2` had the lowest reward in Zone E — PPO could have learned a policy that actively avoids recovery, with no training signal to indicate this was wrong.

**What to do next time**:
```
Reward Validation must precede PPO Training.
Run formal audits on all reward zones before committing to training.
A reward function bug is invisible during training.
```

---

## Lesson 3: BC Is a Diagnostic Tool, Not a Competitor

**What we believed**: We were comparing BC vs PPO as competing policies.

**What we found**: BC = baseline. PPO = deviation from baseline. When `BC ≈ Teacher` (100% match), PPO not improving is diagnostic information, not a failure.

**What to do next time**:
```
Use BC as a sanity check.
If BC ≈ Teacher, the reward function is saturated.
In that case, PPO has no error signal to optimize against.
This is a legitimate stopping condition.
```

---

## Lesson 4: OOD and Recovery Metrics Hide in Averages

**What we believed**: Average metrics (Avg Queue, Avg Reward) are sufficient for policy comparison.

**What we found**:
```
Avg Queue:  BC ≈ PPO (within noise)
Recovery:   BC = 79.4%, PPO = 98.9%
```

Average metrics completely hide the one scenario where PPO provides genuine value (extreme crash recovery, q ≥ 50,000).

**What to do next time**:
```
Always include stress and recovery benchmarks.
Average metrics obscure tail behavior.
For Governor-class systems, survival under extreme load is the real product requirement.
```

---

## Lesson 5: "Continue Training" Requires Evidence

**What we believed**: Project continuation is the default. Stopping requires a reason.

**What we found**: The correct framing is the opposite — stopping is the default. Continuing requires new evidence.

**What to do next time**:
```
Define stopping conditions before starting.
Define evidence thresholds for continuation before training.
"Continue" is a hypothesis. "Stop" is the null.
When the evidence falsifies the continuation hypothesis, stop.
Do not treat training as a search without a defined end.
```

---

## Root Cause: Objective Saturation

The central finding of this project is not that "PPO failed."

The central finding is:

```
When BC ≈ Teacher (100% match),
and Reward encodes Teacher preferences,
PPO has no exploitable error signal.
PPO ≈ BC is the correct behavior, not a failure.
```

This is not a training problem. It is a problem formulation problem.

Future work that wants PPO to outperform BC must first change one of:
```
- The Teacher policy (different objective)
- The Reward function (different shaping)
- The Environment definition (different problem)
- The OOD distribution (different target)
```

Changing the PPO training configuration (steps, learning rate, network size) will not help. The bottleneck is upstream.

---

## Project Governance Summary

| Question | Answer |
|----------|--------|
| Was the project correctly scoped? | Yes. All gates completed. |
| Was the stopping condition defined in advance? | Yes. Gate 5 thresholds defined before training. |
| Was the conclusion based on evidence or belief? | Evidence. Full causal chain verified. |
| Is the project closeable? | Yes. Evidence sufficient. |
| Is it reopenable? | Yes — if a premise changes. |

---

## Final Note

A project that can rigorously explain why it stopped is more valuable than a project that keeps running.

The ability to close — with evidence, not excuses — is the most underrated engineering discipline.

```
SoloForge Governor RL
    Closed: 2026-05-31
    Reason: Evidence sufficient
    Restart condition: Premise change
    Status: Final
```
