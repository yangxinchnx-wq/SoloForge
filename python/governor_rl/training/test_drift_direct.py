# -*- coding: utf-8 -*-
import sys
import os
sys.stdout.reconfigure(encoding='utf-8')

# Test hyperparameter drift module directly
try:
    # Import hyperparameter_drift without going through __init__.py
    import importlib.util
    script_dir = os.path.dirname(os.path.abspath(__file__))
    spec = importlib.util.spec_from_file_location(
        "hyperparameter_drift", 
        os.path.join(script_dir, "hyperparameter_drift.py")
    )
    drift_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(drift_module)
    
    HyperparameterDriftExperiment = drift_module.HyperparameterDriftExperiment
    DriftType = drift_module.DriftType
    HyperparameterSpace = drift_module.HyperparameterSpace
    DriftResult = drift_module.DriftResult
    
    print('✅ Hyperparameter Drift module imported successfully')
    
    # Quick demo
    experiment = HyperparameterDriftExperiment(
        drift_type=DriftType.MOMENTUM,
        governance_enabled=True,
    )
    
    print('\n📊 Running 20 drift steps...')
    for i in range(20):
        perf = 0.5 + i * 0.02 + (hash(str(i)) % 100) / 1000
        result = experiment.step(perf)
        if i % 5 == 0:
            print(f'  Step {i:2d}: perf={perf:.3f}, lr={result.hyperparams["lr"]:.6f}, novelty={result.novelty_score:.3f}')
    
    summary = experiment.get_experiment_summary()
    print(f'\n✅ Experiment Summary:')
    print(f'  Best Performance: {summary["best_performance"]:.4f}')
    print(f'  Total Drifts: {summary["total_drift_count"]}')
    print(f'  Governance Interventions: {summary["governance_interventions"]}')
    
except Exception as e:
    print(f'❌ Error: {e}')
    import traceback
    traceback.print_exc()
