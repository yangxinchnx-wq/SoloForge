import React, { useState } from 'react';
import { Trash2 } from '../../utils/icons';

// 07. 记忆体管理
export default function MemoryTab() {
  const [memoryTab, setMemoryTab] = useState<'custom' | 'url'>('custom');
  const [customMemories, setCustomMemories] = useState([
    { id: '1', title: '开发偏好', content: '总是倾向于采用 Tailwind v4 实用工具类及 named TS 进行导出。' },
    { id: '2', title: '组件架构', content: '所有的 RAG 搜索都必须经过 context-bus 进行统一转发保存。' }
  ]);
  const [newMemTitle, setNewMemTitle] = useState('');
  const [newMemContent, setNewMemContent] = useState('');
  const [urlMemoryLines, setUrlMemoryLines] = useState<string>('https://docs.soloforge.cc/guide\nhttps://github.com/soloforge/mcp-registry');

  const addCustomMemoryItem = () => {
    if (!newMemTitle || !newMemContent) return;
    setCustomMemories([...customMemories, { id: Date.now().toString(), title: newMemTitle, content: newMemContent }]);
    setNewMemTitle('');
    setNewMemContent('');
  };

  return (
    <div className="space-y-6 animate-fadeIn">
      <div className="border-b border-[var(--color-outline)]/20 pb-3 mb-2">
        <h3 className="text-base font-bold text-[var(--color-on-surface)]">记忆体管理</h3>
        <p className="text-xs text-on-surface/50 mt-1">跨轮会话时自动沉淀高价值事实和约束限制条件</p>
      </div>

      <div className="flex border-b border-[var(--color-outline)]/20 gap-4 mb-2">
        <button
          onClick={() => setMemoryTab('custom')}
          className={`pb-2 text-sm font-bold border-b-2 transition-all ${memoryTab === 'custom' ? 'border-[var(--color-primary)] text-[var(--color-primary)]' : 'border-transparent text-on-surface/40'}`}
        >
          偏好事实
        </button>
        <button
          onClick={() => setMemoryTab('url')}
          className={`pb-2 text-sm font-bold border-b-2 transition-all ${memoryTab === 'url' ? 'border-[var(--color-primary)] text-[var(--color-primary)]' : 'border-transparent text-on-surface/40'}`}
        >
          在线参考源
        </button>
      </div>

      {memoryTab === 'custom' && (
        <div className="space-y-4">
          <div className="bg-[var(--color-surface)] border border-[var(--color-outline)]/20 rounded-xl p-4 gap-3 flex flex-col">
            <span className="text-xs text-on-surface/50 font-mono block">录入一个全局常驻记忆</span>
            <div className="grid grid-cols-2 gap-3">
              <input
                type="text"
                placeholder="标题概要 (例如：运行端口)"
                value={newMemTitle}
                onChange={(e) => setNewMemTitle(e.target.value)}
                className="text-sm p-3 bg-[var(--color-bg)] border border-[var(--color-outline)]/20 rounded-lg text-[var(--color-on-surface)] font-sans outline-none focus:border-[var(--color-primary)]"
              />
              <input
                type="text"
                placeholder="细节描述 (例如：始终开启 3000 端映射)"
                value={newMemContent}
                onChange={(e) => setNewMemContent(e.target.value)}
                className="text-sm p-3 bg-[var(--color-bg)] border border-[var(--color-outline)]/20 rounded-lg text-[var(--color-on-surface)] font-sans outline-none focus:border-[var(--color-primary)]"
              />
            </div>
            <button
              onClick={addCustomMemoryItem}
              className="w-full text-[var(--color-bg)] bg-[var(--color-primary)] hover:opacity-90 font-extrabold text-xs py-2 rounded-lg cursor-pointer transition-all"
            >
              写入上下文常驻记忆
            </button>
          </div>

          <div className="space-y-2">
             {customMemories.map((m) => (
              <div key={m.id} className="p-3 bg-[var(--color-surface)] border border-[var(--color-outline)]/15 rounded-xl text-xs flex justify-between items-start gap-4">
                <div>
                  <span className="font-bold text-[var(--color-primary)] text-sm block">{m.title}</span>
                  <p className="text-on-surface/70 text-xs mt-1">{m.content}</p>
                </div>
                <button
                  onClick={() => setCustomMemories(customMemories.filter(item => item.id !== m.id))}
                  className="p-1 hover:bg-white/5 rounded text-on-surface/40 hover:text-red-400 cursor-pointer"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {memoryTab === 'url' && (
        <div className="space-y-4 font-sans">
          <span className="text-xs text-on-surface/50 font-mono block">设置要自动爬取的 API、博客与文本文档 (每行一个首选 URL)</span>
          <textarea
            rows={4}
            value={urlMemoryLines}
            onChange={(e) => setUrlMemoryLines(e.target.value)}
            className="w-full bg-[var(--color-bg)] border border-[var(--color-outline)]/20 rounded-xl p-3.5 text-sm text-[var(--color-on-surface)] outline-none font-mono focus:border-[var(--color-primary)]"
          />
          <div className="flex justify-between items-center bg-[var(--color-surface)] p-3 border border-[var(--color-outline)]/15 rounded-xl">
            <span className="text-xs text-[var(--color-primary)]/75 font-mono">保存时将自动执行异步抓取并写入语义检索库</span>
            <button className="bg-[var(--color-primary)]/15 border border-[var(--color-primary)]/30 text-[var(--color-primary)] hover:text-[var(--color-on-surface)] text-xs font-bold px-4 py-2 rounded-lg active:scale-95 cursor-pointer animate-pulse">
              同步知识源
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
