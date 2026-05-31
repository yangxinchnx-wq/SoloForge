// ─────────────────────────────────────────────────────────────────
// SoloForge Governance Nexus Dashboard Component
// 治理监控大盘组件 - Phase 5+ Observability
// ─────────────────────────────────────────────────────────────────

import React, { useEffect, useState, useCallback } from 'react';
import { StatusIcon } from '../../components/status-icon';
import type { KernelStatus, HealthStatus, KernelEvent } from '../types';

interface PrometheusMetrics {
  entropy: number;
  courtEscalations: number;
  liveMigrations: number;
  reputationSuccess: number;
  lawViolations: number;
  raftApplied: number;
  ipcFrames: number;
  kernelVersion: number;
}

export function Dashboard() {
  const [status, setStatus] = useState<KernelStatus | null>(null);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [events, setEvents] = useState<KernelEvent[]>([]);
  const [subscribedEvents, setSubscribedEvents] = useState<string[]>([]);
  const [metrics, setMetrics] = useState<PrometheusMetrics | null>(null);
  const [metricsError, setMetricsError] = useState<string | null>(null);

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

  // 获取 Prometheus 指标
  const fetchMetrics = useCallback(async () => {
    try {
      const response = await fetch('http://localhost:9090/metrics');
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const text = await response.text();
      const parsed = parsePrometheusMetrics(text);
      setMetrics(parsed);
      setMetricsError(null);
    } catch (e: any) {
      setMetricsError(e.message || 'Failed to fetch metrics');
    }
  }, []);

  // 解析 Prometheus 文本格式指标
  const parsePrometheusMetrics = (text: string): PrometheusMetrics => {
    const result: PrometheusMetrics = {
      entropy: 0,
      courtEscalations: 0,
      liveMigrations: 0,
      reputationSuccess: 0,
      lawViolations: 0,
      raftApplied: 0,
      ipcFrames: 0,
      kernelVersion: 0
    };

    const lines = text.split('\n');
    for (const line of lines) {
      if (line.startsWith('soloforge_cluster_system_entropy{')) {
        const match = line.match(/soloforge_cluster_system_entropy\{[^}]*\}\s+([\d.]+)/);
        if (match) result.entropy = parseFloat(match[1]);
      } else if (line.startsWith('soloforge_court_llm_escalations_total{')) {
        const match = line.match(/soloforge_court_llm_escalations_total\{[^}]*\}\s+([\d.]+)/);
        if (match) result.courtEscalations = parseInt(match[1]);
      } else if (line.startsWith('soloforge_sandbox_live_migrations_total{')) {
        const match = line.match(/soloforge_sandbox_live_migrations_total\{[^}]*\}\s+([\d.]+)/);
        if (match) result.liveMigrations = parseInt(match[1]);
      } else if (line.startsWith('soloforge_reputation_success_total{')) {
        const match = line.match(/soloforge_reputation_success_total\{[^}]*\}\s+([\d.]+)/);
        if (match) result.reputationSuccess = parseInt(match[1]);
      } else if (line.startsWith('soloforge_law_violations_intercepted{')) {
        const match = line.match(/soloforge_law_violations_intercepted\{[^}]*\}\s+([\d.]+)/);
        if (match) result.lawViolations = parseInt(match[1]);
      } else if (line.startsWith('soloforge_kernel_version_stamp{')) {
        const match = line.match(/soloforge_kernel_version_stamp\{[^}]*\}\s+([\d.]+)/);
        if (match) result.kernelVersion = parseInt(match[1]);
      } else if (line.startsWith('soloforge_ipc_frames_sent_total{')) {
        const match = line.match(/soloforge_ipc_frames_sent_total\{[^}]*\}\s+([\d.]+)/);
        if (match) result.ipcFrames = parseInt(match[1]);
      }
    }
    return result;
  };

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
    fetchMetrics();

    // 定期刷新 (2秒)
    const interval = setInterval(() => {
      fetchStatus();
      fetchHealth();
      fetchMetrics();
    }, 2000);

    return () => {
      unsubscribe();
      clearInterval(interval);
    };
  }, [fetchStatus, fetchHealth, fetchEvents, fetchSubscribedEvents, fetchMetrics]);

  // 判断熵值健康度
  const getEntropyStatus = (entropy: number): 'healthy' | 'warning' | 'critical' => {
    if (entropy > 0.85) return 'critical';
    if (entropy > 0.6) return 'warning';
    return 'healthy';
  };

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <h1>SoloForge Governance Nexus 🪐</h1>
        <span className="version-tag">v3.0 Production Frozen</span>
      </header>

      {/* Prometheus 指标监控面板 */}
      <section className="metrics-panel">
        <h2>🛰️ Prometheus Metrics Dashboard</h2>
        {metricsError ? (
          <div className="metrics-error">
            ⚠️ Metrics endpoint unavailable: {metricsError}
          </div>
        ) : metrics ? (
          <div className="metrics-grid">
            {/* 系统熵值 */}
            <div className={`metric-card ${getEntropyStatus(metrics.entropy)}`}>
              <h3>System Entropy</h3>
              <div className="metric-value large">{metrics.entropy.toFixed(4)}</div>
              <div className="metric-label">Cluster-Wide Load Factor</div>
              <div className="metric-threshold">
                {metrics.entropy > 0.85 ? '🚨 CRITICAL' : metrics.entropy > 0.6 ? '⚠️ WARNING' : '✅ HEALTHY'}
              </div>
            </div>

            {/* 司法升级 */}
            <div className="metric-card">
              <h3>Court Escalations</h3>
              <div className="metric-value">{metrics.courtEscalations}</div>
              <div className="metric-label">LLM Adjudication Total</div>
            </div>

            {/* 沙箱迁移 */}
            <div className="metric-card">
              <h3>Sandbox Migrations</h3>
              <div className="metric-value">{metrics.liveMigrations}</div>
              <div className="metric-label">Live Evacuations</div>
            </div>

            {/* 信誉成功 */}
            <div className="metric-card">
              <h3>Reputation Success</h3>
              <div className="metric-value">{metrics.reputationSuccess}</div>
              <div className="metric-label">Trust Updates Committed</div>
            </div>

            {/* 法律拦截 */}
            <div className="metric-card">
              <h3>Law Violations</h3>
              <div className="metric-value">{metrics.lawViolations}</div>
              <div className="metric-label">Security Breaches Blocked</div>
            </div>

            {/* 内核版本 */}
            <div className="metric-card">
              <h3>Kernel Version</h3>
              <div className="metric-value mono">{metrics.kernelVersion}</div>
              <div className="metric-label">Causal Sequence Stamp</div>
            </div>

            {/* IPC 帧数 */}
            <div className="metric-card">
              <h3>IPC Frames</h3>
              <div className="metric-value">{metrics.ipcFrames}</div>
              <div className="metric-label">Python Universe Messages</div>
            </div>
          </div>
        ) : (
          <div className="metrics-loading">Loading metrics...</div>
        )}
      </section>

      {/* 状态卡片 */}
      <div className="status-cards">
        <div className="card">
          <h3>Runtime Status</h3>
          <div className="status-value">
            <span className="label">State:</span>
            <span className={status?.state?.toLowerCase()}>
              {status?.state || 'Loading...'}
            </span>
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
            {health?.healthy ? (
              <>
                <StatusIcon status="success" size={20} />
                <span>Healthy</span>
              </>
            ) : (
              <>
                <StatusIcon status="error" size={20} />
                <span>Unhealthy</span>
              </>
            )}
          </div>
          {health?.error && <div className="error">{health.error}</div>}
        </div>

        <div className="card">
          <h3>Event Subscriptions</h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            {subscribedEvents.length === 0 ? (
              <span style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>No subscriptions</span>
            ) : (
              subscribedEvents.map((event) => (
                <span key={event} style={{
                  padding: '4px 8px',
                  background: 'var(--bg-tertiary)',
                  borderRadius: '4px',
                  fontSize: '11px',
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--text-secondary)'
                }}>
                  {event}
                </span>
              ))
            )}
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

      <footer className="dashboard-footer">
        <p>Status: PRODUCTION_FROZEN | Baseline: v3.0 | Causality Integrity: 100%</p>
        <p>Metrics Endpoint: <a href="http://localhost:9090/metrics" target="_blank">http://localhost:9090/metrics</a></p>
      </footer>
    </div>
  );
}

export default Dashboard;
