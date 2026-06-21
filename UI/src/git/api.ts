import type {
  GitStatusData,
  MessageResponse,
  BranchesResponse,
  DiffResponse,
  FileDiffResponse,
} from './types';

const GIT_BASE = '/api/git';

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);
    if (!res.ok) {
      // Try to parse error body as JSON; fall back to status text
      try {
        const errBody = await res.json();
        return errBody as T;
      } catch {
        throw new Error(`Git 服务返回错误 (${res.status}): ${res.statusText}`);
      }
    }
    const data = await res.json();
    return data as T;
  } catch (err: any) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      throw new Error('Git 服务连接超时，请确认 git-service 已启动 (端口 3002)');
    }
    if (err instanceof TypeError && err.message.includes('fetch')) {
      throw new Error('无法连接到 Git 服务，请确认服务已启动');
    }
    throw err;
  }
}

export const gitApi = {
  getStatus: () => request<GitStatusData>(`${GIT_BASE}/status`),

  init: () =>
    request<MessageResponse>(`${GIT_BASE}/init`, { method: 'POST' }),

  setConfig: (userName: string, userEmail: string, remoteUrl: string) =>
    request<MessageResponse>(`${GIT_BASE}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userName, userEmail, remoteUrl }),
    }),

  addFiles: (filePaths: string[] = []) =>
    request<MessageResponse>(`${GIT_BASE}/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePaths }),
    }),

  commit: (message: string, authorName?: string, authorEmail?: string) =>
    request<MessageResponse>(`${GIT_BASE}/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, authorName, authorEmail }),
    }),

  push: (remoteUrl?: string, token?: string, branch?: string, force?: boolean) =>
    request<MessageResponse>(`${GIT_BASE}/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ remoteUrl, token, branch, force }),
    }),

  getBranches: () => request<BranchesResponse>(`${GIT_BASE}/branches`),

  checkout: (branch: string, create: boolean = false) =>
    request<MessageResponse>(`${GIT_BASE}/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch, create }),
    }),

  getCommitDiff: (hash: string) =>
    request<DiffResponse>(`${GIT_BASE}/diff?hash=${encodeURIComponent(hash)}`),

  getFileDiff: (file: string) =>
    request<FileDiffResponse>(`${GIT_BASE}/file-diff?file=${encodeURIComponent(file)}`),

  resolveConflict: (file: string, resolution: 'ours' | 'theirs' | 'both') =>
    request<MessageResponse>(`${GIT_BASE}/resolve-conflict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file, resolution }),
    }),
};
