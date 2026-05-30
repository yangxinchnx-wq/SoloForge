// ─────────────────────────────────────────────────────────────────
// SoloForge Main App Component
// 主应用组件
// ─────────────────────────────────────────────────────────────────

import React, { useState } from 'react';
import { Dashboard } from './components/Dashboard';
import { DatabasePanel } from './components/DatabasePanel';
import { SchedulerPanel } from './components/SchedulerPanel';
import { EventsPanel } from './components/EventsPanel';
import { NavigationIcon } from '../../components/navigation-icon';

interface AppProps {
  hasElectron: boolean;
}

type View = 'dashboard' | 'database' | 'scheduler' | 'events';

const NAV_ITEMS: { key: View; label: string; icon: string }[] = [
  { key: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
  { key: 'database', label: 'Database', icon: 'database' },
  { key: 'scheduler', label: 'Scheduler', icon: 'scheduler' },
  { key: 'events', label: 'Events', icon: 'events' },
];

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
            {NAV_ITEMS.map((item) => (
              <li
                key={item.key}
                className={currentView === item.key ? 'active' : ''}
                onClick={() => setCurrentView(item.key)}
              >
                <NavigationIcon name={item.icon} size={18} />
                {item.label}
              </li>
            ))}
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

export default App;
