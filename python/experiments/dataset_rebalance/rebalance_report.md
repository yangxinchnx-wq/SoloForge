# Dataset Rebalance Report

**Date**: 2026-05-30

## Hypothesis

降低 noop_ratio 从 57.76% 到 30-35% 会减少 BC POLICY_FREEZE

## Results

### Noop Reduction

| Metric | Before | After |
|--------|--------|-------|
| Noop ratio | 57.76% | 35.25% |
| Total samples | 13,922 | 9,083 |

### Training Data Distribution

**Before:**
```
shrink2:      0 (  0.0%)
shrink1:      3 (  0.0%)
noop:      8,041 ( 57.8%)
expand1:   5,878 ( 42.2%)
expand2:      0 (  0.0%)
```

**After (resampled):**
```
shrink2:      0 (  0.0%)
shrink1:      3 (  0.0%)
noop:      3,202 ( 35.3%)
expand1:   5,878 ( 64.7%)
expand2:      0 (  0.0%)
```

### Key Finding: Missing Actions

**CRITICAL**: The training data has virtually NO shrink actions!
- shrink2: 0 samples (0.0%)
- shrink1: 3 samples (0.0%)
- expand2: 0 samples (0.0%)

This is a **Teacher V3 characteristic**, not a dataset problem.

### BC v1 vs v2 Collapse Comparison

| Governor | Collapse Rate | POLICY_FREEZE | QUEUE_OVERFLOW |
|----------|--------------|---------------|----------------|
| BC v1 | 100% | 5 (100%) | 0 |
| BC v2 | 100% | 2 (40%) | 3 (60%) |

### Analysis

1. **Noop reduction achieved**: 57.76% → 35.25% ✅
2. **But data is still biased**: Only expand1 + noop exist
3. **BC v2 is more diverse in failure modes**: From 100% freeze to 40% freeze + 60% overflow
4. **Collapse rate unchanged**: Both 100%

## Root Cause: Teacher V3 Behavior

The Teacher (AdaptiveGovernorV3) simply does not produce shrink actions. This means:
- Training data cannot learn shrink behavior
- BC and PPO will always be biased toward expand

## Recommendations

### Option A: Modify Teacher to Produce More Diverse Actions
- Requires changing AdaptiveGovernorV3
- Target: Add shrink2, shrink1, expand2 samples

### Option B: Use Synthetic Data Augmentation
- Generate synthetic shrink/expand2 samples
- Risk: May not reflect real governor behavior

### Option C: Change Reward to Encourage Shrink
- If shrinking has positive reward, PPO may discover it
- But BC cannot learn what doesn't exist in data

## Conclusion

**Hypothesis REJECTED for Dataset Rebalance alone.**

The problem is not sampling bias, but **Teacher bias**:
- Teacher V3 never shrinks
- Therefore BC/PPO cannot learn shrink
- Therefore governor cannot adapt to low-load scenarios

**Next step**: Sprint 2B - Risk-aware Reward with modified reward signal
