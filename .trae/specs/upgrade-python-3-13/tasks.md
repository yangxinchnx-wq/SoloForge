# Tasks

- [x] Task 1: 文档合规审批 — 升级前的"通行证"
  - [x] SubTask 1.1: 修改 [系统规格说明.md:283](file:///c:/Users/yangx/Desktop/SoloForge/系统规格说明.md) 把"禁止使用 Python 3.13"改为"推荐 Python 3.13(3.12 兼容至 2026-Q4)"
  - [x] SubTask 1.2: 修改 [前端设想.md:68](file:///c:/Users/yangx/Desktop/SoloForge/前端设想.md) 同步约束(删除"Python 3.13"禁用条目)
  - [x] SubTask 1.3: 修改 [python/README.md:29](file:///c:/Users/yangx/Desktop/SoloForge/python/README.md) 版本表("Python 3.12.10" → "Python 3.13.x")
  - [ ] SubTask 1.4: 提交文档变更 PR(单独 commit,先于代码)— 沙箱外,需用户执行

- [ ] Task 2: 准备 3.13 运行时 — 沙箱外,需用户下载
  - [ ] SubTask 2.1: 从 python-build-standalone releases 下载 Windows cp313 amd64 构建(zip)
  - [ ] SubTask 2.2: 校验 SHA256 与官方公布一致
  - [ ] SubTask 2.3: 解压至 `bin/python-3.13/`
  - [ ] SubTask 2.4: 删除 `bin/python-3.12/` 目录(仅在 Task 1 PR 合并后执行)
  - [ ] SubTask 2.5: 运行 `bin/python-3.13/python.exe --version` 验证

- [x] Task 3: 升级 Python 依赖矩阵
  - [x] SubTask 3.1: 修改 [python/requirements.txt](file:///c:/Users/yangx/Desktop/SoloForge/python/requirements.txt):torch 2.0 → 2.6+
  - [x] SubTask 3.2: 修改 numpy>=1.26 → numpy>=2.0
  - [x] SubTask 3.3: 修改 lancedb>=0.12 → lancedb>=0.20
  - [x] SubTask 3.4: 修改 pyarrow>=14 → pyarrow>=17
  - [x] SubTask 3.5: 修改 numba>=0.59 → numba>=0.61
  - [x] SubTask 3.6: 修改 [python/pyproject.toml:11](file:///c:/Users/yangx/Desktop/SoloForge/python/pyproject.toml) `requires-python = ">=3.12"` → `">=3.13"`
  - [x] SubTask 3.7: 修改 [python/pyproject.toml:30](file:///c:/Users/yangx/Desktop/SoloForge/python/pyproject.toml) `target-version = "py312"` → `"py313"`
  - [x] SubTask 3.8: 修改 [python/soloforge_ai_society/__init__.py:43](file:///c:/Users/yangx/Desktop/SoloForge/python/soloforge_ai_society/__init__.py) `__python_version__ = ">=3.12"` → `">=3.13"`
  - [ ] SubTask 3.9: 在 3.13 虚拟环境跑 `pip install -r requirements.txt`,确认无源码编译 — 沙箱外,需用户执行

- [x] Task 4: 更新所有启动脚本的 Python 路径
  - [x] SubTask 4.1: 修改 [python/run_marl.bat:6](file:///c:/Users/yangx/Desktop/SoloForge/python/run_marl.bat) `python-3.12` → `python-3.13`
  - [x] SubTask 4.2: 修改 [python/run_marl.sh:6](file:///c:/Users/yangx/Desktop/SoloForge/python/run_marl.sh) 路径
  - [x] SubTask 4.3: 修改 [python/run_trainer.bat](file:///c:/Users/yangx/Desktop/SoloForge/python/run_trainer.bat) 路径
  - [x] SubTask 4.4: 修改 [python/run_service.bat](file:///c:/Users/yangx/Desktop/SoloForge/python/run_service.bat) 路径
  - [x] SubTask 4.5: 修改 [python/run_tests.bat](file:///c:/Users/yangx/Desktop/SoloForge/python/run_tests.bat) 路径
  - [x] SubTask 4.6: 修改 [src/mxc-bridge.ts](file:///c:/Users/yangx/Desktop/SoloForge/src/mxc-bridge.ts) 中 Python 可执行文件常量 — 实际无该常量,无需修改

- [x] Task 5: 数据重生 — 已无需操作
  - [x] SubTask 5.1: 删除 `data/ai_society/` 目录 — 目录不存在,无需删除
  - [ ] SubTask 5.2: 启动系统,验证 `DatabaseManager.initialize()` 自动建表成功 — 沙箱外
  - [ ] SubTask 5.3: 验证 8 张 SQLite 表 + 1 个 LanceDB 向量表全部存在 — 沙箱外
  - [ ] SubTask 5.4: 验证预置 institution / culture 数据已加载 — 沙箱外

- [ ] Task 6: 模型权重重生 — 沙箱外
  - [ ] SubTask 6.1: 归档旧 `.pt` 到 `python/marl_service/models/_archive_3.12/`
  - [ ] SubTask 6.2: 执行 `python experiments/ppo/ppo_training_100k.py` 重训
  - [ ] SubTask 6.3: 验证训练收敛(reward 曲线 ±10% 区间)
  - [ ] SubTask 6.4: dump 新 `policy.pt` 与 `critic_warmed_v2.pt`
  - [ ] SubTask 6.5: 验证 `torch.load(..., weights_only=True)` 加载成功

- [ ] Task 7: 验证 IPC 跨语言兼容 — 沙箱外
  - [ ] SubTask 7.1: 启动 [python/marl_service/server.py](file:///c:/Users/yangx/Desktop/SoloForge/python/marl_service/server.py)
  - [ ] SubTask 7.2: 启动后端 `npm start`
  - [ ] SubTask 7.3: 发送心跳帧,验证 Python 3.13 在 100ms 内响应
  - [ ] SubTask 7.4: 抓取日志,确认无 `DeprecationWarning` 阻断业务
  - [ ] SubTask 7.5: 抓取日志,确认无 `OverflowError` 或 `RuntimeWarning`

- [ ] Task 8: 全链路测试 — 沙箱外
  - [ ] SubTask 8.1: 跑 `pytest python/tests/ -v` 全部测试
  - [ ] SubTask 8.2: 跑 `npm test` 后端 vitest
  - [ ] SubTask 8.3: 跑 `npm run db:migrate` 验证 6 个 SurrealDB 迁移脚本不受影响
  - [ ] SubTask 8.4: 跑 `python run_marl.bat` 完整 MARL 服务启动
  - [ ] SubTask 8.5: 跑 Electron 壳 `npm run electron:dev`,验证 UI 3000 ↔ 后端 3001 ↔ Python IPC 三方联通

- [x] Task 9: CI 同步
  - [x] SubTask 9.1: 修改 [.github/workflows/test.yml](file:///c:/Users/yangx/Desktop/SoloForge/.github/workflows/test.yml) 添加 Python 3.13 矩阵
  - [ ] SubTask 9.2: 验证 GitHub Actions 跑通 — 沙箱外
  - [ ] SubTask 9.3: 删除 3.12 matrix 任务(切换截止后)— 推迟到 2026-Q4

- [x] Task 10: 升级后清理与文档
  - [x] SubTask 10.1: 在 [任务进度.md](file:///c:/Users/yangx/Desktop/SoloForge/任务进度.md) 追加升级完成记录
  - [ ] SubTask 10.2: 验证 `_archive_3.12/` 中旧 `.pt` 文件完整保留 — 沙箱外(Task 6 完成后)
  - [ ] SubTask 10.3: 提交所有变更,合并 PR — 沙箱外
