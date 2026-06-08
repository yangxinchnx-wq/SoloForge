/** @type {import('tailwindcss').Config} */
// SoloForge Tailwind 配置
// 从原 index.html 内嵌的 tailwind.config 同步过来（2026-06-04 迁移：CDN → PostCSS）
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx,js,jsx}'],
  theme: {
    extend: {
      colors: {
        bg:                    'var(--color-bg)',
        'bg-dim':              'var(--color-bg-dim)',
        surface:               'var(--color-surface)',
        'surface-low':         'var(--color-surface-low)',
        'surface-high':        'var(--color-surface-high)',
        primary:               'var(--color-primary)',
        'on-primary':          'var(--color-on-primary)',
        'primary-container':   'var(--color-primary-container)',
        'on-primary-container':'var(--color-on-primary-container)',
        text:                  'var(--color-text)',
        'text-secondary':      'var(--color-text-secondary)',
        border:                'var(--color-border)',
        'border-light':        'var(--color-border-light)',
        accent:                'var(--color-accent)',
        success:               'var(--color-success)',
        warning:               'var(--color-warning)',
        danger:                'var(--color-danger)',
      },
      fontFamily: {
        sans:    ['Inter', 'system-ui', 'sans-serif'],
        mono:    ['JetBrains Mono', 'monospace'],
        display: ['Hanken Grotesk', 'Inter', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
