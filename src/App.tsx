import { useEffect, useMemo, useState } from 'react';
import TapTimer from './components/TapTimer';
import WaypointPicker from './components/WaypointPicker';
import SpeedCurveBuilder from './components/SpeedCurveBuilder';
import { createContextPusher } from './lib/contextSync';
import type { ProjectSettings, SpeedCurveState, TapState, ToolTab, Waypoint } from './types';

const pusher = createContextPusher(400);

export default function App() {
  const [tab, setTab] = useState<ToolTab>('waypoints');
  const [project, setProject] = useState<ProjectSettings>({ width: 1920, height: 1080, fps: 30 });
  const [waypoints, setWaypoints] = useState<Waypoint[]>([]);
  const [taps, setTaps] = useState<TapState>({ taps: [] });
  const [speedCurve, setSpeedCurve] = useState<SpeedCurveState>({
    duration: 1.5,
    bezier: [0.25, 0.1, 0.25, 1],
  });
  const [sync, setSync] = useState<'syncing' | 'saved' | 'error'>('saved');

  useEffect(() => pusher.onStatus(setSync), []);

  // Push every change to the backend so GET /api/context stays fresh for your agent.
  const ctxPatch = useMemo(
    () => ({ project, waypoints, taps, speedCurve }),
    [project, waypoints, taps, speedCurve],
  );
  useEffect(() => {
    pusher.push(ctxPatch);
  }, [ctxPatch]);

  return (
    <div className="shell">
      <header className="topbar">
        <div>
          <h1>remotion-helper</h1>
          <p className="dim">waypoints · tap timer · speed curves → Remotion snippets + agent API</p>
        </div>
        <div className="sync" data-state={sync} title="Backend sync status (POST /api/context)">
          <span className="dot" />
          {sync === 'saved' ? 'api synced' : sync === 'syncing' ? 'syncing…' : 'api offline'}
        </div>
      </header>

      <div className="projectbar">
        <label className="field">
          W
          <input
            type="number"
            value={project.width}
            onChange={(e) => setProject({ ...project, width: +e.target.value || 1920 })}
          />
        </label>
        <label className="field">
          H
          <input
            type="number"
            value={project.height}
            onChange={(e) => setProject({ ...project, height: +e.target.value || 1080 })}
          />
        </label>
        <label className="field">
          FPS
          <input
            type="number"
            value={project.fps}
            onChange={(e) => setProject({ ...project, fps: +e.target.value || 30 })}
          />
        </label>
        <code className="dim mono agent-hint">
          agent → GET :8787/api/context
        </code>
      </div>

      <div className="layout">
        <aside className="sidebar">
          <nav>
            {(
              [
                ['waypoints', `Waypoints${waypoints.length ? ` (${waypoints.length})` : ''}`],
                ['timer', `Tap timer${taps.taps.length ? ` (${taps.taps.length})` : ''}`],
                ['curve', 'Speed curve'],
              ] as [ToolTab, string][]
            ).map(([id, label]) => (
              <button
                key={id}
                className={tab === id ? 'navbtn active' : 'navbtn'}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </nav>
        </aside>

        <main className="panel">
          {tab === 'waypoints' && (
            <WaypointPicker waypoints={waypoints} setWaypoints={setWaypoints} project={project} />
          )}
          {tab === 'timer' && <TapTimer taps={taps} setTaps={setTaps} fps={project.fps} />}
          {tab === 'curve' && <SpeedCurveBuilder curve={speedCurve} setCurve={setSpeedCurve} />}
        </main>
      </div>

      <footer className="foot dim">
        Backend: <code>node server/context-server.mjs</code> (:8787) · agent endpoints:{' '}
        <code>GET /api/context</code> · <code>GET /api/agent-context</code> · frontend pushes via{' '}
        <code>POST /api/context</code>
      </footer>
    </div>
  );
}
