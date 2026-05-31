# SoloForge Governor RL: Training Module
# torch 是可选依赖

try:
    from .behavioral_cloning import (
        BehavioralCloning,
        DemonstrationDataset,
        collect_demonstrations,
        load_demonstrations_from_timeline,
    )
    HAS_BC = True
except ImportError:
    BehavioralCloning = None
    DemonstrationDataset = None
    collect_demonstrations = None
    load_demonstrations_from_timeline = None
    HAS_BC = False

try:
    from .ppo_trainer import (
        PPOTrainer,
        PPOConfig,
        RolloutBuffer,
        warm_start_from_bc,
    )
    HAS_PPO = True
except ImportError:
    PPOTrainer = None
    PPOConfig = None
    RolloutBuffer = None
    warm_start_from_bc = None
    HAS_PPO = False

try:
    from .shadow_evaluator import (
        ShadowEvaluator,
        ShadowComparison,
        ShadowEvaluationResult,
    )
    HAS_SHADOW = True
except ImportError:
    ShadowEvaluator = None
    ShadowComparison = None
    ShadowEvaluationResult = None
    HAS_SHADOW = False

try:
    from .curriculum_rollout import collect_rollouts
    from .dataset_sampler import sample_transitions, validate_dataset
    HAS_DATA = True
except ImportError:
    collect_rollouts = None
    sample_transitions = None
    validate_dataset = None
    HAS_DATA = False

__all__ = [
    # Behavioral Cloning
    'BehavioralCloning',
    'DemonstrationDataset',
    'collect_demonstrations',
    'load_demonstrations_from_timeline',
    # PPO Training
    'PPOTrainer',
    'PPOConfig',
    'RolloutBuffer',
    'warm_start_from_bc',
    # Shadow Evaluation
    'ShadowEvaluator',
    'ShadowComparison',
    'ShadowEvaluationResult',
    # Data Pipeline
    'collect_rollouts',
    'sample_transitions',
    'validate_dataset',
    # Availability flags
    'HAS_BC',
    'HAS_PPO',
    'HAS_SHADOW',
    'HAS_DATA',
]
