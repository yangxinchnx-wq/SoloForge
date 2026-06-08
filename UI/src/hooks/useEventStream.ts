// ─────────────────────────────────────────────────────────────────
// 实时事件流 Hook
// 优先走 WebSocket(多路复用通道),失败回退到 SSE
// - 维护最近 N 条事件
// - 暴露"自上次订阅以来"的新事件 (delta 模式)
// ─────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState, useCallback } from 'react';
import { subscribeSse } from '../api/client';
import { getWsClient } from '../api/ws';
import type { KernelEvent } from '../types';

const MAX_EVENTS = 200;
const STORAGE_KEY = 'soloforge.events.recent.v1';

export interface EventStreamState {
  events: KernelEvent[];
  lastEventAt: number | null;
  connected: boolean;
  /** 重置最近事件计数器 */
  clear: () => void;
  /** 自上次 clear 以来新增的事件数 (用于角标) */
  newCount: number;
  /** 重置 newCount = 0 */
  ackNew: () => void;
  /** 当前通道: 'ws' | 'sse' | null */
  channel: 'ws' | 'sse' | null;
}

export function useEventStream(enabled = true): EventStreamState {
  const [events, setEvents] = useState<KernelEvent[]>(() => {
    if (typeof localStorage === 'undefined') return [];
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw) as KernelEvent[];
      return Array.isArray(arr) ? arr.slice(-MAX_EVENTS) : [];
    } catch { return []; }
  });
  const [connected, setConnected] = useState(false);
  const [channel, setChannel] = useState<'ws' | 'sse' | null>(null);
  const newCountRef = useRef(0);
  const [newCount, setNewCount] = useState(0);
  const lastEventAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let unsubWs: (() => void) | null = null;
    let unsubSse: (() => void) | null = null;
    let wsReady = false;

    // 1) 优先 WS
    const ws = getWsClient();
    ws.start();
    const offMsg = ws.on('*', (evt: any) => {
      if (cancelled) return;
      if (evt.type === 'connected') {
        wsReady = true;
        setConnected(true);
        setChannel('ws');
        // 订阅事件推送
        ws.send('state.subscribe', { keys: ['events'] });
        return;
      }
      if (evt.type === 'disconnected') {
        if (channel === 'ws') setConnected(false);
        return;
      }
      if (evt.type === 'event.broadcast' && evt.payload) {
        const e: KernelEvent = {
          event: evt.payload.event,
          payload: evt.payload.data,
          timestamp: evt.payload.kernelTs || Date.now(),
        };
        setEvents(prev => {
          const next = [...prev, e];
          return next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next;
        });
        lastEventAtRef.current = e.timestamp;
        newCountRef.current++;
        setNewCount(newCountRef.current);
      }
    });
    unsubWs = offMsg;

    // 2) 2s 内 WS 没连上 → 回退到 SSE
    const fallback = setTimeout(() => {
      if (cancelled || wsReady) return;
      if (ws.state().connected) return;
      const unsub = subscribeSse((evt) => {
        if (cancelled) return;
        setConnected(true);
        setChannel('sse');
        const e: KernelEvent = {
          event: evt.event,
          payload: evt.payload,
          timestamp: evt.timestamp || Date.now(),
        };
        setEvents(prev => {
          const next = [...prev, e];
          return next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next;
        });
        lastEventAtRef.current = e.timestamp;
        newCountRef.current++;
        setNewCount(newCountRef.current);
      });
      unsubSse = unsub;
    }, 2000);

    return () => {
      cancelled = true;
      clearTimeout(fallback);
      unsubWs?.();
      unsubSse?.();
    };
  }, [enabled]);

  // 持久化 (节流)
  useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    if (events.length === 0) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    const t = setTimeout(() => {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(events)); } catch { /* ignore */ }
    }, 500);
    return () => clearTimeout(t);
  }, [events]);

  const clear = useCallback(() => {
    setEvents([]);
    newCountRef.current = 0;
    setNewCount(0);
  }, []);

  const ackNew = useCallback(() => {
    newCountRef.current = 0;
    setNewCount(0);
  }, []);

  return {
    events,
    lastEventAt: lastEventAtRef.current,
    connected,
    newCount,
    clear,
    ackNew,
    channel,
  };
}
