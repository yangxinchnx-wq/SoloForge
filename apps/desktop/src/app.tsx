// ─────────────────────────────────────────────────────────────────
// SoloForge Main App Component
// ─────────────────────────────────────────────────────────────────

import React, { useState } from 'react';
import { Dashboard } from './components/Dashboard';

interface AppProps {
  hasElectron: boolean;
}

type View = 'dashboard' | 'database' | 'scheduler' | 'events';

export function App({ hasElectron }: AppProps) {
  const [currentView, setCurrentView] = useState<View>('dashboard');

  const renderContent = () => {
    switch (currentView) {
      case 'dashboard':
        return <Dashboard />;
      case 'database':
        return <DatabasePanel />;
      case 'scheduler':
        return <SchedulerPanel />;
      case 'events':
        return <EventsPanel />;
      default:
        return <Dashboard />;
    }
  };

  return (
    <div className="app">
      {/* Standalone Mode Banner */}
      {!hasElectron && (
        <div className="standalone-banner">
          ⚠️ Running in standalone mode - Electron API not available
        </div>
      )}

      {/* Header */}
      <header className="app-header">
        <h1>⚡ SoloForge</h1>
        <span className={`status-badge ${hasElectron ? 'healthy' : 'loading'}`}>
          {hasElectron ? 'Connected' : 'Standalone'}
        </span>
        <span style={{ marginLeft: 'auto', color: 'var(--text-secondary)', fontSize: '13px' }}>
          AI Multi-Agent Autonomous System
        </span>
      </header>

      {/* Main Content */}
      <div className="app-content">
        {/* Sidebar */}
        <nav className="sidebar">
          <ul className="sidebar-nav">
            <li
              className={currentView === 'dashboard' ? 'active' : ''}
              onClick={() => setCurrentView('dashboard')}
            >
              📊 Dashboard
            </li>
            <li
              className={currentView === 'database' ? 'active' : ''}
              onClick={() => setCurrentView('database')}
            >
              🗄️ Database
            </li>
            <li
              className={currentView === 'scheduler' ? 'active' : ''}
              onClick={() => setCurrentView('scheduler')}
            >
              ⚙️ Scheduler
            </li>
            <li
              className={currentView === 'events' ? 'active' : ''}
              onClick={() => setCurrentView('events')}
            >
              📡 Events
            </li>
          </ul>
        </nav>

        {/* Main Panel */}
        <main className="main-panel">
          {renderContent()}
        </main>
      </div>
    </div>
  );
}

// Placeholder components for other panels
function DatabasePanel() {
  const [query, setQuery] = useState('SELECT * FROM migration_history LIMIT 10');
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const executeQuery = async () => {
    if (!window.soloforge) {
      alert('Electron API not available');
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
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{
            width: '100%',
            minHeight: '80px',
            background: 'var(--bg-tertiary)',
            border: '1px solid var(--border-color)',
            borderRadius: '6px',
            padding: '12px',
            color: 'var(--text-primary)',
            fontFamily: 'var(--font-mono)',
            fontSize: '13px',
            resize: 'vertical'
          }}
        />
        <button
          onClick={executeQuery}
          disabled={loading}
          style={{
            marginTop: '12px',
            padding: '8px 20px',
            background: 'var(--accent-blue)',
            color: 'white',
            border: 'none',
            borderRadius: '6px',
            cursor: loading ? 'not-allowed' : 'pointer',
            opacity: loading ? 0.6 : 1
          }}
        >
          {loading ? 'Executing...' : 'Execute Query'}
        </button>
      </div>

      {result && (
        <div className="card">
          <h3>Result</h3>
          <pre style={{
            background: 'var(--bg-tertiary)',
            padding: '16px',
            borderRadius: '6px',
            overflow: 'auto',
            fontSize: '12px',
            fontFamily: 'var(--font-mono)'
          }}>
            {JSON.stringify(result, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

function SchedulerPanel() {
  const [stats, setStats] = useState<any>(null);

  React.useEffect(() => {
    if (!window.soloforge) return;
    const fetchStats = async () => {
      try {
        const s = await window.soloforge.scheduler.getStats();
        setStats(s);
      } catch (e) {
        console.error(e);
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
        {stats ? (
          <div>
            <div className="status-value">
              <span className="label">Mode</span>
              <span>{stats.mode}</span>
            </div>
            <div className="status-value">
              <span className="label">Queue Size</span>
              <span>{stats.queueSize ?? 'N/A'}</span>
            </div>
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
          <div className="empty">Loading...</div>
        )}
      </div>
    </div>
  );
}

function EventsPanel() {
  const [events, setEvents] = useState<any[]>([]);

  React.useEffect(() => {
    if (!window.soloforge) return;

    const unsubscribe = window.soloforge.events.onEvent((event) => {
      setEvents((prev) => [...prev.slice(-99), event]);
    });

    // Initial load
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
        <div className="events">
          {events.length === 0 ? (
            <div className="empty">Waiting for events...</div>
          ) : (
            events.map((event, index) => (
              <div key={`${event.timestamp}-${index}`} className="event-item">
                <span className="event-name">{event.event}</span>
                <span style={{ color: 'var(--text-secondary)', fontSize: '11px', marginLeft: '8px' }}>
                  {JSON.stringify(event.payload).slice(0, 50)}...
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
