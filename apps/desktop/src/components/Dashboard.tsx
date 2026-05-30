// ─────────────────────────────────────────────────────────────────
// SoloForge Dashboard Component
// 示例组件 - 展示如何使用 Electron API
// ─────────────────────────────────────────────────────────────────

import React, { useEffect, useState, useCallback } from 'react';
import type { KernelStatus, KernelEvent, HealthStatus } from '../types';

export function Dashboard() {
  const [status, setStatus] = useState<KernelStatus | null>(null);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [events, setEvents] = useState<KernelEvent[]>([]);
  const [subscribedEvents, setSubscribedEvents] = useState<string[]>([]);

  // 获取内核状态
  const fetchStatus = useCallback(async () => {
    if (!window.soloforge) return;
    try {
      const s = await window.soloforge.kernel.getStatus();
      setStatus(s);
    } catch (e) {
      console.error('Failed to fetch status:', e);
    }
  }, []);

  // 获取健康状态
  const fetchHealth = useCallback(async () => {
    if (!window.soloforge) return;
    try {
      const h = await window.soloforge.kernel.getHealth();
      setHealth(h);
    } catch (e) {
      console.error('Failed to fetch health:', e);
    }
  }, []);

  // 获取事件历史
  const fetchEvents = useCallback(async () => {
    if (!window.soloforge) return;
    try {
      const e = await window.soloforge.kernel.getEvents(50);
      setEvents(e.reverse());
    } catch (e) {
      console.error('Failed to fetch events:', e);
    }
  }, []);

  // 获取订阅的事件列表
  const fetchSubscribedEvents = useCallback(async () => {
    if (!window.soloforge) return;
    try {
      const list = await window.soloforge.events.list();
      setSubscribedEvents(list);
    } catch (e) {
      console.error('Failed to fetch subscribed events:', e);
    }
  }, []);

  // 订阅实时事件
  useEffect(() => {
    if (!window.soloforge) return;

    // 订阅实时事件
    const unsubscribe = window.soloforge.events.onEvent((event) => {
      setEvents((prev) => [...prev.slice(-99), event]);
    });

    // 初始加载
    fetchStatus();
    fetchHealth();
    fetchEvents();
    fetchSubscribedEvents();

    // 定期刷新
    const interval = setInterval(() => {
      fetchStatus();
      fetchHealth();
    }, 2000);

    return () => {
      unsubscribe();
      clearInterval(interval);
    };
  }, [fetchStatus, fetchHealth, fetchEvents, fetchSubscribedEvents]);

  return (
    <div className="dashboard">
      <h1>SoloForge Dashboard</h1>

      {/* 状态卡片 */}
      <div className="status-cards">
        <div className="card">
          <h3>Runtime Status</h3>
          <div className="status-value">
            <span className="label">State:</span>
            <span className={status?.state?.toLowerCase()}>{status?.state || 'Loading...'}</span>
          </div>
          <div className="status-value">
            <span className="label">Mode:</span>
            <span>{status?.mode || 'Loading...'}</span>
          </div>
          <div className="status-value">
            <span className="label">Version:</span>
            <span>{status?.version || '0'}</span>
          </div>
        </div>

        <div className="card">
          <h3>Health</h3>
          <div className={`health-indicator ${health?.healthy ? 'healthy' : 'unhealthy'}`}>
            {health?.healthy ? '✓ Healthy' : '✗ Unhealthy'}
          </div>
          {health?.error && <div className="error">{health.error}</div>}
        </div>

        <div className="card">
          <h3>Event Subscriptions</h3>
          <div className="subscription-list">
            {subscribedEvents.map((event) => (
              <span key={event} className="subscription-tag">{event}</span>
            ))}
          </div>
        </div>
      </div>

      {/* 事件流 */}
      <div className="event-feed">
        <h3>Event Stream</h3>
        <div className="events">
          {events.length === 0 ? (
            <div className="empty">No events yet</div>
          ) : (
            events.map((event, index) => (
              <div key={`${event.timestamp}-${index}`} className="event-item">
                <span className="event-name">{event.event}</span>
                <span className="event-time">
                  {new Date(event.timestamp).toLocaleTimeString()}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
