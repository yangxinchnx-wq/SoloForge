// ─────────────────────────────────────────────────────────────────
// API 文档生成器 — DocGenerator
// - OpenAPI 3.0 规范编辑
// - 端点定义与请求/响应示例
// - 多种格式导出 (HTML/Markdown/Postman/SDK)
// - 实时预览
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from 'react';
import { Tooltip, IconButton, Badge, Button } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; }

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type ParamIn = 'path' | 'query' | 'header' | 'cookie';

interface Endpoint {
  id: string;
  method: HttpMethod;
  path: string;
  summary: string;
  description: string;
  tags: string[];
  parameters: Parameter[];
  requestBody?: RequestBody;
  responses: Record<string, Response>;
  auth: boolean;
  deprecated: boolean;
}

interface Parameter {
  name: string;
  in: ParamIn;
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  required: boolean;
  description: string;
  example?: string;
}

interface RequestBody {
  contentType: 'application/json' | 'multipart/form-data' | 'application/x-www-form-urlencoded';
  schema: string;
  example: string;
  required: boolean;
}

interface Response {
  description: string;
  schema: string;
  example: string;
}

const ENDPOINTS: Endpoint[] = [
  { id: 'e1', method: 'POST', path: '/v1/auth/login', summary: '用户登录', description: '使用邮箱和密码登录,返回 JWT token',
    tags: ['Authentication'], auth: false, deprecated: false,
    parameters: [],
    requestBody: { contentType: 'application/json', required: true, schema: '{ email: string, password: string }', example: '{ "email": "user@example.com", "password": "P@ssw0rd" }' },
    responses: {
      '200': { description: '成功', schema: '{ token: string, user: User }', example: '{ "token": "eyJ...", "user": { ... } }' },
      '401': { description: '凭据错误', schema: '{ error: string }', example: '{ "error": "Invalid credentials" }' },
    },
  },
  { id: 'e2', method: 'POST', path: '/v1/auth/refresh', summary: '刷新 token', description: '使用 refresh token 换取新 access token', tags: ['Authentication'], auth: true, deprecated: false,
    parameters: [],
    requestBody: { contentType: 'application/json', required: true, schema: '{ refresh_token: string }', example: '{ "refresh_token": "rt_..." }' },
    responses: { '200': { description: '成功', schema: '{ access_token: string }', example: '{ "access_token": "eyJ..." }' } },
  },
  { id: 'e3', method: 'GET', path: '/v1/users/{id}', summary: '获取用户', description: '根据 ID 返回用户信息', tags: ['Users'], auth: true, deprecated: false,
    parameters: [{ name: 'id', in: 'path', type: 'string', required: true, description: '用户 ID', example: 'u_12345' }],
    responses: {
      '200': { description: '成功', schema: 'User', example: '{ "id": "u_12345", "name": "Alice", ... }' },
      '404': { description: '用户不存在', schema: '{ error: string }', example: '{ "error": "Not found" }' },
    },
  },
  { id: 'e4', method: 'PUT', path: '/v1/users/{id}', summary: '更新用户', description: '更新用户信息', tags: ['Users'], auth: true, deprecated: false,
    parameters: [{ name: 'id', in: 'path', type: 'string', required: true, description: '用户 ID', example: 'u_12345' }],
    requestBody: { contentType: 'application/json', required: true, schema: 'Partial<User>', example: '{ "name": "Alice Chen" }' },
    responses: { '200': { description: '成功', schema: 'User', example: '{ ... }' } },
  },
  { id: 'e5', method: 'GET', path: '/v1/users', summary: '列出用户', description: '分页获取用户列表', tags: ['Users'], auth: true, deprecated: false,
    parameters: [
      { name: 'limit',  in: 'query', type: 'integer', required: false, description: '每页数量', example: '20' },
      { name: 'offset', in: 'query', type: 'integer', required: false, description: '偏移量', example: '0' },
      { name: 'sort',   in: 'query', type: 'string',  required: false, description: '排序字段', example: 'created_at' },
    ],
    responses: { '200': { description: '成功', schema: '{ data: User[], total: number }', example: '{ "data": [...], "total": 1245 }' } },
  },
  { id: 'e6', method: 'DELETE', path: '/v1/users/{id}', summary: '删除用户', description: '软删除用户', tags: ['Users'], auth: true, deprecated: false,
    parameters: [{ name: 'id', in: 'path', type: 'string', required: true, description: '用户 ID', example: 'u_12345' }],
    responses: { '204': { description: '成功', schema: '', example: '' } },
  },
  { id: 'e7', method: 'POST', path: '/v1/orders', summary: '创建订单', description: '创建新订单', tags: ['Orders'], auth: true, deprecated: false,
    parameters: [],
    requestBody: { contentType: 'application/json', required: true, schema: '{ items: OrderItem[], address_id: string }', example: '{ "items": [...], "address_id": "a_123" }' },
    responses: { '201': { description: '已创建', schema: 'Order', example: '{ "id": "o_123", ... }' } },
  },
  { id: 'e8', method: 'GET', path: '/v1/search', summary: '搜索', description: '全文搜索接口', tags: ['Search'], auth: false, deprecated: true,
    parameters: [
      { name: 'q',     in: 'query', type: 'string',  required: true,  description: '搜索词', example: 'foo' },
      { name: 'limit', in: 'query', type: 'integer', required: false, description: '数量',  example: '10' },
    ],
    responses: { '200': { description: '成功', schema: '{ results: SearchHit[] }', example: '{ ... }' } },
  },
];

const SAMPLE_YAML = `openapi: 3.0.3
info:
  title: SoloForge API
  version: 1.0.0
  description: |
    SoloForge 多智能体系统的 REST API 文档
servers:
  - url: https://api.soloforge.dev
    description: 生产环境
  - url: https://staging-api.soloforge.dev
    description: 预发环境
tags:
  - name: Authentication
    description: 用户认证相关接口
  - name: Users
    description: 用户管理
  - name: Orders
    description: 订单管理
  - name: Search
    description: 搜索接口
paths:
  /v1/auth/login:
    post:
      summary: 用户登录
      tags: [Authentication]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                email: { type: string }
                password: { type: string }
      responses:
        '200':
          description: 成功`;

function methodColor(m: HttpMethod): 'success' | 'info' | 'warning' | 'danger' | 'default' {
  return m === 'GET' ? 'success' : m === 'POST' ? 'info' : m === 'PUT' ? 'warning' : m === 'PATCH' ? 'warning' : 'danger';
}

export function DocGenerator({ open, onClose }: Props) {
  const [tab, setTab] = useState<'endpoints' | 'detail' | 'export' | 'preview'>('endpoints');
  const [activeEndpointId, setActiveEndpointId] = useState<string>(ENDPOINTS[0].id);
  const [tagFilter, setTagFilter] = useState<string>('all');
  const activeEndpoint = ENDPOINTS.find(e => e.id === activeEndpointId) || ENDPOINTS[0];

  const tags = Array.from(new Set(ENDPOINTS.flatMap(e => e.tags)));
  const filtered = tagFilter === 'all' ? ENDPOINTS : ENDPOINTS.filter(e => e.tags.includes(tagFilter));
  const deprecated = ENDPOINTS.filter(e => e.deprecated).length;

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">menu_book</span>
          <h2 className="text-sm font-semibold text-text">API 文档生成器</h2>
          <Badge variant="info">OpenAPI 3.0</Badge>
          <Badge variant="info">{ENDPOINTS.length} 端点</Badge>
          <Badge variant="info">{tags.length} Tags</Badge>
          {deprecated > 0 && <Badge variant="warning">{deprecated} 已废弃</Badge>}
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" icon="save">保存</Button>
            <Button size="sm" icon="publish" variant="primary">发布</Button>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div className="px-3 py-1 border-b border-border bg-bg flex items-center gap-1">
          {([
            { k: 'endpoints', l: `端点 (${ENDPOINTS.length})` },
            { k: 'detail',    l: '端点详情' },
            { k: 'export',    l: '导出' },
            { k: 'preview',   l: '预览' },
          ] as const).map(t => (
            <button key={t.k} onClick={() => setTab(t.k)} className={'px-3 h-6 rounded text-[10px] ' + (tab === t.k ? 'bg-accent/15 text-accent' : 'text-text-secondary hover:bg-surface-high')}>{t.l}</button>
          ))}
        </div>

        <div className="flex-1 flex overflow-hidden">
          <div className="w-72 border-r border-border bg-bg overflow-y-auto">
            <div className="px-3 py-2 border-b border-border-light">
              <select value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} className="w-full bg-bg border border-border-light rounded px-2 h-6 text-[10px]">
                <option value="all">所有标签</option>
                {tags.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            {filtered.map(e => (
              <div key={e.id} onClick={() => { setActiveEndpointId(e.id); setTab('detail'); }}
                className={'px-3 py-2 border-b border-border-light cursor-pointer hover:bg-surface-high ' + (activeEndpointId === e.id ? 'bg-accent/10 border-l-2 border-l-accent' : '')}>
                <div className="flex items-center gap-1 mb-1">
                  <Badge variant={methodColor(e.method)}>{e.method}</Badge>
                  {e.auth && <span className="material-symbols-outlined text-sm text-warning">lock</span>}
                  {e.deprecated && <Badge variant="warning">deprecated</Badge>}
                </div>
                <code className="text-[11px] font-mono text-text block truncate">{e.path}</code>
                <p className="text-[10px] text-text-secondary mt-0.5">{e.summary}</p>
              </div>
            ))}
          </div>

          <div className="flex-1 overflow-auto p-3 space-y-3">
            {tab === 'endpoints' && (
              <>
                <div className="grid grid-cols-5 gap-3">
                  {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map(m => {
                    const count = ENDPOINTS.filter(e => e.method === m).length;
                    return (
                      <div key={m} className="bg-bg border border-border-light rounded-lg p-3 text-center">
                        <Badge variant={methodColor(m as HttpMethod)}>{m}</Badge>
                        <p className="text-2xl font-bold text-text font-mono mt-1">{count}</p>
                      </div>
                    );
                  })}
                </div>
                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <h3 className="text-xs font-semibold text-text mb-2">所有端点</h3>
                  <div className="space-y-1">
                    {ENDPOINTS.map(e => (
                      <div key={e.id} onClick={() => { setActiveEndpointId(e.id); setTab('detail'); }} className="flex items-center gap-2 p-2 bg-surface-high rounded cursor-pointer hover:border-accent border border-transparent">
                        <Badge variant={methodColor(e.method)}>{e.method}</Badge>
                        <code className="text-[11px] font-mono text-text flex-1">{e.path}</code>
                        <span className="text-[10px] text-text-secondary">{e.summary}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}

            {tab === 'detail' && activeEndpoint && (
              <>
                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <Badge variant={methodColor(activeEndpoint.method)}>{activeEndpoint.method}</Badge>
                    <code className="text-sm font-mono font-bold text-text">{activeEndpoint.path}</code>
                    {activeEndpoint.auth && <Badge variant="warning">需要认证</Badge>}
                    {activeEndpoint.deprecated && <Badge variant="warning">已废弃</Badge>}
                  </div>
                  <p className="text-sm text-text mb-1">{activeEndpoint.summary}</p>
                  <p className="text-[11px] text-text-secondary">{activeEndpoint.description}</p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {activeEndpoint.tags.map(t => <Badge key={t} variant="info">{t}</Badge>)}
                  </div>
                </div>

                {activeEndpoint.parameters.length > 0 && (
                  <div className="bg-bg border border-border-light rounded-lg p-3">
                    <h3 className="text-xs font-semibold text-text mb-2">参数 ({activeEndpoint.parameters.length})</h3>
                    <table className="w-full text-[11px]">
                      <thead className="text-text-secondary border-b border-border-light">
                        <tr><th className="text-left py-1">名称</th><th className="text-left py-1">位置</th><th className="text-left py-1">类型</th><th className="text-left py-1">必填</th><th className="text-left py-1">说明</th></tr>
                      </thead>
                      <tbody>
                        {activeEndpoint.parameters.map(p => (
                          <tr key={p.name} className="border-b border-border-light">
                            <td className="py-1.5"><code className="text-accent">{p.name}</code></td>
                            <td className="py-1.5"><Badge variant="default">{p.in}</Badge></td>
                            <td className="py-1.5 text-text font-mono">{p.type}</td>
                            <td className="py-1.5">{p.required ? <Badge variant="danger">是</Badge> : <Badge variant="default">否</Badge>}</td>
                            <td className="py-1.5 text-text-secondary">{p.description}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {activeEndpoint.requestBody && (
                  <div className="bg-bg border border-border-light rounded-lg p-3">
                    <h3 className="text-xs font-semibold text-text mb-2">请求体</h3>
                    <Badge variant="info">{activeEndpoint.requestBody.contentType}</Badge>
                    <p className="text-[10px] text-text-secondary mt-1">Schema: <code className="text-accent">{activeEndpoint.requestBody.schema}</code></p>
                    <pre className="bg-black text-green-300 rounded p-2 text-[10px] font-mono mt-1.5 overflow-x-auto">{activeEndpoint.requestBody.example}</pre>
                  </div>
                )}

                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <h3 className="text-xs font-semibold text-text mb-2">响应</h3>
                  <div className="space-y-1.5">
                    {Object.entries(activeEndpoint.responses).map(([code, resp]) => (
                      <div key={code} className="bg-surface-high rounded p-2">
                        <div className="flex items-center gap-2 mb-1">
                          <Badge variant={code.startsWith('2') ? 'success' : code.startsWith('4') ? 'warning' : 'danger'}>{code}</Badge>
                          <span className="text-[11px] text-text">{resp.description}</span>
                        </div>
                        {resp.schema && <p className="text-[10px] text-text-secondary">Schema: <code className="text-accent">{resp.schema}</code></p>}
                        {resp.example && <pre className="bg-black text-green-300 rounded p-2 text-[10px] font-mono mt-1 overflow-x-auto">{resp.example}</pre>}
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}

            {tab === 'export' && (
              <div className="grid grid-cols-2 gap-3">
                {[
                  { name: 'OpenAPI 3.0 (YAML)', desc: '标准规范,可被所有 OpenAPI 工具消费', icon: 'code' },
                  { name: 'Postman Collection v2.1', desc: '导入到 Postman 立即测试', icon: 'science' },
                  { name: 'Markdown', desc: '适合 Wiki/GitHub 渲染', icon: 'description' },
                  { name: 'TypeScript SDK', desc: '自动生成类型安全的客户端', icon: 'data_object' },
                  { name: 'Python SDK', desc: 'requests + type hints', icon: 'code' },
                  { name: 'HTML 静态站点', desc: '独立的 API 参考站点', icon: 'language' },
                  { name: 'Insomnia', desc: 'Insomnia 工作空间格式', icon: 'science' },
                  { name: 'cURL 脚本', desc: 'shell 脚本可执行', icon: 'terminal' },
                ].map(fmt => (
                  <div key={fmt.name} className="bg-bg border border-border-light rounded-lg p-3 flex items-start gap-2">
                    <span className="material-symbols-outlined text-2xl text-accent">{fmt.icon}</span>
                    <div className="flex-1">
                      <h3 className="text-sm font-semibold text-text">{fmt.name}</h3>
                      <p className="text-[10px] text-text-secondary mt-0.5">{fmt.desc}</p>
                      <Button size="sm" icon="download" className="mt-2">下载</Button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {tab === 'preview' && (
              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">openapi.yaml (预览)</h3>
                <pre className="bg-black text-green-300 rounded p-3 text-[10px] font-mono max-h-[60vh] overflow-y-auto whitespace-pre-wrap">{SAMPLE_YAML}</pre>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
