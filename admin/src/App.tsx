import React, { useState, useEffect } from 'react';
import { LoginPage } from './pages/Login';
import { DashboardPage } from './pages/Dashboard';
import { AgentsPage } from './pages/Agents';
import { RequestLogPage } from './pages/RequestLog';
import { CalibrationPage } from './pages/Calibration';
import { JobsWatchPage } from './pages/JobsWatch';
import { OAuthConsentPage } from './pages/OAuthConsent';
import { pendingOAuthRequest } from './lib/oauth-request';
import { api } from './api';
import { ThemeToggle } from './components/ThemeToggle';

type Page = 'login' | 'dashboard' | 'agents' | 'log' | 'calibration' | 'jobs' | 'oauth-consent';

function getPage(): Page {
  const hash = window.location.hash.replace('#', '') || 'dashboard';
  if (pendingOAuthRequest() && hash === 'dashboard') return 'oauth-consent';
  if (['login', 'dashboard', 'agents', 'log', 'calibration', 'jobs', 'oauth-consent'].includes(hash)) return hash as Page;
  return 'dashboard';
}

export function App() {
  const [page, setPage] = useState<Page>(getPage);

  useEffect(() => {
    const onHash = () => setPage(getPage());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const navigate = (p: Page) => {
    window.location.hash = p;
    setPage(p);
  };

  if (page === 'login') {
    return <><div className="login-theme"><ThemeToggle /></div><LoginPage onLogin={() => navigate(pendingOAuthRequest() ? 'oauth-consent' : 'dashboard')} /></>;
  }

  const handleSignOutEverywhere = async () => {
    if (!confirm('Sign out every active admin session, including other browsers and tabs? Each one will need to re-authenticate via a fresh magic link.')) {
      return;
    }
    try {
      await api.signOutEverywhere();
    } catch {
      // Even if the call fails, push to login — cookie is likely already invalid.
    }
    navigate('login');
  };

  return (
    <div className="app">
      <a className="skip-link" href="#main-content" onClick={event => { event.preventDefault(); document.getElementById('main-content')?.focus(); }}>Skip to main content</a>
      <nav className="sidebar" aria-label="Team brain">
        <div className="sidebar-logo"><img src="/admin/brand/logo-black.png" className="logo-light" alt="" /><img src="/admin/brand/logo-white.png" className="logo-dark" alt="" /><div>ActVox<small>Team brain · GBrain</small></div></div>
        <div className="sidebar-nav">
          <a href="#dashboard" aria-current={page === 'dashboard' ? 'page' : undefined} className={`nav-item ${page === 'dashboard' ? 'active' : ''}`}
             onClick={() => navigate('dashboard')}>Dashboard</a>
          <a href="#agents" aria-current={page === 'agents' ? 'page' : undefined} className={`nav-item ${page === 'agents' ? 'active' : ''}`}
             onClick={() => navigate('agents')}>Agents</a>
          <a href="#log" aria-current={page === 'log' ? 'page' : undefined} className={`nav-item ${page === 'log' ? 'active' : ''}`}
             onClick={() => navigate('log')}>Request Log</a>
          <a href="#calibration" aria-current={page === 'calibration' ? 'page' : undefined} className={`nav-item ${page === 'calibration' ? 'active' : ''}`}
             onClick={() => navigate('calibration')}>Calibration</a>
          <a href="#jobs" aria-current={page === 'jobs' ? 'page' : undefined} className={`nav-item ${page === 'jobs' ? 'active' : ''}`}
             onClick={() => navigate('jobs')}>Jobs Watch</a>
        </div>
        <div style={{ marginTop: 'auto', padding: '16px 12px', borderTop: '1px solid var(--border)' }}>
          <div className="theme-control"><ThemeToggle /></div>
          <button
            onClick={handleSignOutEverywhere}
            style={{
              background: 'transparent',
              border: '1px solid var(--border)',
              color: 'var(--text-secondary)',
              padding: '6px 10px',
              borderRadius: 6,
              fontSize: 12,
              cursor: 'pointer',
              width: '100%',
            }}
            title="Revoke every active admin session — every browser, every tab"
          >
            Sign out everywhere
          </button>
        </div>
      </nav>
      <main className="main" id="main-content" tabIndex={-1}>
        {page === 'dashboard' && <DashboardPage />}
        {page === 'agents' && <AgentsPage />}
        {page === 'log' && <RequestLogPage />}
        {page === 'calibration' && <CalibrationPage />}
        {page === 'jobs' && <JobsWatchPage />}
        {page === 'oauth-consent' && <OAuthConsentPage />}
      </main>
    </div>
  );
}
