/**
 * 智能代码文档生成器 Modal
 *
 * 2026-07-03 阶段3.1.C 从 ChatPanel.tsx 抽出。
 * 原 ChatPanel 内联 modal (260 行 JSX + 11 state + 3 handler) 拆为独立子应用。
 *
 * 状态:全部在 useDocsGeneratorStore,本组件只负责渲染 + 事件监听。
 * 事件监听:
 *   - soloforge-response-selected-text (编辑器选中文本回填)
 *   - soloforge-open-docs-generator (外部触发打开)
 *   - ESC keydown (关闭 modal)
 */

import { useEffect } from 'react';
import {
  FileText, X, HelpCircle, FileCode, Clock, Brain,
  Loader2, Check, Copy, Download, CheckCheck,
} from '../utils/icons';
import { MountTransition } from './MountTransition';
import { useDocsGeneratorStore } from '../state/useDocsGeneratorStore';

export default function DocsGeneratorModal() {
  // ── store 订阅 ───────────────────────────────────
  const isDocsModalOpen = useDocsGeneratorStore(s => s.isDocsModalOpen);
  const selectedCode = useDocsGeneratorStore(s => s.selectedCode);
  const selectedFileName = useDocsGeneratorStore(s => s.selectedFileName);
  const isGeneratingDocs = useDocsGeneratorStore(s => s.isGeneratingDocs);
  const generatedDocFormat = useDocsGeneratorStore(s => s.generatedDocFormat);
  const generatedContent = useDocsGeneratorStore(s => s.generatedContent);
  const copiedDoc = useDocsGeneratorStore(s => s.copiedDoc);
  const errorMsg = useDocsGeneratorStore(s => s.errorMsg);
  const showHelperGuide = useDocsGeneratorStore(s => s.showHelperGuide);
  const isWholeFile = useDocsGeneratorStore(s => s.isWholeFile);

  // ── setters / actions (函数引用稳定, 不需 selector) ───
  const setSelectedCode = useDocsGeneratorStore(s => s.setSelectedCode);
  const setGeneratedDocFormat = useDocsGeneratorStore(s => s.setGeneratedDocFormat);
  const setCopiedDoc = useDocsGeneratorStore(s => s.setCopiedDoc);
  const setShowHelperGuide = useDocsGeneratorStore(s => s.setShowHelperGuide);
  const setSelectedFileName = useDocsGeneratorStore(s => s.setSelectedFileName);
  const setErrorMsg = useDocsGeneratorStore(s => s.setErrorMsg);
  const setIsWholeFile = useDocsGeneratorStore(s => s.setIsWholeFile);
  const setIsDocsModalOpen = useDocsGeneratorStore(s => s.setIsDocsModalOpen);
  const openDocsGenerator = useDocsGeneratorStore(s => s.openDocsGenerator);
  const requestSelectedText = useDocsGeneratorStore(s => s.requestSelectedText);
  const generateDocs = useDocsGeneratorStore(s => s.generateDocs);
  const insertToCodeHead = useDocsGeneratorStore(s => s.insertToCodeHead);
  const exportDoc = useDocsGeneratorStore(s => s.exportDoc);

  // ── 事件监听: 编辑器选中文本回填 + 外部触发打开 ──
  useEffect(() => {
    const handleResponseSelectedText = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail) {
        if (detail.text && detail.text.trim()) {
          setSelectedCode(detail.text);
          setIsWholeFile(false);
        } else if (detail.fullContent && detail.fullContent.trim()) {
          setSelectedCode(detail.fullContent);
          setIsWholeFile(true);
        } else {
          setSelectedCode('');
          setIsWholeFile(false);
        }
        setSelectedFileName(detail.fileName || '');
        setErrorMsg('');
      } else {
        setErrorMsg('无法读取当前编辑器选中的代码');
      }
    };
    const handleOpenDocsGenerator = () => {
      openDocsGenerator();
    };
    window.addEventListener('soloforge-response-selected-text', handleResponseSelectedText);
    window.addEventListener('soloforge-open-docs-generator', handleOpenDocsGenerator);
    return () => {
      window.removeEventListener('soloforge-response-selected-text', handleResponseSelectedText);
      window.removeEventListener('soloforge-open-docs-generator', handleOpenDocsGenerator);
    };
  }, [
    setSelectedCode, setIsWholeFile, setSelectedFileName, setErrorMsg, openDocsGenerator,
  ]);

  // ── ESC 关闭 modal ──────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isDocsModalOpen) {
        setIsDocsModalOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, [isDocsModalOpen, setIsDocsModalOpen]);

  // ── 渲染 ────────────────────────────────────────────
  return (
    <MountTransition show={isDocsModalOpen} variant="fade" duration={180}>
      <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
        {/* Backdrop */}
        <div
          onClick={() => setIsDocsModalOpen(false)}
          className="absolute inset-0 bg-transparent"
        />

        {/* Real Backdrop Layer for blur and click-out */}
        <div
          className="fixed inset-0 bg-black/75 backdrop-blur-sm z-40"
          onClick={() => setIsDocsModalOpen(false)}
        />

        {/* Modal Body */}
        <div
          className="sf-anim sf-anim-fade-scale relative w-full max-w-2xl bg-surface border border-outline rounded-xl shadow-[0_20px_50px_rgba(0,0,0,0.15)] overflow-hidden flex flex-col max-h-[85vh] font-sans z-50 text-left"
        >
          {/* Header */}
          <div className="p-4 border-b border-outline/40 bg-bg/40 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="p-1.5 rounded-lg bg-emerald-500/10 text-emerald-400">
                <FileText className="w-4 h-4" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-on-surface">智能代码文档生成助手</h3>
                <p className="text-[10px] text-on-surface/50">支持生成标准 JSDoc 或 Markdown 格式注释文档并一键注入头部</p>
              </div>
            </div>

            <div className="flex items-center gap-1.5 ml-auto mr-1" />

            <button
              onClick={() => setIsDocsModalOpen(false)}
              className="p-1 hover:bg-surface-bright rounded text-on-surface/40 hover:text-primary transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Content */}
          <div className="p-5 flex-1 overflow-y-auto space-y-4">
            {/* Helper Guide Explanation Section */}
            <MountTransition show={showHelperGuide} variant="height" duration={200}>
                <div className="overflow-hidden">
                  <div className="p-4 bg-emerald-500/5 rounded-lg border border-emerald-500/15 space-y-2.5 text-xs text-left mb-2">
                    <div className="flex items-center gap-2 text-emerald-400 font-bold">
                      <HelpCircle className="w-4 h-4 shrink-0 text-[#ffde82]" />
                      <span>这个功能的作用是什么？（Code Documentation Helper）</span>
                    </div>
                    <div className="text-on-surface/80 space-y-2 leading-relaxed text-[11px]">
                      <p>
                        <strong>1. 智能精要解析</strong>：借助内核集成的 Gemini 大模型能力，高敏感度捕捉您框选的主体代码的传参、业务边界、执行序列，并完成架构级梳理。
                      </p>
                      <p>
                        <strong>2. 双规定制机制</strong>：
                      </p>
                      <ul className="list-disc list-inside pl-3 space-y-1 text-on-surface/70">
                        <li><strong>JSDoc 规格</strong>：完美遵循开发标准，输出包含 <code className="text-[#ffde82] bg-white/5 px-1 py-0.5 rounded font-mono">@param</code> / <code className="text-[#ffde82] bg-white/5 px-1 py-0.5 rounded font-mono">@returns</code> 的方法块级多行原生注释。</li>
                        <li><strong>Markdown 规格</strong>：提供清晰的代码结构拆解、业务流走向分析与极端边界说明，最适合用于研发 Wiki、设计白皮书的团队归档。</li>
                      </ul>
                      <p>
                        <strong>3. 一键无缝集成 / 卓越导出</strong>：
                      </p>
                      <ul className="list-disc list-inside pl-3 space-y-1 text-on-surface/70">
                        <li><strong>头部注入</strong>：点击后全自动将格式化的文档内容添加至该文件顶部第1行，消除繁杂的手动选中复制流程。</li>
                        <li><strong>自主导出</strong>：支持生成并下载对应的文档文件包，免去粘连错误。</li>
                      </ul>
                    </div>
                  </div>
                </div>
            </MountTransition>

            {/* Active Context Selection File info */}
            <div className="p-3 bg-bg/40 rounded-lg border border-outline flex items-center justify-between text-xs">
              <div className="flex items-center gap-2 text-on-surface/80">
                <FileCode className="w-4 h-4 text-primary" />
                <span className="font-semibold text-on-surface">当前代码上下文:</span>
                <span className="font-mono text-emerald-400 font-bold bg-emerald-500/10 px-1.5 py-0.5 rounded text-[10.5px]">
                  {selectedFileName || '未选择文件'}
                </span>
              </div>
              <button
                onClick={() => requestSelectedText()}
                className="text-[10px] text-primary hover:underline flex items-center gap-1 cursor-pointer font-bold"
              >
                <Clock className="w-3 h-3" />
                <span>重试抓取选区</span>
              </button>
            </div>

            {/* Selected Code display or warning */}
            <div className="space-y-1.5 text-left">
              <div className="flex justify-between items-center text-[10px] font-bold text-on-surface/40 uppercase tracking-wider">
                <span>欲文档化的内容段 (可在此直接任意编辑、删减、增加内容或填入文本)</span>
                {selectedCode ? (
                  isWholeFile ? (
                    <span className="text-[9px] text-[#34d399] font-bold bg-[#34d399]/10 border border-[#34d399]/20 px-1.5 py-0.5 rounded">
                      已捕获整份文件
                    </span>
                  ) : (
                    <span className="text-[9px] text-[#ffde82] font-bold bg-[#ffde82]/10 border border-[#ffde82]/20 px-1.5 py-0.5 rounded">
                      已捕获高亮选区
                    </span>
                  )
                ) : (
                  <span className="text-[9px] text-red-400 font-bold bg-red-400/10 border border-red-400/20 px-1.5 py-0.5 rounded">
                    待自主输入
                  </span>
                )}
              </div>

              <div className="relative group rounded-md border border-outline focus-within:border-primary bg-bg/50 overflow-hidden transition-all flex flex-col">
                <textarea
                  value={selectedCode}
                  onChange={(e) => setSelectedCode(e.target.value)}
                  placeholder="直接在此处贴入、编写、删除、修改任何需要文档化的代码、汉字备注或其它内容。也可以双击或划选编辑器中的代码自动实时抓取..."
                  className="w-full h-40 p-3 bg-transparent text-[11px] font-mono text-on-surface placeholder-on-surface/30 outline-none resize-y select-text leading-relaxed border-none focus:ring-0 active:ring-0 focus:outline-none"
                />

                {/* Character / Line Counters */}
                <div className="flex items-center justify-between px-3 py-1.5 bg-surface-bright/50 border-t border-outline/30 text-[10px] font-mono text-on-surface/50 select-none">
                  <div className="flex items-center gap-3">
                    <span>行数: <strong className="text-on-surface">{selectedCode ? selectedCode.split('\n').length : 0}</strong></span>
                    <span>字符数: <strong className="text-on-surface">{selectedCode.length}</strong></span>
                  </div>

                  <div className="flex items-center gap-2">
                    {selectedCode && (
                      <button
                        onClick={() => setSelectedCode('')}
                        className="bg-red-500/10 hover:bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded border border-red-500/20 hover:border-red-500/40 font-semibold cursor-pointer transition-colors text-[9px]"
                        title="一键清空"
                      >
                        清空内容
                      </button>
                    )}
                    <span className="text-[9px] text-emerald-500/70 font-semibold bg-emerald-500/5 border border-emerald-500/10 px-1.5 rounded">
                      支持自定义输入与中英文混排
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Formats and action triggers */}
            <div className="flex items-center justify-between pt-1">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-on-surface/80">目标格式规格:</span>
                <div className="flex bg-bg/60 p-0.5 rounded border border-outline/30 text-[10.5px]">
                  <button
                    onClick={() => setGeneratedDocFormat('jsdoc')}
                    className={`px-3 py-1 rounded font-bold transition-all cursor-pointer ${
                      generatedDocFormat === 'jsdoc'
                        ? 'bg-primary text-bg'
                        : 'text-on-surface/65 hover:text-primary'
                    }`}
                  >
                    JSDoc 注释规格
                  </button>
                  <button
                    onClick={() => setGeneratedDocFormat('markdown')}
                    className={`px-3 py-1 rounded font-bold transition-all cursor-pointer ${
                      generatedDocFormat === 'markdown'
                        ? 'bg-primary text-bg'
                        : 'text-on-surface/65 hover:text-primary'
                    }`}
                  >
                    Markdown 解析规格
                  </button>
                </div>
              </div>

              <button
                onClick={() => generateDocs(generatedDocFormat)}
                disabled={isGeneratingDocs || !selectedCode.trim()}
                className="flex items-center gap-1.5 bg-[#2563eb] hover:bg-blue-500 text-white rounded-lg px-4 py-2 text-xs font-bold active:scale-95 transition-all cursor-pointer disabled:opacity-40 disabled:hover:bg-[#2563eb]"
              >
                {isGeneratingDocs ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>智算生成中...</span>
                  </>
                ) : (
                  <>
                    <Brain className="w-3.5 h-3.5 text-[#ffde82]" />
                    <span>启动大模型智算生成</span>
                  </>
                )}
              </button>
            </div>

            {/* Generation output / Errors */}
            {errorMsg && (
              <div className="p-3 bg-red-500/10 border border-red-500/25 rounded-md text-red-400 text-[11px] font-semibold leading-relaxed text-left">
                ⚠️ {errorMsg}
              </div>
            )}

            {/* Result area */}
            {generatedContent && (
              <div className="space-y-2 animate-fadeIn select-text text-left">
                <div className="flex items-center justify-between text-[10px] font-bold text-on-surface/40 uppercase tracking-wider">
                  <span>生成成果详情预览</span>
                  <span className="text-[9px] text-emerald-400 font-mono">GENERATE EXCELLENT STATUS: OK</span>
                </div>

                <div className="relative rounded-md border border-outline bg-surface p-3 shadow-lg max-h-[200px] overflow-y-auto font-mono text-[11.5px] text-on-surface whitespace-pre-wrap select-text leading-relaxed text-left">
                  {generatedContent}
                </div>

                {/* Footer operations (copy, export & insert) */}
                <div className="grid grid-cols-3 gap-2.5 pt-2 select-none">
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(generatedContent);
                      setCopiedDoc(true);
                      setTimeout(() => setCopiedDoc(false), 2000);
                    }}
                    className="flex items-center justify-center gap-1 py-2 px-1 rounded-lg border border-outline/40 hover:bg-surface-bright text-xs font-semibold text-on-surface/90 hover:text-primary transition-colors cursor-pointer"
                  >
                    {copiedDoc ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-green-500 shrink-0" />
                        <span>已复制</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5 text-on-surface/50 shrink-0" />
                        <span>复制代码</span>
                      </>
                    )}
                  </button>

                  <button
                    onClick={() => exportDoc()}
                    className="flex items-center justify-center gap-1 py-2 px-1 rounded-lg border border-outline/40 hover:bg-surface-bright text-xs font-semibold text-on-surface/90 hover:text-primary transition-colors cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5 text-on-surface/50 shrink-0" />
                    <span>导出文档</span>
                  </button>

                  <button
                    onClick={() => insertToCodeHead()}
                    className="flex items-center justify-center gap-1 py-2 px-1 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 text-emerald-300 font-bold text-xs transition-all cursor-pointer shadow-[0_2px_10px_rgba(16,185,129,0.15)]"
                  >
                    <CheckCheck className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    <span>一键应用头部</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </MountTransition>
  );
}
