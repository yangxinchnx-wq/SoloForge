/**
 * 智能代码文档生成器 store
 *
 * 2026-07-03 阶段3.1.C 从 ChatPanel.tsx 抽出。
 * 原 11 个 useState 收敛到单一 zustand store,DocsGeneratorModal 组件订阅即可。
 *
 * 注意:zustand store 不能跑 useEffect,事件监听/ESC handler 仍在 DocsGeneratorModal.tsx 内。
 */

import { create } from 'zustand';

export type DocFormat = 'jsdoc' | 'markdown';

interface DocsGeneratorState {
  // ── 状态 ──────────────────────────────────────────
  isDocsModalOpen: boolean;
  selectedCode: string;
  selectedFileName: string;
  isGeneratingDocs: boolean;
  generatedDocFormat: DocFormat;
  generatedContent: string;
  copiedDoc: boolean;
  errorMsg: string;
  showHelperGuide: boolean;
  isWholeFile: boolean;

  // ── setters ──────────────────────────────────────
  setIsDocsModalOpen: (v: boolean) => void;
  setSelectedCode: (v: string) => void;
  setSelectedFileName: (v: string) => void;
  setIsGeneratingDocs: (v: boolean) => void;
  setGeneratedDocFormat: (v: DocFormat) => void;
  setGeneratedContent: (v: string) => void;
  setCopiedDoc: (v: boolean) => void;
  setErrorMsg: (v: string) => void;
  setShowHelperGuide: (v: boolean) => void;
  setIsWholeFile: (v: boolean) => void;

  // ── 复合 actions ─────────────────────────────────
  /** 打开 modal 并清空上次内容 */
  openDocsGenerator: () => void;
  /** 重新请求编辑器选中文本 (派发自定义事件) */
  requestSelectedText: () => void;
  /** 关闭 modal */
  closeDocsModal: () => void;
  /** 调用 /api/llm/stream SSE 流式生成文档 */
  generateDocs: (format: DocFormat) => Promise<void>;
  /** 把生成内容包装成注释,派发 soloforge-insert-comment-to-head 给编辑器 */
  insertToCodeHead: () => void;
  /** 导出为 .md / .jsdoc.txt 文件 */
  exportDoc: () => void;
}

export const useDocsGeneratorStore = create<DocsGeneratorState>((set, get) => ({
  // ── 初始状态 ──────────────────────────────────────
  isDocsModalOpen: false,
  selectedCode: '',
  selectedFileName: '',
  isGeneratingDocs: false,
  generatedDocFormat: 'jsdoc',
  generatedContent: '',
  copiedDoc: false,
  errorMsg: '',
  showHelperGuide: false,
  isWholeFile: false,

  // ── setters ──────────────────────────────────────
  setIsDocsModalOpen: (v) => set({ isDocsModalOpen: v }),
  setSelectedCode: (v) => set({ selectedCode: v }),
  setSelectedFileName: (v) => set({ selectedFileName: v }),
  setIsGeneratingDocs: (v) => set({ isGeneratingDocs: v }),
  setGeneratedDocFormat: (v) => set({ generatedDocFormat: v }),
  setGeneratedContent: (v) => set({ generatedContent: v }),
  setCopiedDoc: (v) => set({ copiedDoc: v }),
  setErrorMsg: (v) => set({ errorMsg: v }),
  setShowHelperGuide: (v) => set({ showHelperGuide: v }),
  setIsWholeFile: (v) => set({ isWholeFile: v }),

  // ── 复合 actions ─────────────────────────────────
  openDocsGenerator: () => {
    set({
      isDocsModalOpen: true,
      generatedContent: '',
      errorMsg: '',
      selectedCode: '',
      selectedFileName: '',
      showHelperGuide: false,
      isWholeFile: false,
    });
    // 派发查询事件给编辑器
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('soloforge-request-selected-text'));
    }
  },

  requestSelectedText: () => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('soloforge-request-selected-text'));
    }
  },

  closeDocsModal: () => set({ isDocsModalOpen: false }),

  generateDocs: async (format) => {
    const { selectedCode } = get();
    if (!selectedCode.trim()) {
      set({ errorMsg: '请提供或选择一些代码块来进行文档/注释生成。' });
      return;
    }
    set({ isGeneratingDocs: true, errorMsg: '', generatedContent: '' });

    try {
      const formatPrompt = format === 'jsdoc'
        ? `请针对以下代码段生成一段标准的 JSDoc 注释。
要求：
1. 包含核心功能、输入参数名、输入类型、返回值说明、返回值类型。
2. 语言使用简体中文。
3. 请【直接输出】多行注释段（形如 /** ... */），不要将 JSDoc 包裹在代码块中，不要输出多余解释或 Markdown 自带的\`\`\``
        : `请针对以下代码段生成一份精致的 Markdown 代码解析文档。
要求：
1. 结构包括：核心功能概述、逻辑思路精解（步骤或重点说明）、异常/安全边界与使用示例。
2. 格式优雅，使用清晰的 Markdown 标头、粗体和列表。
3. 语言使用简体中文。
4. **注意**：由于之后可能会插入至代码中，请直接输出生成的文档本体，确保可以用 /* ... */ 注释块进行包裹。`;

      const response = await fetch('/api/llm/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          systemPrompt: formatPrompt,
          userGoal: `Code:\n\`\`\`\n${selectedCode}\n\`\`\``,
          model: 'main',
          temperature: 0.3,
          maxTokens: 2048,
        }),
      });

      if (!response.ok || !response.body) {
        const errText = await response.text().catch(() => '');
        set({ errorMsg: `AI 助理文档生成失败: HTTP ${response.status} ${errText}` });
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let textResult = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const evt = JSON.parse(payload);
            if (typeof evt.delta === 'string') textResult += evt.delta;
            if (evt.error) throw new Error(evt.error);
          } catch (e: any) {
            if (e instanceof SyntaxError) continue;
            throw e;
          }
        }
      }

      textResult = textResult.replace(/^```[a-zA-Z0-9]*\n/, '').replace(/\n```$/, '');
      set({ generatedContent: textResult });
    } catch (err: any) {
      console.error(err);
      set({ errorMsg: `服务请求故障，请稍后重试: ${err.message}` });
    } finally {
      set({ isGeneratingDocs: false });
    }
  },

  insertToCodeHead: () => {
    const { generatedContent, generatedDocFormat } = get();
    if (!generatedContent) return;

    let commentText = '';
    if (generatedDocFormat === 'jsdoc') {
      const cleanContent = generatedContent.trim();
      if (cleanContent.startsWith('/**') || cleanContent.startsWith('/*')) {
        commentText = cleanContent;
      } else {
        commentText = `/**\n * ${cleanContent.replace(/\n/g, '\n * ')}\n */`;
      }
    } else {
      commentText = `/*\n================================================================\n代码模块说明与剖析 (Markdown 格式详情)\n================================================================\n\n${generatedContent.trim()}\n*/`;
    }

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('soloforge-insert-comment-to-head', {
        detail: { comment: commentText }
      }));
    }
    set({ isDocsModalOpen: false });
  },

  exportDoc: () => {
    const { generatedContent, selectedFileName, generatedDocFormat } = get();
    if (!generatedContent) return;
    const filename = `${selectedFileName ? selectedFileName.replace(/\.[^/.]+$/, "") : "code"}_doc.${generatedDocFormat === 'jsdoc' ? 'jsdoc.txt' : 'md'}`;
    const blob = new Blob([generatedContent], { type: 'text/markdown;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  },
}));

// ── HMR 边界:改 store 代码时热替换 store 实例,不触发 full page reload ──
// React 组件树保持挂载,文档生成器 UI 状态 (modal 开关/已生成内容) 会重置为初始值。
if (import.meta.hot) {
  import.meta.hot.accept((m) => {
    if (m) useDocsGeneratorStore.setState(m.useDocsGeneratorStore.getState(), true);
  });
}
