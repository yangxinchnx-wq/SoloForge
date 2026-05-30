// ─────────────────────────────────────────────────────────────────
// SoloForge Scheduler Panel Component
// 调度器面板
// ─────────────────────────────────────────────────────────────────

import React, { useEffect, useState } from 'react';
import { StatusIcon } from '../../components/status-icon';
import type { SchedulerStats } from '../types';

export function SchedulerPanel() {
  const [stats, setStats] = useState<SchedulerStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!window.soloforge) {
      setLoading(false);
      return;
    }

    const fetchStats = async () => {
      try {
        const s = await window.soloforge.scheduler.getStats();
        setStats(s);
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    };

    fetchStats();
    const interval = setInterval(fetchStats, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="dashboard">
      <h1>Scheduler</h1>

      <div className="card">
        <h3>Rust Scheduler</h3>
        {loading ? (
          <div className="empty">
            <StatusIcon status="loading" size={24} />
            <span style={{ marginLeft: '8px' }}>Loading...</span>
          </div>
        ) : stats ? (
          <div>
            <div className="status-value">
              <span className="label">Mode</span>
              <span>{stats.mode}</span>
            </div>
            <div className="status-value">
              <span className="label">Queue Size</span>
              <span>{stats.queueSize ?? 'N/A'}</span>
            </div>
            {stats.error && (
              <div className="error" style={{ marginTop: '12px' }}>
                {stats.error}
              </div>
            )}
            {stats.stats && (
              <pre style={{
                marginTop: '12px',
                background: 'var(--bg-tertiary)',
                padding: '12px',
                borderRadius: '6px',
                fontSize: '11px',
                fontFamily: 'var(--font-mono)',
                overflow: 'auto'
              }}>
                {JSON.stringify(stats.stats, null, 2)}
              </pre>
            )}
          </div>
        ) : (
          <div className="empty">
            <StatusIcon status="warning" size={24} />
            <span style={{ marginLeft: '8px' }}>Scheduler not available</span>
          </div>
        )}
      </div>
    </div>
  );
}

export default SchedulerPanel;
