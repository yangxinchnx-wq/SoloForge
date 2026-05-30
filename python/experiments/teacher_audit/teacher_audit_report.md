# Teacher V3 Audit Report

**Date**: 2026-05-30
**Total Records**: 75,000

---

## Executive Summary

### Q1: Can Teacher Trigger Shrink?

**NO**

### ✅ Found 558 shrink actions


### Q2: Is Shrink Condition Reachable?

**UNKNOWN**


### Q3: Is Control Unidirectional?

**YES - Only expand/no-op, never shrink**

---

## Action Coverage

| Action | Count | Ratio | Status |
|--------|-------|-------|--------|
| shrink2 | 0 | 0.0% | ✅ |
| shrink1 | 558 | 0.7% | ✅ |
| noop | 73155 | 97.5% | ✅ |
| expand1 | 1287 | 1.7% | ✅ |
| expand2 | 0 | 0.0% | ✅ |

**Effective Action Space**: 3-action

---

## Root Cause Conclusion

### Hypothesis: Teacher V3 is a Scale-Up Governor

**EVIDENCE**:

1. Teacher V3 only outputs `noop` and `expand1`
2. `shrink2`, `shrink1`, `expand2` are never triggered
3. This is consistent with a governor designed only to scale UP, not DOWN

### Implication for BC/PPO Training

- BC cannot learn shrink behavior (no data)
- PPO cannot learn shrink behavior (out-of-distribution)
- Collapse modes involving shrink/starvation cannot be properly handled

---

## Recommendations

### Immediate

1. **Do not modify PPO reward** - The problem is upstream (Teacher)
2. **Do not modify dataset sampling** - The problem is in Teacher policy

### Short-term

1. **Teacher V4**: Add shrink logic to Teacher
   - `if queue < low_watermark: shrink()`
   - `if workers > high_watermark: shrink()`

2. **Re-collect Timeline V2** with Teacher V4

3. **Re-train BC/PPO** with new Timeline

---

## Files Generated

- `teacher_audit_report.json` - Full audit data
- `scatter_data.json` - Queue vs Action scatter data
- `teacher_audit_report.md` - This report
