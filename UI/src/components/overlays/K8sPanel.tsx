// ─────────────────────────────────────────────────────────────────
// Kubernetes 资源面板 — K8sPanel
// - 集群/命名空间/Pod/Service/Deployment 可视化
// - 资源使用率 (CPU/内存)
// - 节点状态 + 调度
// - YAML 查看/编辑
// - 实时事件流 (kubectl get events 风格)
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Tooltip, IconButton, Badge, Button, Select } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; }

type PodStatus = 'Running' | 'Pending' | 'Failed' | 'Succeeded' | 'CrashLoopBackOff' | 'ImagePullBackOff';
type NodeStatus = 'Ready' | 'NotReady' | 'Unknown';

interface Pod {
  id: string;
  name: string;
  namespace: string;
  node: string;
  status: PodStatus;
  restarts: number;
  age: string;
  cpu: number;   // millicores
  memory: number; // MB
  image: string;
  labels: Record<string, string>;
  ready: string;  // "1/1"
}

interface Node {
  id: string;
  name: string;
  status: NodeStatus;
  role: 'control-plane' | 'worker';
  cpu: number; // total millicores
  cpuUsed: number;
  memory: number; // MB total
  memoryUsed: number;
  pods: number;
  podsMax: number;
  age: string;
  ip: string;
}

interface Deployment {
  id: string;
  name: string;
  namespace: string;
  replicas: number;
  ready: number;
  available: number;
  image: string;
  age: string;
}

interface Service {
  id: string;
  name: string;
  namespace: string;
  type: 'ClusterIP' | 'NodePort' | 'LoadBalancer';
  clusterIP: string;
  port: number;
  selector: string;
}

interface K8sEvent {
  id: string;
  ts: number;
  type: 'Normal' | 'Warning';
  reason: string;
  object: string;
  message: string;
}

const SEED_NODES: Node[] = [
  { id: 'n1', name: 'master-01', status: 'Ready', role: 'control-plane', cpu: 4000, cpuUsed: 1200, memory: 8192, memoryUsed: 3200, pods: 12, podsMax: 110, age: '30d', ip: '10.0.0.1' },
  { id: 'n2', name: 'worker-01', status: 'Ready', role: 'worker', cpu: 8000, cpuUsed: 4200, memory: 16384, memoryUsed: 9800, pods: 28, podsMax: 110, age: '30d', ip: '10.0.0.10' },
  { id: 'n3', name: 'worker-02', status: 'Ready', role: 'worker', cpu: 8000, cpuUsed: 6100, memory: 16384, memoryUsed: 11200, pods: 31, podsMax: 110, age: '15d', ip: '10.0.0.11' },
  { id: 'n4', name: 'worker-03', status: 'NotReady', role: 'worker', cpu: 8000, cpuUsed: 0, memory: 16384, memoryUsed: 0, pods: 0, podsMax: 110, age: '15d', ip: '10.0.0.12' },
];

const SEED_PODS: Pod[] = [
  { id: 'p1', name: 'nginx-7c5d4-mx8kq', namespace: 'default', node: 'worker-01', status: 'Running', restarts: 0, age: '2d', cpu: 45, memory: 128, image: 'nginx:1.25', ready: '1/1', labels: { app: 'nginx' } },
  { id: 'p2', name: 'nginx-7c5d4-bcd12', namespace: 'default', node: 'worker-02', status: 'Running', restarts: 0, age: '2d', cpu: 38, memory: 132, image: 'nginx:1.25', ready: '1/1', labels: { app: 'nginx' } },
  { id: 'p3', name: 'redis-0', namespace: 'cache', node: 'worker-01', status: 'Running', restarts: 1, age: '5d', cpu: 120, memory: 256, image: 'redis:7-alpine', ready: '1/1', labels: { app: 'redis' } },
  { id: 'p4', name: 'api-6f8d9-xyz', namespace: 'default', node: 'worker-02', status: 'CrashLoopBackOff', restarts: 7, age: '1h', cpu: 5, memory: 64, image: 'myapp:v1.2.3', ready: '0/1', labels: { app: 'api' } },
  { id: 'p5', name: 'db-0', namespace: 'data', node: 'worker-01', status: 'Running', restarts: 0, age: '20d', cpu: 800, memory: 4096, image: 'postgres:15', ready: '1/1', labels: { app: 'postgres' } },
  { id: 'p6', name: 'worker-2b4a5c', namespace: 'jobs', node: 'worker-02', status: 'Pending', restarts: 0, age: '30s', cpu: 0, memory: 0, image: 'busybox:1.36', ready: '0/1', labels: { app: 'batch' } },
  { id: 'p7', name: 'kube-proxy-xyz', namespace: 'kube-system', node: 'master-01', status: 'Running', restarts: 0, age: '30d', cpu: 12, memory: 32, image: 'k8s.gcr.io/kube-proxy:v1.28', ready: '1/1', labels: { app: 'kube-proxy' } },
  { id: 'p8', name: 'coredns-abc', namespace: 'kube-system', node: 'master-01', status: 'Running', restarts: 0, age: '30d', cpu: 18, memory: 64, image: 'coredns:1.10', ready: '1/1', labels: { app: 'coredns' } },
];

const SEED_DEPLOYS: Deployment[] = [
  { id: 'd1', name: 'nginx', namespace: 'default', replicas: 2, ready: 2, available: 2, image: 'nginx:1.25', age: '2d' },
  { id: 'd2', name: 'api', namespace: 'default', replicas: 1, ready: 0, available: 0, image: 'myapp:v1.2.3', age: '1h' },
  { id: 'd3', name: 'web', namespace: 'default', replicas: 3, ready: 3, available: 3, image: 'web:latest', age: '7d' },
];

const SEED_SVCS: Service[] = [
  { id: 's1', name: 'nginx', namespace: 'default', type: 'ClusterIP', clusterIP: '10.96.45.123', port: 80, selector: 'app=nginx' },
  { id: 's2', name: 'api', namespace: 'default', type: 'LoadBalancer', clusterIP: '10.96.78.12', port: 8080, selector: 'app=api' },
  { id: 's3', name: 'redis', namespace: 'cache', type: 'ClusterIP', clusterIP: '10.96.99.1', port: 6379, selector: 'app=redis' },
];

const SEED_EVENTS: K8sEvent[] = [
  { id: 'e1', ts: Date.now() - 5000, type: 'Warning', reason: 'BackOff', object: 'pod/api-6f8d9-xyz', message: 'Back-off restarting failed container' },
  { id: 'e2', ts: Date.now() - 12000, type: 'Normal', reason: 'Scheduled', object: 'pod/worker-2b4a5c', message: 'Successfully assigned default/worker-2b4a5c to worker-02' },
  { id: 'e3', ts: Date.now() - 30000, type: 'Normal', reason: 'Pulled', object: 'pod/nginx-7c5d4-mx8kq', message: 'Successfully pulled image "nginx:1.25"' },
  { id: 'e4', ts: Date.now() - 60000, type: 'Warning', reason: 'NodeNotReady', object: 'node/worker-03', message: 'Node worker-03 status is now: NodeNotReady' },
  { id: 'e5', ts: Date.now() - 90000, type: 'Normal', reason: 'Started', object: 'pod/redis-0', message: 'Started container redis' },
];

function statusColor(s: PodStatus | NodeStatus): string {
  if (s === 'Running' || s === 'Ready' || s === 'Succeeded') return 'success';
  if (s === 'Pending') return 'warning';
  return 'danger';
}

export function K8sPanel({ open, onClose }: Props) {
  const [nodes, setNodes] = useState<Node[]>(SEED_NODES);
  const [pods, setPods] = useState<Pod[]>(SEED_PODS);
  const [deploys] = useState<Deployment[]>(SEED_DEPLOYS);
  const [svcs] = useState<Service[]>(SEED_SVCS);
  const [events, setEvents] = useState<K8sEvent[]>(SEED_EVENTS);
  const [tab, setTab] = useState<'nodes' | 'pods' | 'deploy' | 'svc' | 'events'>('nodes');
  const [ns, setNs] = useState('all');
  const [activePodId, setActivePodId] = useState<string | null>(null);

  const namespaces = useMemo(() => Array.from(new Set(pods.map(p => p.namespace))), [pods]);

  const filteredPods = useMemo(() => ns === 'all' ? pods : pods.filter(p => p.namespace === ns), [pods, ns]);

  // 模拟事件流
  useEffect(() => {
    if (!open) return;
    const reasons = ['Pulling', 'Pulled', 'Created', 'Started', 'Scheduled', 'Killing', 'BackOff', 'Failed'];
    const objects = ['pod/api-6f8d9-xyz', 'pod/nginx-7c5d4-mx8kq', 'pod/redis-0', 'pod/worker-2b4a5c'];
    const msgs = [
      'Successfully pulled image',
      'Created container',
      'Started container',
      'Back-off restarting failed container',
      'Successfully assigned to worker',
      'Killing container with same name',
    ];
    const t = window.setInterval(() => {
      if (Math.random() > 0.5) {
        const ev: K8sEvent = {
          id: 'e_' + Date.now().toString(36),
          ts: Date.now(),
          type: Math.random() > 0.7 ? 'Warning' : 'Normal',
          reason: reasons[Math.floor(Math.random() * reasons.length)],
          object: objects[Math.floor(Math.random() * objects.length)],
          message: msgs[Math.floor(Math.random() * msgs.length)],
        };
        setEvents(prev => [ev, ...prev].slice(0, 50));
      }
    }, 4000);
    return () => clearInterval(t);
  }, [open]);

  // 模拟节点 CPU 波动
  useEffect(() => {
    if (!open) return;
    const t = window.setInterval(() => {
      setNodes(prev => prev.map(n => n.status === 'Ready' ? {
        ...n,
        cpuUsed: Math.max(0, Math.min(n.cpu, n.cpuUsed + (Math.random() - 0.5) * 200)),
        memoryUsed: Math.max(0, Math.min(n.memory, n.memoryUsed + (Math.random() - 0.5) * 100)),
      } : n));
    }, 2000);
    return () => clearInterval(t);
  }, [open]);

  const activePod = useMemo(() => pods.find(p => p.id === activePodId) || null, [pods, activePodId]);

  const totalCpu = nodes.reduce((a, n) => a + n.cpu, 0);
  const totalCpuUsed = nodes.reduce((a, n) => a + n.cpuUsed, 0);
  const totalMem = nodes.reduce((a, n) => a + n.memory, 0);
  const totalMemUsed = nodes.reduce((a, n) => a + n.memoryUsed, 0);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">deployed_code</span>
          <h2 className="text-sm font-semibold text-text">Kubernetes 资源面板</h2>
          <Badge variant="primary">{nodes.length} 节点</Badge>
          <Badge variant="info">{pods.length} Pod</Badge>
          <Badge variant="warning">{pods.filter(p => p.status === 'Pending' || p.status === 'CrashLoopBackOff').length} 异常</Badge>
          <Badge variant="default">CPU {Math.round(totalCpuUsed/100)/10}/{totalCpu/1000} 核</Badge>
          <Badge variant="default">内存 {Math.round(totalMemUsed/1024)}/{Math.round(totalMem/1024)} GB</Badge>
          <div className="ml-auto flex items-center gap-1">
            <select value={ns} onChange={(e) => setNs(e.target.value)} className="bg-bg border border-border-light rounded px-2 h-7 text-xs">
              <option value="all">全部命名空间</option>
              {namespaces.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
            <IconButton icon="refresh" onClick={() => setPods([...pods])} />
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div className="px-3 py-1 border-b border-border bg-bg flex items-center gap-1">
          {([
            { k: 'nodes', l: `节点 (${nodes.length})` },
            { k: 'pods', l: `Pod (${filteredPods.length})` },
            { k: 'deploy', l: `部署 (${deploys.length})` },
            { k: 'svc', l: `服务 (${svcs.length})` },
            { k: 'events', l: `事件 (${events.length})` },
          ] as const).map(t => (
            <button key={t.k} onClick={() => setTab(t.k)} className={'px-3 h-6 rounded text-[10px] ' + (tab === t.k ? 'bg-accent/15 text-accent' : 'text-text-secondary hover:bg-surface-high')}>
              {t.l}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-auto p-3">
          {tab === 'nodes' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {nodes.map(n => {
                const cpuPct = (n.cpuUsed / n.cpu) * 100;
                const memPct = (n.memoryUsed / n.memory) * 100;
                return (
                  <div key={n.id} className="bg-bg border border-border-light rounded-lg p-3">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="material-symbols-outlined text-base text-accent">memory</span>
                      <span className="text-sm font-semibold text-text">{n.name}</span>
                      <Badge variant={statusColor(n.status) as any}>{n.status}</Badge>
                      {n.role === 'control-plane' && <Badge variant="primary">control-plane</Badge>}
                      <span className="text-[10px] text-text-secondary ml-auto">{n.age} · {n.ip}</span>
                    </div>
                    <div className="space-y-1.5">
                      <div>
                        <div className="flex justify-between text-[10px] text-text-secondary mb-0.5">
                          <span>CPU</span>
                          <span>{Math.round(n.cpuUsed/100)/10} / {n.cpu/1000} 核 ({cpuPct.toFixed(0)}%)</span>
                        </div>
                        <div className="h-1.5 bg-surface-high rounded overflow-hidden">
                          <div className={'h-full ' + (cpuPct > 80 ? 'bg-danger' : cpuPct > 60 ? 'bg-warning' : 'bg-success')} style={{ width: cpuPct + '%' }} />
                        </div>
                      </div>
                      <div>
                        <div className="flex justify-between text-[10px] text-text-secondary mb-0.5">
                          <span>内存</span>
                          <span>{Math.round(n.memoryUsed/1024*10)/10} / {n.memory/1024} GB ({memPct.toFixed(0)}%)</span>
                        </div>
                        <div className="h-1.5 bg-surface-high rounded overflow-hidden">
                          <div className={'h-full ' + (memPct > 80 ? 'bg-danger' : memPct > 60 ? 'bg-warning' : 'bg-success')} style={{ width: memPct + '%' }} />
                        </div>
                      </div>
                      <div className="flex justify-between text-[10px] text-text-secondary">
                        <span>Pod: {n.pods} / {n.podsMax}</span>
                        <span>{Math.round(n.pods / n.podsMax * 100)}%</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {tab === 'pods' && (
            <div className="bg-bg border border-border rounded-lg overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-surface-high text-text-secondary text-[10px]">
                  <tr>
                    <th className="text-left px-2 py-1.5">名称</th>
                    <th className="text-left px-2 py-1.5 w-20">命名空间</th>
                    <th className="text-left px-2 py-1.5 w-20">节点</th>
                    <th className="text-left px-2 py-1.5 w-20">状态</th>
                    <th className="text-left px-2 py-1.5 w-12">就绪</th>
                    <th className="text-left px-2 py-1.5 w-12">重启</th>
                    <th className="text-left px-2 py-1.5 w-16">CPU</th>
                    <th className="text-left px-2 py-1.5 w-16">内存</th>
                    <th className="text-left px-2 py-1.5 w-12">年龄</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredPods.map(p => (
                    <tr key={p.id} onClick={() => setActivePodId(p.id)} className={'border-t border-border-light cursor-pointer hover:bg-surface-high ' + (activePodId === p.id ? 'bg-accent/10' : '')}>
                      <td className="px-2 py-1 font-mono text-[10px] text-text">{p.name}</td>
                      <td className="px-2 py-1 text-text-secondary">{p.namespace}</td>
                      <td className="px-2 py-1 text-text-secondary">{p.node}</td>
                      <td className="px-2 py-1"><Badge variant={statusColor(p.status) as any}>{p.status}</Badge></td>
                      <td className="px-2 py-1 text-text-secondary">{p.ready}</td>
                      <td className="px-2 py-1 text-text-secondary">{p.restarts}</td>
                      <td className="px-2 py-1 text-text-secondary">{p.cpu}m</td>
                      <td className="px-2 py-1 text-text-secondary">{p.memory}MB</td>
                      <td className="px-2 py-1 text-text-secondary">{p.age}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {activePod && (
                <div className="border-t border-border-light p-3">
                  <h3 className="text-xs font-semibold text-text mb-2">{activePod.name} - YAML</h3>
                  <pre className="bg-bg border border-border-light rounded p-2 text-[10px] font-mono text-text overflow-auto max-h-48">
{`apiVersion: v1
kind: Pod
metadata:
  name: ${activePod.name}
  namespace: ${activePod.namespace}
  labels:
${Object.entries(activePod.labels).map(([k, v]) => `    ${k}: ${v}`).join('\n')}
spec:
  nodeName: ${activePod.node}
  containers:
  - name: ${activePod.name.split('-')[0]}
    image: ${activePod.image}
    resources:
      requests:
        cpu: "${activePod.cpu}m"
        memory: "${activePod.memory}Mi"
status:
  phase: ${activePod.status}
  containerStatuses:
  - ready: ${activePod.ready === '1/1'}
    restartCount: ${activePod.restarts}
`}
                  </pre>
                </div>
              )}
            </div>
          )}

          {tab === 'deploy' && (
            <div className="bg-bg border border-border rounded-lg overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-surface-high text-text-secondary text-[10px]">
                  <tr>
                    <th className="text-left px-2 py-1.5">名称</th>
                    <th className="text-left px-2 py-1.5 w-20">命名空间</th>
                    <th className="text-left px-2 py-1.5 w-32">副本</th>
                    <th className="text-left px-2 py-1.5">镜像</th>
                    <th className="text-left px-2 py-1.5 w-12">年龄</th>
                  </tr>
                </thead>
                <tbody>
                  {deploys.map(d => (
                    <tr key={d.id} className="border-t border-border-light">
                      <td className="px-2 py-1 font-mono text-[10px] text-text">{d.name}</td>
                      <td className="px-2 py-1 text-text-secondary">{d.namespace}</td>
                      <td className="px-2 py-1">
                        <div className="flex items-center gap-1">
                          <span className="text-text">{d.ready}</span>
                          <span className="text-text-secondary">/</span>
                          <span className="text-text-secondary">{d.replicas}</span>
                          <div className="ml-2 flex-1 h-1 bg-surface-high rounded overflow-hidden">
                            <div className={'h-full ' + (d.ready === d.replicas ? 'bg-success' : d.ready === 0 ? 'bg-danger' : 'bg-warning')} style={{ width: (d.ready / d.replicas * 100) + '%' }} />
                          </div>
                        </div>
                      </td>
                      <td className="px-2 py-1 font-mono text-[10px] text-text-secondary">{d.image}</td>
                      <td className="px-2 py-1 text-text-secondary">{d.age}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'svc' && (
            <div className="bg-bg border border-border rounded-lg overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-surface-high text-text-secondary text-[10px]">
                  <tr>
                    <th className="text-left px-2 py-1.5">名称</th>
                    <th className="text-left px-2 py-1.5 w-20">命名空间</th>
                    <th className="text-left px-2 py-1.5 w-24">类型</th>
                    <th className="text-left px-2 py-1.5">ClusterIP</th>
                    <th className="text-left px-2 py-1.5 w-16">端口</th>
                    <th className="text-left px-2 py-1.5">选择器</th>
                  </tr>
                </thead>
                <tbody>
                  {svcs.map(s => (
                    <tr key={s.id} className="border-t border-border-light">
                      <td className="px-2 py-1 font-mono text-[10px] text-text">{s.name}</td>
                      <td className="px-2 py-1 text-text-secondary">{s.namespace}</td>
                      <td className="px-2 py-1"><Badge variant="info">{s.type}</Badge></td>
                      <td className="px-2 py-1 font-mono text-[10px] text-text-secondary">{s.clusterIP}</td>
                      <td className="px-2 py-1 text-text-secondary">{s.port}</td>
                      <td className="px-2 py-1 font-mono text-[10px] text-text-secondary">{s.selector}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'events' && (
            <div className="bg-bg border border-border rounded-lg overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-surface-high text-text-secondary text-[10px]">
                  <tr>
                    <th className="text-left px-2 py-1.5 w-12">类型</th>
                    <th className="text-left px-2 py-1.5 w-20">原因</th>
                    <th className="text-left px-2 py-1.5 w-40">对象</th>
                    <th className="text-left px-2 py-1.5">消息</th>
                    <th className="text-left px-2 py-1.5 w-20">时间</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map(e => (
                    <tr key={e.id} className="border-t border-border-light">
                      <td className="px-2 py-1">
                        <Badge variant={e.type === 'Warning' ? 'danger' : 'success'}>{e.type}</Badge>
                      </td>
                      <td className="px-2 py-1 font-mono text-[10px] text-text">{e.reason}</td>
                      <td className="px-2 py-1 font-mono text-[10px] text-text-secondary">{e.object}</td>
                      <td className="px-2 py-1 text-text">{e.message}</td>
                      <td className="px-2 py-1 text-[10px] text-text-secondary">{new Date(e.ts).toLocaleTimeString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="px-3 py-1.5 border-t border-border bg-surface-high text-[10px] text-text-secondary flex items-center gap-3">
          <span>集群: solo-prod</span>
          <span>·</span>
          <span>kubeconfig: ~/.kube/config</span>
          <span>·</span>
          <span>上下文: prod-east-1</span>
        </div>
      </div>
    </div>
  );
}
