// ─────────────────────────────────────────────────────────────────
// Electron Forge 配置
// 使用官方推荐的 Electron 构建方式
// ─────────────────────────────────────────────────────────────────

module.exports = {
  packagerConfig: {
    name: 'SoloForge',
    executableName: 'soloforge',
    asar: true,
    icon: './public/icon'
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'SoloForge'
      }
    }
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-vite',
      config: {
        build: [
          {
            entry: 'src/main.ts',
            config: 'vite.main.config.mjs'
          },
          {
            entry: 'src/preload.ts',
            config: 'vite.preload.config.mjs'
          }
        ],
        renderer: [
          {
            name: 'main_window',
            config: 'vite.renderer.config.mjs'
          }
        ]
      }
    }
  ]
};
