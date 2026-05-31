# -*- coding: utf-8 -*-
import sys
sys.stdout.reconfigure(encoding='utf-8')

# 直接导入不经过 __init__.py
import importlib.util
import os

script_dir = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('drift', os.path.join(script_dir, 'hyperparameter_drift.py'))
drift = importlib.util.module_from_spec(spec)
spec.loader.exec_module(drift)

print('✅ Full module imported!')

exp = drift.HyperparameterDriftExperiment(drift_type=drift.DriftType.MOMENTUM)
for i in range(10):
    result = exp.step(0.5 + i * 0.05)
    if i % 3 == 0:
        print(f'Step {i}: lr={result.hyperparams["lr"]:.6f}, novelty={result.novelty_score:.4f}')

print('✅ Full drift experiment PASSED!')
