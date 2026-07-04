/**
 * terminal 模块 — 共享类型
 *
 * 模块边界:
 *   - 上游 (ChatPanel): 只 import types + useChatWorkdir hook
 *   - 下游 (E2BService): import resolveOrCreateWorkdir 拿 cwd 注入 tool_call
 *   - UI (TerminalPanel): 内部组件, 通过 props 收 chatId/workdir
 */

export type WorkdirSource = 'auto' | 'manual' | 'inherited';

export interface ChatWorkdirEntry {
  chatId: string;
  workdir: string;
  source: WorkdirSource;
  updatedAt: number;
  alias?: string;
}

/** 反向索引的轻量形态 — 序列化友好 */
export interface ChatWorkdirPersisted {
  byChatId: Record<string, ChatWorkdirEntry>;
  /** workdir -> chatId[] (realpath 归一后的小写键) */
  pathIndex: Record<string, string[]>;
  workspaceRoot: string;
}

export interface ResolveOrCreateOptions {
  /**
   * 7 天内若有 chat 复用同一 workspaceRoot, 新 chat 自动继承其 workdir
   * 默认 true. 设 false 可强制每个 chat 都新建子目录.
   */
  inheritFromSibling?: boolean;
  /** 新建时强制 source 标记 */
  source?: WorkdirSource;
}

export interface SetWorkdirOptions {
  source?: WorkdirSource;
  alias?: string;
}

export interface WorkdirValidationResult {
  ok: boolean;
  reason?: string;
}
