// ─────────────────────────────────────────────────────────────────
// 通知规则引擎 — NotifierRules
// - 触发器 (build-fail / deploy / new-event / pr-merge 等)
// - 条件 (级别/项目/分支/作者)
// - 动作 (toast / notification / sound / email / webhook)
// - 启用/禁用/优先级
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Tooltip, IconButton, Badge, Button, Select, Switch } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; }

type Trigger = 'build-fail' | 'build-pass' | 'deploy-start' | 'deploy-end' | 'new-event' | 'pr-open' | 'pr-merge' | 'error-spike' | 'agent-action' | 'commit';
type Level = 'info' | 'success' | 'warning' | 'error';
type Action = 'toast' | 'notification' | 'sound' | 'email' | 'webhook' | 'slack';

interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: Trigger;
  conditions: Array<{ field: 'level' | 'project' | 'branch' | 'author'; op: 'eq' | 'neq' | 'contains' | 'regex'; value: string }>;
  actions: Array<{ type: Action; config?: string }>;
  throttle?: number;  // minutes
  priority: 1 | 2 | 3 | 4 | 5;
  hitCount: number;
  lastHit?: number;
}

const STORE = 'soloforge.notifier-rules.v1';

const TRIGGERS: Array<{ id: Trigger; label: string; icon: string }> = [
  { id: 'build-fail',    label: '构建失败', icon: 'error' },
  { id: 'build-pass',    label: '构建通过', icon: 'check_circle' },
  { id: 'deploy-start',  label: '开始部署', icon: 'rocket_launch' },
  { id: 'deploy-end',    label: '部署完成', icon: 'deployed_code' },
  { id: 'new-event',     label: '新事件',   icon: 'new_releases' },
  { id: 'pr-open',       label: 'PR 打开',  icon: 'merge' },
  { id: 'pr-merge',      label: 'PR 合并',  icon: 'merge_type' },
  { id: 'error-spike',   label: '错误激增', icon: 'trending_up' },
  { id: 'agent-action',  label: '智能体行动', icon: 'smart_toy' },
  { id: 'commit',        label: '代码提交', icon: 'commit' },
];

const ACTIONS: Array<{ id: Action; label: string; icon: string }> = [
  { id: 'toast',         label: '弹窗 Toast', icon: 'notifications_active' },
  { id: 'notification',  label: '通知中心', icon: 'notifications' },
  { id: 'sound',         label: '播放声音', icon: 'volume_up' },
  { id: 'email',         label: '发送邮件', icon: 'mail' },
  { id: 'webhook',       label: 'Webhook',   icon: 'webhook' },
  { id: 'slack',         label: 'Slack',     icon: 'forum' },
];

const LEVELS: Array<{ id: Level; label: string }> = [
  { id: 'info',    label: '信息' },
  { id: 'success', label: '成功' },
  { id: 'warning', label: '警告' },
  { id: 'error',   label: '错误' },
];

const SEED: Rule[] = [
  { id: 'r1', name: '构建失败立即通知', enabled: true, trigger: 'build-fail', conditions: [{ field: 'level', op: 'eq', value: 'error' }], actions: [{ type: 'toast' }, { type: 'sound' }, { type: 'slack', config: '#dev-alerts' }], priority: 5, hitCount: 23, lastHit: Date.now() - 3600000 },
  { id: 'r2', name: '部署完成发送邮件', enabled: true, trigger: 'deploy-end', conditions: [{ field: 'branch', op: 'eq', value: 'main' }], actions: [{ type: 'email', config: 'team@company.com' }], throttle: 5, priority: 3, hitCount: 12, lastHit: Date.now() - 86400000 },
  { id: 'r3', name: 'PR 合并 Toast', enabled: true, trigger: 'pr-merge', conditions: [], actions: [{ type: 'toast' }], priority: 2, hitCount: 47 },
  { id: 'r4', name: '错误激增告警', enabled: false, trigger: 'error-spike', conditions: [{ field: 'level', op: 'eq', value: 'error' }], actions: [{ type: 'sound' }, { type: 'webhook', config: 'https://hooks.example.com/alerts' }], throttle: 15, priority: 5, hitCount: 0 },
];

function load(): Rule[] { try { const r = localStorage.getItem(STORE); if (r) return JSON.parse(r); } catch { /* */ } return SEED; }
function save(d: Rule[]) { try { localStorage.setItem(STORE, JSON.stringify(d)); } catch { /* */ } }

export function NotifierRules({ open, onClose }: Props) {
  const [rules, setRules] = useState<Rule[]>(load);
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => { save(rules); }, [rules]);

  const editing = useMemo(() => rules.find(r => r.id === editingId) || null, [rules, editingId]);

  const addRule = useCallback(() => {
    const id = 'r_' + Date.now().toString(36);
    setRules(prev => [...prev, {
      id, name: '新规则', enabled: true, trigger: 'new-event', conditions: [],
      actions: [{ type: 'toast' }], priority: 3, hitCount: 0,
    }]);
    setEditingId(id);
  }, []);

  const updateRule = useCallback((id: string, patch: Partial<Rule>) => {
    setRules(prev => prev.map(r => r.id === id ? { ...r, ...patch } : r));
  }, []);

  const delRule = useCallback((id: string) => {
    setRules(prev => prev.filter(r => r.id !== id));
    if (editingId === id) setEditingId(null);
  }, [editingId]);

  const testRule = useCallback((id: string) => {
    setRules(prev => prev.map(r => r.id === id ? { ...r, hitCount: r.hitCount + 1, lastHit: Date.now() } : r));
    alert('已模拟触发规则 (命中 +1)');
  }, []);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1100px] max-w-[95vw] h-[80vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">rule</span>
          <h2 className="text-sm font-semibold text-text">通知规则引擎</h2>
          <Badge variant="primary">{rules.filter(r => r.enabled).length} / {rules.length} 已启用</Badge>
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" icon="add" onClick={addRule}>新建规则</Button>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div className="flex-1 flex overflow-hidden">
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {rules.map(r => (
              <div key={r.id} className={'bg-bg border rounded-lg p-3 transition cursor-pointer ' + (editingId === r.id ? 'border-accent ring-2 ring-accent/20' : 'border-border hover:border-primary')}
                onClick={() => setEditingId(r.id)}>
                <div className="flex items-center gap-2">
                  <Switch checked={r.enabled} onChange={(v) => updateRule(r.id, { enabled: v })} />
                  <span className="material-symbols-outlined text-sm text-accent">
                    {TRIGGERS.find(t => t.id === r.trigger)?.icon}
                  </span>
                  <h3 className="text-sm font-semibold text-text flex-1">{r.name}</h3>
                  <Badge variant="default">P{r.priority}</Badge>
                  <span className="text-[10px] text-text-secondary">命中 {r.hitCount}</span>
                </div>
                <div className="flex items-center gap-2 mt-2 text-[10px] text-text-secondary">
                  <span className="px-1.5 py-0.5 rounded bg-accent/15 text-accent">当 {TRIGGERS.find(t => t.id === r.trigger)?.label}</span>
                  {r.conditions.length > 0 && <span>+ {r.conditions.length} 条件</span>}
                  <span>→</span>
                  {r.actions.map((a, i) => (
                    <span key={i} className="px-1.5 py-0.5 rounded bg-primary/15 text-primary">
                      {ACTIONS.find(x => x.id === a.type)?.label}{a.config ? `: ${a.config}` : ''}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {editing && (
            <div className="w-80 border-l border-border bg-bg p-3 overflow-y-auto space-y-2">
              <h3 className="text-xs font-semibold text-text">编辑规则</h3>
              <input value={editing.name} onChange={(e) => updateRule(editing.id, { name: e.target.value })}
                className="w-full bg-surface border border-border-light rounded px-2 h-8 text-sm font-medium" />

              <div>
                <label className="text-[10px] text-text-secondary">触发器</label>
                <Select value={editing.trigger} options={TRIGGERS.map(t => ({ value: t.id, label: t.label }))} onChange={(v) => updateRule(editing.id, { trigger: v as Trigger })} className="w-full" />
              </div>

              <div>
                <label className="text-[10px] text-text-secondary">优先级</label>
                <Select value={String(editing.priority)} options={['1', '2', '3', '4', '5'].map(p => ({ value: p, label: `P${p}` }))} onChange={(v) => updateRule(editing.id, { priority: Number(v) as Rule['priority'] })} className="w-full" />
              </div>

              <div>
                <label className="text-[10px] text-text-secondary">节流 (分钟, 0 = 不限)</label>
                <input type="number" value={editing.throttle || 0} onChange={(e) => updateRule(editing.id, { throttle: Number(e.target.value) })}
                  className="w-full bg-surface border border-border-light rounded px-2 h-7 text-xs" />
              </div>

              <div>
                <label className="text-[10px] text-text-secondary flex justify-between">
                  条件
                  <Button size="xs" icon="add" onClick={() => updateRule(editing.id, { conditions: [...editing.conditions, { field: 'level', op: 'eq', value: 'error' }] })}>新增</Button>
                </label>
                <div className="space-y-1">
                  {editing.conditions.map((c, i) => (
                    <div key={i} className="flex gap-1">
                      <Select value={c.field} options={[{ value: 'level', label: '级别' }, { value: 'project', label: '项目' }, { value: 'branch', label: '分支' }, { value: 'author', label: '作者' }]} onChange={(v) => updateRule(editing.id, { conditions: editing.conditions.map((x, j) => j === i ? { ...x, field: v as any } : x) })} className="w-20" />
                      <Select value={c.op} options={['eq', 'neq', 'contains', 'regex'].map(o => ({ value: o, label: o }))} onChange={(v) => updateRule(editing.id, { conditions: editing.conditions.map((x, j) => j === i ? { ...x, op: v as any } : x) })} className="w-20" />
                      <input value={c.value} onChange={(e) => updateRule(editing.id, { conditions: editing.conditions.map((x, j) => j === i ? { ...x, value: e.target.value } : x) })}
                        className="flex-1 bg-surface border border-border-light rounded px-2 h-7 text-xs font-mono" />
                      <IconButton icon="close" size="xs" onClick={() => updateRule(editing.id, { conditions: editing.conditions.filter((_, j) => j !== i) })} />
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-[10px] text-text-secondary flex justify-between">
                  动作
                  <Button size="xs" icon="add" onClick={() => updateRule(editing.id, { actions: [...editing.actions, { type: 'toast' }] })}>新增</Button>
                </label>
                <div className="space-y-1">
                  {editing.actions.map((a, i) => (
                    <div key={i} className="flex gap-1">
                      <Select value={a.type} options={ACTIONS.map(x => ({ value: x.id, label: x.label }))} onChange={(v) => updateRule(editing.id, { actions: editing.actions.map((x, j) => j === i ? { ...x, type: v as Action } : x) })} className="w-32" />
                      <input value={a.config || ''} onChange={(e) => updateRule(editing.id, { actions: editing.actions.map((x, j) => j === i ? { ...x, config: e.target.value } : x) })} placeholder="配置"
                        className="flex-1 bg-surface border border-border-light rounded px-2 h-7 text-xs font-mono" />
                      <IconButton icon="close" size="xs" onClick={() => updateRule(editing.id, { actions: editing.actions.filter((_, j) => j !== i) })} />
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex gap-1 mt-3">
                <Button size="sm" variant="primary" icon="play_arrow" onClick={() => testRule(editing.id)} block>测试触发</Button>
                <Button size="sm" variant="danger" icon="delete" onClick={() => delRule(editing.id)}>删除</Button>
              </div>

              <div className="text-[10px] text-text-secondary pt-2 border-t border-border-light">
                <div>命中次数: {editing.hitCount}</div>
                <div>最近触发: {editing.lastHit ? new Date(editing.lastHit).toLocaleString() : '从未'}</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
