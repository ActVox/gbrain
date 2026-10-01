import React, { useState, useEffect } from 'react';
import { api } from '../api';
import { Dialog } from '../components/Dialog';

interface FeedEvent {
  agent: string; operation: string; scopes: string; latency_ms: number; status: string; timestamp: string;
}
interface Snapshot {
  stats: { connected_agents: number; requests_today: number; active_tokens: number };
  health: { expiring_soon: number; error_rate: string };
  at: Date;
}

export function DashboardPage() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [sseStatus, setSseStatus] = useState('Connecting');
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [detail, setDetail] = useState<FeedEvent | null>(null);

  useEffect(() => {
    let active = true;
    let pending = false;
    async function refresh() {
      if (pending) return;
      pending = true;
      try {
        const [stats, health] = await Promise.all([api.stats(), api.health()]);
        if (active) { setSnapshot({ stats, health, at: new Date() }); setFailed(false); }
      } catch { if (active) setFailed(true); }
      finally { pending = false; }
    }
    void refresh();
    const interval = setInterval(refresh, 30000);
    return () => { active = false; clearInterval(interval); };
  }, [retry]);

  useEffect(() => {
    setSseStatus('Connecting');
    const es = new EventSource('/admin/events', { withCredentials: true });
    es.onopen = () => setSseStatus('Connected');
    es.onmessage = e => {
      try {
        const event = JSON.parse(e.data) as FeedEvent;
        if (['agent', 'operation', 'scopes', 'status', 'timestamp'].every(key => typeof event[key as keyof FeedEvent] === 'string') && Number.isFinite(event.latency_ms)) {
          setEvents(previous => [event, ...previous].slice(0, 50));
        }
      } catch { /* Ignore malformed frames without interrupting subsequent events. */ }
    };
    // An open EventSource owns its retry lifecycle. Closing on error disables it.
    es.onerror = () => setSseStatus(es.readyState === EventSource.CLOSED ? 'Disconnected' : 'Reconnecting');
    return () => { es.onopen = null; es.onmessage = null; es.onerror = null; es.close(); };
  }, [retry]);

  const successful = (event: FeedEvent) => ['success', 'success_with_warnings'].includes(event.status);
  const visible = events.filter(event => (filter === 'all' || (filter === 'success' ? successful(event) : !successful(event)))
    && `${event.agent} ${event.operation}`.toLowerCase().includes(query.trim().toLowerCase()));
  const timeAgo = (timestamp: string) => {
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000));
    if (!Number.isFinite(seconds)) return 'Time unavailable';
    return seconds < 60 ? `${seconds}s ago` : seconds < 3600 ? `${Math.floor(seconds / 60)} min ago` : `${Math.floor(seconds / 3600)}h ago`;
  };

  return <>
    <header className="dashboard-heading"><div><p className="eyebrow">ACTVOX / TEAM BRAIN</p><h1 className="page-title">Dashboard</h1><p className="muted">Shared memory, agent access and request activity.</p></div><button className="btn btn-secondary" onClick={() => setRetry(value => value + 1)}>Refresh</button></header>
    <p className="data-freshness" role="status">{failed ? snapshot ? 'Updates unavailable. Showing the last successful snapshot.' : 'Dashboard data unavailable. Retry with Refresh.' : snapshot ? `Updated ${snapshot.at.toLocaleTimeString()} · Refreshes every 30 seconds` : 'Loading dashboard data…'}</p>
    <div className="metrics dashboard-metrics" aria-label="Brain metrics">
      {[
        ['Registered clients', snapshot?.stats.connected_agents, 'OAuth registrations, not live connections'],
        ['Requests · last 24h', snapshot?.stats.requests_today, 'Rolling request count'],
        ['Unexpired access tokens', snapshot?.stats.active_tokens, 'Tokens currently within their lifetime'],
        ['Errors · last 24h', snapshot?.health.error_rate, 'Share of logged requests'],
      ].map(([label, value, help]) => <div className="metric" key={label}><div className="metric-label">{label}</div><div className="metric-value">{value ?? '—'}</div><p className="metric-help">{help}</p></div>)}
    </div>
    <div className="attention-panel"><div><strong>Token health</strong><p className="muted">{snapshot ? `${snapshot.health.expiring_soon} access tokens expire within 24 hours.` : 'Token expiry data is not available yet.'} Machine clients can renew automatically.</p></div><a className="btn btn-secondary" href="#agents">Review agents</a></div>
    <section aria-labelledby="activity-heading">
      <div className="activity-heading"><h2 id="activity-heading">Request activity</h2><span role="status" className={`stream-status ${sseStatus === 'Connected' ? 'is-connected' : ''}`}>{sseStatus}</span></div>
      <p className="muted activity-help">Latest 50 received events since this page was opened. <a href="#log">Open the request log</a> for history.</p>
      <div className="activity-controls"><div className="activity-filters" role="group" aria-label="Filter by result">{[['all', 'All'], ['error', 'Errors'], ['success', 'Successful']].map(([value, label]) => <button className="btn btn-secondary" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}</div><label className="activity-search">Find a request<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Agent or operation" /></label></div>
      <div className="feed" tabIndex={0} role="region" aria-label="Request activity table">
        {visible.length === 0 ? <div className="feed-empty">{events.length ? 'No matching requests. Clear the search or choose All.' : sseStatus === 'Connected' ? 'No events received yet. New requests will appear here.' : 'Activity is unavailable until the connection is restored.'}</div> : <table><caption className="sr-only">Latest received requests, newest first</caption><thead><tr>{['Agent', 'Operation', 'Scopes', 'Duration', 'Result', 'Time', 'Details'].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead><tbody>{visible.map((event, index) => <tr key={`${event.timestamp}-${index}`}>
          <td className="mono">{event.agent}</td><td className="mono">{event.operation}</td><td className="muted">{event.scopes.split(',').join(' · ')}</td><td className="mono">{event.latency_ms} ms</td><td><span className={`badge badge-${successful(event) ? 'success' : 'error'}`}>{event.status}</span></td><td className="muted"><time dateTime={event.timestamp}>{timeAgo(event.timestamp)}</time></td><td><button className="btn btn-secondary" aria-label={`Details for ${event.operation} from ${event.agent}`} onClick={() => setDetail(event)}>View</button></td>
        </tr>)}</tbody></table>}
      </div>
      <p className="data-freshness">Showing {visible.length} of {events.length} received events · Newest first</p>
    </section>
    {detail && <Dialog title="Request details" titleId="request-detail-title" onClose={() => setDetail(null)}><dl className="request-details">{[['Agent', detail.agent], ['Operation', detail.operation], ['Scopes', detail.scopes], ['Duration', `${detail.latency_ms} ms`], ['Result', detail.status], ['Time', detail.timestamp]].map(([label, value]) => <React.Fragment key={label}><dt>{label}</dt><dd className="mono">{value}</dd></React.Fragment>)}</dl><p className="muted">{!successful(detail) ? 'This event does not include an error message. The result alone does not identify the cause.' : 'This request completed successfully.'}</p></Dialog>}
  </>;
}
