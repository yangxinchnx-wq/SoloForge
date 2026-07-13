/**
 * useChatClickCanvasBridge
 * ---------------------------------------------------------------------------
 * 把"点击 chat" → "自动切换到该 chat 上次访问的画布"做成的 React hook。
 *
 * 设计：
 *   - 监听 selectedChatId 变化
 *   - 调用 GET /api/canvas/resources (header: X-Requester-Chat-Session-Id=<chatId>)
 *   - 取 lastAccessedCanvasId 回调出去
 *   - 若该 chat 从未访问任何画布 → 可选自动 create (allowCreate=true)
 *
 * 业务约束：
 *   - ACL: 所有 canvas 都是 public, 但读/写需要 requester
 *   - 画布 ID 与 chat ID 解耦 (canvas_1 ... canvas_10)
 *   - chat → canvas 是 N:N, 但 lastAccessedCanvas 维护 1:1
 *
 * 使用：
 *   const { canvasId, ready, createCanvasForChat } = useChatClickCanvasBridge({
 *     chatId: selectedChatId,
 *     allowCreate: true,
 *   });
 *   // 把 canvasId 喂给 PreviewPanel 的 sessionIdRef
 *
 * 注意：
 *   - 调用方必须把 canvasId 状态提升到可以驱动 PreviewPanel 的位置
 *   - 该 hook 内部维护 mapping, 不会 dispatch 全局事件 (避免耦合)
 */

import { useEffect, useRef, useState } from 'react';
import {
  listCanvasResources,
  createCanvas,
  updateCanvasDescription,
  type CanvasResource,
  type CanvasListResponse,
} from '../services/canvas/sessionApi';

export interface UseChatClickCanvasBridgeOptions {
  /** 当前选中的 chat session id */
  chatId: string | null | undefined;
  /** 该 chat 从未访问任何画布时是否自动建一个 (默认 true) */
  allowCreate?: boolean;
  /** 自动创建时塞的默认 description */
  defaultDescription?: string;
  /** 取消 / 跳过: 例如 chatId 为空字符串 */
  enabled?: boolean;
}

export interface UseChatClickCanvasBridgeResult {
  /** 当前 chat 关联的画布 ID (canvas_1 ... canvas_10) */
  canvasId: string | null;
  /** 拉取/创建是否完成 (用于在 PreviewPanel 显示加载态) */
  ready: boolean;
  /** 失败信息 */
  error: string | null;
  /** 所有可访问的画布 (按 displayName 升序) */
  canvases: CanvasResource[];
  /** 上限 */
  maxCanvases: number;
  /** 强制重新拉取 (例如外部删除画布后) */
  refresh: () => Promise<void>;
  /** 用户手动切画布 (点 chip) — 立刻切换 + 写 access */
  selectCanvas: (canvasId: string) => void;
  /** P0: 改画布描述 (owner only) — 成功后刷新列表 */
  renameCanvas: (canvasId: string, description: string) => Promise<boolean>;
  /** 手动建一个新画布 (返回新画布 ID; 已满返回 null) */
  createCanvasForChat: () => Promise<string | null>;
}

const INFLIGHT = new Map<string, Promise<CanvasListResponse | null>>();

export function useChatClickCanvasBridge(
  opts: UseChatClickCanvasBridgeOptions,
): UseChatClickCanvasBridgeResult {
  const {
    chatId,
    allowCreate = true,
    defaultDescription,
    enabled = true,
  } = opts;

  const [canvasId, setCanvasId] = useState<string | null>(null);
  const [canvases, setCanvases] = useState<CanvasResource[]>([]);
  const [maxCanvases, setMaxCanvases] = useState<number>(10);
  const [ready, setReady] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const lastResolvedFor = useRef<string | null>(null);
  const aliveRef = useRef(true);
  // 用 ref 跟踪 canvasId, 避免 resolve 闭包捕获过期的 state 值
  const canvasIdRef = useRef<string | null>(null);
  useEffect(() => { canvasIdRef.current = canvasId; }, [canvasId]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const resolve = async (id: string): Promise<string | null> => {
    if (!id) {
      setCanvasId(null);
      setCanvases([]);
      setReady(true);
      return null;
    }
    if (lastResolvedFor.current === id && canvasIdRef.current) {
      // 同一个 chatId 已 resolve 过, 跳过重复请求
      return canvasIdRef.current;
    }
    // 不设 ready=false — 保持待机状态可见, 避免新建对话时画布闪烁
    setError(null);

    let resp = INFLIGHT.get(id);
    if (!resp) {
      resp = listCanvasResources(id);
      INFLIGHT.set(id, resp);
      resp.finally(() => INFLIGHT.delete(id));
    }
    const list = await resp;
    if (!aliveRef.current) return null;
    if (list) {
      setCanvases(list.canvases || []);
      setMaxCanvases(list.maxCanvases || 10);
    }

    let targetId = list?.lastAccessedCanvasId ?? null;
    // 若没访问过任何画布:
    //   1. 先看全局有没有可用画布, 有就复用第一个 (不新建)
    //   2. 全局一个画布都没有, 才自动创建 (allowCreate=true 时)
    if (!targetId) {
      const allCanvases = list?.canvases || [];
      if (allCanvases.length > 0) {
        // 复用序号最小的画布
        targetId = allCanvases[0].sessionId;
      } else if (allowCreate) {
        const created = await createCanvas(id, defaultDescription);
        if (!aliveRef.current) return null;
        if (!created) {
          setError('canvas limit reached (max 10)');
          setCanvasId(null);
          setReady(true);
          return null;
        }
        targetId = created.sessionId;
        // 重新拉一次列表拿到全量
        const fresh = await listCanvasResources(id);
        if (aliveRef.current && fresh) {
          setCanvases(fresh.canvases || []);
        }
      }
    }
    lastResolvedFor.current = id;
    setCanvasId(targetId);
    setReady(true);
    return targetId;
  };

  useEffect(() => {
    if (!enabled) {
      setCanvasId(null);
      setCanvases([]);
      setReady(true);
      return;
    }
    // chatId 变化时, 立即进入待机状态 (canvasId=null, ready=true)
    // 避免经过 ready=false 的加载态导致画布闪烁
    setCanvasId(null);
    setReady(true);
    void resolve(chatId || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, enabled, allowCreate]);

  // ★ 监听画布删除事件 → 刷新列表
  useEffect(() => {
    const handler = () => {
      lastResolvedFor.current = null;
      void resolve(chatId || '');
    };
    window.addEventListener('soloforge-canvas-deleted', handler);
    return () => window.removeEventListener('soloforge-canvas-deleted', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  return {
    canvasId,
    canvases,
    maxCanvases,
    ready,
    error,
    refresh: () => {
      lastResolvedFor.current = null;
      return resolve(chatId || '');
    },
    selectCanvas: (cid: string) => {
      // 立刻本地切, 不等服务端 round-trip; 后台拉列表顺便记 access
      setCanvasId(cid);
      lastResolvedFor.current = chatId || null;
      // fire-and-forget: 记 access + 刷新列表
      void (async () => {
        try {
          await fetch(`/api/canvas/sessions/${encodeURIComponent(cid)}`, {
            headers: {
              'X-Requester-Chat-Session-Id': chatId || '',
            },
          });
        } catch {}
      })();
    },
    createCanvasForChat: async () => {
      const created = await createCanvas(chatId || '', defaultDescription);
      if (created) {
        lastResolvedFor.current = chatId || null;
        setCanvasId(created.sessionId);
        // 刷新列表
        void resolve(chatId || '');
      }
      return created?.sessionId ?? null;
    },
    renameCanvas: async (canvasId: string, description: string) => {
      const updated = await updateCanvasDescription(canvasId, description, chatId || '');
      if (updated) {
        // 刷新列表拿到新的 description
        lastResolvedFor.current = null;
        await resolve(chatId || '');
      }
      return updated !== null;
    },
  };
}
