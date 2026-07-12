// ─────────────────────────────────────────────────────────────────────
// SoloForge 启动错误码体系
// ─────────────────────────────────────────────────────────────────────
//
// 命名空间: B (Boot)
//
//   B0xx  HTML 加载 / 主题预置脚本
//   B1xx  ESM 模块加载 (main.tsx / App.tsx)
//   B2xx  React mount 阶段 (root, StrictMode)
//   B3xx  Context/Provider (ThemeContext)
//   B4xx  App 主体组件 mount (Header / ChatPanel / PreviewPanel / ...)
//   B5xx  后端 / Vite HMR / API 3001 / SurrealDB / Garnet
//   B6xx  IPC 桥 (Electron agent-bridge / preload)
//   B7xx  拖拽 / ResizeObserver / 已知 noisy 路径
//   B8xx  BroadcastChannel / 跨窗口通信
//   B9xx  其他 (兜底)
//
// 调用方式:
//   import { reportBootError } from './boot/bootError';
//   reportBootError('B301', { detail: 'ThemeContext crashed', error });
//
// UI 会在 #root 顶层覆盖一个红/黄底黑字的启动错误屏, 显示
//   错误码 + 标题 + 详细信息 + 出错位置 + 重试按钮
//
// 即便整个 React 树都挂掉, 这个屏依然能显示 (通过 vanilla DOM
// 直接绘制在 document.body 上)。
// ─────────────────────────────────────────────────────────────────────

export type BootErrorCode =
  | `B0${number}${number}${number}`
  | `B1${number}${number}${number}`
  | `B2${number}${number}${number}`
  | `B3${number}${number}${number}`
  | `B4${number}${number}${number}`
  | `B5${number}${number}${number}`
  | `B6${number}${number}${number}`
  | `B7${number}${number}${number}`
  | `B8${number}${number}${number}`
  | `B9${number}${number}${number}`;

export const BOOT_ERROR_REGISTRY: Record<string, { title: string; hint: string }> = {
  // B0xx — HTML / 主题预置
  B001: { title: '主题预置脚本崩溃', hint: 'localStorage 损坏 / localStorage 被禁用, 已回退到 gruvbox' },
  B002: { title: 'CSS 变量注入失败', hint: 'document.documentElement 不可写 (CSP?)' },
  B003: { title: '主 bundle 加载失败', hint: '检查 Vite 3000 端口是否启动, /src/main.tsx 路径' },

  // B1xx — ESM 加载
  B101: { title: 'main.tsx 加载失败', hint: 'ESM 语法错误 / 循环依赖 / 构建产物缺失' },
  B102: { title: 'App.tsx 加载失败', hint: 'App.tsx 顶部 import 链异常' },
  B103: { title: '依赖模块解析失败', hint: '运行 npm ls 查依赖, 重新 npm install' },

  // B2xx — React mount
  B201: { title: '#root 节点缺失', hint: 'index.html 里没找到 id="root"' },
  B202: { title: 'createRoot 抛错', hint: 'React 19 与 StrictMode 不兼容某个组件' },
  B203: { title: '初次 render 异常', hint: '通常是 Provider 树顶层的 Context throw' },

  // B3xx — Context/Provider
  B301: { title: 'ThemeContext Provider 异常', hint: 'useTheme hook 失败 / preset 配置错' },
  B302: { title: 'ActivityBar Provider 异常', hint: '—' },
  B303: { title: 'ChatPanel Provider 异常', hint: '—' },
  B304: { title: 'PreviewPanel Provider 异常', hint: '—' },

  // B4xx — App 子组件 mount
  B401: { title: 'Header 渲染失败', hint: '—' },
  B402: { title: 'ActivityBar 渲染失败', hint: '—' },
  B403: { title: 'FileExplorer 渲染失败', hint: '—' },
  B404: { title: 'HistoryAndEditorPanel 渲染失败', hint: '—' },
  B405: { title: 'SourceCodeEditor 渲染失败', hint: '—' },
  B406: { title: 'ChatPanel 渲染失败', hint: '—' },
  B407: { title: 'PreviewPanel 渲染失败', hint: '—' },
  B408: { title: 'StatusBar 渲染失败', hint: '—' },
  B409: { title: 'ThemeModal 渲染失败', hint: '—' },
  B40A: { title: 'SettingsModal 渲染失败', hint: '—' },
  B40B: { title: 'StatsModal 渲染失败', hint: '—' },
  B40C: { title: 'FloatingEditorWindow 渲染失败', hint: '—' },
  B40D: { title: 'AgentSettingsModal 渲染失败', hint: '—' },

  // B5xx — 后端 / 数据层
  B501: { title: 'Vite HMR 长时间无响应', hint: '检查 http://localhost:3000/ 是否能 curl 通' },
  B502: { title: '后端 3001 连不上', hint: '5s 内无响应。可能原因: (1) 后端进程没起 (2) CORS preflight 失败 (3) 鉴权层挡住。查看后端日志 / DevTools Network' },
  B503: { title: 'SurrealDB 不可用', hint: '嵌入式 rocksdb 路径权限 / 锁文件残留' },
  B504: { title: 'Garnet 6379 不可用', hint: '缓存层挂了, 不影响主流程但状态可能被重置' },
  B505: { title: 'go-git-service 3002 不可用', hint: 'git 操作会降级到本地' },
  B506: { title: 'MARL 8765 不可用', hint: '多助理强化学习服务挂了, 主流程不依赖' },
  B507: { title: 'API token 鉴权失败', hint: '环境变量 SOLOFORGE_API_TOKENS 缺失, 看后端 admin /api/security' },

  // B6xx — IPC 桥
  B601: { title: 'Electron preload 不可用', hint: 'preload.cjs 加载失败 / contextIsolation 配置错' },
  B602: { title: 'agent-bridge IPC handler 未注册', hint: 'registerAgentIpc() 没在 app.whenReady 里跑' },
  B603: { title: 'agent-bridge WS 反复断连', hint: '后端 3001 没起 / 反向代理问题' },
  B604: { title: 'canvas host window 创建失败', hint: 'Electron BrowserWindow constructor 抛错' },

  // B7xx — 已知 noisy
  B701: { title: 'ResizeObserver loop limit', hint: '已在 main.tsx 静默处理, 但持续触发说明有组件死循环' },
  B702: { title: 'CSS Containment 计算崩溃', hint: 'dnd-kit 拖拽 + 复杂 layout 可能触发' },

  // B8xx — BroadcastChannel
  B801: { title: 'BroadcastChannel 初始化失败', hint: 'Electron 老版本不支持, 跨窗口同步会降级' },
  B802: { title: 'popout editor 通信失败', hint: '广播消息序列化失败' },

  // B9xx — 兜底
  B999: { title: '未知错误', hint: '看 console / 后端日志 / git status' },
};

export function lookupBootError(code: string): { title: string; hint: string } {
  return (
    BOOT_ERROR_REGISTRY[code] ?? {
      title: `未注册的错误码 ${code}`,
      hint: '这个错误码没在 BOOT_ERROR_REGISTRY 里登记, 通常是组件抛了未识别的异常',
    }
  );
}
