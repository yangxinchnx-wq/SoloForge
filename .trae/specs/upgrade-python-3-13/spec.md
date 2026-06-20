# SoloForge 全项目 Python 3.13.9 + Node 24 LTS 升级 Spec

## Why

当前项目锁定 Python 3.12.10 与 Node 22 LTS,但生态(PyTorch 2.6+、LanceDB 0.20+、pyarrow 17+、numba 0.61+、Node 24 LTS)对 Python 3.13 与 Node 24 的支持已成熟。需要建立一条**端到端、可回滚、低破坏面**的升级路径,使项目能在 Python 3.13.9 + Node 24 LTS 上跑通全链路(后端 MARL 服务、AI 社会数据库、迁移脚本、Electron 打包),同时严格遵守"最大稳定性 > 最大性能 > 顶级性能"的优先级与"先改文档、再改代码"的合规顺序。

## What Changes

- **BREAKING** 修改 [系统规格说明.md:283](file:///c:/Users/yangx/Desktop/SoloForge/系统规格说明.md) 与 [前端设想.md:68](file:///c:/Users/yangx/Desktop/SoloForge/前端设想.md) 中的"禁止使用 Python 3.13 / Node 24"约束
- **BREAKING** 替换 `bin/python-3.12/` 为 `bin/python-3.13/`(python-build-standalone 3.13 运行时)
- 升级 `python/requirements.txt` 中所有 C 扩展依赖到 3.13 兼容版本(torch / lancedb / pyarrow / numba / numpy)
- 升级 `python/pyproject.toml` 的 `requires-python` 与 ruff `target-version`
- 更新所有启动脚本([python/run_marl.bat](file:///c:/Users/yangx/Desktop/SoloForge/python/run_marl.bat)、[python/run_marl.sh](file:///c:/Users/yangx/Desktop/SoloForge/python/run_marl.sh)、[run_trainer.bat](file:///c:/Users/yangx/Desktop/SoloForge/python/run_trainer.bat)、[run_service.bat](file:///c:/Users/yangx/Desktop/SoloForge/python/run_service.bat)、[run_tests.bat](file:///c:/Users/yangx/Desktop/SoloForge/python/run_tests.bat))的 Python 路径
- 更新 TypeScript 端跨语言 IPC 假设([src/mxc-bridge.ts](file:///c:/Users/yangx/Desktop/SoloForge/src/mxc-bridge.ts) 中 Python 路径常量)
- 重训 PPO 策略权重并重新 dump `.pt` 模型文件
- 删除空的 `data/ai_society/` 目录,让 `DatabaseManager.initialize()` 重新建库
- 修改 CI 工作流 [.github/workflows/test.yml](file:///c:/Users/yangx/Desktop/SoloForge/.github/workflows/test.yml) 中 Python 矩阵

## Impact

- **Affected specs**:
  - [系统规格说明.md § 版本要求](file:///c:/Users/yangx/Desktop/SoloForge/系统规格说明.md#L271-L283)
  - [前端设想.md § 端口与依赖](file:///c:/Users/yangx/Desktop/SoloForge/前端设想.md#L60-L68)
  - [python/README.md](file:///c:/Users/yangx/Desktop/SoloForge/python/README.md) 版本表
  - [任务进度.md](file:///c:/Users/yangx/Desktop/SoloForge/任务进度.md) 后续追加
- **Affected code**:
  - `bin/python-3.12/` → `bin/python-3.13/`(整目录替换)
  - `python/requirements.txt` 依赖锁
  - `python/pyproject.toml` 元数据
  - `python/soloforge_ai_society/__init__.py` `__python_version__`
  - `python/run_*.bat` / `python/run_*.sh` 启动脚本
  - `python/marl_service/models/*.pt` 模型权重(需重训)
  - `python/experiments/ppo/*.py` 训练脚本(可能需微调)
  - `src/mxc-bridge.ts` 路径常量
  - `.github/workflows/test.yml` Python 矩阵

## ADDED Requirements

### Requirement: Python 3.13 运行时可用
The system SHALL 提供 python-build-standalone 3.13.x 的便携构建,放置在 `bin/python-3.13/` 目录下,且所有启动脚本 SHALL 引用该路径。

#### Scenario: 启动 MARL 服务成功
- **WHEN** 用户执行 `python\run_marl.bat`
- **THEN** 系统 SHALL 启动 Python 3.13.x 并成功运行 `marl_service.server`,且无 `SyntaxError` 或 `ImportError`

### Requirement: 依赖矩阵升级
The system SHALL 将 [python/requirements.txt](file:///c:/Users/yangx/Desktop/SoloForge/python/requirements.txt) 中的所有 C 扩展依赖升级到 3.13 兼容版本:`torch>=2.6.0,<3.0.0`、`numpy>=2.0.0,<3.0.0`、`lancedb>=0.20.0,<1.0.0`、`pyarrow>=17.0.0,<20.0.0`、`numba>=0.61.0,<1.0.0`。

#### Scenario: pip install 成功
- **WHEN** 在 3.13 虚拟环境中执行 `pip install -r requirements.txt`
- **THEN** 所有依赖 SHALL 在不源码编译的前提下安装成功

### Requirement: 文档合规先于代码
The system SHALL 在修改任何代码、依赖、配置前,**先**完成 [系统规格说明.md](file:///c:/Users/yangx/Desktop/SoloForge/系统规格说明.md) 与 [前端设想.md](file:///c:/Users/yangx/Desktop/SoloForge/前端设想.md) 中"禁止 Python 3.13"约束的修改,并在 PR 描述中引用此变更。

#### Scenario: PR 描述含文档变更链接
- **WHEN** 提交升级 PR
- **THEN** PR 描述 SHALL 包含指向 [系统规格说明.md](file:///c:/Users/yangx/Desktop/SoloForge/系统规格说明.md) 与 [前端设想.md](file:///c:/Users/yangx/Desktop/SoloForge/前端设想.md) 文档修改的提交链接

### Requirement: AI 社会数据重生
The system SHALL 在 3.13 升级后,首次 `DatabaseManager.initialize()` 时使用全新的 SQLite + LanceDB schema(无遗留数据),且 `data/ai_society/` 目录 SHALL 被视为可重新生成。

#### Scenario: 空数据启动成功
- **WHEN** 删除 `data/ai_society/` 后启动系统
- **THEN** 系统 SHALL 在不报错的前提下重建全部 8 张 SQLite 表与 1 个 LanceDB 向量表,并加载预置 institution / culture

### Requirement: 模型权重重生
The system SHALL 在 3.13 升级后,通过 [python/experiments/ppo/ppo_training_100k.py](file:///c:/Users/yangx/Desktop/SoloForge/python/experiments/ppo/ppo_training_100k.py) 重新训练并 dump 新的 `policy.pt` 与 `critic_warmed_v2.pt`,旧 `.pt` 文件 SHALL 归档至 `python/marl_service/models/_archive_3.12/`。

#### Scenario: 重训成功
- **WHEN** 执行 `python experiments/ppo/ppo_training_100k.py`
- **THEN** 训练 SHALL 在 torch 2.6+ 上收敛,且最终 reward SHALL 落入与原报告 ±10% 区间

### Requirement: 跨语言 IPC 兼容
The system SHALL 验证 TypeScript ↔ Python 3.13 的 msgpack IPC 在 [src/mxc-bridge.ts](file:///c:/Users/yangx/Desktop/SoloForge/src/mxc-bridge.ts) 与 [python/marl_service/server.py](file:///c:/Users/yangx/Desktop/SoloForge/python/marl_service/server.py) 之间能正常 round-trip,且无 3.13 特有的 `OverflowError` 或 `DeprecationWarning` 阻断业务。

#### Scenario: IPC 心跳成功
- **WHEN** 后端通过 IPC 发送心跳帧
- **THEN** Python 3.13 服务 SHALL 在 100ms 内返回响应,且日志中 SHALL 不出现 `DeprecationWarning`

## MODIFIED Requirements

### Requirement: Python 版本要求
原约束:Python 3.12.x 锁定,禁止 3.13
新约束:Python 3.13.x 推荐,3.12 仍兼容(向后兼容直到 2026-Q4 切换截止)

### Requirement: ruff target-version
原约束:`target-version = "py312"`
新约束:`target-version = "py313"`

### Requirement: `__python_version__` 元数据
原约束:`__python_version__ = ">=3.12"`
新约束:`__python_version__ = ">=3.13"`

## REMOVED Requirements

### Requirement: Python 3.13 禁用
**Reason**: 生态已成熟(pytorch 2.6+、lancedb 0.20+、pyarrow 17+、numba 0.61+ 均官方支持 3.13),且 3.12 维护期至 2028-10 但生态已先行。
**Migration**: 在 3.13 上跑通全部 100+ 单元测试 + 6 个迁移 + 全链路冒烟,方可关闭 3.12 路径。
