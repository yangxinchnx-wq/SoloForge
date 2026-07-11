/**
 * trainingRoutes.ts — 投喂训练数据辅助路由 [PATCHED]
 *
 * 路由:
 *   POST /api/training/fetch-url   → 抓取 URL 内容 (绕过 CORS)
 *         Body: { urls: string[], maxLength?: number }
 *         Response: { results: [{ url, title, content, charCount, error? }] }
 *
 * 安全加固 (2026-07-11):
 *   - DNS 解析 + IP 黑名单 (防 SSRF)
 *   - URL 格式深度校验
 *   - 认证中间件 (可选启用)
 */

import type { Request, Response } from 'express';
import dns from 'node:dns';
import net from 'node:net';
import { promisify } from 'node:util';
import { authenticateToken } from '../middleware/auth';

const FETCH_TIMEOUT_MS = 8_000;
const MAX_CONTENT_BYTES = 50 * 1024;
const MAX_URLS = 5;

const BLOCKED_IP_RANGES: Array<{ cidr: string; label: string }> = [
  { cidr: '127.0.0.0/8',     label: 'loopback' },
  { cidr: '::1/128',          label: 'loopback-ipv6' },
  { cidr: '10.0.0.0/8',      label: 'rfc1918-a' },
  { cidr: '172.16.0.0/12',   label: 'rfc1918-b' },
  { cidr: '192.168.0.0/16',  label: 'rfc1918-c' },
  { cidr: '169.254.169.254/32', label: 'cloud-metadata' },
  { cidr: '100.64.0.0/10',   label: 'cgnat' },
  { cidr: '198.18.0.0/15',   label: 'benchmark' },
  { cidr: 'fc00::/7',         label: 'ula' },
  { cidr: 'fe80::/10',        label: 'link-local' },
];

function isIPInRange(ipParts: number[], cidr: string): boolean {
  const [network, prefixStr] = cidr.split('/');
  const prefix = parseInt(prefixStr, 10);
  const netParts = network.split('.').map(Number);
  if (prefix === 0) return true;
  const mask = ~(0xffffffff >>> prefix);
  const ipInt = (ipParts[0] << 24) | (ipParts[1] << 16) | (ipParts[2] << 8) | ipParts[3];
  const netInt = (netParts[0] << 24) | (netParts[1] << 16) | (netParts[2] << 8) | netParts[3];
  return (ipInt & mask) === (netInt & mask);
}

function isIPv6InRange(ip: string, cidr: string): boolean {
  if (cidr === '::/0') return true;
  if (cidr === '::1/128') return ip === '::1' || ip === '0000:0000:0000:0000:0000:0000:0000:0001';
  if (cidr === 'fe80::/10') return ip.startsWith('fe80:') || ip.startsWith('fe80');
  if (cidr === 'fc00::/7') return ip.startsWith('fc') || ip.startsWith('fd');
  return false;
}

function isIpBlocked(ip: string): { blocked: boolean; reason?: string } {
  if (net.isIPv4(ip)) {
    const buf = ip.split('.').map(Number);
    for (const range of BLOCKED_IP_RANGES) {
      if (!range.cidr.includes(':') && isIPInRange(buf, range.cidr)) {
        return { blocked: true, reason: `${range.label} (${range.cidr})` };
      }
    }
    return { blocked: false };
  }
  if (net.isIPv6(ip)) {
    for (const range of BLOCKED_IP_RANGES) {
      if (range.cidr.includes(':') && isIPv6InRange(ip, range.cidr)) {
        return { blocked: true, reason: `${range.label} (${range.cidr})` };
      }
    }
    return { blocked: false };
  }
  return { blocked: true, reason: 'unrecognized-ip-format' };
}

async function resolveAndCheckUrl(urlStr: string): Promise<{ ok: boolean; error?: string }> {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return { ok: false, error: 'URL 格式无效' };
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, error: '仅支持 http/https 协议' };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, error: 'URL 不允许包含用户名/密码' };
  }

  if (parsed.hash) {
    return { ok: false, error: 'URL 不允许包含 fragment (#)' };
  }

  const hostname = parsed.hostname;

  if (net.isIP(hostname)) {
    const result = isIpBlocked(hostname);
    if (result.blocked) {
      return { ok: false, error: `目标地址被禁止访问: ${result.reason}` };
    }
    return { ok: true };
  }

  try {
    const dnsLookup = promisify(dns.lookup);
    const addresses: dns.LookupAddress[] = await dnsLookup(hostname, { all: true });

    if (!addresses || addresses.length === 0) {
      return { ok: false, error: `DNS 解析失败: ${hostname}` };
    }

    for (const addr of addresses) {
      const result = isIpBlocked(addr.address);
      if (result.blocked) {
        return { ok: false, error: `目标地址解析到被禁止的 IP: ${addr.address} (${result.reason})` };
      }
    }

    return { ok: true };
  } catch (dnsErr: any) {
    return { ok: false, error: `DNS 解析异常: ${(dnsErr as Error).message}` };
  }
}

function extractTextFromHtml(html: string): { title: string; content: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  let title = titleMatch ? titleMatch[1].trim() : '';

  let body = html;
  body = body.replace(/<script[\s\S]*?<\/script>/gi, '');
  body = body.replace(/<style[\s\S]*?<\/style>/gi, '');
  body = body.replace(/<nav[\s\S]*?<\/nav>/gi, '');
  body = body.replace(/<footer[\s\S]*?<\/footer>/gi, '');
  body = body.replace(/<header[\s\S]*?<\/header>/gi, '');
  body = body.replace(/<aside[\s\S]*?<\/aside>/gi, '');
  body = body.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
  body = body.replace(/<svg[\s\S]*?<\/svg>/gi, '');

  const articleMatch = body.match(/<article[\s\S]*?>([\s\S]*?)<\/article>/i);
  const mainMatch = body.match(/<main[\s\S]*?>([\s\S]*?)<\/main>/i);
  const extractFrom = articleMatch?.[1] || mainMatch?.[1] || body;

  let text = extractFrom.replace(/<[^>]+>/g, ' ');

  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&hellip;/g, '...')
    .replace(/&mdash;/g, '\u2014')
    .replace(/&ndash;/g, '\u2013');

  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.trim();

  return { title, content: text };
}

async function fetchOneUrl(url: string, maxLength: number): Promise<{
  url: string;
  title: string;
  content: string;
  charCount: number;
  error?: string;
}> {
  const check = await resolveAndCheckUrl(url);
  if (!check.ok) {
    return { url, title: '', content: '', charCount: 0, error: check.error || 'SSRF 防护拦截' };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'SoloForge-TrainingBot/1.0',
        'Accept': 'text/html,application/xhtml+xml,text/plain,*/*',
      },
      redirect: 'follow',
    });
    clearTimeout(timer);

    if (!res.ok) {
      return { url, title: '', content: '', charCount: 0, error: `HTTP ${res.status}` };
    }

    if (res.url && res.url !== url) {
      const redirectCheck = await resolveAndCheckUrl(res.url);
      if (!redirectCheck.ok) {
        return { url, title: '', content: '', charCount: 0, error: `重定向目标被禁止: ${redirectCheck.error}` };
      }
    }

    const contentType = res.headers.get('content-type') || '';

    if (contentType.includes('text/plain')) {
      const text = await res.text();
      const truncated = text.slice(0, maxLength);
      return { url, title: url.split('/').pop() || url, content: truncated, charCount: text.length };
    }

    const raw = await res.text();
    const rawBytes = Buffer.byteLength(raw, 'utf-8');
    if (rawBytes > MAX_CONTENT_BYTES * 2) {
      const truncated = raw.slice(0, MAX_CONTENT_BYTES);
      const { title, content } = extractTextFromHtml(truncated);
      return { url, title, content: content.slice(0, maxLength), charCount: content.length };
    }

    const { title, content } = extractTextFromHtml(raw);
    const truncated = content.slice(0, maxLength);

    return { url, title, content: truncated, charCount: content.length };
  } catch (err: any) {
    const msg = err?.name === 'AbortError' ? `超时 (${FETCH_TIMEOUT_MS}ms)` : (err?.message || '抓取失败');
    return { url, title: '', content: '', charCount: 0, error: msg };
  }
}

async function handleFetchUrl(req: Request, res: Response): Promise<void> {
  const { urls, maxLength = 8000 } = req.body || {};

  if (!Array.isArray(urls) || urls.length === 0) {
    res.status(400).json({ error: 'urls 数组不能为空' });
    return;
  }

  const limited = urls.slice(0, MAX_URLS).map((u: string) => String(u).trim()).filter(Boolean);

  for (const u of limited) {
    try {
      new URL(u);
    } catch {
      res.status(400).json({ error: `无效 URL 格式: ${u}` });
      return;
    }
  }

  const cappedMaxLength = Math.min(Math.max(Number(maxLength) || 8000, 1), 100_000);

  const results = await Promise.all(limited.map((url: string) => fetchOneUrl(url, cappedMaxLength)));

  res.json({ results });
}

export function registerTrainingRoutes(app: import('express').Express): void {
  app.post('/api/training/fetch-url', authenticateToken, handleFetchUrl);
}
