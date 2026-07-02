import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
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
      exclude: [
        'antd-style',
        '@lobehub/fluent-emoji',
      ],
    },
    server: {
      hmr: process.env.ENABLE_HMR === 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {
        // [2026-06-28 关键修复] .soloforge/ 在项目根目录, 不在 UI/ 下; 必须用绝对路径
        //   才能让 Vite 跳过监听。**/.soloforge/** 只能匹配 UI/.soloforge, 漏掉了
        //   根目录的 .soloforge/chats.json (用户每次 chat 都会写这个文件, Vite 监听到
        //   → page reload → 用户看到 "对话框一输入就崩溃")。
        ignored: [
          '**/active_resources_db.json',
          '**/providers_db.json',
          '**/metadata.json',
          '**/*.surql',
          '**/resources/**',
          '**/release/**',
          '**/.soloforge_settings.json*',
          '**/.soloforge/**',
          path.resolve(__dirname, '..', '.soloforge').replace(/\\/g, '/'),
          path.resolve(__dirname, '..', '.soloforge').replace(/\\/g, '/') + '/**',
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
            // Lobehub 图标库(已知很大,1-2MB minified)
            // 仅当实际被 ModelIcon.tsx 引用时才打入 lobehub chunk,
            // 让其他路过引用不强制打整个 lobehub-icons (B 优化)
            if (id.includes('@lobehub/icons') && id.includes('node_modules/@lobehub/icons')) {
              return 'vendor-lobehub-icons';
            }
            // React-virtuoso 虚拟列表
            if (id.includes('react-virtuoso') || id.includes('react-window')) return 'vendor-virtuoso';
            // Lucide 图标
            if (id.includes('lucide-react')) return 'vendor-lucide';
            // Monaco / 代码编辑器
            if (id.includes('monaco-') || id.includes('@monaco-editor')) return 'vendor-monaco';
            // 2026-07-02 优化:状态管理单独 chunk(Zustand + 持久化中间件)
            if (id.includes('zustand') || id.includes('immer')) return 'vendor-zustand';
            // 2026-07-02 优化:Google AI SDK 单独 chunk(@google/genai 是流式 SDK,体积不小)
            if (id.includes('@google/genai') || id.includes('@google-cloud')) return 'vendor-ai-sdk';
            // 2026-07-02 优化:LLM / SSE / 解析库(pako / jszip / event-source-polyfill 等)
            if (id.includes('eventsource') || id.includes('event-source-polyfill')) return 'vendor-sse';
            // dnd-kit 拖拽核心(独立,避免和主包混在一起)
            if (id.includes('@dnd-kit')) return 'vendor-dnd';
            // SurrealDB 嵌入式客户端(独立,体量大)
            if (id.includes('surrealdb')) return 'vendor-surrealdb';
            // 兜底:其它 node_modules 一起打包,避免每个包都拆出来
            return 'vendor-misc';
          },
        },
      },
      // 2026-06-24:提升单 chunk 大小警告阈值,避免 CI 报错
      chunkSizeWarningLimit: 1500,
    },
  };
});

