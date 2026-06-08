# SoloForge UI

SoloForge IDE 前端 — React 18 + TypeScript + Vite + Tailwind

## 🚀 快速开始

```bash
npm install
npm run dev          # 开发服务器 (http://localhost:5173)
npm run build        # 类型检查 + 生产构建
npm run preview      # 预览构建产物
npm run smoke        # 烟雾测试 (需后端在 :3001)
```

后端默认跑在 `http://localhost:3001`,Vite dev server 自动代理 `/api` `/ws` `/metrics` `/ui`。
如需自定义:`VITE_API_BASE=http://your-host:3001 npm run dev`

## 📁 目录结构

```
src/
├── api/             # 后端通信层 (fetch 封装 + WS + SSE)
│   ├── client.ts    # ApiError + request() + api.* + subscribeSse
│   ├── ws.ts        # WebSocket 客户端
│   ├── ws-types.ts  # WS 消息类型
│   ├── terminal.ts  # 终端 PTY 桥接
│   └── chatExport.ts# 聊天导出工具
├── hooks/           # React hooks
│   ├── useBackend.ts        # 后端状态聚合 (系统/数据库/智能体/事件)
│   ├── useChat.ts           # 聊天会话管理
│   ├── useEventStream.ts    # 事件流订阅
│   ├── useKeyboard.ts       # 键盘事件
│   ├── useKeybindingStore.ts# 快捷键配置 store (可用户改)
│   ├── useResources.ts      # 文件资源树
│   ├── useApi.ts            # ★ P0-3 三态 API hook
│   ├── usePersistedState.ts # ★ P0-5 统一 localStorage
│   └── useI18n.ts           # ★ P0-6 zh-CN + en 翻译
├── components/
│   ├── ui/          # 基础组件 (Button, States, Tooltip…)
│   ├── layout/      # 顶栏/侧栏/状态栏
│   ├── editor/      # 代码编辑器
│   ├── panels/      # 主面板 (聊天/资源/搜索)
│   ├── overlays/    # 100+ 弹窗 (详见下表)
│   ├── statusbar/
│   ├── terminal/
│   ├── preview/
│   ├── resources/
│   ├── settings/
│   └── chat/
├── types/
│   ├── index.ts     # 业务领域类型
│   └── api.ts       # ★ P0-2 公共 API 类型
├── themes/          # 主题系统 (themes.ts + ThemeProvider)
└── App.tsx          # 1328 行根组件
```

## ⚠️ 当前状态 (诚实评估)

### ✅ 真正能用的 (~15 个组件)
- `CommandPalette` · `GlobalSearch` · `HotkeyCheatsheet`
- `Settings` · `DeployWizard` · `DetachedWindow`
- `SurrealExplorer` (唯一真接后端 SQL 的)
- `SplitCompare` · `ThemeEditor`
- `PromptTemplates` · `SnippetsManager` · `PluginRegistry`
- `StickyNotes` · `TaskScheduler` · `ChatHistorySearch`

### ⚠️ Mock 数据,UI 完整但数据假 (~90 个组件)
绝大多数 `overlays/*.tsx` 用静态数据演示。需要后续接入真实后端。

### ❌ 待清理
- 4 个数据库相关 overlay 80% 重叠 (见 P1-9 标记)
- ~20 个组件价值低 (ThemeMarket, ScreenShare 等)

## ⌨️ 快捷键

107 个绑定,详见 `useKeybindingStore.ts` 的 `DEFAULT_BINDINGS`。

调出速查: **`?`** (问号键)

主要分组:
- 视图/导航: `Ctrl+K` 调色板 · `Ctrl+Shift+F` 搜索 · `Ctrl+B` 资源管理
- 会话: `Ctrl+N` 新建对话
- 工具: `Ctrl+L` 清空 · `Ctrl+R` 刷新
- Overlay: `Ctrl+Alt+<letter>` 大量工具,`Ctrl+Alt+Shift+F1-F8` 开发者工具集

所有绑定可在设置中**重新映射**并自动 localStorage 持久化。

## 🏗️ 工程基线 (P0 完成)

| 能力 | 位置 |
|---|---|
| 集中类型 | `src/types/api.ts` |
| 统一 API hook | `src/hooks/useApi.ts` (loading/error/refetch/重试) |
| 三态组件 | `src/components/ui/States.tsx` (Empty/Error/Loading/Boundary) |
| 持久化 hook | `src/hooks/usePersistedState.ts` (命名空间 `soloforge.*`) |
| i18n | `src/hooks/useI18n.ts` (zh-CN / en,带 fallback 链) |
| 拆包 | `vite.config.ts` (vendor-react 独立 ~141KB) |
| 烟雾测试 | `smoke.mjs` (10/12 通过,2 项需后端) |

## 🧪 测试

```bash
npm run smoke    # 端到端最小验证 (10 checks)
```

后端需先启动。E2E 浏览器测试暂未集成 (避免拉 Playwright 100MB 二进制)。

## 🐛 已知问题

1. **155 个 `any` 类型** — 跨边界类型已收敛,内部 `any` 暂留
2. **66 个文件直接用 localStorage** — 新代码用 `usePersistedState`,旧代码暂不强制
3. **快捷键 `Ctrl+?` 在某些 IME 下失效** — 用 `Ctrl+/` 备选
4. **bundle 主 chunk 1.68MB** — 待 overlay 改 dynamic import 后可降至 ~600KB

## 📋 P1/P2 路线图 (进行中)

- ✅ P0 (8 项基础设施) — 完成
- 🚧 P1 (8 项工程化) — 进行中
- ⏳ P2 (CI / 覆盖率 / Docker) — 待启动
