# 候选删除 overlay 清单 (P1-12 / D 完成)

> 状态:第一轮 D 已完成,删 2 个 (ScreenShare, DataIO)。
> 剩余 6 个有外部依赖(ProjectIO/ThemeMarket/SkillsMarket/RecentActivity/CollabCursors/Splash),代价高于收益,**暂保留**。

## ✅ 已删除 (D 第一轮)

| 文件 | 大小 | 节省 |
|---|---|---|
| `ScreenShare.tsx` | 16.7K | 1681→1664 KB |
| `DataIO.tsx` | 16.5K | 1664→1647 KB |
| **合计** | 33.2K | **34KB / 9KB gzip** |

## ❌ 暂留 (外部依赖)

| 文件 | 暂留原因 |
|---|---|
| `ProjectIO.tsx` | TopBar `onOpenProjectIO` 引用 + chat/resources 联动 |
| `ThemeMarket.tsx` | `onApply` 主题应用 + Toast 副作用 |
| `SkillsMarket.tsx` | palette → `skill` 快捷键 + 5 处状态 |
| `RecentActivity.tsx` | 同上 5 处 |
| `CollabCursors.tsx` | `collab` 快捷键 + 5 处 |
| `Splash.tsx` | 启动屏,1.2s 动画,删了 Splash import 也得回滚 |

## 🟡 中优先 (有功能但单薄)

| 文件 | 理由 |
|---|---|
| `QrGenerator.tsx` | 真有功能但用户极少用 |
| `BookmarkManager.tsx` | 浏览器原生收藏夹足够 |
| `ColorPalette.tsx` | 设计师工具,目标用户窄 |
| `IconBrowser.tsx` | 内部使用,IDE 自带图标选择器 |
| `WorkflowPipeline.tsx` | 与 `TaskScheduler` 重叠 |
| `DependencyGraph.tsx` | 与 `CodeMap` 重叠 |

## 📊 总数据 (更新后)

- 原始 overlay 数: **108**
- D 第一轮删除: 2 (-2%)
- 主 chunk 节省: 1681KB → 1647KB (-34KB, -2%)
- 剩余候选: 6 (高优先暂留) + 6 (中优先) = 12

## ⚠️ 关键经验 (Fact)

删除 overlay 之前,**必须**检查 App.tsx 之外的引用:
- `TopBar.tsx` / `Sidebar.tsx` 等布局组件的 props
- 其他 overlay 的 import (例如 `Notifications` 包含核心 API)
- palette 快捷键里映射的 ID (skill / activity / collab)

直接 grep `import.*<Name>` 和 `<Name>` 在全 src/ 才能确认。

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
