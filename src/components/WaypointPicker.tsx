import { useEffect, useRef, useState } from 'react';
import type { ProjectSettings, Stroke, StrokePoint, Waypoint } from '../types';
import { strokesToRemotion, waypointsToRemotion } from '../lib/remotionExport';
import WaypointStage, { type StagePoint } from './WaypointStage';

interface Props {
  waypoints: Waypoint[];
  setWaypoints: (w: Waypoint[]) => void;
  strokes: Stroke[];
  setStrokes: (s: Stroke[]) => void;
  project: ProjectSettings;
  bgUrl: string | null;
  onBgFile: (f: File) => Promise<void>;
  onClearBg: () => Promise<void>;
}

let n = 0;
const nid = (p: string) => `${p}${Date.now().toString(36)}${(n++).toString(36)}`;

/** Min travel (normalized units) before a sampled mouse point is kept. */
const EPS = 0.004;

export default function WaypointPicker({
  waypoints,
  setWaypoints,
  strokes,
  setStrokes,
  project,
  bgUrl,
  onBgFile,
  onClearBg,
}: Props) {
  const [mode, setMode] = useState<'click' | 'draw'>('click');
  const [modalOpen, setModalOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [bgBusy, setBgBusy] = useState(false);
  const [bgError, setBgError] = useState<string | null>(null);

  // In-progress freehand stroke — local only, committed to parent on pen-up
  // (same draft pattern as the speed-curve handles: no App re-render per move).
  const [draft, setDraft] = useState<StrokePoint[] | null>(null);
  const drawStart = useRef(0);

  // Speed playback: traces the selected stroke at its recorded timestamps.
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [playPos, setPlayPos] = useState<StrokePoint | null>(null);
  const playIdx = useRef(0);

  useEffect(() => {
    if (!playingId) return;
    const st = strokes.find((s) => s.id === playingId);
    if (!st || st.points.length === 0) {
      setPlayingId(null);
      return;
    }
    playIdx.current = 0;
    const t0 = performance.now();
    let raf = 0;
    const loop = (now: number) => {
      const el = (now - t0) / 1000;
      const pts = st.points;
      let i = playIdx.current;
      while (i < pts.length - 2 && pts[i + 1].t <= el) i++;
      playIdx.current = i;
      const a = pts[i];
      const b = pts[Math.min(i + 1, pts.length - 1)];
      const span = Math.max(1e-6, b.t - a.t);
      const f = Math.min(1, Math.max(0, (el - a.t) / span));
      setPlayPos({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, t: el });
      if (el >= pts[pts.length - 1].t) {
        setPlayingId(null);
        setPlayPos(null);
        return;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playingId, strokes]);

  // Precision modal: Esc to close, lock page scroll while open.
  useEffect(() => {
    if (!modalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setModalOpen(false);
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [modalOpen]);

  const onPick = (p: StagePoint) => {
    setWaypoints([
      ...waypoints,
      { id: nid('wp'), x: +p.x.toFixed(4), y: +p.y.toFixed(4), label: `P${waypoints.length + 1}` },
    ]);
  };

  const onStrokeStart = (p: StagePoint) => {
    drawStart.current = performance.now();
    setDraft([{ ...p, t: 0 }]);
  };

  const onStrokePoint = (p: StagePoint) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const last = prev[prev.length - 1];
      const dx = p.x - last.x;
      const dy = p.y - last.y;
      if (dx * dx + dy * dy < EPS * EPS) return prev;
      const t = (performance.now() - drawStart.current) / 1000;
      return [...prev, { x: p.x, y: p.y, t: +t.toFixed(3) }];
    });
  };

  const onStrokeEnd = () => {
    setDraft((prev) => {
      if (prev && prev.length) {
        setStrokes([...strokes, { id: nid('st'), label: `S${strokes.length + 1}`, points: prev }]);
      }
      return null;
    });
  };

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= waypoints.length) return;
    const next = [...waypoints];
    [next[i], next[j]] = [next[j], next[i]];
    setWaypoints(next.map((w, k) => ({ ...w, label: `P${k + 1}` })));
  };

  const stopPlaying = () => {
    setPlayingId(null);
    setPlayPos(null);
  };

  const snippet = waypointsToRemotion(waypoints, project);
  const strokeSnippet = strokesToRemotion(strokes, project, project.fps);
  const emptyHint = mode === 'click' ? 'click anywhere to add P1' : 'press and drag to draw S1';

  const stageProps = {
    waypoints,
    strokes,
    draft,
    playPos,
    project,
    bgUrl,
    mode,
    emptyHint,
    onPick,
    onStrokeStart,
    onStrokePoint,
    onStrokeEnd,
  };

  return (
    <div className="wp-layout">
      <div>
        <div className="row" style={{ marginTop: 0, marginBottom: 10 }}>
          <button className={mode === 'click' ? 'btn' : 'btn ghost'} onClick={() => setMode('click')}>
            Click points
          </button>
          <button className={mode === 'draw' ? 'btn' : 'btn ghost'} onClick={() => setMode('draw')}>
            Draw path
          </button>
          <button className="btn ghost" style={{ marginLeft: 'auto' }} onClick={() => setModalOpen(true)}>
            ⛶ Precise
          </button>
        </div>
        <div className="hint">
          {mode === 'click'
            ? 'Click the stage to drop a waypoint. Chain order = list order.'
            : 'Press and drag on the stage to draw — your mouse speed is recorded with the path.'}
        </div>
        <WaypointStage {...stageProps} />
        {modalOpen && (
          <div className="modal-backdrop" onClick={() => setModalOpen(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-bar">
                <span className="dim">Waypoint stage — big surface for precise placement (Esc to close)</span>
                <button className="btn ghost" onClick={() => setModalOpen(false)}>Close ✕</button>
              </div>
              <WaypointStage {...stageProps} />
            </div>
          </div>
        )}
        <div className="row">
          <button className="btn ghost" onClick={() => setWaypoints([])} disabled={!waypoints.length}>
            Clear points
          </button>
          <button
            className="btn ghost"
            onClick={() => setWaypoints(waypoints.slice(0, -1))}
            disabled={!waypoints.length}
          >
            Undo point
          </button>
          <button className="btn ghost" onClick={() => { stopPlaying(); setStrokes([]); }} disabled={!strokes.length}>
            Clear strokes
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              setBgBusy(true);
              setBgError(null);
              try {
                await onBgFile(f);
              } catch {
                setBgError('upload failed (png/jpg/webp/gif, ≤10MB)');
              } finally {
                setBgBusy(false);
              }
            }}
          />
          <button className="btn ghost" disabled={bgBusy} onClick={() => fileRef.current?.click()}>
            {bgBusy ? 'Uploading…' : bgUrl ? 'Replace bg' : 'Set bg image'}
          </button>
          {bgUrl && (
            <button
              className="btn ghost"
              disabled={bgBusy}
              onClick={async () => {
                setBgBusy(true);
                try {
                  await onClearBg();
                } finally {
                  setBgBusy(false);
                }
              }}
            >
              Remove bg
            </button>
          )}
        </div>
        {bgError && <div className="hint danger-text">{bgError}</div>}
      </div>
      <div className="wp-side">
        <h3>Chain ({waypoints.length})</h3>
        <ol className="chain">
          {waypoints.map((w, i) => (
            <li key={w.id}>
              <code>
                {w.label}: {w.x.toFixed(4)}, {w.y.toFixed(4)}
                <span className="dim">
                  {' '}
                  → {Math.round(w.x * project.width)},{Math.round(w.y * project.height)}px
                </span>
              </code>
              <span className="mini-row">
                <button className="mini" onClick={() => move(i, -1)}>↑</button>
                <button className="mini" onClick={() => move(i, 1)}>↓</button>
                <button
                  className="mini danger"
                  onClick={() => setWaypoints(waypoints.filter((x) => x.id !== w.id))}
                >
                  ✕
                </button>
              </span>
            </li>
          ))}
          {waypoints.length === 0 && <li className="dim">No waypoints yet.</li>}
        </ol>
        <h3>Strokes ({strokes.length})</h3>
        <ol className="chain mono">
          {strokes.map((s) => {
            const dur = s.points.length ? s.points[s.points.length - 1].t : 0;
            const playing = playingId === s.id;
            return (
              <li key={s.id}>
                <code>
                  {s.label}: {s.points.length} pts · {dur.toFixed(2)}s
                </code>
                <span className="mini-row">
                  <button className="mini" onClick={() => (playing ? stopPlaying() : setPlayingId(s.id))}>
                    {playing ? '■' : '▶'}
                  </button>
                  <button
                    className="mini danger"
                    onClick={() => {
                      if (playing) stopPlaying();
                      setStrokes(strokes.filter((x) => x.id !== s.id));
                    }}
                  >
                    ✕
                  </button>
                </span>
              </li>
            );
          })}
          {strokes.length === 0 && <li className="dim">Draw on the stage in Draw mode.</li>}
        </ol>
        <h3>Remotion export</h3>
        <pre className="code">{snippet}</pre>
        <div className="row">
          <button className="btn" onClick={() => navigator.clipboard.writeText(snippet)}>
            Copy points
          </button>
          <button
            className="btn ghost"
            disabled={!strokes.length}
            onClick={() => navigator.clipboard.writeText(strokeSnippet)}
          >
            Copy strokes
          </button>
        </div>
        {strokes.length > 0 && <pre className="code" style={{ marginTop: 8 }}>{strokeSnippet}</pre>}
      </div>
    </div>
  );
}
