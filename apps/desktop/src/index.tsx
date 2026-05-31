// SoloForge Frontend Entry
import React from 'react';
import ReactDOM from 'react-dom/client';

function App() {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100vh',
      fontFamily: 'system-ui, sans-serif',
      backgroundColor: '#1a1a2e',
      color: '#eee'
    }}>
      <h1 style={{ fontSize: '2.5rem', marginBottom: '1rem' }}>
        SoloForge
      </h1>
      <p style={{ fontSize: '1.2rem', opacity: 0.8 }}>
        AI Multi-Agent Autonomous System
      </p>
      <div style={{ marginTop: '2rem', padding: '1.5rem', backgroundColor: '#16213e', borderRadius: '8px' }}>
        <h2 style={{ fontSize: '1rem', marginBottom: '0.5rem' }}>System Status</h2>
        <div style={{ display: 'grid', gap: '0.5rem', fontSize: '0.9rem' }}>
          <div>Kernel: <span style={{ color: '#4ade80' }}>READY</span></div>
          <div>Database: <span style={{ color: '#4ade80' }}>CONNECTED</span></div>
          <div>Mode: <span style={{ color: '#60a5fa' }}>NORMAL</span></div>
        </div>
      </div>
      <p style={{ marginTop: '2rem', fontSize: '0.8rem', opacity: 0.5 }}>
        Electron App • React 18
      </p>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
