import React, { useState, useRef } from 'react';
import { Check, Trash2, Plus } from '../../utils/icons';
import { useStaticTheme, PRESET_FONTS, preloadFontByName } from '../../context/ThemeContext';

// 01. 界面语言与全局字体
export default function LanguageTab({ onClose }: { onClose: () => void }) {
  const [selectedLang, setSelectedLang] = useState(() => localStorage.getItem('soloforge_lang') || 'zh-CN');

  const changeLanguage = (lang: string) => {
    setSelectedLang(lang);
    localStorage.setItem('soloforge_lang', lang);
    try {
      const channel = new BroadcastChannel('soloforge-editor-sync-channel');
      channel.postMessage({
        type: 'TOAST',
        toast: lang === 'zh-CN' ? '🇨🇳 选中的显示语言已变更为: 简体中文 (已即时应用)' : '🇺🇸 Preferred language updated: English (US) (Instant load-out applied)'
      });
      channel.close();
    } catch (e) {
      console.warn(e);
    }
  };

  const { customFonts, selectedFont, addCustomFont, deleteCustomFont, setSelectedFont } = useStaticTheme();
  const fontInputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="space-y-6 animate-fadeIn text-left pb-6">
      <div className="bg-[var(--color-surface)] border border-[var(--color-outline)]/20 rounded-xl p-5 space-y-4">
        <span className="text-xs text-[var(--color-primary)] font-mono tracking-wider font-semibold uppercase block">语言偏好设置</span>
        <div className="flex items-center justify-between">
          <div>
            <span className="text-sm font-bold text-[var(--color-on-surface)]">系统显示语言</span>
            <p className="text-xs text-on-surface/50 mt-0.5">多国语言自动校准，默认为中文显示</p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => changeLanguage('zh-CN')}
              className={`px-3.5 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                selectedLang === 'zh-CN'
                  ? 'bg-[var(--color-primary)]/10 border border-[var(--color-primary)]/40 text-[var(--color-primary)] shadow-[0_0_12px_rgba(var(--color-primary-rgb),0.15)] font-extrabold'
                  : 'bg-[var(--color-bg)] border border-[var(--color-outline)]/15 text-on-surface/50 hover:text-white hover:border-[var(--color-outline)]/35'
              }`}
            >
              简体中文 (ZH)
            </button>
            <button
              onClick={() => changeLanguage('en-US')}
              className={`px-3.5 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                selectedLang === 'en-US'
                  ? 'bg-[var(--color-primary)]/10 border border-[var(--color-primary)]/40 text-[var(--color-primary)] shadow-[0_0_12px_rgba(var(--color-primary-rgb),0.15)] font-extrabold'
                  : 'bg-[var(--color-bg)] border border-[var(--color-outline)]/15 text-on-surface/50 hover:text-white hover:border-[var(--color-outline)]/35'
              }`}
            >
              English (US)
            </button>
          </div>
        </div>
      </div>

      {/* Font settings nested inline */}
      <div className="bg-[var(--color-surface)] border border-[var(--color-outline)]/20 rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <span className="text-xs text-[var(--color-primary)] font-mono tracking-wider font-semibold uppercase block">全局字体设置</span>
            <p className="text-xs text-on-surface/50 mt-0.5">轻触快速点击切换首选字体样式包，自动全站生效</p>
          </div>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
          {[...PRESET_FONTS, ...customFonts].map((font, idx) => {
            const isActive = selectedFont === font.name;

            // Derive display CSS font family name
            let displayFontFamily = font.name;
            if (font.name === '系统默认 (System UI)') {
              displayFontFamily = 'system-ui, sans-serif';
            } else if (font.name === '默认 (Default)') {
              displayFontFamily = 'Inter, sans-serif';
            } else if (font.name.includes('(')) {
              const m = font.name.match(/\(([^)]+)\)/);
              if (m) displayFontFamily = m[1];
            }

            return (
              <div
                key={idx}
                role="button"
                tabIndex={0}
                data-font-card={font.name}
                onClick={() => setSelectedFont(font.name)}
                onMouseEnter={() => preloadFontByName(font.name, customFonts)}
                onFocus={() => preloadFontByName(font.name, customFonts)}
                onTouchStart={() => preloadFontByName(font.name, customFonts)}
                className={`p-3.5 rounded-xl border text-left flex flex-col justify-between cursor-pointer transition-all ${
                  isActive
                    ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/10 shadow-[0_0_12px_rgba(var(--color-primary-rgb),0.25)]'
                    : 'border-[var(--color-outline)]/15 bg-[var(--color-bg)] hover:bg-[var(--color-surface-bright)]/30 hover:border-[var(--color-outline)]/35'
                }`}
                style={{ fontFamily: displayFontFamily }}
              >
                <div className="flex items-start justify-between min-w-0 gap-1.5">
                  <span className="text-xs font-bold text-[var(--color-on-surface)] truncate">
                    {font.name.replace(/\s*\(Default\)|\s*\(System UI\)/, '')}
                  </span>
                  {isActive && (
                    <span className="w-4 h-4 rounded-full bg-[var(--color-primary)] text-[var(--color-bg)] flex items-center justify-center shrink-0">
                      <Check className="w-2.5 h-2.5 font-extrabold stroke-[3.5]" />
                    </span>
                  )}
                </div>

                <div className="mt-3 flex items-center justify-between">
                  <span className="text-[9px] text-on-surface/40 font-mono tracking-wider leading-none">
                    {font.isPreset ? '系统预设' : '已导入'}
                  </span>
                  {!font.isPreset && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteCustomFont(font.name);
                      }}
                      className="p-1 text-on-surface/30 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors cursor-pointer"
                      title="删除此字体"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}

          {/* If selected font is custom, show clear delete button */}
          {!PRESET_FONTS.some(f => f.name === selectedFont) && (
            <div className="col-span-full mt-2 mb-2 flex justify-start">
              <button
                onClick={() => deleteCustomFont(selectedFont)}
                className="px-3 py-1.5 flex items-center gap-1.5 rounded-lg border border-red-500/20 bg-red-500/5 text-red-100 hover:bg-red-500/15 hover:border-red-500/40 transition-colors text-xs cursor-pointer font-medium shrink-0"
                title="释放/删除当前选中的本地字体资源"
              >
                <Trash2 className="w-3.5 h-3.5 text-red-400" />
                <span className="text-red-400">从缓存中移除选中本地字体资源: {selectedFont.replace(' (Local)', '')}</span>
              </button>
            </div>
          )}

          {/* Hidden dynamic local font loader input element */}
          <input
            type="file"
            ref={fontInputRef}
            accept=".ttf,.otf,.woff,.woff2"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;

              const reader = new FileReader();
              reader.onload = (event) => {
                const result = event.target?.result as string;
                if (result) {
                  // Extract readable display name without format extension
                  const nameWithoutExt = file.name.replace(/\.[^/.]+$/, "");
                  // Create premium display name, e.g. "MyFont (Local)"
                  const cleanName = `${nameWithoutExt} (Local)`;
                  addCustomFont(cleanName, result);
                  setSelectedFont(cleanName);
                }
              };
              reader.readAsDataURL(file);
            }}
            style={{ display: 'none' }}
          />

          {/* Plus Add action panel card */}
          <div
            role="button"
            onClick={() => {
              onClose();
              try {
                const channel = new BroadcastChannel('soloforge-editor-sync-channel');
                channel.postMessage({
                  type: 'JUMP_TO_EXPLORER',
                  toast: '📂 已为您跳转至资源管理文件夹！在左侧文件树「assets/fonts」中点击任何 .ttf/.otf/.woff 字体文件，即可自动生成样式磁贴，全局快速点击切换！'
                });
                channel.close();
              } catch (e) {
                console.warn(e);
              }
            }}
            className="p-3.5 rounded-xl border border-dashed border-[var(--color-primary)]/40 hover:border-[var(--color-primary)] hover:bg-[var(--color-primary)]/5 text-center flex flex-col items-center justify-center cursor-pointer transition-all gap-1 text-[var(--color-primary)] group min-h-[72px]"
            title="从软件资源管理文件夹导入并应用新字体"
          >
            <Plus className="w-5 h-5 stroke-[2.5] group-hover:scale-110 transition-transform active:scale-95" />
            <span className="text-[10.5px] font-bold tracking-tight">导入本地字体</span>
          </div>
        </div>
      </div>
    </div>
  );
}
