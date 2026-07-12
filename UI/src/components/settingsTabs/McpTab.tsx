import React, { useState } from 'react';
import { Trash2 } from '../../utils/icons';

// 04. MCP 工具注册
export default function McpTab() {
  const [mcpTools, setMcpTools] = useState([
    { name: 'Filesystem MCP', desc: '宿主机沙箱文件读写控制端', route: 'localhost:5011' },
    { name: 'Direct MySQL Query', desc: '数据库元数据反射与分析端', route: 'localhost:5013' }
  ]);
  const [newMcpName, setNewMcpName] = useState('');
  const [newMcpDesc, setNewMcpDesc] = useState('');
  const [newMcpRoute, setNewMcpRoute] = useState('');
  const registerNewMcp = () => {
    if (!newMcpName) return;
    setMcpTools([...mcpTools, { name: newMcpName, desc: newMcpDesc || '自定义本地扩展工具', route: newMcpRoute || 'localhost:8121' }]);
    setNewMcpName('');
    setNewMcpDesc('');
    setNewMcpRoute('');
  };

  return (
    <div className="space-y-6 animate-fadeIn">
      <div className="border-b border-[var(--color-outline)]/20 pb-3 mb-2">
        <h3 className="text-base font-bold text-[var(--color-on-surface)]">MCP 工具注册</h3>
        <p className="text-xs text-on-surface/50 mt-1">注册并管辖 Model Context Protocol 扩展，协助模型操作外部工具</p>
      </div>

      {/* Listing of MCP tools */}
      <div className="space-y-2">
        <span className="text-xs text-[var(--color-primary)] font-mono font-semibold block">已加载的 MCP 服务套件</span>
        {mcpTools.map((mcp, idx) => (
          <div key={idx} className="p-3 bg-[var(--color-surface)] border border-[var(--color-outline)]/15 rounded-xl flex items-center justify-between shadow-sm">
            <div>
              <span className="text-sm font-bold text-[var(--color-on-surface)] flex items-center gap-2">{mcp.name} <span className="text-xs text-[var(--color-primary)] font-mono bg-[var(--color-primary)]/10 px-1.5 py-0.5 rounded font-normal shrink-0">{mcp.route}</span></span>
              <p className="text-xs text-on-surface/50 mt-1">{mcp.desc}</p>
            </div>
            <button
              onClick={() => setMcpTools(mcpTools.filter((_, i) => i !== idx))}
              className="text-on-surface/40 hover:text-red-400 p-1.5 hover:bg-red-500/10 rounded-lg transition-colors cursor-pointer"
              title="卸载"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>

      {/* Addition Form */}
      <div className="p-4 bg-[var(--color-surface)] border border-[var(--color-outline)]/20 rounded-xl space-y-3">
        <span className="text-xs text-[var(--color-primary)] font-mono block font-semibold">注册新 MCP 服务</span>
        <div className="grid grid-cols-3 gap-3">
          <input
            type="text"
            placeholder="服务名称"
            value={newMcpName}
            onChange={(e) => setNewMcpName(e.target.value)}
            className="text-sm p-3 bg-[var(--color-bg)] border border-[var(--color-outline)]/20 rounded-lg text-[var(--color-on-surface)] focus:border-[var(--color-primary)] outline-none"
          />
          <input
            type="text"
            placeholder="功能描述"
            value={newMcpDesc}
            onChange={(e) => setNewMcpDesc(e.target.value)}
            className="text-sm p-3 bg-[var(--color-bg)] border border-[var(--color-outline)]/20 rounded-lg text-[var(--color-on-surface)] focus:border-[var(--color-primary)] outline-none"
          />
          <input
            type="text"
            placeholder="服务寻址 (如 localhost:8011)"
            value={newMcpRoute}
            onChange={(e) => setNewMcpRoute(e.target.value)}
            className="text-sm p-3 bg-[var(--color-bg)] border border-[var(--color-outline)]/20 rounded-lg text-[var(--color-on-surface)] font-mono focus:border-[var(--color-primary)] outline-none"
          />
        </div>
        <button
          onClick={registerNewMcp}
          className="w-full bg-[var(--color-primary)] hover:opacity-90 text-[var(--color-bg)] font-extrabold text-xs py-2.5 rounded-lg transition-all cursor-pointer"
        >
          授权并加载至中枢
        </button>
      </div>

      {/* Recommendations */}
      <div className="bg-[var(--color-surface)]/60 border border-dashed border-[var(--color-outline)]/30 rounded-xl p-4.5 space-y-2">
        <span className="text-xs text-[var(--color-primary)]/80 font-mono font-semibold block">优质 MCP 数据源推荐</span>
        <p className="text-xs text-on-surface/50 leading-relaxed font-sans">
          建议通过拉取以下公共开源插件扩展助理环境控制边界：<br/>
          • Tencent Cloud Developer Tools Server: <span className="text-[var(--color-primary)] hover:underline cursor-pointer font-mono">github.com/tencent-mcp/studio-server</span><br/>
          • Ali Alibaba Qwen RAG Search: <span className="text-[var(--color-primary)] hover:underline cursor-pointer font-mono">github.com/alibaba/qwen-mcp</span>
        </p>
      </div>
    </div>
  );
}
