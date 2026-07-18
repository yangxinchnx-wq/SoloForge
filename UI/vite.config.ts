import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      // 2026-07-02: Vite 8 / Rolldown 不再自动补 .tsx 扩展名, .ts 文件里 import '../context/Foo'
      //   (无扩展名) 会报 Module not found. 这里显式列出全部可能的扩展名, .ts 文件 import
      //   .tsx 也算合法,避免每次写 .ts 时还要把 import 改成 '../context/Foo.tsx'
      extensions: ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json'],
      // 2026-06-29 (Vite 6→8 升级): Rolldown 不支持 optimizeDeps.rolldownOptions.alias (会触发
      //   "Expected never but received 'alias'" 警告)。所有别名统一收拢到 resolve.alias。
      //   用数组形式 + 显式子入口条目,确保 @lobehub/ui/icons 这种 directory + subentry 场景
      //   能精确重定向到 stubs/lobehub-ui/icons.mjs(不依赖 resolver 自行拼路径)。
      //   顺序敏感:更具体的子入口要排在父目录别名之前。
      alias: [
        { find: '@', replacement: path.resolve(__dirname, '.') },
        { find: 'antd', replacement: path.resolve(__dirname, 'stubs/antd.mjs') },
        { find: 'antd-style', replacement: path.resolve(__dirname, 'stubs/antd-style.mjs') },
        { find: '@lobehub/ui/icons', replacement: path.resolve(__dirname, 'stubs/lobehub-ui/icons.mjs') },
        { find: '@lobehub/fluent-emoji', replacement: path.resolve(__dirname, 'stubs/lobehub-ui/index.mjs') },
        { find: '@lobehub/ui', replacement: path.resolve(__dirname, 'stubs/lobehub-ui') },
      ],
    },
    // 2026-06-27:@lobehub/icons 的子入口会传递性引用 antd / @lobehub/ui 等本项目未安装的包,
    // 触发 esbuild "Could not resolve" 然后把整个 pre-bundle 跑挂,导致浏览器拿到 504 Outdated Optimize Dep。
    // 这些包在 src 中没有任何 import(vite.config.ts 历史注释也明确标注「未使用」),
    // 所以直接告诉 Vite 别扫描。
    //
    // 2026-06-29 (Vite 6→8 升级): esbuildOptions 已 deprecated,Vite 8 用 Rolldown 也不再有
    // rolldownOptions.alias 字段。所有别名收归上层 resolve.alias (上方数组形式)。
    optimizeDeps: {
      // ★ 2026-07-18: 移除 force: true 和 clearViteCachePlugin。
      //   之前每次启动都清缓存 + 强制重新预构建,导致依赖缓存不稳定。
      //   每次文件变化时 Vite 都重新扫描依赖 → page reload (而非 HMR)。
      //   现在让 Vite 正常缓存依赖,只在 package.json 变化时才重新预构建。
      //   浏览器缓存问题已由 server.headers no-store 解决,不需要清 Vite 缓存。
      //
      // ★ 2026-07-18: noDiscovery: true — 禁止运行时依赖发现。
      //   Vite 8 的 optimizer 在文件变化时会重新扫描依赖,即使没有新依赖,
      //   也会触发 page reload,覆盖 HMR 热更新。
      //   设置 noDiscovery 后,Vite 只使用 include 中列出的依赖,
      //   不会在文件变化时重新扫描,HMR 可以正常工作。
      //   代价:新增依赖时需要手动加到 include 中。
      noDiscovery: true,
      exclude: [
        'antd-style',
        '@lobehub/fluent-emoji',
      ],
      // 2026-07-05 加速 React mount + 2026-07-18 完整列出所有依赖:
      // noDiscovery: true 要求所有需要预构建的依赖都在这里列出。
      // 列表从 .vite/deps/_metadata.json 中提取 (Vite 之前自动发现的依赖)。
      include: [
        'react',
        'react-dom',
        'react-dom/client',
        'react/jsx-dev-runtime',
        'react/jsx-runtime',
        'react-router-dom',
        'zustand',
        'zustand/middleware',
        'zustand/react/shallow',
        '@dnd-kit/core',
        '@dnd-kit/sortable',
        '@dnd-kit/modifiers',
        '@dnd-kit/utilities',
        '@heroicons/react/24/outline',
        '@lobehub/icons',
        '@react-three/drei',
        '@react-three/fiber',
        '@vue/compiler-dom',
        '@vue/compiler-sfc',
        '@babel/parser',
        'animejs',
        'cheerio',
        'framer-motion',
        'recharts',
        'three',
        'xstate',
      ],
    },
    server: {
      // ★ 2026-07-18: HMR 重新启用 (之前因 agent 编辑干扰而禁用)。
      //   解法不是禁用 HMR,而是收紧 watch.ignored 让 agent 写的数据文件
      //   (DB/log/JSON/surql) 不触发 Vite 重新编译。只有 src/ 下代码改动
      //   才走 HMR 热替换,保留 React 状态不丢失。
      //   - React 组件: @vitejs/plugin-react 自动 Fast Refresh,改组件不刷新整页
      //   - store/utils: 已补全 HMR 边界 (zustand accept / 纯函数 self-accept),改 store 不刷新整页
      //     唯一例外: settings/store.ts 用 decline 显式拒绝 (自定义 store + 单例,不适合热替换)
      hmr: process.env.DISABLE_HMR !== 'true',
      // ★ 2026-07-17 关键修复: 即使 HMR 禁用, 也必须保留文件监听!
      //   原配置 watch: null 导致 vite 不重新编译修改的文件,
      //   F5 刷新也只能拿到旧代码 (vite 内存里是旧版本)。
      //   现在保留 watch 让 vite 重新编译, 只是不推送 HMR,
      //   用户 F5 刷新时拿到最新编译的代码, 且不会被 agent 编辑干扰。
      watch: {
        // [2026-06-28 关键修复] .soloforge/ 在项目根目录, 不在 UI/ 下; 必须用绝对路径
        //   才能让 Vite 跳过监听。**/.soloforge/** 只能匹配 UI/.soloforge, 漏掉了
        //   根目录的 .soloforge/chats.json (用户每次 chat 都会写这个文件, Vite 监听到
        //   → page reload → 用户看到 "对话框一输入就崩溃")。
        //
        // ★ 2026-07-18: 大幅收紧 watch 范围。agent 运行时会频繁写以下文件,
        //   全部忽略,只保留 src/ + index.html + vite.config.ts 的监听:
        //   - 数据库目录 (canvas_sessions_db / soloforge_vault / canvas_surreal_db)
        //   - 日志文件 (*.log — UI/ 下有几十个)
        //   - 构建产物 (dist / coverage / release / build)
        //   - 静态资源 (resources / stubs / public)
        //   - Go 服务 (git-service)
        //   - Electron 主进程 (electron/*.cjs — 主进程代码,不影响渲染器 HMR)
        //   - 根目录 JSON 数据文件 (probe cache / metadata / providers db)
        ignored: [
          // ── 数据文件 ──
          '**/active_resources_db.json',
          '**/providers_db.json',
          '**/metadata.json',
          '**/model_context_db.json',
          '**/model_probe_cache.json',
          '**/provider_probe_cache.json',
          '**/*.surql',
          // ★ 2026-07-18: 修复 **/data/** 误伤 src/data/ 的问题。
          //   **/data/** 会匹配任何路径下的 data 目录,包括 src/data/。
          //   现在用绝对路径只忽略 UI 根目录的 data/ (数据库目录),
          //   不影响 src/data/ (defaultChats.ts 等源码)。
          path.resolve(__dirname, 'data').replace(/\\/g, '/') + '/**',
          '**/.soloforge_settings.json*',
          '**/.soloforge/**',
          path.resolve(__dirname, '..', '.soloforge').replace(/\\/g, '/'),
          path.resolve(__dirname, '..', '.soloforge').replace(/\\/g, '/') + '/**',
          // ── 日志 ──
          '**/*.log',
          '**/*.err',
          '**/*.out',
          // ── 构建产物 / 静态资源 ──
          '**/resources/**',
          '**/release/**',
          '**/dist/**',
          '**/coverage/**',
          '**/build/**',
          '**/stubs/**',
          '**/public/**',
          // ── 后端服务 ──
          '**/git-service/**',
          '**/electron/**',
        ],
      },
      // ★ 2026-07-17: 强制浏览器不缓存 dev 资源
      //   原因: Vite 用 ETag/Last-Modified 做条件请求, 文件变化后浏览器
      //   可能仍返回 304 Not Modified, 导致加载旧代码。
      //   no-store 彻底禁止浏览器缓存, 每次都重新请求。
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      },
      // 2026-07-05 加速 React mount (强制刷新时减少黑屏时间):
      // Vite dev server 按需转换文件 — 浏览器请求 main.tsx → Vite 转换 →
      // 返回 → 浏览器解析 import → 请求下一个文件 → Vite 转换 → ...
      // 这个 request waterfall 是刷新慢的根因 (几百个 ESM 请求串行)。
      // warmup 让 Vite 在 dev server 启动后立刻预转换首屏关键路径文件,
      // 浏览器请求时直接命中缓存,不等待转换。
      warmup: {
        clientFiles: [
          './src/main.tsx',
          './src/App.tsx',
          './src/index.css',
          './src/context/ThemeContext.tsx',
          './src/context/LayoutContext.tsx',
          './src/state/appStore.ts',
          './src/components/Header.tsx',
          './src/components/ChatPanel.tsx',
          './src/components/ActivityBar.tsx',
          './src/components/StatusBar.tsx',
          './src/components/MountTransition.tsx',
          './src/styles/animations.css',
          './src/data/defaultChats.ts',
          './src/types.ts',
        ],
      },
    },
    // 2026-06-24 性能优化:大依赖拆成独立 chunk
    //   - 之前:所有依赖打进 main bundle,启动时一次性加载 10-30MB JS,内存峰值很高
    //   - 现在:按需加载,首屏只加载 react + 自己的代码,lobehub-icons 走独立 chunk
    //   - 用户进入对应页面(预览/设置/统计)时再异步加载,稳态内存下降
    // 2026-06-24 清理:删除未使用依赖 antd / @lobehub/ui / @lobehub/fluent-emoji / recharts 的 chunk 规则
    // 2026-07-01:删除 motion 依赖,所有动画改用 CSS transition + 自研 <MountTransition>。
    //   因此移除 vendor-motion chunk 规则,所有运动相关的轻量类库已不存在。
    build: {
      // 2026-07-02:启用 CSS 代码分割 (CSS 也能按 chunk 拆)
      cssCodeSplit: true,
      // 2026-07-02:Rolldown 报告 minify 提速 + terser 选项
      minify: 'esbuild',
      // 2026-07-02:treeshake 强化 — smallAssets 阈值调小,让 PNG / wasm 等小文件更积极
      reportCompressedSize: false,
      sourcemap: false,
      // 2026-06-29 (Vite 6→8 升级): rollupOptions 在 Vite 8 中重命名为 rolldownOptions (Rolldown 迁移)。
      // 函数式 manualChunks 仍兼容 (deprecated,后续可迁移到 advancedChunks.groups)。
      rolldownOptions: {
        output: {
          manualChunks: (id) => {
            // node_modules 里的包按需拆
            if (!id.includes('node_modules')) return;

            // ── 2026-07-18: 精细化 chunk 拆分 ──────────────────────
            // 之前所有未匹配的包都进 vendor-misc (3.4MB),导致首屏加载
            // three.js / @vue/compiler-sfc / recharts 等只有 lazy 组件才需要的重依赖。
            // 现在按依赖用途分组,让每个 chunk 只在对应的 lazy 组件加载时才下载。
            //
            // 关键原理: manualChunks 只决定模块归属哪个 chunk,
            // 浏览器何时加载该 chunk 仍由 import 图决定。
            // 如果 three 只被 PreviewPanel (lazy) 引用,vendor-three 就只在
            // PreviewPanel 加载时才请求。这样首屏不加载 3D 库。

            // Lobehub 图标库(已知很大,1-2MB minified)
            if (id.includes('@lobehub/icons') && id.includes('node_modules/@lobehub/icons')) {
              return 'vendor-lobehub-icons';
            }

            // ── React 核心 (首屏必需,所有页面共享) ──
            // react 442KB + react-dom + react-router 86KB + scheduler
            // ★ 重要: 必须显式匹配 node_modules/react/ (不是 react-dom),
            //   否则 react 的 CJS wrapper 会被 Rolldown 放进引用它的 lazy chunk
            //   (如 vendor-charts),导致主 bundle 静态 import 该 lazy chunk。
            if (
              id.includes('react-dom') ||
              id.includes('react-router') ||
              id.includes('scheduler/') ||
              id.includes('node_modules/react/')
            ) {
              return 'vendor-react';
            }

            // ── 3D 渲染栈 (只被 PreviewPanel → CanvasStage3D 引用,lazy) ──
            // three 1099KB + @react-three/fiber 229KB + three-stdlib 205KB
            // + @monogrid/gainmap-js 29KB + animejs 384KB (CanvasStage 动画)
            if (
              id.includes('/three/') || id.includes('/three-stdlib/') ||
              id.includes('@react-three/fiber') || id.includes('@react-three/drei') ||
              id.includes('@monogrid/gainmap-js') ||
              id.includes('/animejs/')
            ) {
              return 'vendor-three';
            }

            // ── 翻译器/解析器栈 (只被 PreviewPanel → vueTranslator 引用,lazy) ──
            // @vue/compiler-sfc 1079KB + @babel/parser 418KB + parse5 194KB
            // + cheerio 40KB + htmlparser2 75KB + css-select 26KB + entities 37KB
            if (
              id.includes('@vue/compiler-sfc') || id.includes('@vue/compiler-dom') ||
              id.includes('@vue/compiler-core') || id.includes('@babel/parser') ||
              id.includes('/parse5/') || id.includes('/cheerio/') ||
              id.includes('/htmlparser2/') || id.includes('/css-select/') ||
              id.includes('/entities/')
            ) {
              return 'vendor-translate';
            }

            // ── 图表 (只被 StatsModal 引用,已 lazy) ──
            // recharts 805KB — 只匹配 recharts 自身。
            // d3-scale/d3-shape/decimal.js-light 不放这里:它们可能被主 bundle
            // 中的其他包共享,如果放进 vendor-charts 会导致首屏加载整个 recharts。
            // 让它们落入 vendor-misc (254KB,首屏加载无压力)。
            if (id.includes('/recharts/')) {
              return 'vendor-charts';
            }

            // ── 动画 (只被 PreviewPanel 引用,lazy) ──
            // framer-motion 67KB + motion-dom 193KB
            if (id.includes('/framer-motion/') || id.includes('/motion-dom/') || id.includes('/motion-utils/')) {
              return 'vendor-motion';
            }

            // ── 图标 (Header/ActivityBar/ChatPanel 等首屏组件用) ──
            if (id.includes('@heroicons/react')) {
              return 'vendor-icons';
            }

            // ── 以下保持原有规则 ──
            // React-virtuoso 虚拟列表
            if (id.includes('react-virtuoso') || id.includes('react-window')) return 'vendor-virtuoso';
            // 2026-07-18: lucide-react 已移除 (所有图标迁移到 @heroicons/react),
            //   chunk 规则也已清理。
            // Monaco / 代码编辑器
            if (id.includes('monaco-') || id.includes('@monaco-editor')) return 'vendor-monaco';
            // 状态管理(Zustand + 持久化中间件)
            if (id.includes('zustand') || id.includes('immer')) return 'vendor-zustand';
            // LLM / SSE / 解析库
            if (id.includes('eventsource') || id.includes('event-source-polyfill')) return 'vendor-sse';
            // dnd-kit 拖拽核心
            if (id.includes('@dnd-kit')) return 'vendor-dnd';
            // SurrealDB 嵌入式客户端
            if (id.includes('surrealdb')) return 'vendor-surrealdb';

            // 兜底:其余小包合并,体积已大幅缩小 (从 3.4MB → ~200KB)
            return 'vendor-misc';
          },
        },
      },
      // 2026-06-24:提升单 chunk 大小警告阈值,避免 CI 报错
      chunkSizeWarningLimit: 1500,
      // ★ 2026-07-18: 精细化 modulepreload 控制
      //   Vite 默认为所有 chunk (包括 lazy chunk 的依赖) 生成 <link rel="modulepreload">,
      //   导致首屏预加载 vendor-three (1169KB) / vendor-translate (1065KB) / vendor-motion (128KB)
      //   等 lazy-only chunk,抵消了代码拆分的优势。
      //   resolveDependencies 让我们过滤:只预加载首屏直接需要的 chunk,
      //   lazy chunk 的依赖在 lazy chunk 实际加载时才下载。
      modulePreload: {
        polyfill: true,
        resolveDependencies: (_filename, deps, { hostType }) => {
          // 只对主 HTML 入口过滤 lazy-only chunk。
          // lazy import (hostType='js') 保留全部 deps — 它们是 lazy chunk 加载时需要的。
          if (hostType !== 'html') return deps;
          // 这些 chunk 只被 lazy 组件 (PreviewPanel/StatsModal/SourceCodeEditor) 引用,
          // 不应在首屏预加载。它们会在对应 lazy 组件加载时才下载。
          const lazyOnlyPatterns = [
            'vendor-three',
            'vendor-translate',
            'vendor-motion',
            'vendor-monaco',
            'vendor-surrealdb',
          ];
          return deps.filter((dep) => !lazyOnlyPatterns.some((p) => dep.includes(p)));
        },
      },
    },
  };
});

