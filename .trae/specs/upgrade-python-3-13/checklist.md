# Checklist

## 文档合规
- [x] [系统规格说明.md:276](file:///c:/Users/yangx/Desktop/SoloForge/系统规格说明.md) Node.js 22 LTS 注明"24 LTS 可选,需 ≥ 22.11"
- [x] [系统规格说明.md:283](file:///c:/Users/yangx/Desktop/SoloForge/系统规格说明.md) "禁止 Node 24 / Python 3.13" 已删除,改为"禁止 Rust nightly"
- [x] [系统规格说明.md:277](file:///c:/Users/yangx/Desktop/SoloForge/系统规格说明.md) Python 精确到 3.13.9
- [x] [前端设想.md:60](file:///c:/Users/yangx/Desktop/SoloForge/前端设想.md) Python 精确到 3.13.9
- [x] [前端设想.md:68](file:///c:/Users/yangx/Desktop/SoloForge/前端设想.md) 约束行更新(去掉 Node 24 / Python 3.13 禁用)
- [x] [python/README.md:29](file:///c:/Users/yangx/Desktop/SoloForge/python/README.md) 版本表 3.13.9
- [x] 5 个启动脚本(run_marl.bat/sh、run_trainer.bat、run_service.bat、run_tests.bat)echo 与错误消息精确到 3.13.9
- [ ] 文档变更 PR 已先于代码 PR 合并 — 沙箱外

## 运行时到位
- [ ] `bin/python-3.13/python.exe --version` 输出 3.13.9 — 沙箱外
- [ ] python-build-standalone 3.13 构建 SHA256 校验通过 — 沙箱外
- [ ] 旧 `bin/python-3.12/` 目录已删除 — 沙箱外
- [ ] python 3.13 虚拟环境创建成功 — 沙箱外

## 依赖安装
- [ ] `pip install -r requirements.txt` 在 3.13 上零源码编译 — 沙箱外
- [ ] `python -c "import torch; print(torch.__version__)"` 输出 2.6+ — 沙箱外
- [ ] `python -c "import lancedb; print(lancedb.__version__)"` 输出 0.20+ — 沙箱外
- [ ] `python -c "import pyarrow; print(pyarrow.__version__)"` 输出 17+ — 沙箱外
- [ ] `python -c "import numba; print(numba.__version__)"` 输出 0.61+ — 沙箱外
- [ ] `python -c "import numpy; print(numpy.__version__)"` 输出 2.0+ — 沙箱外

## 配置文件同步
- [x] [python/requirements.txt](file:///c:/Users/yangx/Desktop/SoloForge/python/requirements.txt) 全部依赖锁已升
- [x] [python/pyproject.toml:11](file:///c:/Users/yangx/Desktop/SoloForge/python/pyproject.toml) `requires-python = ">=3.13"`
- [x] [python/pyproject.toml:30](file:///c:/Users/yangx/Desktop/SoloForge/python/pyproject.toml) `target-version = "py313"`
- [x] [python/soloforge_ai_society/__init__.py:43](file:///c:/Users/yangx/Desktop/SoloForge/python/soloforge_ai_society/__init__.py) `__python_version__ = ">=3.13"`

## 启动脚本
- [x] [python/run_marl.bat](file:///c:/Users/yangx/Desktop/SoloForge/python/run_marl.bat) 路径指向 python-3.13
- [x] [python/run_marl.sh](file:///c:/Users/yangx/Desktop/SoloForge/python/run_marl.sh) 路径指向 python-3.13
- [x] [python/run_trainer.bat](file:///c:/Users/yangx/Desktop/SoloForge/python/run_trainer.bat) 路径指向 python-3.13
- [x] [python/run_service.bat](file:///c:/Users/yangx/Desktop/SoloForge/python/run_service.bat) 路径指向 python-3.13
- [x] [python/run_tests.bat](file:///c:/Users/yangx/Desktop/SoloForge/python/run_tests.bat) 路径指向 python-3.13
- [x] [src/mxc-bridge.ts](file:///c:/Users/yangx/Desktop/SoloForge/src/mxc-bridge.ts) — 实际无 Python 常量,无需修改

## 数据重生
- [x] `data/ai_society/` 目录已清空(目录不存在,无需操作)
- [ ] 8 张 SQLite 表自动创建成功 — 沙箱外
- [ ] LanceDB social_memory 向量表创建成功 — 沙箱外
- [ ] 预置 institution / culture 数据已加载 — 沙箱外

## 模型重生
- [ ] 旧 `.pt` 文件已归档至 `_archive_3.12/` — 沙箱外
- [ ] PPO 100k 重训完成 — 沙箱外
- [ ] reward 曲线与 [python/artifacts/long_horizon.json](file:///c:/Users/yangx/Desktop/SoloForge/python/artifacts/long_horizon.json) 对比在 ±10% 区间 — 沙箱外
- [ ] 新 `policy.pt` 与 `critic_warmed_v2.pt` 已 dump — 沙箱外
- [ ] `torch.load(..., weights_only=True)` 加载成功 — 沙箱外

## IPC 兼容
- [ ] Python 3.13 MARL 服务成功启动 — 沙箱外
- [ ] TypeScript 后端 IPC 心跳 round-trip < 100ms — 沙箱外
- [ ] 日志中无 `DeprecationWarning` — 沙箱外
- [ ] 日志中无 `OverflowError` 或 `RuntimeWarning` — 沙箱外

## 全链路测试
- [ ] `pytest python/tests/ -v` 全部通过 — 沙箱外
- [ ] `npm test` 后端 vitest 全部通过 — 沙箱外
- [ ] `npm run db:migrate` 6 个 SurrealDB 迁移脚本不受影响 — 沙箱外
- [ ] `python run_marl.bat` 完整启动 — 沙箱外
- [ ] `npm run electron:dev` 三方联通(UI 3000 / 后端 3001 / Python IPC) — 沙箱外

## CI 同步
- [x] [.github/workflows/test.yml](file:///c:/Users/yangx/Desktop/SoloForge/.github/workflows/test.yml) Python 3.13 矩阵添加
- [ ] GitHub Actions 跑通 — 沙箱外

## 升级后收尾
- [x] [任务进度.md](file:///c:/Users/yangx/Desktop/SoloForge/任务进度.md) 追加升级记录
- [ ] `_archive_3.12/` 旧模型完整保留 — 沙箱外(Task 6 完成后)
- [ ] 所有变更 PR 合并 — 沙箱外
