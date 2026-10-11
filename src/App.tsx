import { useEffect, useMemo, useState } from 'react';
import TapTimer from './components/TapTimer';
import WaypointPicker from './components/WaypointPicker';
import SpeedCurveBuilder from './components/SpeedCurveBuilder';
import { createContextPusher, fetchContext, uploadStageBg } from './lib/contextSync';
import type { HelperContext, ProjectSettings, SpeedCurveState, Stroke, TapState, Waypoint } from './types';

const pusher = createContextPusher(400);

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(new Error('could not read file'));
    r.readAsDataURL(file);
  });
}

export default function App() {
  const [project, setProject] = useState<ProjectSettings>({ width: 1920, height: 1080, fps: 30 });
  const [waypoints, setWaypoints] = useState<Waypoint[]>([]);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [taps, setTaps] = useState<TapState>({ taps: [] });
  const [speedCurve, setSpeedCurve] = useState<SpeedCurveState>({
    duration: 1.5,
    bezier: [0.25, 0.1, 0.25, 1],
  });
  const [stageBg, setStageBg] = useState<string | null>(null);
  const [sync, setSync] = useState<'syncing' | 'saved' | 'error'>('saved');
  const [resetting, setResetting] = useState(false);

  useEffect(() => pusher.onStatus(setSync), []);

  // Pick up server-side state (stage bg) on load. UI state stays authoritative
  // for waypoints/taps/curve — the backend never overwrites those on boot.
  useEffect(() => {
    fetchContext()
      .then((ctx) => {
        if (ctx.stageBg?.url) setStageBg(`${ctx.stageBg.url}?v=${Date.now()}`);
      })
      .catch(() => setSync('error'));
  }, []);

  // Push every change to the backend so GET /api/context stays fresh for your agent.
  const ctxPatch = useMemo(
    () => ({ project, waypoints, strokes, taps, speedCurve }),
    [project, waypoints, strokes, taps, speedCurve],
  );
  useEffect(() => {
    pusher.push(ctxPatch);
  }, [ctxPatch]);

  const resetAll = async () => {
    setResetting(true);
    try {
      const res = await fetch('/api/reset', { method: 'POST' });
      if (!res.ok) throw new Error(`reset -> ${res.status}`);
      const ctx = (await res.json()) as HelperContext;
      setProject(ctx.project);
      setWaypoints(ctx.waypoints ?? []);
      setStrokes(ctx.strokes ?? []);
      setTaps(ctx.taps ?? { taps: [] });
      setSpeedCurve(ctx.speedCurve);
      setStageBg(null);
    } catch {
      setSync('error');
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="shell">
      <header className="topbar">
        <div>
          <h1>remotion-helper</h1>
          <p className="dim">waypoints · tap timer · speed curves → Remotion snippets + agent API</p>
        </div>
        <div className="top-actions">
          <button className="btn ghost" onClick={resetAll} disabled={resetting}>
            {resetting ? 'Resetting…' : 'Reset all'}
          </button>
          <div className="sync" data-state={sync} title="Backend sync status (POST /api/context)">
            <span className="dot" />
            {sync === 'saved' ? 'api synced' : sync === 'syncing' ? 'syncing…' : 'api offline'}
          </div>
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
        <code className="dim mono agent-hint">agent → GET :8787/api/context</code>
      </div>

      <main className="bento">
        <section className="panel bento-main" id="waypoints">
          <h2 className="section-title">Waypoints{waypoints.length ? ` (${waypoints.length})` : ''}</h2>
          <WaypointPicker
            waypoints={waypoints}
            setWaypoints={setWaypoints}
            strokes={strokes}
            setStrokes={setStrokes}
            project={project}
            bgUrl={stageBg}
            onBgFile={async (file) => {
              const dataUrl = await fileToDataUrl(file);
              setStageBg(await uploadStageBg(dataUrl));
            }}
            onClearBg={async () => setStageBg(await uploadStageBg(null))}
          />
        </section>
        <section className="panel bento-side" id="timer">
          <h2 className="section-title">Tap timer{taps.taps.length ? ` (${taps.taps.length})` : ''}</h2>
          <TapTimer taps={taps} setTaps={setTaps} fps={project.fps} />
        </section>
        <section className="panel bento-side" id="curve">
          <h2 className="section-title">Speed curve</h2>
          <SpeedCurveBuilder curve={speedCurve} setCurve={setSpeedCurve} />
        </section>
      </main>

      <footer className="foot dim">
        Backend: <code>node server/context-server.mjs</code> (:8787) · agent endpoints:{' '}
        <code>GET /api/context</code> · <code>GET /api/agent-context</code> · frontend pushes via{' '}
        <code>POST /api/context</code>
      </footer>
    </div>
  );
}
