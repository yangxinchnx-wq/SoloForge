# Dataset Balance Audit Report

**Timeline**: datasets/timeline_v3_1.jsonl

**Total Entries**: 157,000

## Audit Checks

| Check | Status |
|-------|--------|
| Action Distribution (max < 40%) | PASS |
| Transition Diversity (>= 10) | PASS |
| Recovery Coverage (> 10%) | PASS |
| Crisis Coverage (> 5%) | PASS |
| Worker Distribution (each > 5%) | PASS |

## Action Distribution

| Action | Ratio | Threshold |
|--------|-------|----------|
| shrink2 | 17.7% | PASS |
| shrink1 | 6.0% | PASS |
| noop | 31.7% | PASS |
| expand1 | 25.5% | PASS |
| expand2 | 19.1% | PASS |

## Transition Diversity

- Unique Transitions: 25
- Recovery Ratio: 14.9%
- Crisis Ratio: 15.5%

## Conclusion

✅ **Timeline V3.1 Certified** - Proceed to BC V3 Training
