# -*- coding: utf-8 -*-
import sys
import os

# Force unbuffered output
sys.stdout.flush()
print("TEST: Starting...", flush=True)

# Test 1: Try importing governor_rl.training
try:
    sys.stdout.flush()
    print("TEST: Importing governor_rl.training...", flush=True)
    import governor_rl.training
    sys.stdout.flush()
    print("TEST: governor_rl.training imported OK", flush=True)
except Exception as e:
    sys.stdout.flush()
    print(f"TEST: Import failed: {e}", flush=True)
    import traceback
    traceback.print_exc()

# Test 2: Import hyperparameter_drift directly
try:
    sys.stdout.flush()
    print("TEST: Importing hyperparameter_drift...", flush=True)
    import importlib.util
    script_dir = os.path.dirname(os.path.abspath(__file__))
    spec = importlib.util.spec_from_file_location(
        "hyperparameter_drift", 
        os.path.join(script_dir, "hyperparameter_drift.py")
    )
    drift = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(drift)
    sys.stdout.flush()
    print("TEST: hyperparameter_drift loaded OK", flush=True)
except Exception as e:
    sys.stdout.flush()
    print(f"TEST: Load failed: {e}", flush=True)
    import traceback
    traceback.print_exc()

# Test 3: Run experiment
try:
    sys.stdout.flush()
    print("TEST: Creating experiment...", flush=True)
    exp = drift.HyperparameterDriftExperiment(drift_type=drift.DriftType.MOMENTUM)
    sys.stdout.flush()
    print("TEST: Running 5 steps...", flush=True)
    for i in range(5):
        result = exp.step(0.5 + i * 0.05)
        print(f"TEST Step {i}: lr={result.hyperparams['lr']:.6f}", flush=True)
    print("TEST: DONE!", flush=True)
except Exception as e:
    sys.stdout.flush()
    print(f"TEST: Run failed: {e}", flush=True)
    import traceback
    traceback.print_exc()

sys.stdout.flush()
print("TEST: Script completed", flush=True)
