# bin/ 目录重建说明

> 换电脑或新机部署时，按本文档重建 `bin/`。
> `bin/` 被 `.gitignore` 排除，不会随 Git 迁移，所以新机 `git clone` 之后需要重建。

## 为什么 bin/ 不进 Git

`bin/` 约 3.7 GB，装的都是第三方运行时和本地模型，不是项目源码。塞进 Git 会：

- 逼近 GitHub 单文件 100 MB 的硬限制（历史里的 `surreal.exe` 就有 90.5 MB）
- 迅速耗尽 Git LFS 免费额度（1 GB 存储 / 1 GB 月带宽）
- 让每次 `git clone` 变成 GB 级下载

## 组件清单

| 组件 | 大小 | 必须 | 重建方式 |
|---|---|---|---|
| `python-3.13/` | 1.68 GB | 是 | 脚本 `-Component Python` |
| `models/` | 912 MB（纯 torch 版 470 MB） | 是 | 脚本 `-Component Models` |
| `jdk-23-mini/` | 131 MB | 暂不需要 | 脚本 `-Component Runtimes` |
| `surreal.exe` | 109 MB | 是 | 脚本 `-Component Databases` |
| `qdrant/` | 108 MB | 是 | 脚本 `-Component Databases` |
| `nodejs/` | 94 MB | 否 | 脚本 `-Component Runtimes` |
| `garnet/` | 45 MB | 是 | 脚本 `-Component Databases` |
| `scheduler.exe` | 1.2 MB | 是 | `cargo build`，见下文 |
| `data/` | 592 MB | **否** | 运行时数据，新机自动重建，不要搬 |
| `python-3.13.tar.gz` | 45 MB | **否** | 已解压的冗余压缩包，可直接删 |

`data/` 里是 qdrant 向量存储、duckdb 文件和 pid 文件，都是运行时状态，新机启动会自己生成。

## 一键重建

```powershell
# 全部重建（含 Python，耗时最长）
powershell -ExecutionPolicy Bypass -File scripts\setup-bin.ps1 -Component All -UseMirror

# 只要数据库三件套 + 嵌入模型（默认行为，约 730 MB）
powershell -ExecutionPolicy Bypass -File scripts\setup-bin.ps1 -UseMirror
```

`-UseMirror` 会把 GitHub Release 走 `ghproxy.net`、HuggingFace 走 `hf-mirror.com`、PyPI 走清华镜像。国内网络建议始终带上。

可组合的组件：`Databases` / `Models` / `Runtimes` / `Python` / `All`。已存在的组件会自动跳过，可反复重跑。

## 手动下载链接（脚本失败时的兜底）

脚本里每个组件下载失败都会打印对应链接，也可以直接手动下：

| 组件 | 地址 |
|---|---|
| Python 3.13.14 | `https://www.python.org/ftp/python/3.13.14/python-3.13.14-amd64.exe` |
| SurrealDB 2.0.3 | `https://github.com/surrealdb/surrealdb/releases/tag/v2.0.3` |
| Qdrant 1.18.2 | `https://github.com/qdrant/qdrant/releases/tag/v1.18.2` |
| Garnet 1.1.10 | `https://github.com/microsoft/garnet/releases/tag/v1.1.10` |
| Node 24.15.0 | `https://nodejs.org/dist/v24.15.0/node-v24.15.0-win-x64.zip` |
| JDK 23 | `https://adoptium.net/temurin/releases/?version=23` |
| 嵌入模型 | `https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` |

手动放置位置：

```
bin\surreal.exe
bin\qdrant\qdrant.exe
bin\garnet\portable\net10.0\GarnetServer.exe
bin\models\paraphrase-multilingual-MiniLM-L12-v2\
bin\nodejs\
bin\jdk-23-mini\
bin\python-3.13\
```

## Python 部分（重点）

`bin/python-3.13` 的 `site-packages` 里有 torch 502 MB、lancedb 162 MB、llvmlite 103 MB、scipy 98 MB 等大包，脚本会按 `scripts/requirements-bin.txt`（160 个包）重装。

**两个坑，脚本已经处理了，手动装时请注意：**

1. **torch 必须走 CPU 索引。** PyPI 上的 Windows 版 torch 默认是 CUDA 构建，会拉约 2.5 GB，而项目用的是 CPU 版（502 MB）：
   ```
   pip install torch==2.12.1 --index-url https://download.pytorch.org/whl/cpu
   ```
2. **清掉残留代理。** 本机环境变量里可能有失效的 `HTTP_PROXY`，会让 pip 卡死：
   ```
   set HTTP_PROXY=
   set HTTPS_PROXY=
   pip install -r scripts\requirements-bin.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
   ```

## scheduler.exe 重建

产物来自 `rust_core`，bin target 名是 `scheduler_daemon`：

```powershell
cd rust_core
cargo build --release
copy target\release\scheduler_daemon.exe ..\bin\scheduler.exe
```

## 校验

```powershell
bin\python-3.13\python.exe -c "import torch, sentence_transformers; print(torch.__version__)"
dir bin\surreal.exe, bin\qdrant\qdrant.exe, bin\garnet\portable\net10.0\GarnetServer.exe
```

## 本机可以直接删的

- `bin/python-3.13.tar.gz`（45 MB）—— 解压后剩下的压缩包
- `bin/data/`（592 MB）—— 迁移时不用带，新机自动重建
