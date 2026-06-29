/**
 * fileSystemApi — 前端文件系统 API 封装
 *
 * 所有文件操作通过 HTTP 调用 UI/server.ts 暴露的端点
 * server.ts 负责读写宿主机真实磁盘文件
 */

const API_BASE = '/api/files';

// ============================================================
// 类型
// ============================================================

export interface FileNode {
  name: string;
  type: 'file' | 'folder';
  path: string;
  children?: FileNode[];
  size?: number;
  mtime?: number;
}

export interface ReadFileResponse {
  success: boolean;
  content?: string;
  error?: string;
  mtime?: number;
}

export interface SaveFileResponse {
  success: boolean;
  error?: string;
}

export interface ListFilesResponse {
  success: boolean;
  files?: FileNode[];
  error?: string;
}

export interface FileStatsResponse {
  success: boolean;
  stats?: {
    totalFiles: number;
    totalFolders: number;
    totalSize: number;
  };
  error?: string;
}

// ============================================================
// API 调用
// ============================================================

export const fileSystemApi = {
  /**
   * 读取文件内容
   * GET /api/files/read?path=xxx
   */
  async readFile(path: string): Promise<string> {
    const res = await fetch(
      `${API_BASE}/read?path=${encodeURIComponent(path)}`,
      {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `读取文件失败: HTTP ${res.status}`);
    }

    const data = await res.json();
    if (!data.success) {
      throw new Error(data.error ?? '读取文件失败');
    }
    return data.content ?? '';
  },

  /**
   * 保存文件内容
   * POST /api/files/save
   * Body: { path, content }
   */
  async saveFile(path: string, content: string): Promise<void> {
    const res = await fetch(`${API_BASE}/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `保存文件失败: HTTP ${res.status}`);
    }

    const data = await res.json();
    if (!data.success) {
      throw new Error(data.error ?? '保存文件失败');
    }
  },

  /**
   * 列出目录内容
   * GET /api/files/list?dir=xxx
   */
  async listFiles(dir: string = ''): Promise<FileNode[]> {
    const res = await fetch(
      `${API_BASE}/list?dir=${encodeURIComponent(dir)}`,
      {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `列出文件失败: HTTP ${res.status}`);
    }

    const data: ListFilesResponse = await res.json();
    if (!data.success) {
      throw new Error(data.error ?? '列出文件失败');
    }
    return data.files ?? [];
  },

  /**
   * 创建新文件或文件夹
   * POST /api/files/create
   * Body: { path, content?, isDir? }
   */
  async createFile(path: string, content: string = '', isDir: boolean = false): Promise<void> {
    const res = await fetch(`${API_BASE}/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content, isDir }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `创建文件失败: HTTP ${res.status}`);
    }

    const data = await res.json();
    if (!data.success) {
      throw new Error(data.error ?? '创建文件失败');
    }
  },

  /**
   * 删除文件/文件夹
   * DELETE /api/files/delete?path=xxx
   */
  async deleteFile(path: string): Promise<void> {
    const res = await fetch(
      `${API_BASE}/delete?path=${encodeURIComponent(path)}`,
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `删除文件失败: HTTP ${res.status}`);
    }

    const data = await res.json();
    if (!data.success) {
      throw new Error(data.error ?? '删除文件失败');
    }
  },

  /**
   * 重命名文件/文件夹
   * POST /api/files/rename
   * Body: { oldPath, newPath }
   */
  async renameFile(oldPath: string, newPath: string): Promise<void> {
    const res = await fetch(`${API_BASE}/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldPath, newPath }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `重命名文件失败: HTTP ${res.status}`);
    }

    const data = await res.json();
    if (!data.success) {
      throw new Error(data.error ?? '重命名文件失败');
    }
  },

  /**
   * 获取文件统计信息
   * GET /api/files/stats
   */
  async getStats(): Promise<{ totalFiles: number; totalFolders: number; totalSize: number }> {
    const res = await fetch(`${API_BASE}/stats`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `获取统计失败: HTTP ${res.status}`);
    }

    const data = await res.json();
    if (!data.success || !data.stats) {
      throw new Error(data.error ?? '获取统计失败');
    }
    return data.stats;
  },
};
