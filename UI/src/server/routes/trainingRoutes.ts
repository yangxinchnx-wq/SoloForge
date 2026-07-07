/**
 * trainingRoutes.ts — 投喂训练数据辅助路由
 *
 * 路由:
 *   POST /api/training/fetch-url   → 抓取 URL 内容 (绕过 CORS)
 *         Body: { urls: string[], maxLength?: number }
 *         Response: { results: [{ url, title, content, charCount, error? }] }
 *
 * 设计:
 *   - 使用原生 fetch + 正则剥 HTML 标签, 不依赖 cheerio
 *   - 单 URL 超时 8s, 最大内容 50KB (防 OOM)
 *   - 自动提取 <title> 和正文
 *   - 去除 script/style/nav/footer/header 等非正文元素
 */

import type { Request, Response } from 'express';

const FETCH_TIMEOUT_MS = 8_000;
const MAX_CONTENT_BYTES = 50 * 1024; // 50KB per URL
const MAX_URLS = 5;

/**
 * 从 HTML 中提取纯文本 (正则剥标签, 不依赖 cheerio)
 */
function extractTextFromHtml(html: string): { title: string; content: string } {
  // 提取 <title>
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  let title = titleMatch ? titleMatch[1].trim() : '';

  // 去除 script / style / nav / footer / header / aside / noscript / svg
  let body = html;
  body = body.replace(/<script[\s\S]*?<\/script>/gi, '');
  body = body.replace(/<style[\s\S]*?<\/style>/gi, '');
  body = body.replace(/<nav[\s\S]*?<\/nav>/gi, '');
  body = body.replace(/<footer[\s\S]*?<\/footer>/gi, '');
  body = body.replace(/<header[\s\S]*?<\/header>/gi, '');
  body = body.replace(/<aside[\s\S]*?<\/aside>/gi, '');
  body = body.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
  body = body.replace(/<svg[\s\S]*?<\/svg>/gi, '');

  // 尝试提取 <article> 或 <main> 内容 (优先)
  const articleMatch = body.match(/<article[\s\S]*?>([\s\S]*?)<\/article>/i);
  const mainMatch = body.match(/<main[\s\S]*?>([\s\S]*?)<\/main>/i);
  const extractFrom = articleMatch?.[1] || mainMatch?.[1] || body;

  // 剥所有 HTML 标签
  let text = extractFrom.replace(/<[^>]+>/g, ' ');

  // 解码常见 HTML 实体
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&hellip;/g, '...')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–');

  // 合并多余空白
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.trim();

  return { title, content: text };
}

/**
 * 抓取单个 URL
 */
async function fetchOneUrl(url: string, maxLength: number): Promise<{
  url: string;
  title: string;
  content: string;
  charCount: number;
  error?: string;
}> {
  try {
    // 校验 URL 格式
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { url, title: '', content: '', charCount: 0, error: '仅支持 http/https 协议' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'SoloForge-TrainingBot/1.0',
        'Accept': 'text/html,application/xhtml+xml,text/plain,*/*',
      },
    });
    clearTimeout(timer);

    if (!res.ok) {
      return { url, title: '', content: '', charCount: 0, error: `HTTP ${res.status}` };
    }

    const contentType = res.headers.get('content-type') || '';

    // 如果是纯文本, 直接返回
    if (contentType.includes('text/plain')) {
      const text = await res.text();
      const truncated = text.slice(0, maxLength);
      return { url, title: url.split('/').pop() || url, content: truncated, charCount: text.length };
    }

    // HTML 解析
    const raw = await res.text();
    const rawBytes = Buffer.byteLength(raw, 'utf-8');
    if (rawBytes > MAX_CONTENT_BYTES * 2) {
      // 超大页面, 只取前 MAX_CONTENT_BYTES 的 HTML
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

/**
 * POST /api/training/fetch-url
 */
async function handleFetchUrl(req: Request, res: Response) {
  const { urls, maxLength = 8000 } = req.body || {};

  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'urls 数组不能为空' });
  }

  const limited = urls.slice(0, MAX_URLS).map((u: string) => String(u).trim()).filter(Boolean);

  // 并行抓取
  const results = await Promise.all(limited.map((url: string) => fetchOneUrl(url, maxLength)));

  return res.json({ results });
}

/**
 * 路由注册
 */
export function registerTrainingRoutes(app: import('express').Express): void {
  app.post('/api/training/fetch-url', handleFetchUrl);
}
