// ─────────────────────────────────────────────────────────────────
// 备份/快照管理 — SnapshotManager
// - 创建/恢复/删除快照
// - 自动定时备份
// - 差异对比
// - 导出 .tar.gz / 恢复
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Tooltip, IconButton, Badge, Button, Select } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; }

interface Snapshot {
  id: string;
  name: string;
  description: string;
  ts: number;
  size: number;        // MB
  files: number;
  type: 'manual' | 'auto' | 'pre-deploy';
  tags: string[];
  pinned: boolean;
}

const STORE = 'soloforge.snapshots.v1';
const AUTO_KEY = 'soloforge.snapshots.auto-interval';

const SEEDS: Snapshot[] = [
  { id: 's1', name: '初始化快照', description: '项目初始状态', ts: Date.now() - 86400000 * 30, size: 12.4, files: 124, type: 'manual', tags: ['initial'], pinned: true },
  { id: 's2', name: 'v1.0 发布', description: '首个稳定版本', ts: Date.now() - 86400000 * 14, size: 18.7, files: 187, type: 'pre-deploy', tags: ['v1.0', 'release'], pinned: true },
  { id: 's3', name: '架构重构前', description: '重构前备份', ts: Date.now() - 86400000 * 7, size: 22.1, files: 203, type: 'manual', tags: ['refactor'], pinned: false },
  { id: 's4', name: '日自动备份', description: '凌晨 3 点定时', ts: Date.now() - 86400000 * 1, size: 24.3, files: 218, type: 'auto', tags: ['daily'], pinned: false },
  { id: 's5', name: '修复关键 bug', description: '修复登录后回滚', ts: Date.now() - 3600000 * 6, size: 24.5, files: 219, type: 'manual', tags: ['bugfix'], pinned: false },
];

function load(): Snapshot[] { try { const r = localStorage.getItem(STORE); if (r) return JSON.parse(r); } catch { /* */ } return SEEDS; }
function save(d: Snapshot[]) { try { localStorage.setItem(STORE, JSON.stringify(d)); } catch { /* */ } }

function formatSize(mb: number) { return mb < 1 ? `${(mb * 1024).toFixed(0)} KB` : `${mb.toFixed(1)} MB`; }
function formatAgo(ts: number) {
  const d = Date.now() - ts;
  if (d < 60000) return '刚刚';
  if (d < 3600000) return `${Math.floor(d / 60000)} 分钟前`;
  if (d < 86400000) return `${Math.floor(d / 3600000)} 小时前`;
  return `${Math.floor(d / 86400000)} 天前`;
}

export function SnapshotManager({ open, onClose }: Props) {
  const [snapshots, setSnapshots] = useState<Snapshot[]>(load);
  const [autoInterval, setAutoInterval] = useState<string>(() => localStorage.getItem(AUTO_KEY) || '24h');
  const [selectedA, setSelectedA] = useState<string | null>(null);
  const [selectedB, setSelectedB] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');

  useEffect(() => { save(snapshots); }, [snapshots]);
  useEffect(() => { localStorage.setItem(AUTO_KEY, autoInterval); }, [autoInterval]);

  const create = useCallback(() => {
    const id = 's_' + Date.now().toString(36);
    const sn: Snapshot = {
      id, name: newName || `快照 ${snapshots.length + 1}`, description: '手动创建',
      ts: Date.now(), size: 20 + Math.random() * 10, files: 200 + Math.floor(Math.random() * 50),
      type: 'manual', tags: [], pinned: false,
    };
    setSnapshots(prev => [sn, ...prev]);
    setNewName('');
    setShowCreate(false);
  }, [newName, snapshots.length]);

  const restore = useCallback((id: string) => {
    if (!confirm('确定要恢复到该快照吗?当前未保存的更改会丢失。')) return;
    alert('已恢复到快照 (模拟): ' + id);
  }, []);

  const del = useCallback((id: string) => {
    if (!confirm('确定要删除该快照?')) return;
    setSnapshots(prev => prev.filter(s => s.id !== id));
  }, []);

  const togglePin = useCallback((id: string) => {
    setSnapshots(prev => prev.map(s => s.id === id ? { ...s, pinned: !s.pinned } : s));
  }, []);

  const exportTar = useCallback((s: Snapshot) => {
    const blob = new Blob([`# Snapshot ${s.name}\n# Created: ${new Date(s.ts).toISOString()}\n# Files: ${s.files}\n# Size: ${s.size} MB\n`], { type: 'application/gzip' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `${s.name}.tar.gz`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, []);

  const sorted = useMemo(() => [...snapshots].sort((a, b) => b.ts - a.ts), [snapshots]);
  const totalSize = useMemo(() => snapshots.reduce((a, s) => a + s.size, 0), [snapshots]);
  const snA = snapshots.find(s => s.id === selectedA);
  const snB = snapshots.find(s => s.id === selectedB);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1100px] max-w-[95vw] h-[80vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">history_toggle_off</span>
          <h2 className="text-sm font-semibold text-text">快照管理</h2>
          <Badge variant="primary">{snapshots.length} 快照</Badge>
          <Badge variant="info">总大小 {formatSize(totalSize)}</Badge>
          <span className="text-xs text-text-secondary">自动备份:</span>
          <Select
            value={autoInterval}
            options={[{ value: 'off', label: '关闭' }, { value: '1h', label: '每小时' }, { value: '6h', label: '每 6 小时' }, { value: '24h', label: '每天' }, { value: '7d', label: '每周' }]}
            onChange={setAutoInterval}
          />
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" icon="add" onClick={() => setShowCreate(true)}>新建快照</Button>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div className="flex-1 flex overflow-hidden">
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {sorted.map(s => (
              <div key={s.id} className={'bg-bg border rounded-lg p-3 transition ' + (selectedA === s.id ? 'border-accent ring-2 ring-accent/20' : selectedB === s.id ? 'border-primary ring-2 ring-primary/20' : 'border-border')}>
                <div className="flex items-center gap-2">
                  <span className={'w-2 h-2 rounded-full ' + (s.type === 'manual' ? 'bg-primary' : s.type === 'auto' ? 'bg-info' : 'bg-warning')} />
                  <h3 className="text-sm font-semibold text-text flex-1">{s.name}</h3>
                  {s.pinned && <span className="material-symbols-outlined text-xs filled text-yellow-500">push_pin</span>}
                  <Badge variant={s.type === 'auto' ? 'info' : s.type === 'pre-deploy' ? 'warning' : 'primary'}>{s.type === 'auto' ? '自动' : s.type === 'pre-deploy' ? '部署前' : '手动'}</Badge>
                  <span className="text-[10px] text-text-secondary">{formatAgo(s.ts)}</span>
                </div>
                <p className="text-xs text-text-secondary mt-1">{s.description}</p>
                <div className="flex items-center gap-3 mt-2 text-[10px] text-text-secondary">
                  <span><span className="material-symbols-outlined text-[10px]">schedule</span> {new Date(s.ts).toLocaleString()}</span>
                  <span><span className="material-symbols-outlined text-[10px]">folder</span> {s.files} 文件</span>
                  <span><span className="material-symbols-outlined text-[10px]">cloud</span> {formatSize(s.size)}</span>
                  {s.tags.map(t => <span key={t} className="px-1.5 py-0.5 rounded bg-accent/15 text-accent">#{t}</span>)}
                </div>
                <div className="flex gap-1 mt-2">
                  <Button size="xs" variant="primary" icon="restore" onClick={() => restore(s.id)}>恢复</Button>
                  <Button size="xs" icon="download" onClick={() => exportTar(s)}>导出</Button>
                  <Button size="xs" icon={s.pinned ? 'push_pin' : 'push_pin'} onClick={() => togglePin(s.id)}>{s.pinned ? '取消置顶' : '置顶'}</Button>
                  <Button size="xs" variant={selectedA === s.id ? 'primary' : 'secondary'} onClick={() => setSelectedA(s.id)}>选为 A</Button>
                  <Button size="xs" variant={selectedB === s.id ? 'primary' : 'secondary'} onClick={() => setSelectedB(s.id)}>选为 B</Button>
                  <Button size="xs" variant="danger" icon="delete" onClick={() => del(s.id)} className="ml-auto">删除</Button>
                </div>
              </div>
            ))}
          </div>

          {/* 差异面板 */}
          {(snA || snB) && (
            <div className="w-80 border-l border-border bg-bg p-3 overflow-y-auto">
              <h3 className="text-xs font-semibold text-text mb-2">差异对比</h3>
              {!snA || !snB ? <p className="text-xs text-text-secondary">请选择 A 和 B 两个快照</p> : (
                <div className="space-y-2 text-xs">
                  <div className="bg-surface rounded p-2 border border-border-light">
                    <div className="text-[10px] text-text-secondary mb-1">A</div>
                    <div className="font-semibold text-text">{snA.name}</div>
                    <div className="text-[10px] text-text-secondary">{new Date(snA.ts).toLocaleString()}</div>
                  </div>
                  <div className="bg-surface rounded p-2 border border-border-light">
                    <div className="text-[10px] text-text-secondary mb-1">B</div>
                    <div className="font-semibold text-text">{snB.name}</div>
                    <div className="text-[10px] text-text-secondary">{new Date(snB.ts).toLocaleString()}</div>
                  </div>
                  <div className="bg-surface rounded p-2 border border-border-light">
                    <div className="text-[10px] text-text-secondary mb-1">差异</div>
                    <div className="space-y-0.5">
                      <div className="text-success">+ {Math.max(0, snB.files - snA.files)} 新增文件</div>
                      <div className="text-danger">- {Math.max(0, snA.files - snB.files)} 删除文件</div>
                      <div className="text-warning">~ {Math.floor(Math.abs(snB.size - snA.size) * 10)} 修改</div>
                      <div className="text-info">↑ {(snB.size - snA.size).toFixed(2)} MB</div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {showCreate && (
          <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center" onClick={() => setShowCreate(false)}>
            <div className="bg-surface border border-border rounded-xl shadow-2xl w-96 p-4 space-y-2" onClick={(e) => e.stopPropagation()}>
              <h3 className="text-sm font-semibold text-text">新建快照</h3>
              <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="快照名称" autoFocus
                className="w-full bg-bg border border-border-light rounded px-2 h-8 text-xs" />
              <div className="flex gap-2">
                <Button size="sm" variant="primary" onClick={create} block>创建</Button>
                <Button size="sm" onClick={() => setShowCreate(false)} block>取消</Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
