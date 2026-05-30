// ─────────────────────────────────────────────────────────────────
// SoloForge Database Panel Component
// 数据库面板
// ─────────────────────────────────────────────────────────────────

import React, { useState } from 'react';
import { ActionIcon } from '../../components/action-icon';

export function DatabasePanel() {
  const [query, setQuery] = useState('SELECT * FROM migration_history LIMIT 10');
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const executeQuery = async () => {
    if (!window.soloforge) {
      setResult({ error: 'Electron API not available' });
      return;
    }
    setLoading(true);
    try {
      const res = await window.soloforge.db.query(query);
      setResult(res);
    } catch (e) {
      setResult({ error: (e as Error).message });
    }
    setLoading(false);
  };

  return (
    <div className="dashboard">
      <h1>Database Explorer</h1>

      <div className="card">
        <h3>Query Editor</h3>
        <textarea
          className="textarea"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ minHeight: '120px' }}
        />
        <div style={{ marginTop: '12px', display: 'flex', gap: '8px' }}>
          <button
            className="btn btn-primary"
            onClick={executeQuery}
            disabled={loading}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <ActionIcon action="play" size={16} />
              {loading ? 'Executing...' : 'Execute Query'}
            </span>
          </button>
        </div>
      </div>

      {result && (
        <div className="card">
          <h3>Result</h3>
          {result.error ? (
            <div className="error" style={{ whiteSpace: 'pre-wrap' }}>
              {result.error}
            </div>
          ) : (
            <pre style={{
              background: 'var(--bg-tertiary)',
              padding: '16px',
              borderRadius: '6px',
              overflow: 'auto',
              fontSize: '12px',
              fontFamily: 'var(--font-mono)',
              maxHeight: '400px'
            }}>
              {JSON.stringify(result.data || result, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export default DatabasePanel;
