import { useRef, useState } from 'react';
import type { ProjectSettings, Waypoint } from '../types';
import { waypointsToRemotion } from '../lib/remotionExport';

interface Props {
  waypoints: Waypoint[];
  setWaypoints: (w: Waypoint[]) => void;
  project: ProjectSettings;
  bgUrl: string | null;
  onBgFile: (f: File) => Promise<void>;
  onClearBg: () => Promise<void>;
}

let n = 0;
const nid = () => `wp${Date.now().toString(36)}${(n++).toString(36)}`;

export default function WaypointPicker({ waypoints, setWaypoints, project, bgUrl, onBgFile, onClearBg }: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [bgBusy, setBgBusy] = useState(false);
  const [bgError, setBgError] = useState<string | null>(null);

  const addFromClick = (e: React.MouseEvent) => {
    const el = stageRef.current?.getBoundingClientRect();
    if (!el) return;
    const x = Math.min(1, Math.max(0, (e.clientX - el.left) / el.width));
    const y = Math.min(1, Math.max(0, (e.clientY - el.top) / el.height));
    setWaypoints([
      ...waypoints,
      { id: nid(), x: +x.toFixed(4), y: +y.toFixed(4), label: `P${waypoints.length + 1}` },
    ]);
  };

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= waypoints.length) return;
    const next = [...waypoints];
    [next[i], next[j]] = [next[j], next[i]];
    setWaypoints(next.map((w, k) => ({ ...w, label: `P${k + 1}` })));
  };

  const snippet = waypointsToRemotion(waypoints, project);

  return (
    <div className="grid2">
      <div>
        <div className="hint">Click the stage to drop a waypoint. Chain order = list order.</div>
        <div
          ref={stageRef}
          className="stage"
          style={{ aspectRatio: `${project.width} / ${project.height}` }}
          onClick={addFromClick}
        >
          {bgUrl && <img src={bgUrl} className="stage-bg" alt="" draggable={false} />}
          <div className="stage-grid" />
          {waypoints.map((w, i) => (
            <div
              key={w.id}
              className="wp"
              style={{ left: `${w.x * 100}%`, top: `${w.y * 100}%` }}
              title={`${w.label} (${w.x}, ${w.y})`}
            >
              {i + 1}
            </div>
          ))}
          {waypoints.length > 1 && (
            <svg className="wp-lines" viewBox="0 0 100 100" preserveAspectRatio="none">
              <polyline
                points={waypoints.map((w) => `${w.x * 100},${w.y * 100}`).join(' ')}
                fill="none"
                stroke="currentColor"
                strokeWidth={0.6}
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          )}
          {waypoints.length === 0 && <div className="stage-empty">click anywhere to add P1</div>}
        </div>
        <div className="row">
          <button className="btn ghost" onClick={() => setWaypoints([])} disabled={!waypoints.length}>
            Clear
          </button>
          <button
            className="btn ghost"
            onClick={() => setWaypoints(waypoints.slice(0, -1))}
            disabled={!waypoints.length}
          >
            Undo last
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
      <div>
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
        <h3>Remotion export</h3>
        <pre className="code">{snippet}</pre>
        <button className="btn" onClick={() => navigator.clipboard.writeText(snippet)}>
          Copy snippet
        </button>
      </div>
    </div>
  );
}
