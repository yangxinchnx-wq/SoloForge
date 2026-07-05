import React, { useState } from 'react';
import { Search, Database, Trash2 } from '../../utils/icons';

// 09. 知识库控制
export default function KnowledgeBaseTab() {
  const [knowledgeSearchTerm, setKnowledgeSearchTerm] = useState('');
  const [knowledgeBases, setKnowledgeBases] = useState([
    { name: 'API文档库', fileCount: 4, size: '2.4 MB' },
    { name: 'SpringCloud设计蓝图', fileCount: 8, size: '14.2 MB' },
    { name: '前端主题库规范', fileCount: 2, size: '640 KB' }
  ]);
  const [newKbName, setNewKbName] = useState('');
  const createNewKbMock = () => {
    if (!newKbName) return;
    setKnowledgeBases([...knowledgeBases, { name: newKbName, fileCount: 0, size: '0 KB' }]);
    setNewKbName('');
  };

  return (
    <div className="space-y-6 animate-fadeIn">
      <div className="border-b border-[var(--color-outline)]/20 pb-3 mb-2">
        <h3 className="text-base font-bold text-[var(--color-on-surface)]">知识库控制</h3>
        <p className="text-xs text-on-surface/50 mt-1">新建并部署专属本地知识库，上传高价值代码文档或 PDF 参与 RAG 语义检索</p>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2 space-y-2">
          <span className="text-xs text-on-surface/50 block">按名称过滤外部知识分片</span>
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-on-surface/40" />
            <input
              type="text"
              placeholder="输入关键字开始全局模糊检索..."
              value={knowledgeSearchTerm}
              onChange={(e) => setKnowledgeSearchTerm(e.target.value)}
              className="w-full text-sm pl-9 p-2.5 bg-[var(--color-bg)] border border-[var(--color-outline)]/20 rounded-xl text-[var(--color-on-surface)] outline-none focus:border-[var(--color-primary)]"
            />
          </div>
        </div>

        <div className="space-y-2">
          <span className="text-xs text-[var(--color-primary)] font-mono block font-semibold">快速新建索引区</span>
          <div className="flex gap-1.5">
            <input
              type="text"
              placeholder="分类名称"
              value={newKbName}
              onChange={(e) => setNewKbName(e.target.value)}
              className="text-sm p-2 bg-[var(--color-bg)] border border-[var(--color-outline)]/20 rounded-lg text-[var(--color-on-surface)] font-sans outline-none focus:border-[var(--color-primary)] w-full"
            />
            <button
              onClick={createNewKbMock}
              className="bg-[var(--color-primary)] hover:opacity-90 text-[var(--color-bg)] font-extrabold text-xs px-3.5 rounded-lg cursor-pointer transition-all"
            >
              创建
            </button>
          </div>
        </div>
      </div>

      <div className="space-y-2 pt-1">
        {knowledgeBases
          .filter(kb => kb.name.toLowerCase().includes(knowledgeSearchTerm.toLowerCase()))
          .map((kb) => (
            <div key={kb.name} className="p-3.5 bg-[var(--color-surface)] border border-[var(--color-outline)]/25 rounded-xl flex items-center justify-between hover:border-[var(--color-primary)]/30 transition-all shadow-sm">
              <div className="flex items-center gap-3">
                <Database className="w-4 h-4 text-[var(--color-primary)] animate-pulse" />
                <div>
                  <span className="text-sm font-bold text-[var(--color-on-surface)] block">{kb.name}</span>
                  <span className="text-xs text-on-surface/50 font-mono mt-0.5">挂载结构: {kb.fileCount} 个分卷 / {kb.size} 共用缓冲区</span>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button className="text-xs bg-[var(--color-surface-bright)] hover:bg-[var(--color-on-surface)]/5 text-[var(--color-on-surface)] border border-[var(--color-outline)]/15 py-1 px-3 rounded-lg cursor-pointer transition-all">
                  上传文档
                </button>
                <button
                  onClick={() => setKnowledgeBases(prev => prev.filter(item => item.name !== kb.name))}
                  className="p-1 hover:bg-red-500/10 rounded text-on-surface/40 hover:text-red-400 cursor-pointer transition-all"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
        ))}
      </div>
    </div>
  );
}
