// ─────────────────────────────────────────────────────────────────
// 极简 i18n (P0-6)
// - 不引第三方依赖,保持轻量
// - 当前支持 zh-CN / en 两种语言,默认 zh-CN
// - 缺翻译时回退到 key 本身
// - 新代码请用 const t = useI18n(); t('保存')
// ─────────────────────────────────────────────────────────────────

import { useCallback } from 'react';
import { usePersistedState } from './usePersistedState';

export type Locale = 'zh-CN' | 'en';

const translations: Record<Locale, Record<string, string>> = {
  'zh-CN': {
    // 系统通用
    'common.save': '保存',
    'common.cancel': '取消',
    'common.delete': '删除',
    'common.edit': '编辑',
    'common.create': '创建',
    'common.search': '搜索',
    'common.refresh': '刷新',
    'common.loading': '加载中…',
    'common.empty': '暂无数据',
    'common.retry': '重试',
    'common.error': '出错了',
    'common.confirm': '确认',
    'common.close': '关闭',
    // 业务
    'chat.send': '发送',
    'chat.new': '新建对话',
    'chat.thinking': '思考中…',
    'file.open': '打开文件',
    'file.save': '保存文件',
    'settings.title': '设置',
    'palette.placeholder': '输入命令或搜索…',
  },
  'en': {
    'common.save': 'Save',
    'common.cancel': 'Cancel',
    'common.delete': 'Delete',
    'common.edit': 'Edit',
    'common.create': 'Create',
    'common.search': 'Search',
    'common.refresh': 'Refresh',
    'common.loading': 'Loading…',
    'common.empty': 'No data',
    'common.retry': 'Retry',
    'common.error': 'Error',
    'common.confirm': 'Confirm',
    'common.close': 'Close',
    'chat.send': 'Send',
    'chat.new': 'New Chat',
    'chat.thinking': 'Thinking…',
    'file.open': 'Open File',
    'file.save': 'Save File',
    'settings.title': 'Settings',
    'palette.placeholder': 'Type a command or search…',
  },
};

export function useI18n(): { t: (key: string, fallback?: string) => string; locale: Locale; setLocale: (l: Locale) => void } {
  const [locale, setLocale] = usePersistedState<Locale>('i18n', 'locale', 'zh-CN');
  const t = useCallback((key: string, fallback?: string) => {
    const dict = translations[locale];
    if (dict && key in dict) return dict[key];
    // fallback 链: zh-CN 字典 → en 字典 → fallback 参数 → key 本身
    if (locale !== 'zh-CN' && key in translations['zh-CN']) return translations['zh-CN'][key];
    if (key in translations['en']) return translations['en'][key];
    return fallback ?? key;
  }, [locale]);
  return { t, locale, setLocale };
}

/** 非 hook 版本,供工具函数/单文件模块用 */
export function tr(key: string, locale: Locale = 'zh-CN', fallback?: string): string {
  const dict = translations[locale];
  if (dict && key in dict) return dict[key];
  if (locale !== 'zh-CN' && key in translations['zh-CN']) return translations['zh-CN'][key];
  if (key in translations['en']) return translations['en'][key];
  return fallback ?? key;
}
