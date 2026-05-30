// ─────────────────────────────────────────────────────────────────
// SoloForge Events Panel Component
// 事件监控面板
// ─────────────────────────────────────────────────────────────────

import React, { useEffect, useState } from 'react';
import { StatusIcon } from '../../components/status-icon';
import type { KernelEvent } from '../types';

export function EventsPanel() {
  const [events, setEvents] = useState<KernelEvent[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!window.soloforge) return;

    setConnected(true);

    // 订阅实时事件
    const unsubscribe = window.soloforge.events.onEvent((event) => {
      setEvents((prev) => [...prev.slice(-99), event]);
    });

    // 初始加载
    window.soloforge.kernel.getEvents(50).then((e) => {
      setEvents(e.reverse());
    });

    return () => unsubscribe();
  }, []);

  return (
    <div className="dashboard">
      <h1>Event Monitor</h1>

      <div className="card">
        <h3>Real-time Events</h3>
        <div style={{ marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <StatusIcon status={connected ? 'online' : 'offline'} size={16} />
          <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
            {connected ? 'Connected - Listening for events' : 'Disconnected'}
          </span>
        </div>
        <div className="events">
          {events.length === 0 ? (
            <div className="empty">Waiting for events...</div>
          ) : (
            events.map((event, index) => (
              <div key={`${event.timestamp}-${index}`} className="event-item">
                <span className="event-name">{event.event}</span>
                <span style={{ color: 'var(--text-secondary)', fontSize: '11px', marginLeft: '8px' }}>
                  {JSON.stringify(event.payload).slice(0, 50)}
                  {JSON.stringify(event.payload).length > 50 && '...'}
                </span>
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

export default EventsPanel;
