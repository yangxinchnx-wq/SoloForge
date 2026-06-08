// ─────────────────────────────────────────────────────────────────
// 合规审计器 — ComplianceAudit
// - SOC 2 / ISO 27001 / HIPAA 控制项
// - 控制项成熟度评估
// - 证据收集 + 审计跟踪
// - 风险登记册
// - 整改任务
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Tooltip, IconButton, Badge, Button } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; }

type Framework = 'SOC 2' | 'ISO 27001' | 'HIPAA' | 'PCI DSS' | 'GDPR';
type Status = 'implemented' | 'partial' | 'planned' | 'not_applicable' | 'failed';
type Risk = 'low' | 'medium' | 'high' | 'critical';

interface Control {
  id: string;
  framework: Framework;
  code: string;
  title: string;
  description: string;
  category: string;
  status: Status;
  maturity: number;   // 0-5
  owner: string;
  evidence: string[];
  lastReview: number;
  nextReview: number;
  risk: Risk;
}

const CONTROLS: Control[] = [
  // SOC 2
  { id: 'c1',  framework: 'SOC 2', code: 'CC1.1', title: '管理层理念与运营风格', description: '董事会与管理层展示诚信、道德价值观与能力', category: '控制环境', status: 'implemented', maturity: 4, owner: 'CEO', evidence: ['年度治理章程.pdf', '行为准则.pdf'], lastReview: Date.now() - 30 * 86400000, nextReview: Date.now() + 60 * 86400000, risk: 'low' },
  { id: 'c2',  framework: 'SOC 2', code: 'CC2.1', title: '信息安全沟通', description: '向内部和外部传达安全策略和程序', category: '沟通', status: 'implemented', maturity: 4, owner: 'CISO', evidence: ['信息安全政策.pdf', '安全意识培训记录.xlsx'], lastReview: Date.now() - 60 * 86400000, nextReview: Date.now() + 30 * 86400000, risk: 'low' },
  { id: 'c3',  framework: 'SOC 2', code: 'CC5.1', title: '控制活动选择与开发', description: '选择和开发控制活动以降低风险', category: '风险评估', status: 'partial', maturity: 3, owner: 'CISO', evidence: ['风险评估报告.pdf'], lastReview: Date.now() - 90 * 86400000, nextReview: Date.now() + 0, risk: 'medium' },
  { id: 'c4',  framework: 'SOC 2', code: 'CC6.1', title: '逻辑访问控制', description: '实施逻辑访问安全措施,基于最小权限', category: '访问控制', status: 'partial', maturity: 3, owner: 'Security', evidence: ['IAM 配置截图', '季度访问审查报告.pdf'], lastReview: Date.now() - 45 * 86400000, nextReview: Date.now() + 15 * 86400000, risk: 'high' },
  { id: 'c5',  framework: 'SOC 2', code: 'CC6.6', title: '边界逻辑访问控制', description: '实施边界保护 (防火墙/WAF)', category: '网络', status: 'implemented', maturity: 5, owner: 'Platform', evidence: ['WAF 规则配置', '季度渗透测试报告.pdf'], lastReview: Date.now() - 30 * 86400000, nextReview: Date.now() + 60 * 86400000, risk: 'low' },
  { id: 'c6',  framework: 'SOC 2', code: 'CC7.1', title: '系统运行检测', description: '持续监控系统异常', category: '监控', status: 'implemented', maturity: 4, owner: 'SRE', evidence: ['监控告警配置', 'On-call 值班表'], lastReview: Date.now() - 14 * 86400000, nextReview: Date.now() + 90 * 86400000, risk: 'low' },
  { id: 'c7',  framework: 'SOC 2', code: 'CC7.2', title: '安全事件响应', description: '建立安全事件响应计划', category: '事件响应', status: 'partial', maturity: 2, owner: 'CISO', evidence: ['IR 计划 v0.8.pdf'], lastReview: Date.now() - 120 * 86400000, nextReview: Date.now() - 30 * 86400000, risk: 'high' },
  { id: 'c8',  framework: 'SOC 2', code: 'CC8.1', title: '变更管理', description: '对系统变更实施授权和测试', category: '变更', status: 'implemented', maturity: 4, owner: 'Engineering', evidence: ['PR 流程文档', 'CI/CD 配置', '部署审批记录'], lastReview: Date.now() - 7 * 86400000, nextReview: Date.now() + 90 * 86400000, risk: 'low' },
  { id: 'c9',  framework: 'SOC 2', code: 'CC9.1', title: '风险缓解', description: '识别、选择和开发风险缓解控制', category: '风险评估', status: 'partial', maturity: 3, owner: 'CISO', evidence: ['风险登记册.xlsx'], lastReview: Date.now() - 60 * 86400000, nextReview: Date.now() + 30 * 86400000, risk: 'medium' },
  // ISO 27001
  { id: 'c10', framework: 'ISO 27001', code: 'A.5.1', title: '信息安全策略', description: '定义并批准信息安全策略', category: '策略', status: 'implemented', maturity: 5, owner: 'CISO', evidence: ['ISMS 政策 v3.0.pdf'], lastReview: Date.now() - 90 * 86400000, nextReview: Date.now() + 90 * 86400000, risk: 'low' },
  { id: 'c11', framework: 'ISO 27001', code: 'A.6.1', title: '人力资源安全', description: '员工入职/离职流程', category: 'HR', status: 'implemented', maturity: 4, owner: 'HR', evidence: ['入职清单.xlsx', '离职检查表.xlsx'], lastReview: Date.now() - 30 * 86400000, nextReview: Date.now() + 60 * 86400000, risk: 'low' },
  { id: 'c12', framework: 'ISO 27001', code: 'A.8.1', title: '资产清单', description: '维护完整的资产清单', category: '资产', status: 'partial', maturity: 2, owner: 'IT', evidence: ['资产清单 v0.5.xlsx'], lastReview: Date.now() - 120 * 86400000, nextReview: Date.now() - 15 * 86400000, risk: 'high' },
  { id: 'c13', framework: 'ISO 27001', code: 'A.10.1', title: '密码学控制', description: '实施加密控制保护信息', category: '加密', status: 'implemented', maturity: 4, owner: 'Security', evidence: ['TLS 证书', 'KMS 配置'], lastReview: Date.now() - 30 * 86400000, nextReview: Date.now() + 60 * 86400000, risk: 'low' },
  { id: 'c14', framework: 'ISO 27001', code: 'A.12.1', title: '运行安全', description: '运行程序和控制', category: '运行', status: 'implemented', maturity: 4, owner: 'SRE', evidence: ['运维手册.pdf'], lastReview: Date.now() - 30 * 86400000, nextReview: Date.now() + 60 * 86400000, risk: 'low' },
  { id: 'c15', framework: 'ISO 27001', code: 'A.16.1', title: '事件响应改进', description: '从事件中学习并改进', category: '事件响应', status: 'partial', maturity: 3, owner: 'CISO', evidence: ['Postmortem 模板'], lastReview: Date.now() - 30 * 86400000, nextReview: Date.now() + 60 * 86400000, risk: 'medium' },
  // HIPAA
  { id: 'c16', framework: 'HIPAA', code: '164.308(a)(1)', title: '安全管理', description: '实施安全管理流程', category: '管理', status: 'implemented', maturity: 4, owner: 'Compliance', evidence: ['HIPAA 政策.pdf'], lastReview: Date.now() - 30 * 86400000, nextReview: Date.now() + 60 * 86400000, risk: 'low' },
  { id: 'c17', framework: 'HIPAA', code: '164.312(a)(1)', title: '访问控制', description: 'PHI 唯一用户识别和访问控制', category: '访问控制', status: 'partial', maturity: 3, owner: 'Security', evidence: ['访问控制矩阵.xlsx'], lastReview: Date.now() - 30 * 86400000, nextReview: Date.now() + 30 * 86400000, risk: 'high' },
  { id: 'c18', framework: 'HIPAA', code: '164.312(e)(1)', title: '传输安全', description: 'PHI 传输加密', category: '加密', status: 'implemented', maturity: 5, owner: 'Security', evidence: ['TLS 配置', '端到端加密测试'], lastReview: Date.now() - 30 * 86400000, nextReview: Date.now() + 60 * 86400000, risk: 'low' },
  { id: 'c19', framework: 'HIPAA', code: '164.404', title: '泄露通知', description: '60 天内通知受影响的个人', category: '事件响应', status: 'planned', maturity: 1, owner: 'Legal', evidence: [], lastReview: Date.now() - 180 * 86400000, nextReview: Date.now() - 60 * 86400000, risk: 'critical' },
  // PCI DSS
  { id: 'c20', framework: 'PCI DSS', code: 'Req 1', title: '网络防火墙配置', description: '在持卡人数据环境周围实施防火墙', category: '网络', status: 'implemented', maturity: 4, owner: 'Network', evidence: ['防火墙规则审核报告'], lastReview: Date.now() - 30 * 86400000, nextReview: Date.now() + 90 * 86400000, risk: 'low' },
  { id: 'c21', framework: 'PCI DSS', code: 'Req 3', title: '持卡人数据保护', description: '保护存储的持卡人数据', category: '数据保护', status: 'partial', maturity: 3, owner: 'Security', evidence: ['数据加密策略.pdf'], lastReview: Date.now() - 30 * 86400000, nextReview: Date.now() + 60 * 86400000, risk: 'high' },
  { id: 'c22', framework: 'PCI DSS', code: 'Req 10', title: '日志和监控', description: '跟踪和监控所有网络资源访问', category: '监控', status: 'implemented', maturity: 4, owner: 'SRE', evidence: ['日志保留策略.pdf', 'SIEM 配置'], lastReview: Date.now() - 30 * 86400000, nextReview: Date.now() + 60 * 86400000, risk: 'low' },
];

const FRAMEWORKS: Framework[] = ['SOC 2', 'ISO 27001', 'HIPAA', 'PCI DSS', 'GDPR'];
const STATUSES: Status[] = ['implemented', 'partial', 'planned', 'not_applicable', 'failed'];
const RISKS: Risk[] = ['low', 'medium', 'high', 'critical'];

function statusLabel(s: Status): string {
  return { implemented: '已实施', partial: '部分实施', planned: '计划中', not_applicable: '不适用', failed: '失败' }[s];
}
function statusColor(s: Status): 'success' | 'warning' | 'info' | 'default' | 'danger' {
  return s === 'implemented' ? 'success' : s === 'partial' ? 'warning' : s === 'planned' ? 'info' : s === 'failed' ? 'danger' : 'default';
}

export function ComplianceAudit({ open, onClose }: Props) {
  const [tab, setTab] = useState<'overview' | 'controls' | 'evidence' | 'risk' | 'gap'>('overview');
  const [fw, setFw] = useState<Framework | 'all'>('all');
  const [status, setStatus] = useState<Status | 'all'>('all');
  const [activeCtrl, setActiveCtrl] = useState<string>(CONTROLS[0].id);

  const stats = useMemo(() => {
    const byFramework: Record<string, number> = {};
    for (const c of CONTROLS) {
      byFramework[c.framework] = (byFramework[c.framework] || 0) + 1;
    }
    const byStatus: Record<Status, number> = { implemented: 0, partial: 0, planned: 0, not_applicable: 0, failed: 0 };
    for (const c of CONTROLS) byStatus[c.status]++;
    const byRisk: Record<Risk, number> = { low: 0, medium: 0, high: 0, critical: 0 };
    for (const c of CONTROLS) byRisk[c.risk]++;
    const avgMaturity = CONTROLS.reduce((a, c) => a + c.maturity, 0) / CONTROLS.length;
    const overdue = CONTROLS.filter(c => c.nextReview < Date.now() && c.status !== 'not_applicable').length;
    return { byFramework, byStatus, byRisk, avgMaturity, overdue, total: CONTROLS.length };
  }, []);

  const visible = useMemo(() => {
    return CONTROLS.filter(c => {
      if (fw !== 'all' && c.framework !== fw) return false;
      if (status !== 'all' && c.status !== status) return false;
      return true;
    });
  }, [fw, status]);

  const activeControl = CONTROLS.find(c => c.id === activeCtrl) || CONTROLS[0];

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">verified</span>
          <h2 className="text-sm font-semibold text-text">合规审计器</h2>
          <Badge variant="primary">{stats.total} 控制项</Badge>
          <Badge variant={stats.avgMaturity >= 4 ? 'success' : stats.avgMaturity >= 3 ? 'warning' : 'danger'}>成熟度 {stats.avgMaturity.toFixed(1)}/5</Badge>
          {stats.overdue > 0 && <Badge variant="danger">⚠ {stats.overdue} 复审逾期</Badge>}
          <Badge variant="warning">{stats.byStatus.partial} 部分</Badge>
          <Badge variant="info">{stats.byStatus.planned} 计划</Badge>
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" icon="file_download">审计报告</Button>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div className="px-3 py-1 border-b border-border bg-bg flex items-center gap-1">
          {([
            { k: 'overview', l: '概览' },
            { k: 'controls', l: `控制项 (${visible.length})` },
            { k: 'evidence', l: '证据' },
            { k: 'risk',     l: '风险登记' },
            { k: 'gap',      l: '差距分析' },
          ] as const).map(t => (
            <button key={t.k} onClick={() => setTab(t.k)} className={'px-3 h-6 rounded text-[10px] ' + (tab === t.k ? 'bg-accent/15 text-accent' : 'text-text-secondary hover:bg-surface-high')}>{t.l}</button>
          ))}
        </div>

        <div className="flex-1 overflow-auto p-3">
          {tab === 'overview' && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                {FRAMEWORKS.map(f => (
                  <div key={f} onClick={() => { setFw(f); setTab('controls'); }} className="bg-bg border border-border-light rounded-lg p-2 cursor-pointer hover:bg-surface-high">
                    <p className="text-[10px] text-text-secondary">{f}</p>
                    <p className="text-xl font-bold text-text">{stats.byFramework[f] || 0}</p>
                    <p className="text-[10px] text-text-secondary">控制项</p>
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <h3 className="text-xs font-semibold text-text mb-2">实施状态分布</h3>
                  {STATUSES.map(s => (
                    <div key={s} className="flex items-center gap-2 mb-1">
                      <Badge variant={statusColor(s) as any}>{statusLabel(s)}</Badge>
                      <div className="flex-1 h-2 bg-surface-high rounded overflow-hidden">
                        <div className={'h-full ' + (statusColor(s) === 'success' ? 'bg-success' : statusColor(s) === 'warning' ? 'bg-warning' : statusColor(s) === 'danger' ? 'bg-danger' : 'bg-info')} style={{ width: (stats.byStatus[s] / stats.total * 100) + '%' }} />
                      </div>
                      <span className="text-[10px] font-mono text-text w-8 text-right">{stats.byStatus[s]}</span>
                    </div>
                  ))}
                </div>

                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <h3 className="text-xs font-semibold text-text mb-2">风险等级</h3>
                  {RISKS.map(r => (
                    <div key={r} className="flex items-center gap-2 mb-1">
                      <Badge variant={r === 'critical' ? 'danger' : r === 'high' ? 'warning' : r === 'medium' ? 'info' : 'default'}>{r}</Badge>
                      <div className="flex-1 h-2 bg-surface-high rounded overflow-hidden">
                        <div className={'h-full ' + (r === 'critical' ? 'bg-danger' : r === 'high' ? 'bg-warning' : r === 'medium' ? 'bg-info' : 'bg-success')} style={{ width: (stats.byRisk[r] / stats.total * 100) + '%' }} />
                      </div>
                      <span className="text-[10px] font-mono text-text w-8 text-right">{stats.byRisk[r]}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">即将到期 / 已逾期</h3>
                <div className="space-y-1">
                  {CONTROLS.filter(c => c.nextReview < Date.now() + 30 * 86400000 && c.nextReview > 0).slice(0, 5).map(c => {
                    const overdue = c.nextReview < Date.now();
                    return (
                      <div key={c.id} onClick={() => { setActiveCtrl(c.id); setTab('controls'); }} className="flex items-center gap-2 text-[11px] p-1 hover:bg-surface-high rounded cursor-pointer">
                        <Badge variant={overdue ? 'danger' : 'warning'}>{overdue ? '逾期' : '即将'}</Badge>
                        <code className="text-[10px] text-text-secondary">{c.code}</code>
                        <span className="text-text flex-1 truncate">{c.title}</span>
                        <span className="text-[10px] text-text-secondary">{new Date(c.nextReview).toLocaleDateString()}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {tab === 'controls' && (
            <div className="bg-bg border border-border rounded-lg overflow-hidden">
              <div className="px-3 py-1 border-b border-border-light flex items-center gap-1">
                <select value={fw} onChange={(e) => setFw(e.target.value as any)} className="bg-bg border border-border-light rounded px-2 h-6 text-[10px]">
                  <option value="all">所有框架</option>
                  {FRAMEWORKS.map(f => <option key={f} value={f}>{f}</option>)}
                </select>
                <select value={status} onChange={(e) => setStatus(e.target.value as any)} className="bg-bg border border-border-light rounded px-2 h-6 text-[10px]">
                  <option value="all">所有状态</option>
                  {STATUSES.map(s => <option key={s} value={s}>{statusLabel(s)}</option>)}
                </select>
              </div>
              <table className="w-full text-xs">
                <thead className="bg-surface-high text-text-secondary text-[10px]">
                  <tr>
                    <th className="text-left px-2 py-1.5 w-16">框架</th>
                    <th className="text-left px-2 py-1.5 w-20">代码</th>
                    <th className="text-left px-2 py-1.5">控制项</th>
                    <th className="text-left px-2 py-1.5 w-16">状态</th>
                    <th className="text-left px-2 py-1.5 w-16">成熟度</th>
                    <th className="text-left px-2 py-1.5 w-16">风险</th>
                    <th className="text-left px-2 py-1.5 w-20">负责人</th>
                    <th className="text-left px-2 py-1.5 w-16">证据</th>
                    <th className="text-left px-2 py-1.5 w-16">复审</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map(c => (
                    <tr key={c.id} onClick={() => setActiveCtrl(c.id)} className={'border-t border-border-light cursor-pointer hover:bg-surface-high ' + (activeCtrl === c.id ? 'bg-accent/10' : '')}>
                      <td className="px-2 py-1 text-[10px] text-text-secondary">{c.framework}</td>
                      <td className="px-2 py-1 font-mono text-[10px] text-accent">{c.code}</td>
                      <td className="px-2 py-1 text-text">{c.title}</td>
                      <td className="px-2 py-1"><Badge variant={statusColor(c.status) as any}>{statusLabel(c.status)}</Badge></td>
                      <td className="px-2 py-1">
                        <div className="flex gap-0.5">
                          {Array.from({ length: 5 }, (_, i) => (
                            <div key={i} className={'w-1.5 h-3 ' + (i < c.maturity ? 'bg-accent' : 'bg-surface-high')} />
                          ))}
                        </div>
                      </td>
                      <td className="px-2 py-1"><Badge variant={c.risk === 'critical' ? 'danger' : c.risk === 'high' ? 'warning' : c.risk === 'medium' ? 'info' : 'default'}>{c.risk}</Badge></td>
                      <td className="px-2 py-1 text-text-secondary">{c.owner}</td>
                      <td className="px-2 py-1 text-text-secondary">{c.evidence.length}</td>
                      <td className="px-2 py-1 text-[10px] text-text-secondary">{new Date(c.nextReview).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'evidence' && activeControl && (
            <div className="space-y-3">
              <div className="bg-bg border border-border-light rounded-lg p-3">
                <div className="flex items-center gap-2 mb-2">
                  <Badge variant="default">{activeControl.framework}</Badge>
                  <code className="text-sm font-mono font-bold text-accent">{activeControl.code}</code>
                  <Badge variant={statusColor(activeControl.status) as any}>{statusLabel(activeControl.status)}</Badge>
                </div>
                <h3 className="text-base font-semibold text-text">{activeControl.title}</h3>
                <p className="text-xs text-text-secondary mt-1">{activeControl.description}</p>
              </div>

              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h4 className="text-xs font-semibold text-text mb-2">证据 ({activeControl.evidence.length})</h4>
                {activeControl.evidence.length === 0 ? <p className="text-xs text-text-secondary">⚠ 无证据 - 需要补齐</p> : (
                  <div className="space-y-1">
                    {activeControl.evidence.map((e, i) => (
                      <div key={i} className="flex items-center gap-2 p-1.5 bg-bg border border-border-light rounded">
                        <span className="material-symbols-outlined text-base text-accent">description</span>
                        <span className="text-[11px] text-text flex-1">{e}</span>
                        <Button size="xs" icon="visibility">查看</Button>
                      </div>
                    ))}
                  </div>
                )}
                <Button size="sm" icon="upload" className="mt-2">上传证据</Button>
              </div>
            </div>
          )}

          {tab === 'risk' && (
            <div className="bg-bg border border-border rounded-lg overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-surface-high text-text-secondary text-[10px]">
                  <tr>
                    <th className="text-left px-2 py-1.5 w-20">风险</th>
                    <th className="text-left px-2 py-1.5">控制项</th>
                    <th className="text-left px-2 py-1.5 w-20">负责人</th>
                    <th className="text-left px-2 py-1.5 w-20">下次复审</th>
                    <th className="text-left px-2 py-1.5 w-20">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {CONTROLS.filter(c => c.risk === 'high' || c.risk === 'critical').map(c => (
                    <tr key={c.id} onClick={() => { setActiveCtrl(c.id); setTab('controls'); }} className={'border-t border-border-light cursor-pointer hover:bg-surface-high ' + (c.risk === 'critical' ? 'bg-danger/5' : 'bg-warning/5')}>
                      <td className="px-2 py-1"><Badge variant={c.risk === 'critical' ? 'danger' : 'warning'}>{c.risk}</Badge></td>
                      <td className="px-2 py-1">
                        <code className="text-[10px] text-text-secondary">{c.code}</code>
                        <span className="ml-2 text-text">{c.title}</span>
                      </td>
                      <td className="px-2 py-1 text-text-secondary">{c.owner}</td>
                      <td className="px-2 py-1 text-text-secondary">{new Date(c.nextReview).toLocaleDateString()}</td>
                      <td className="px-2 py-1"><Button size="xs" icon="build">整改</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'gap' && (
            <div className="space-y-3">
              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">差距分析 (Gap Analysis)</h3>
                <p className="text-[10px] text-text-secondary mb-3">当前状态 vs 目标状态 - 列出所有未完全实施的控制项</p>
                <div className="space-y-1">
                  {CONTROLS.filter(c => c.status === 'partial' || c.status === 'planned' || c.status === 'failed').map(c => (
                    <div key={c.id} className="p-2 bg-bg border border-border-light rounded">
                      <div className="flex items-center gap-2">
                        <Badge variant={statusColor(c.status) as any}>{statusLabel(c.status)}</Badge>
                        <code className="text-[10px] font-mono text-text-secondary">{c.code}</code>
                        <span className="text-[11px] text-text flex-1">{c.title}</span>
                        <Badge variant={c.risk === 'critical' ? 'danger' : 'warning'}>{c.risk}</Badge>
                      </div>
                      <div className="grid grid-cols-2 gap-2 mt-1 text-[10px]">
                        <div>
                          <span className="text-text-secondary">当前: </span>
                          <span className="text-text">{statusLabel(c.status)} (成熟度 {c.maturity}/5)</span>
                        </div>
                        <div>
                          <span className="text-text-secondary">目标: </span>
                          <span className="text-success">完全实施 (成熟度 5/5)</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="px-3 py-1.5 border-t border-border bg-surface-high text-[10px] text-text-secondary flex items-center gap-3">
          <span>{CONTROLS.length} 控制项</span>
          <span>·</span>
          <span>{FRAMEWORKS.length} 框架</span>
          <span>·</span>
          <span>平均成熟度 {stats.avgMaturity.toFixed(1)}/5</span>
          <span>·</span>
          <span>{stats.overdue} 复审逾期</span>
        </div>
      </div>
    </div>
  );
}
