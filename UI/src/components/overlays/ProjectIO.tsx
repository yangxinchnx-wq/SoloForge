// ─────────────────────────────────────────────────────────────────
// 项目导入 / 导出
// 导出:全部设置 / 会话 / 主题 / 自定义 token / 资源树 打包为 JSON
// 导入:解析 JSON 并恢复 (可选择: 会话 / 主题 / 设置)
// ─────────────────────────────────────────────────────────────────

import { useState, useRef, useMemo } from 'react';
import { useTheme } from '../../themes';
import { Button, Tooltip, Switch, Badge } from '../ui/Button';

interface Props {
  open: boolean;
  onClose: () => void;
  projectName: string;
  chat: {
    sessions: any[];
    settings: any;
  };
  resources: {
    tree: any;
  };
}

const SECTIONS = [
  { id: 'sessions', label: '对话会话',   icon: 'forum',  desc: '所有会话 + 消息' },
  { id: 'settings', label: 'AI 设置',    icon: 'tune',   desc: '模型 / 温度 / 提示词' },
  { id: 'theme',    label: '主题',       icon: 'palette',desc: '主题选择 + 自定义 token' },
  { id: 'tree',     label: '资源树',     icon: 'account_tree', desc: '文件结构 (不含文件内容)' },
];

const STORAGE_KEY = 'soloforge.lastImport';

export function ProjectIO({ open, onClose, projectName, chat, resources }: Props) {
  const { current, themeList } = useTheme();
  const [picked, setPicked] = useState<Record<string, boolean>>({
    sessions: true, settings: true, theme: true, tree: false,
  });
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const exportData = useMemo(() => {
    const obj: any = {
      __type: 'soloforge-export',
      version: 1,
      project: projectName,
      exportedAt: new Date().toISOString(),
    };
    if (picked.sessions) obj.sessions = chat.sessions;
    if (picked.settings) obj.settings = chat.settings;
    if (picked.theme) obj.theme = { baseId: current.id, custom: (current as any)._custom || {} };
    if (picked.tree) obj.tree = resources.tree;
    return obj;
  }, [picked, chat, current, resources, projectName]);

  const totalSize = useMemo(() => {
    const json = JSON.stringify(exportData);
    return new Blob([json]).size;
  }, [exportData]);

  const fileCount = useMemo(() => {
    let n = 0;
    const walk = (node: any) => {
      if (!node) return;
      if (node.type === 'file') n++;
      if (node.children) node.children.forEach(walk);
    };
    walk(resources.tree);
    return n;
  }, [resources.tree]);

  const handleExport = () => {
    const json = JSON.stringify(exportData, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `soloforge-${projectName.toLowerCase().replace(/\s+/g, '-')}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setResult({ ok: true, msg: `已导出 ${picked.sessions ? chat.sessions.length : 0} 个会话 · ${(totalSize / 1024).toFixed(1)} KB` });
  };

  const handleCopy = () => {
    const json = JSON.stringify(exportData, null, 2);
    navigator.clipboard?.writeText(json).then(() => {
      setResult({ ok: true, msg: 'JSON 已复制到剪贴板' });
    });
  };

  const handleImport = (file: File) => {
    setImporting(true);
    setResult(null);
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const obj = JSON.parse(String(e.target?.result));
        if (obj.__type !== 'soloforge-export') {
          throw new Error('不是 SoloForge 导出文件');
        }
        // 局部应用
        let count = 0;
        if (obj.sessions && Array.isArray(obj.sessions)) {
          try {
            const existing = JSON.parse(localStorage.getItem('soloforge.chat.history.v1') || '[]');
            const merged = [...obj.sessions, ...existing].slice(0, 100);
            localStorage.setItem('soloforge.chat.history.v1', JSON.stringify(merged));
            count += obj.sessions.length;
          } catch { /* ignore */ }
        }
        if (obj.settings) {
          try {
            localStorage.setItem('soloforge.chat.settings.v1', JSON.stringify(obj.settings));
            count++;
          } catch { /* ignore */ }
        }
        if (obj.theme && obj.theme.baseId) {
          try {
            localStorage.setItem('soloforge-theme', obj.theme.baseId);
            if (obj.theme.custom) {
              localStorage.setItem('soloforge.theme.custom.v1', JSON.stringify(obj.theme.custom));
            }
            count++;
          } catch { /* ignore */ }
        }
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify({
            name: file.name, size: file.size, at: Date.now(), sections: Object.keys(obj).filter(k => k !== '__type' && k !== 'version' && k !== 'project' && k !== 'exportedAt'),
          }));
        } catch { /* ignore */ }
        setResult({ ok: true, msg: `成功导入 ${count} 项 · 刷新页面后生效` });
      } catch (err: any) {
        setResult({ ok: false, msg: `导入失败: ${err.message || err}` });
      } finally {
        setImporting(false);
      }
    };
    reader.readAsText(file);
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[175] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="w-[700px] max-w-[92vw] bg-surface rounded-2xl border border-border shadow-2xl overflow-hidden flex flex-col animate-slide-in-up"
        onClick={e => e.stopPropagation()}
        style={{ maxHeight: '90vh' }}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between px-5 h-12 border-b border-border bg-gradient-to-r from-primary/5 to-accent/5">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary text-lg">sync_alt</span>
            <h3 className="font-display font-semibold text-text">项目导入 / 导出</h3>
            <Badge variant="default">{projectName}</Badge>
          </div>
          <button
            onClick={onClose}
            className="material-symbols-outlined text-text-secondary hover:text-text w-7 h-7 flex items-center justify-center rounded hover:bg-surface-high"
          >close</button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4 scrollbar-thin">
          {/* 导出区 */}
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <span className="material-symbols-outlined text-success text-sm">file_download</span>
              <span className="text-xs font-semibold text-text">导出</span>
              <span className="text-[10px] text-text-secondary">勾选要包含的内容,打包为 JSON</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {SECTIONS.map(s => (
                <label
                  key={s.id}
                  className={`group flex items-start gap-2 p-2.5 rounded-lg border cursor-pointer transition-all ${
                    picked[s.id]
                      ? 'border-primary/40 bg-primary/5'
                      : 'border-border-light bg-bg-dim hover:border-border'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={!!picked[s.id]}
                    onChange={e => setPicked(p => ({ ...p, [s.id]: e.target.checked }))}
                    className="mt-0.5 accent-primary"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 text-xs font-medium text-text">
                      <span className="material-symbols-outlined text-sm text-primary">{s.icon}</span>
                      {s.label}
                    </div>
                    <div className="text-[10px] text-text-secondary mt-0.5">{s.desc}</div>
                    <div className="text-[9px] text-text-secondary/70 font-mono mt-1">
                      {s.id === 'sessions' && `${chat.sessions.length} 会话`}
                      {s.id === 'settings' && `1 套设置`}
                      {s.id === 'theme' && `${current.name} + 自定义`}
                      {s.id === 'tree' && `${fileCount} 文件`}
                    </div>
                  </div>
                </label>
              ))}
            </div>
            <div className="flex items-center justify-between mt-3 p-2.5 rounded-lg bg-bg-dim border border-border-light text-[10px]">
              <div className="flex items-center gap-2 text-text-secondary">
                <span className="material-symbols-outlined text-sm">dataset</span>
                <span>预计大小: <span className="font-mono text-text">{(totalSize / 1024).toFixed(1)} KB</span></span>
              </div>
              <div className="flex items-center gap-1.5">
                <Button variant="ghost" size="sm" icon="content_copy" onClick={handleCopy}>复制</Button>
                <Button variant="primary" size="sm" icon="download" onClick={handleExport}>下载 .json</Button>
              </div>
            </div>
          </div>

          <div className="h-px bg-border" />

          {/* 导入区 */}
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <span className="material-symbols-outlined text-info text-sm">file_upload</span>
              <span className="text-xs font-semibold text-text">导入</span>
              <span className="text-[10px] text-text-secondary">选择 .json 文件恢复</span>
            </div>
            <div
              onClick={() => fileRef.current?.click()}
              onDragOver={e => { e.preventDefault(); }}
              onDrop={e => {
                e.preventDefault();
                const f = e.dataTransfer.files[0];
                if (f && f.name.endsWith('.json')) handleImport(f);
              }}
              className="border-2 border-dashed border-border-light rounded-xl p-6 text-center cursor-pointer hover:border-primary hover:bg-primary/5 transition-colors"
            >
              <span className="material-symbols-outlined text-3xl text-text-secondary/50">upload_file</span>
              <p className="text-xs text-text mt-2">点击或拖拽 JSON 文件到此处</p>
              <p className="text-[10px] text-text-secondary mt-1">
                仅识别 <code className="font-mono">__type: soloforge-export</code> 的导出文件
              </p>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={e => {
                const f = e.target.files?.[0];
                if (f) handleImport(f);
                e.target.value = '';
              }}
            />
            <div className="mt-2 text-[10px] text-text-secondary flex items-center gap-1.5">
              <span className="material-symbols-outlined text-sm">info</span>
              <span>导入后会自动合并会话(不去重)、覆盖设置/主题。刷新页面后生效。</span>
            </div>
          </div>

          {/* 结果展示 */}
          {result && (
            <div className={`p-3 rounded-lg flex items-start gap-2 text-xs animate-slide-in-up ${
              result.ok
                ? 'bg-success/10 border border-success/30 text-success'
                : 'bg-danger/10 border border-danger/30 text-danger'
            }`}>
              <span className="material-symbols-outlined text-sm">
                {result.ok ? 'check_circle' : 'error'}
              </span>
              <span>{result.msg}</span>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between px-5 h-11 bg-surface-low border-t border-border">
          <span className="text-[10px] text-text-secondary">SoloForge Export v1 · JSON Schema</span>
          <Button variant="ghost" size="sm" onClick={onClose}>关闭</Button>
        </div>
      </div>
    </div>
  );
}
