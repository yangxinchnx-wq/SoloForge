# SoloForge 前端重构方案 — 3 项高 ROI

> **范围**:App.tsx 状态重组 / usePersistedState 推广 / useChannel 抽象
> **节奏**:分批小步快走,每步 1 个独立 commit,可回退
> **作者**:基于对 25 个核心文件的深读(App.tsx 1297 行 + 5 hooks + 4 主题 + 4 API + 2 overlay)
> **日期**:2026-06-20

---

## Summary

SoloForge 前端已具备企业级 IDE 雏形(100+ overlay / 90+ 快捷键 / WS+SSE+HTTP 三通道),但存在三类结构性问题,本次重构聚焦最高 ROI 的三项:

1. **App.tsx 状态爆炸**(P0)— 109 个 useState 全部外提 + 109 行 Esc 栈式关闭,任一 setter 触发整体 re-render,新加 overlay 必须改两处
2. **持久化无统一抽象**(P1)— `usePersistedState` hook 早就写好(L3 注释"P0-5 起步"),但只有 `useI18n` 一处使用;40+ 文件仍裸调 `localStorage.getItem/setItem`
3. **双通道 fallback 重复实现**(P2)— `useBackend`(WS→HTTP)、`useEventStream`(WS→SSE)、`terminal.ts`(HTTP 探针)三处手写,逻辑相似但形态不一

每项独立 PR、独立可回退,完成顺序建议:① App.tsx → ② usePersistedState → ③ useChannel。

---

## Current State Analysis

### 已确认的问题(基于源码)

| 证据 | 文件 | 行 |
|---|---|---|
| 109 个 useState 全部外提 | `UI/src/App.tsx` | L155-263 |
| 手动 109 行 Esc 栈式关闭 | `UI/src/App.tsx` | L442-573 |
| usePersistedState 已存在但仅 1 处用 | `UI/src/hooks/usePersistedState.ts` | L1-69 |
| 40+ 文件裸调 localStorage | `UI/src/**` | 全局 |
| WS→HTTP 双通道重复 | `UI/src/hooks/useBackend.ts` | L90-160 |
| WS→SSE 双通道重复 | `UI/src/hooks/useEventStream.ts` | L40-100 |
| HTTP 探针重复 | `UI/src/api/terminal.ts` | L200-260 |
| CommandPalette 10+ 个 pushToast 占位 | `UI/src/components/overlays/CommandPalette.tsx` | L72-81 |

### 已存在但未铺开的资产

- `usePersistedState` — 完整持久化 hook,带 `readPersisted` / `writePersisted` / `listScopeKeys` 配套
- `getWsClient()` 单例 — `UI/src/api/ws.ts` 已实现心跳 / 重连 / since 补发
- `subscribeSse` — `UI/src/api/client.ts` 已实现 3s 指数重连

### 不动的部分

- 4 个主题文件 / 4 个布局文件(无结构问题)
- 主题系统 / Tailwind 桥接 / YIQ 暗色判断
- 100+ overlay 组件本身(只是按"快捷键已挂但 run 占位"运行,符合产品定位)

---

## Phase 1 — App.tsx 状态重组(P0 · 4 个小步)

### 1.1 抽 useOverlayState hook

**新文件**:`UI/src/hooks/useOverlayState.ts`

**设计**:
```ts
type OverlayKey = string;  // 'palette' | 'settings' | 'tour' | ...
type OverlayApi = {
  isOpen: (k: OverlayKey) => boolean;
  open: (k: OverlayKey) => void;
  close: (k: OverlayKey) => void;
  toggle: (k: OverlayKey) => void;
  closeTop: () => OverlayKey | null;  // 栈式 Esc 关闭
  openedList: OverlayKey[];           // 按打开顺序,栈底→栈顶
};

export function useOverlayState(): OverlayApi;
```

**实现要点**:
- 内部 `useState<Set<OverlayKey>>`,O(1) 增删 + 维护 `order: OverlayKey[]`
- `closeTop()`:找 order 末尾,移除并返回 key
- 用 `useCallback` 锁住所有方法,避免 App.tsx 重复创建
- 单一 `useState`,而不是 109 个 `useState`

**验收**:`pnpm typecheck` 通过,App.tsx 中 109 个 setter 减少到 0 个(只保留 layout/activity 这种业务状态)

### 1.2 App.tsx 替换 100+ useState → 单 Set<OverlayKey>

**改动文件**:`UI/src/App.tsx`

**步骤**:
1. 删除 L155-263 中所有 `const [xxxOpen, setXxxOpen] = useState(false)` 声明(约 90 行)
2. 删除对应的 `setXxxOpen(true)` / `setXxxOpen(false)` 调用(可全局 sed:`setXxxOpen(` → `overlay.open('xxx')` / `overlay.close('xxx')`)
3. 删除 L442-573 的手动 Esc 栈式关闭代码(约 130 行)
4. 在 L442 位置改为 `useEffect(() => { const onKey = (e) => { if (e.key === 'Escape') overlay.closeTop(); }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey); }, [overlay])`
5. 渲染位置 `<Xxx open={xxxOpen} />` 全部改为 `<Xxx open={overlay.isOpen('xxx')} />`

**影响范围**:
- App.tsx 减少约 220 行(1297 → ~1080)
- 渲染性能提升:closeTop() 只 re-render 当前 overlay 子树,而不是整个 App
- 100+ 短路判断:之前 `xxxOpen && <Xxx />`,现在 `overlay.isOpen('xxx') && <Xxx />`,语义一致

**验收**:
- 启动后所有 overlay 都能用原快捷键打开
- Esc 按一次关一个,关完最上层的才进到下层
- 关闭调色板、设置、tour 三个最常用的 overlay 行为完全一致

### 1.3 命名收敛 — OverlayKey 类型化

**改动文件**:`UI/src/hooks/useOverlayState.ts` + App.tsx 引用处

**设计**:
```ts
export const OVERLAY_KEYS = [
  'palette', 'settings', 'tour', 'deploy', 'hotkey', 'themeEditor',
  // ... 共 109 个 key,导出成 const tuple
] as const;
export type OverlayKey = typeof OVERLAY_KEYS[number];
```

**收益**:`isOpen('paltte')` 拼错会编译报错,不再依赖字符串约定

**验收**:全量 `pnpm typecheck` 通过;grep `overlay.isOpen` 调用都使用合法 key

### 1.4 拆 App.tsx 中大型 JSX 块(可选 · 看 PR 体积)

**改动文件**:`UI/src/App.tsx` → 拆出 `UI/src/components/layout/TopLevelOverlays.tsx`

**设计**:把 L600-1297 的 100+ overlay 渲染 `<Xxx open={xxxOpen} onClose={() => setXxxOpen(false)} />` 收编到一个新组件,通过 `props.overlays` 接收 overlay api

**收益**:App.tsx 主体聚焦布局,overlay 渲染单一职责

**备注**:这一步如果 1.1-1.3 之后 App.tsx 已经 ≤ 900 行,可以省略;否则做。

---

## Phase 2 — usePersistedState 推广(P1 · 5 个小步)

### 2.1 列出迁移目标清单

**新建**:`UI/src/data/storageKeys.ts`

**作用**:把 13+ 个 localStorage key 全部列出,带 scope 分类:
```ts
export const STORAGE = {
  chat: { history: 'history.v1', settings: 'settings.v1', explanations: 'explanations.v1' },
  events: { recent: 'recent.v1' },
  keybindings: { store: 'store.v1' },
  theme: { current: 'current', custom: 'custom.v1' },
  activity: { order: 'order' },
  terminal: { history: 'realHistory', env: 'env' },
  ws: { lastSeq: 'lastServerSeq', token: 'token' },
  cmd: { favorites: 'favorites', history: 'history' },
  overlay: { tourCompleted: 'tour.completed' },
  // ... 共 30+ 个
} as const;
```

**验收**:grep `localStorage.getItem|setItem` 的总数减到 0(全改 readPersisted/writePersisted)

### 2.2 迁移 `useChat.ts`(影响面大,优先)

**改动文件**:`UI/src/hooks/useChat.ts`

**步骤**:
- L56-66 sessions 读写 → `usePersistedState('chat', 'history.v1', [...])`
- L68-77 settings → `usePersistedState('chat', 'settings.v1', ...)`
- L92-115 explanations → `usePersistedState('chat', 'explanations.v1', ...)`
- 删掉 5 处裸调 localStorage

**验收**:刷新页面 / 重启 dev server 后,会话、设置、AI 解释都还在;并入 `STORAGE` 命名

### 2.3 迁移 `useEventStream.ts`

**改动文件**:`UI/src/hooks/useEventStream.ts`

**步骤**:
- L34 read / L133 write → `usePersistedState('events', 'recent.v1', [])`
- 节流 500ms 保留(避免高频写盘)

### 2.4 迁移 `useKeybindingStore.ts`

**改动文件**:`UI/src/hooks/useKeybindingStore.ts`

**步骤**:
- L152 read / L158 write → `usePersistedState('keybindings', 'store.v1', DEFAULT)`

### 2.5 批量迁移 30+ overlay 组件

**改动文件**:以下 30+ 文件,把内联 `load() / save()` 函数改为 `usePersistedState`

```
ActivityBar.tsx (order)
ActivityFeed.tsx
CommandPalette.tsx (favorites / history)
Notifications.tsx (collapsed)
ThemeProvider.tsx (current / custom)
App.tsx (tour.completed)
Terminal.tsx (history / env)
CenterPanels.tsx (recent files)
SettingsModal.tsx (prompts)
PerformanceMonitor.tsx
PomodoroStats.tsx (3 个)
PromptTemplates.tsx
ProjectIO.tsx (备份 key)
SnapshotManager.tsx
SplitCompare.tsx (layout)
StickyNotes.tsx
SurrealExplorer.tsx (history)
TaskBoard.tsx
TaskScheduler.tsx
ThemeGenerator.tsx
ThemeMarket.tsx
Translator.tsx (history / glossary)
VoiceChat.tsx
WebhookTester.tsx
WebPreview.tsx (history)
WorkflowPipeline.tsx
UmlTools.tsx
SecretScanner.tsx
ScriptRunner.tsx
QrGenerator.tsx
PluginRegistry.tsx
PluginRegistry.tsx (log)
NotesEditor.tsx
NetworkMonitor.tsx
```

**步骤**:
- 每个文件把 `load() / save()` 删掉,改 `usePersistedState(scope, key, default)`
- localStorage key 从 `soloforge.xxx` → `soloforge.<scope>.<key>`(命名空间)
- **保留 1 个**内部 load(给 reset/export 等非组件代码用 `readPersisted`)

**验收**:
- grep `localStorage\.(get|set)Item` 在 src/ 下为 0 命中
- 保留一个 `storageKeys.ts` 集中管理

### 2.6 加 storage 迁移工具(可选 · 防止老数据丢)

**新文件**:`UI/src/data/migrateStorage.ts`

**作用**:启动时检测老 key(`soloforge.chat.history` 无 `.v1`),有则迁到新 key 后删旧 key

**收益**:用户升级版本不丢会话

**备注**:如果当前用户群里 < 5 个 active dev,这一步可省略;否则做。

---

## Phase 3 — useChannel 双通道抽象(P2 · 3 个小步)

### 3.1 抽 useChannel<T> hook

**新文件**:`UI/src/hooks/useChannel.ts`

**设计**:
```ts
type ChannelMode = 'ws-primary-http-fallback' | 'ws-primary-sse-fallback' | 'http-only';

type ChannelOptions<T> = {
  mode: ChannelMode;
  // WS 订阅
  subscribe?: (handlers: Record<string, (data: any) => void>) => () => void;
  // HTTP 兜底轮询
  poll?: () => Promise<T>;
  // SSE 兜底
  sseUrl?: string;
  // 公共
  intervalMs?: number;       // 兜底轮询间隔
  maxBackoffMs?: number;     // WS 重连上限
  parseSnapshot?: (raw: any) => T;  // 协议适配
  transform?: (data: any) => T;     // WS 消息 → T
};

type ChannelState<T> = {
  data: T | null;
  connected: boolean;
  channel: 'ws' | 'sse' | 'http' | null;
  retryAttempt: number;
  lastError: Error | null;
  lastUpdate: number;
  refresh: () => void;
};

export function useChannel<T>(opts: ChannelOptions<T>): ChannelState<T>;
```

**实现要点**:
- WS:复用 `getWsClient()`(已有心跳 / 重连)
- SSE:复用 `subscribeSse`(已有 3s 指数重连)
- HTTP:复用 `request<T>` + 指数退避
- 互斥逻辑:WS 连上立即关 SSE poll,避免重复触发

### 3.2 useBackend 切换到 useChannel

**改动文件**:`UI/src/hooks/useBackend.ts`

**步骤**:
- L90-200 WS/HTTP 逻辑 → `useChannel<BackendSnapshot>({ mode: 'ws-primary-http-fallback', subscribe: { 'state.snapshot': ..., 'state.kernel': ... }, poll: async () => { return await fetchAllInParallel(); }, intervalMs: 5000 })`
- 5 个 `snapshotTo*` 适配器作为 `parseSnapshot` 传入
- 保留 `useObservation` / `useScheduler` 单独轮询 hook(它们不是 fallback 关系)

**验收**:
- 启动后 5 个 key(kernel/system/db/agents/events)实时同步
- WS 断 → 自动切 HTTP → 5s 轮询
- WS 恢复 → 切回,期间 HTTP 停掉

### 3.3 useEventStream 切换到 useChannel

**改动文件**:`UI/src/hooks/useEventStream.ts`

**步骤**:
- L40-100 双通道 → `useChannel<UiEvent[]>({ mode: 'ws-primary-sse-fallback', ... })`
- 持久化走 `usePersistedState`(`events.recent.v1`)
- 保留 `newCount` / `ackNew` 角标逻辑

**验收**:
- 启动后 events 实时增加
- WS 故障 → SSE 兜底
- 切回后无重复

---

## Assumptions & Decisions

| 假设 | 决策 |
|---|---|
| 用户接受 React 19 + Vite + TS 现有栈 | 继续,不引入新框架 |
| 不引入 zustand / jotai / redux | useState + useReducer + useOverlayState 单 Set<OverlayKey> 够用 |
| 不引入 react-virtual / DOMPurify 等 | 留给后续 PR(本方案聚焦 3 项) |
| 不重写 ws.ts 单例 | 复用 `getWsClient()`,只在 hook 层抽象 |
| 不动 mock 数据 / `__thinking__` sentinel | 仅记录,不修 |
| 命名空间用 `soloforge.<scope>.<key>` | 沿用 usePersistedState 已有约定 |
| 不在 plan 中改后端协议 | WS 消息 schema 保持不变 |
| 拆分时保留 export 路径(避免大改) | 新文件用 `*.ts` + `index.ts` re-export,旧 import 不动 |

### 已识别的风险

1. **PR 1 风险最大**:`App.tsx` 109 个 setter 批量替换容易漏。**对策**:Phase 1.1 先建 hook,1.2 用 sed 替换后再人工 grep 校验
2. **PR 2 风险中等**:30+ 文件改持久化,可能改坏默认值。**对策**:每个文件 grep 老 key 改完确认;导出/导入用 `usePersistedState` 的 reset 兜底
3. **PR 3 风险最低**:useChannel 是新 hook,旧 hook 在 useChannel 成熟后切

---

## Verification Steps

每个 commit 完成后:

1. **TypeScript 编译**:`pnpm typecheck` 必须通过(没有 any 增加)
2. **本地 dev**:`pnpm dev` 启动,以下场景必须行为不变:
   - 启动后所有 overlay 都能用快捷键打开
   - Esc 按一次关一个
   - 刷新后会话/设置/解释/快捷键/主题/事件都还在
3. **回归路径**(每条必过):
   - 打开调色板(Ctrl+K)/ 关闭
   - 切 4 个主题(暗金/深海/晨光/紫晶)
   - 跑 1 个 chat 消息(看 WS chunk → 累积 → done)
   - 触发 1 个 toast + 1 个 notification
   - 拖拽文件到 ChatPanel(看 `text/x-soloforge-paths` MIME)
   - 拖动 Splitter 改宽度
   - 切 activity(explorer → search → git)
4. **grep 指标**:
   - `grep -r "useState" UI/src/App.tsx` 减到 ≤ 5 处
   - `grep -r "localStorage\." UI/src` 减到 ≤ 5 处(只允许 storageKeys.ts / 迁移工具)
   - `grep -r "setXxxOpen\(" UI/src` 减到 0

### 完成后长期验证

- 切到一个 overlay 频繁切换的路径,DevTools Performance 录制,看 React reconciliation 时间是否下降
- 制造 WS 断开(开 devtools 把 WS 拦掉),看 HTTP 兜底是否无缝

---

## 执行顺序与 commit 拆解建议

| # | commit 标题 | 范围 | 行变化 |
|---|---|---|---|
| 1 | `refactor(ui): 新增 useOverlayState hook 替代 100+ useState 模板` | Phase 1.1 | +85 |
| 2 | `refactor(ui): App.tsx 改用 useOverlayState + Esc closeTop` | Phase 1.2 | -220 |
| 3 | `chore(ui): OverlayKey 类型化避免拼写错` | Phase 1.3 | +20 |
| 4 | `chore(ui): 新增 storageKeys.ts 集中管理 13+ localStorage key` | Phase 2.1 | +50 |
| 5 | `refactor(ui): useChat 改用 usePersistedState 持久化 3 个 key` | Phase 2.2 | -30 |
| 6 | `refactor(ui): useEventStream 改用 usePersistedState` | Phase 2.3 | -10 |
| 7 | `refactor(ui): useKeybindingStore 改用 usePersistedState` | Phase 2.4 | -10 |
| 8 | `refactor(ui): 30+ overlay 组件迁移 usePersistedState` | Phase 2.5 | -150 |
| 9 | `chore(ui): 新增 migrateStorage 处理老 key 升级` | Phase 2.6 | +40(可选) |
| 10 | `refactor(ui): 新增 useChannel 抽象双通道 fallback` | Phase 3.1 | +120 |
| 11 | `refactor(ui): useBackend 切换 useChannel` | Phase 3.2 | -60 |
| 12 | `refactor(ui): useEventStream 切换 useChannel` | Phase 3.3 | -40 |

**总变化**:约 -200 行(主代码),+300 行(新基础设施),净 +100 行但消除了 3 大类结构问题。

---

## 不在本方案范围(后续 PR)

- 大列表虚拟化(`@tanstack/react-virtual`)
- DOMPurify 包 `dangerouslySetInnerHTML`
- fetch `AbortController` 超时
- 拆 5 大文件(PreviewPane / CenterPanels / useChat / CommandPalette / App)
- TypeScript `any` 清理
- drag-and-drop 键盘替代
- mock 数据 → 真实后端联调
- `useChannel` 模式再增加(`polling-only` 等)
- 命令 id 重复修复
