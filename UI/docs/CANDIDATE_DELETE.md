# 候选删除 overlay 清单 (P1-12)

> 状态:**仅标记,未实际删除**。等用户明确点头后再清理。
> 标准:功能价值低 / 与其他组件 80%+ 重叠 / 仅占位无逻辑

## 🔴 高优先 (建议删,收益大)

| 文件 | 大小 | 理由 | 替代 |
|---|---|---|---|
| `ScreenShare.tsx` | 16.7K | 纯占位 UI,无任何功能 | 未来用 WebRTC 真做 |
| `CollabCursors.tsx` | 22.1K | "模拟"协同,标注自己是 mock | 真正协同在 `SharedCollab.tsx` |
| `SharedCollab.tsx` | 22.1K | 与 `CollabCursors` 80% 重叠 | 留 `SharedCollab`,删 `CollabCursors` |
| `ThemeMarket.tsx` | 18.7K | 列了几个预设主题,无网络获取 | 主题直接改 `themes.ts` 即可 |
| `SkillsMarket.tsx` | 10.7K | 静态列表,假"已安装"提示 | 真实市场需要后端支持 |
| `ProjectIO.tsx` | 12.2K | 与 `DataIO.tsx` 重复 | 留 `DataIO` |
| `DataIO.tsx` | (在 19+) | 与 `chatExport.ts` 重叠 | 合并入 `chatExport` |
| `Splash.tsx` | 2.8K | 启动画面,几乎无内容 | 可保留(用户第一印象) |
| `RoleSelector.tsx` | 5.3K | 角色选择,无后端 | 等多角色系统落地 |
| `ErrorDetailModal.tsx` | ? | 与 `ErrorState` 重叠 | 改用 `ErrorState` |
| `Notifications.tsx` | 10.9K | 与 `NotifierRules.tsx` 重复 | 留 `NotifierRules` |
| `RecentActivity.tsx` | 22.5K | 静态列表 | 数据接入前可删 |

**估计节省 bundle 体积: ~150-200KB (未 gzip)**

## 🟡 中优先 (有功能但单薄)

| 文件 | 理由 |
|---|---|
| `QrGenerator.tsx` | 真有功能但用户极少用 |
| `BookmarkManager.tsx` | 浏览器原生收藏夹足够 |
| `ColorPalette.tsx` | 设计师工具,目标用户窄 |
| `IconBrowser.tsx` | 内部使用,IDE 自带图标选择器 |
| `WorkflowPipeline.tsx` | 与 `TaskScheduler` 重叠 |
| `DependencyGraph.tsx` | 与 `CodeMap` 重叠 |

## 🟢 低优先 (功能清晰,保留)

PromptLab · TokenTracker · AgentOrchestrator · EmbeddingExplorer · CacheInspector
DeploymentPipeline · ExperimentBoard · ModelRegistry · QueueMonitor · 等
*这些是 Batch 12-13 新做的,有清晰领域,功能完整*

## 📊 总数据

- 当前 overlay 数: **108**
- 高优先删除: ~12 个 (-11%)
- 中优先删除: ~6 个 (-6%)
- 建议目标规模: **~85 个** (-20%)

## ⚠️ 风险提示

删除前需要:
1. 在 `App.tsx` 移除对应 import / state / handler / esc stack / JSX
2. 在 `useKeybindingStore.ts` 移除对应绑定
3. 在 `HotkeyCheatsheet.tsx` 移除显示
4. 跑 `npm run build` + `npm run smoke` 确认

预计每次删除 1 个需要 5 处修改 + 1 次构建验证。**批量删效率高**。
