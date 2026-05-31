// ─────────────────────────────────────────────────────────────────
// SoloForge Observation Panel
// 文明演化观测面板 - 占位组件
// ─────────────────────────────────────────────────────────────────

import React, { useState, useEffect } from 'react';

interface ObservationData {
  cycleId: number;
  timestamp: string;
  entropy: number;
  interventions: number;
  courtCases: number;
  coalitions: number;
}

export function ObservationPanel() {
  const [isObserving, setIsObserving] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<string>('未启动');
  const [observations, setObservations] = useState<ObservationData[]>([]);

  // 占位数据
  const placeholderData: ObservationData[] = [
    { cycleId: 1, timestamp: '2026-05-31 00:00', entropy: 0.32, interventions: 0, courtCases: 0, coalitions: 2 },
    { cycleId: 2, timestamp: '2026-05-31 01:00', entropy: 0.45, interventions: 1, courtCases: 3, coalitions: 3 },
    { cycleId: 3, timestamp: '2026-05-31 02:00', entropy: 0.68, interventions: 2, courtCases: 7, coalitions: 2 },
  ];

  useEffect(() => {
    // TODO: 连接运行中的 kernel 获取实时数据
    setObservations(placeholderData);
  }, []);

  const handleStartObservation = () => {
    setIsObserving(true);
    setLastUpdate(new Date().toISOString());
    // TODO: 启动 npm run start:observe
  };

  const handleStopObservation = () => {
    setIsObserving(false);
    // TODO: 停止观察脚本
  };

  const getEntropyStatus = (entropy: number): { color: string; label: string } => {
    if (entropy < 0.3) return { color: '#22c55e', label: '高度有序' };
    if (entropy < 0.6) return { color: '#3b82f6', label: '正常运行' };
    if (entropy < 0.85) return { color: '#f59e0b', label: '压力预警' };
    return { color: '#ef4444', label: '危机告警' };
  };

  return (
    <div className="observation-panel">
      {/* Header */}
      <div className="panel-header">
        <h2>🪐 文明演化观测</h2>
        <div className="header-actions">
          {isObserving ? (
            <button className="btn-stop" onClick={handleStopObservation}>
              ⏹️ 停止观测
            </button>
          ) : (
            <button className="btn-start" onClick={handleStartObservation}>
              ▶️ 开始观测
            </button>
          )}
        </div>
      </div>

      {/* Status Bar */}
      <div className="status-bar">
        <div className="status-item">
          <span className="status-label">观测状态</span>
          <span className={`status-value ${isObserving ? 'active' : 'inactive'}`}>
            {isObserving ? '🟢 运行中' : '⚪ 已停止'}
          </span>
        </div>
        <div className="status-item">
          <span className="status-label">最后更新</span>
          <span className="status-value">{lastUpdate}</span>
        </div>
        <div className="status-item">
          <span className="status-label">观测周期</span>
          <span className="status-value">{observations.length} 次</span>
        </div>
      </div>

      {/* Entropy Gauge */}
      <div className="entropy-section">
        <h3>🌡️ 系统熵值</h3>
        <div className="entropy-gauge">
          <div className="gauge-track">
            <div
              className="gauge-fill"
              style={{
                width: `${Math.min((observations[observations.length - 1]?.entropy || 0.5) * 100, 100)}%`,
                backgroundColor: getEntropyStatus(observations[observations.length - 1]?.entropy || 0.5).color
              }}
            />
          </div>
          <div className="gauge-labels">
            <span>0</span>
            <span>0.5</span>
            <span>1.0</span>
          </div>
          <div className="gauge-value">
            当前: {observations[observations.length - 1]?.entropy?.toFixed(4) || '-.----'}
          </div>
        </div>
        <div className="entropy-legend">
          <span style={{ color: '#22c55e' }}>● 高度有序</span>
          <span style={{ color: '#3b82f6' }}>● 正常运行</span>
          <span style={{ color: '#f59e0b' }}>● 压力预警</span>
          <span style={{ color: '#ef4444' }}>● 危机告警</span>
        </div>
      </div>

      {/* Metrics Grid */}
      <div className="metrics-section">
        <h3>📊 治理指标</h3>
        <div className="metrics-grid">
          <div className="metric-card">
            <span className="metric-icon">🏛️</span>
            <span className="metric-value">{observations[observations.length - 1]?.interventions || 0}</span>
            <span className="metric-label">干预总数</span>
          </div>
          <div className="metric-card">
            <span className="metric-icon">⚖️</span>
            <span className="metric-value">{observations[observations.length - 1]?.courtCases || 0}</span>
            <span className="metric-label">司法案件</span>
          </div>
          <div className="metric-card">
            <span className="metric-icon">🤝</span>
            <span className="metric-value">{observations[observations.length - 1]?.coalitions || 0}</span>
            <span className="metric-label">联盟形成</span>
          </div>
        </div>
      </div>

      {/* Timeline */}
      <div className="timeline-section">
        <h3>📜 演化时间线</h3>
        <div className="timeline">
          {observations.map((obs, idx) => {
            const status = getEntropyStatus(obs.entropy);
            return (
              <div key={idx} className="timeline-item">
                <div className="timeline-marker" style={{ backgroundColor: status.color }} />
                <div className="timeline-content">
                  <div className="timeline-header">
                    <span className="timeline-cycle">Cycle {obs.cycleId}</span>
                    <span className="timeline-time">{obs.timestamp}</span>
                  </div>
                  <div className="timeline-stats">
                    <span style={{ color: status.color }}>🌡️ {obs.entropy.toFixed(4)}</span>
                    <span>🏛️ {obs.interventions}</span>
                    <span>⚖️ {obs.courtCases}</span>
                    <span>🤝 {obs.coalitions}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Placeholder Notice */}
      <div className="placeholder-notice">
        <p>📌 <strong>占位组件</strong> - 当前显示模拟数据</p>
        <p>启动 <code>npm run start:observe</code> 后将显示实时数据</p>
      </div>

      <style>{`
        .observation-panel {
          padding: 20px;
          height: 100%;
          overflow-y: auto;
        }

        .panel-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 20px;
        }

        .panel-header h2 {
          margin: 0;
          font-size: 20px;
        }

        .btn-start, .btn-stop {
          padding: 8px 16px;
          border: none;
          border-radius: 6px;
          cursor: pointer;
          font-weight: 500;
        }

        .btn-start {
          background: #22c55e;
          color: white;
        }

        .btn-stop {
          background: #ef4444;
          color: white;
        }

        .status-bar {
          display: flex;
          gap: 24px;
          padding: 12px 16px;
          background: var(--bg-secondary);
          border-radius: 8px;
          margin-bottom: 24px;
        }

        .status-item {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .status-label {
          font-size: 12px;
          color: var(--text-secondary);
        }

        .status-value {
          font-size: 14px;
          font-weight: 500;
        }

        .status-value.active {
          color: #22c55e;
        }

        .status-value.inactive {
          color: #6b7280;
        }

        .entropy-section, .metrics-section, .timeline-section {
          margin-bottom: 24px;
        }

        .entropy-section h3, .metrics-section h3, .timeline-section h3 {
          font-size: 16px;
          margin-bottom: 12px;
          color: var(--text-primary);
        }

        .entropy-gauge {
          background: var(--bg-secondary);
          padding: 16px;
          border-radius: 8px;
        }

        .gauge-track {
          height: 24px;
          background: linear-gradient(to right, #22c55e 0%, #3b82f6 50%, #f59e0b 75%, #ef4444 100%);
          border-radius: 12px;
          position: relative;
        }

        .gauge-fill {
          height: 100%;
          border-radius: 12px;
          transition: width 0.3s ease;
        }

        .gauge-labels {
          display: flex;
          justify-content: space-between;
          margin-top: 8px;
          font-size: 12px;
          color: var(--text-secondary);
        }

        .gauge-value {
          margin-top: 8px;
          font-size: 18px;
          font-weight: 500;
          text-align: center;
        }

        .entropy-legend {
          display: flex;
          gap: 16px;
          margin-top: 12px;
          font-size: 12px;
          flex-wrap: wrap;
        }

        .metrics-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 16px;
        }

        .metric-card {
          background: var(--bg-secondary);
          padding: 20px;
          border-radius: 8px;
          text-align: center;
        }

        .metric-icon {
          font-size: 24px;
          display: block;
          margin-bottom: 8px;
        }

        .metric-value {
          font-size: 28px;
          font-weight: 600;
          display: block;
        }

        .metric-label {
          font-size: 12px;
          color: var(--text-secondary);
        }

        .timeline {
          position: relative;
          padding-left: 24px;
        }

        .timeline::before {
          content: '';
          position: absolute;
          left: 8px;
          top: 0;
          bottom: 0;
          width: 2px;
          background: var(--border-color);
        }

        .timeline-item {
          position: relative;
          margin-bottom: 16px;
        }

        .timeline-marker {
          position: absolute;
          left: -20px;
          top: 4px;
          width: 12px;
          height: 12px;
          border-radius: 50%;
        }

        .timeline-content {
          background: var(--bg-secondary);
          padding: 12px 16px;
          border-radius: 8px;
        }

        .timeline-header {
          display: flex;
          justify-content: space-between;
          margin-bottom: 8px;
        }

        .timeline-cycle {
          font-weight: 500;
        }

        .timeline-time {
          font-size: 12px;
          color: var(--text-secondary);
        }

        .timeline-stats {
          display: flex;
          gap: 16px;
          font-size: 12px;
        }

        .placeholder-notice {
          margin-top: 24px;
          padding: 16px;
          background: var(--bg-secondary);
          border-left: 4px solid #f59e0b;
          border-radius: 4px;
          font-size: 13px;
          color: var(--text-secondary);
        }

        .placeholder-notice code {
          background: var(--bg-tertiary);
          padding: 2px 6px;
          border-radius: 4px;
          font-size: 12px;
        }
      `}</style>
    </div>
  );
}
