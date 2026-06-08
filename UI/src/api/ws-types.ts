// ─────────────────────────────────────────────────────────────────
// 前端共享的 WS 协议类型(后端 src/ws/types.ts 的镜像)
// 字段保持一致
// ─────────────────────────────────────────────────────────────────

export interface FrameBase {
  id: string;
  seq: number;
  t: number;
  ack?: number;
  type: string;
  payload?: any;
}

export interface ChatSendPayload {
  sessionId: string;
  text: string;
  model?: string;
  attachments?: string[];
  settings?: {
    temperature?: number;
    enableTools?: boolean;
    enableMemory?: boolean;
    enableRag?: boolean;
    hybridEnabled?: boolean;
    secondaryModel?: string;
  };
}

export type ClientMsg =
  | (FrameBase & { type: 'ping'; payload?: { ts: number } })
  | (FrameBase & { type: 'chat.send'; payload: ChatSendPayload })
  | (FrameBase & { type: 'chat.abort'; payload: { sessionId: string; messageId: string } })
  | (FrameBase & { type: 'term.exec'; payload: { execId: string; command: string; cwd?: string; env?: Record<string, string>; timeoutMs?: number } })
  | (FrameBase & { type: 'term.abort'; payload: { execId: string } })
  | (FrameBase & { type: 'state.subscribe'; payload: { keys: string[] } })
  | (FrameBase & { type: 'state.resync'; payload: { keys?: string[] } })
  | (FrameBase & { type: 'ack'; payload: { upTo: number } });

export type ServerMsg =
  | (FrameBase & { type: 'pong'; payload: { ts: number; serverTs: number; rtt: number } })
  | (FrameBase & { type: 'welcome'; payload: { wsId: string; since: number; serverVersion: string } })
  | (FrameBase & { type: 'chat.chunk'; payload: { sessionId: string; messageId: string; delta: string; index: number } })
  | (FrameBase & { type: 'chat.done'; payload: { sessionId: string; messageId: string; usage?: { promptTokens: number; completionTokens: number; totalMs: number } } })
  | (FrameBase & { type: 'chat.error'; payload: { sessionId: string; messageId: string; code: string; message: string } })
  | (FrameBase & { type: 'term.start'; payload: { execId: string; pid?: number; ts: number } })
  | (FrameBase & { type: 'term.stdout'; payload: { execId: string; data: string; ts: number; chunkIndex: number } })
  | (FrameBase & { type: 'term.stderr'; payload: { execId: string; data: string; ts: number; chunkIndex: number } })
  | (FrameBase & { type: 'term.exit'; payload: { execId: string; code: number; durationMs: number } })
  | (FrameBase & { type: 'event.broadcast'; payload: { event: string; data: any; kernelTs: number } })
  | (FrameBase & { type: 'state.snapshot'; payload: { key: string; data: any; version: number } })
  | (FrameBase & { type: 'state.diff'; payload: { key: string; patches: any[]; version: number } })
  | (FrameBase & { type: 'error'; payload: { code: string; message: string; ref?: string } });
