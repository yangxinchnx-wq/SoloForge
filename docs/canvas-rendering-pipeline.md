# 画布渲染链路经验文档

> 2026-07-12 排查并修复画布空白问题后总结

## 完整链路

```
LLM API
  ↓ SSE stream (reasoning_content + content 混合)
Java Backend (LlmGateway.java)
  ↓ extractDeltaContent: 用 \u0001 前缀标记 reasoning_content
Java Backend (ChatController.java)
  ↓ textFlux.subscribe: 根据 \u0001 前缀发送 reasoning / text SSE 事件
Node.js Relay (aiBackend.ts → parseRacerSSE)
  ↓ 分发 reasoning / text 事件到前端
Frontend (useChatStore.ts → startChat callback)
  ├─ reasoning 事件 → streamBridge.onText() (只进流送区, 不喂 pusher)
  └─ text 事件 → IncrementalCanvasPusher.feedChunk()
       ↓ parseCodeBlocks: 检测 ```json ... ``` 代码块
       ↓ LineTracker.translateAndPush()
            ├─ __json_dsl__: 直接 JSON.parse → pushRawDsl()
            └─ 其他语言: translateCodeAsync() → UniversalNode → pushToCanvas()
                 ↓
       pushRawDsl / pushToCanvas:
         ├─ ensureCanvasAndPush() → window.soloforge.canvas.push() → Flutter 画布
         └─ usePreviewStreamStore.updateStream() → previewStreamStore
              ↓
       PreviewPanel (订阅 previewStreamStore)
         ↓ renderPlaceholder()
         ├─ 有 AST 数据 → WebAstPreview (Web 渲染, 优先)
         └─ canvas running + 无数据 → 透明占位 (Flutter 嵌入窗口渲染)
```

## 历史断路点 (4个)

### 断路 1: reasoning_content 混入代码块检测
- **问题**: LLM 的思考过程 (reasoning_content) 和实际输出 (content) 混在一个流里，思考过程中的 ``` 字符干扰了代码块检测
- **修复**: Java 后端用 \u0001 前缀标记 reasoning_content，前端分离成 reasoning 事件，只进流送区，不喂给 IncrementalCanvasPusher
- **文件**: `LlmGateway.java`, `ChatController.java`, `aiBackend.ts`, `useChatStore.ts`

### 断路 2: PreviewPanel 显示透明占位
- **问题**: canvasState === 'running' 时直接返回透明 div，即使 previewStreamStore 里有 AST 数据也走不到 WebAstPreview
- **修复**: 把 WebAstPreview 的检查提到 canvasState === 'running' 前面
- **文件**: `PreviewPanel.tsx` → renderPlaceholder()

### 断路 3: WebAstPreview 不认识 Flutter DSL 格式
- **问题**: pushRawDsl 写入的是 Flutter DSL ({type, props, children})，但 WebAstPreview 只认 UniversalNode ({type, style, content, children})
- **修复**: 添加 normalizeNode() 函数自动归一化两种格式
- **文件**: `WebAstPreview.tsx`

### 断路 4: WebAstPreview 不支持 svg 类型
- **问题**: LLM 画图返回 type: "svg"，但 WebAstPreview 的 switch 没有 svg 分支，default 返回 null
- **修复**: 新增 svg 类型处理，用 dangerouslySetInnerHTML 渲染 SVG 字符串
- **文件**: `WebAstPreview.tsx`

### 断路 5: 上下文混乱 (history 丢失代码)
- **问题**: buildDisplayText 把代码块替换成 "已渲染到画布 (json)"，这个被替换的文本写入 ChatMessage.content，发送 history 时 LLM 看不到之前生成的代码
- **修复**: ChatMessage 新增 rawContent 字段保存原始输出，构建 history 时优先使用 rawContent
- **文件**: `types/chat.ts`, `useChatStore.ts`

## 关键数据格式

### Flutter DSL (LLM 返回 / 推送画布)
```json
{
  "type": "svg",
  "props": { "content": "<svg>...</svg>", "width": 200, "height": 200 },
  "children": []
}
```

### UniversalNode (翻译器输出)
```json
{
  "type": "text",
  "content": "Hello",
  "style": { "color": "#fff", "fontSize": 16 },
  "children": []
}
```

### previewStreamStore entry
```typescript
{
  ast: UniversalNode,           // 当前最佳 root (半成品也行)
  payload: PreviewPayload,      // 已确认的 payload
  isStreaming: boolean,
  language: string,
  sourceCode: string,
  rawBytes: number,
  pushError: string | null,
}
```

## 关键文件清单

| 文件 | 职责 |
|------|------|
| `LlmGateway.java` | LLM API 调用，区分 content / reasoning_content |
| `ChatController.java` | SSE 流式接口，发送 text / reasoning 事件 |
| `aiBackend.ts` | 前端 SSE 解析，分发事件 |
| `useChatStore.ts` | 聊天状态管理，事件路由，history 构建 |
| `incrementalCanvasPusher.ts` | 代码块解析，增量翻译，推画布 + previewStreamStore |
| `previewStreamStore.ts` | AST 预览流状态 (Zustand) |
| `PreviewPanel.tsx` | 画布预览面板，订阅 previewStreamStore |
| `WebAstPreview.tsx` | Web 端 AST 渲染器 (UniversalNode + Flutter DSL) |
| `canvasHost.cjs` | Electron 画布进程管理，IPC canvas:push |
