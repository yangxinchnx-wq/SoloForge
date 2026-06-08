// ─────────────────────────────────────────────────────────────────
// SoloForge 前端 WebSocket 客户端(单例)
// - 自动重连 + 指数退避 + 抖动
// - 消息路由(type → Set<handler>)
// - seq 自增,自动加 id/t/seq
// - 应用层 ping/pong 计算 rtt
// ─────────────────────────────────────────────────────────────────

import { ClientMsg, ServerMsg } from './ws-types';
import { API_BASE } from './client';

type Handler = (msg: ServerMsg) => void;

export interface WsClient {
  /** 启动(幂等) */
  start: () => void;
  /** 主动关闭 */
  stop: () => void;
  /** 发送消息(自动加 id/seq/t) */
  send: <T = any>(type: ClientMsg['type'], payload?: T) => string;
  /** 订阅某种 type 的消息,返回取消订阅函数 */
  on: (type: ServerMsg['type'] | '*', handler: Handler) => () => void;
  /** 状态 */
  state: () => {
    connected: boolean;
    connecting: boolean;
    rtt: number;
    lastError: string | null;
    reconnectAttempt: number;
  };
}

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 25_000;

const LAST_SEQ_KEY = 'soloforge.ws.lastServerSeq';
const TOKEN_KEY = 'soloforge.ws.token';

function loadLastSeq(): number {
  try {
    const v = localStorage.getItem(LAST_SEQ_KEY);
    if (v) return parseInt(v, 10) || 0;
  } catch { /* ignore */ }
  return 0;
}
function saveLastSeq(n: number): void {
  try { localStorage.setItem(LAST_SEQ_KEY, String(n)); } catch { /* ignore */ }
}

/** 读 token:env > localStorage > 登录态 > 空 */
function loadToken(): string {
  const env = (import.meta as any).env?.VITE_WS_TOKEN as string | undefined;
  if (env) return env;
  try {
    const v = localStorage.getItem(TOKEN_KEY);
    if (v) return v;
  } catch { /* ignore */ }
  return '';
}

export function createWsClient(opts?: { url?: string }): WsClient {
  const handlers = new Map<string, Set<Handler>>();
  let ws: WebSocket | null = null;
  let connected = false;
  let connecting = false;
  let closedByUser = false;
  let rtt = 0;
  let lastError: string | null = null;
  let reconnectAttempt = 0;
  let seq = 0;
  let lastServerSeq = 0;
  let hbTimer: ReturnType<typeof setInterval> | null = null;

  // 计算 ws URL:API_BASE 是 '' (同源) 或 'http://localhost:3001'
  const resolveUrl = (since?: number): string => {
    if (opts?.url) return opts.url;
    let base: string;
    if (API_BASE === '') {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      base = `${proto}//${window.location.host}/ws`;
    } else {
      base = API_BASE.replace(/^http/, 'ws') + '/ws';
    }
    const params: string[] = [];
    if (since !== undefined && since > 0) params.push('since=' + since);
    const token = loadToken();
    if (token) params.push('token=' + encodeURIComponent(token));
    return params.length > 0 ? base + '?' + params.join('&') : base;
  };

  const connect = () => {
    if (closedByUser || connecting || (ws && ws.readyState !== WebSocket.CLOSED)) return;
    connecting = true;
    // 重连时带 ?since=<lastServerSeq> 让服务端补发
    const since = reconnectAttempt > 0 ? lastServerSeq : loadLastSeq();
    const url = resolveUrl(since);
    try {
      ws = new WebSocket(url);
    } catch (e: any) {
      connecting = false;
      lastError = e?.message || 'ws create failed';
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      connected = true;
      connecting = false;
      lastError = null;
      reconnectAttempt = 0;
      console.info('[SoloForge WS] connected:', url);
      startHeartbeat();
      emit('*', makeSynthetic('connected' as any));
    };

    ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === 'pong' && msg.payload) {
        rtt = msg.payload.rtt;
      }
      // 追踪 serverSeq,用于重连补发
      if (typeof msg.seq === 'number' && msg.seq > lastServerSeq) {
        lastServerSeq = msg.seq;
        // 节流:每 10 帧写一次 localStorage
        if (lastServerSeq % 10 === 0) saveLastSeq(lastServerSeq);
      }
      emit(msg.type, msg);
      emit('*', msg);
    };

    ws.onerror = (ev) => {
      lastError = 'ws error';
      // 浏览器 Event 不暴露 detail,记录但不抛
      console.warn('[SoloForge WS] error', ev);
    };

    ws.onclose = (ev) => {
      connected = false;
      connecting = false;
      stopHeartbeat();
      lastError = `ws closed: code=${ev.code} reason=${ev.reason || ''}`;
      console.info('[SoloForge WS] closed', ev.code, ev.reason);
      emit('*', makeSynthetic('disconnected' as any));
      if (!closedByUser) scheduleReconnect();
    };
  };

  const scheduleReconnect = () => {
    if (closedByUser) return;
    reconnectAttempt++;
    // 指数退避 + ±20% 抖动
    const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt - 1));
    const jitter = base * (0.8 + Math.random() * 0.4);
    const delay = Math.round(jitter);
    console.info(`[SoloForge WS] reconnect in ${delay}ms (attempt ${reconnectAttempt})`);
    setTimeout(connect, delay);
  };

  const startHeartbeat = () => {
    stopHeartbeat();
    hbTimer = setInterval(() => {
      if (!connected) return;
      send('ping', { ts: Date.now() });
    }, HEARTBEAT_INTERVAL_MS);
  };

  const stopHeartbeat = () => {
    if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
  };

  const emit = (type: string, msg: ServerMsg) => {
    const set = handlers.get(type);
    if (set) set.forEach(h => { try { h(msg); } catch (e) { /* ignore */ } });
  };

  const send: WsClient['send'] = (type, payload) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.warn(`[SoloForge WS] send dropped (not open): ${type}`);
      return '';
    }
    const id = 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    seq++;
    const frame: ClientMsg = { id, seq, t: Date.now(), type, payload } as any;
    try {
      ws.send(JSON.stringify(frame));
    } catch (e: any) {
      lastError = e?.message || 'send failed';
    }
    return id;
  };

  const on: WsClient['on'] = (type, handler) => {
    let set = handlers.get(type);
    if (!set) { set = new Set(); handlers.set(type, set); }
    set.add(handler);
    return () => set!.delete(handler);
  };

  const makeSynthetic = (type: string): ServerMsg => ({
    id: 'sys_' + Date.now().toString(36),
    seq: 0,
    t: Date.now(),
    type: type as any,
    payload: { rtt, lastError, reconnectAttempt },
  });

  return {
    start: connect,
    stop: () => {
      closedByUser = true;
      stopHeartbeat();
      if (ws) try { ws.close(1000, 'client stop'); } catch { /* ignore */ }
      ws = null;
      connected = false;
    },
    send,
    on,
    state: () => ({ connected, connecting, rtt, lastError, reconnectAttempt }),
  };
}

/** 全局单例(惰性) */
let _client: WsClient | null = null;
export function getWsClient(): WsClient {
  if (!_client) _client = createWsClient();
  return _client;
}
