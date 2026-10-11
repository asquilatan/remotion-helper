import { useEffect, useRef, useState } from 'react';
import type { SpeedCurveState } from '../types';
import { bezierToCss, speedCurveToRemotion } from '../lib/remotionExport';

interface Props {
  curve: SpeedCurveState;
  setCurve: (c: SpeedCurveState) => void;
}

/** Cubic bezier y(x) via Newton solve — good enough for preview + sampling. */
function cubicAt(x1: number, y1: number, x2: number, y2: number, x: number): number {
  let t = x;
  for (let i = 0; i < 8; i++) {
    const bx = 3 * (1 - t) ** 2 * t * x1 + 3 * (1 - t) * t ** 2 * x2 + t ** 3;
    const dx = 3 * (1 - t) ** 2 * x1 + 6 * (1 - t) * t * (x2 - x1) + 3 * t ** 2 * (1 - x2);
    if (Math.abs(dx) < 1e-4) break;
    t = Math.min(1, Math.max(0, t - (bx - x) / dx));
  }
  return 3 * (1 - t) ** 2 * t * y1 + 3 * (1 - t) * t ** 2 * y2 + t ** 3;
}

const W = 320;
const H = 200;
const PAD = 18;

export default function SpeedCurveBuilder({ curve, setCurve }: Props) {
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const raf = useRef(0);
  const svgRef = useRef<SVGSVGElement>(null);
  // Which handle is being dragged, if any.
  const [drag, setDrag] = useState<0 | 1 | null>(null);
  // Transient drag position — local only, committed to parent on release.
  // This keeps every pointermove from re-rendering the whole app + backend sync.
  const [draft, setDraft] = useState<[number, number, number, number] | null>(null);
  const [x1, y1, x2, y2] = draft ?? curve.bezier;

  const toSvg = (bx: number, by: number): [number, number] => [
    PAD + bx * (W - PAD * 2),
    H - PAD - by * (H - PAD * 2),
  ];
  const fromSvg = (sx: number, sy: number): [number, number] => [
    Math.min(1, Math.max(0, (sx - PAD) / (W - PAD * 2))),
    Math.min(1.2, Math.max(-0.2, (H - PAD - sy) / (H - PAD * 2))),
  ];

  const path = Array.from({ length: 65 }, (_, i) => {
    const x = i / 64;
    const y = cubicAt(x1, y1, x2, y2, x);
    const [sx, sy] = toSvg(x, y);
    return `${i ? 'L' : 'M'}${sx.toFixed(1)},${sy.toFixed(1)}`;
  }).join(' ');

  const [h1x, h1y] = toSvg(x1, y1);
  const [h2x, h2y] = toSvg(x2, y2);
  const [sx0, sy0] = toSvg(0, 0);
  const [sx1, sy1] = toSvg(1, 1);

  useEffect(() => {
    if (!playing) return;
    const t0 = performance.now();
    const loop = (now: number) => {
      const p = ((now - t0) / 1000 / curve.duration) % 1;
      setProgress(p);
      raf.current = requestAnimationFrame(loop);
    };
    raf.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf.current);
  }, [playing, curve.duration]);

  const eased = cubicAt(x1, y1, x2, y2, progress);
  const snippet = speedCurveToRemotion(curve);

  /** Commit the in-progress drag to the parent (and backend) exactly once. */
  const commit = () => {
    if (draft) {
      const rounded = draft.map((v) => +v.toFixed(3)) as [number, number, number, number];
      setDraft(null);
      setCurve({ ...curve, bezier: rounded });
    }
    setDrag(null);
  };

  const onMove = (e: React.PointerEvent) => {
    if (drag === null) return;
    const r = svgRef.current?.getBoundingClientRect();
    if (!r) return;
    const sx = ((e.clientX - r.left) / r.width) * W;
    const sy = ((e.clientY - r.top) / r.height) * H;
    const [bx, by] = fromSvg(sx, sy);
    // Local-only update: no parent re-render, no backend push until release.
    setDraft(drag === 0 ? [bx, by, x2, y2] : [x1, y1, bx, by]);
  };

  return (
    <div className="grid2">
      <div>
        <div className="hint">
          Drag the two handles (After-Effects-style speed curve). Preview below loops a dot with
          your easing.
        </div>
        <svg
          ref={svgRef}
          className="curve"
          viewBox={`0 0 ${W} ${H}`}
          onPointerUp={commit}
          onPointerCancel={commit}
          onPointerLeave={() => {
            // Only auto-commit on leave if the pointer is still down outside;
            // a plain hover-out with no drag active is a no-op.
            if (drag !== null) commit();
          }}
          onPointerMove={onMove}
        >
          <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} className="axis" />
          <line x1={PAD} y1={PAD} x2={PAD} y2={H - PAD} className="axis" />
          <path d={path} className="curve-line" />
          <line x1={sx0} y1={sy0} x2={h1x} y2={h1y} className="handle-line" />
          <line x1={sx1} y1={sy1} x2={h2x} y2={h2y} className="handle-line" />
          <circle
            cx={h1x}
            cy={h1y}
            r={9}
            className="handle"
            style={{ cursor: 'grab' }}
            onPointerDown={(e) => {
              (e.target as SVGCircleElement).setPointerCapture(e.pointerId);
              setDrag(0);
            }}
          />
          <circle
            cx={h2x}
            cy={h2y}
            r={9}
            className="handle"
            style={{ cursor: 'grab' }}
            onPointerDown={(e) => {
              (e.target as SVGCircleElement).setPointerCapture(e.pointerId);
              setDrag(1);
            }}
          />
          <circle cx={sx0} cy={sy0} r={4} className="anchor" />
          <circle cx={sx1} cy={sy1} r={4} className="anchor" />
        </svg>
        <div className="row wrap">
          {(['x1', 'y1', 'x2', 'y2'] as const).map((k, i) => (
            <label key={k} className="field">
              {k}
              <input
                type="number"
                step={0.01}
                min={k.startsWith('y') ? -1 : 0}
                max={k.startsWith('y') ? 2 : 1}
                value={curve.bezier[i]}
                onChange={(e) => {
                  const v = +e.target.value;
                  const next = [...curve.bezier] as [number, number, number, number];
                  next[i] = Number.isFinite(v) ? v : 0;
                  setCurve({ ...curve, bezier: next });
                }}
              />
            </label>
          ))}
          <label className="field">
            dur(s)
            <input
              type="number"
              step={0.1}
              min={0.2}
              max={10}
              value={curve.duration}
              onChange={(e) => setCurve({ ...curve, duration: Math.max(0.2, +e.target.value || 1) })}
            />
          </label>
        </div>
        <div className="row">
          <button className="btn ghost" onClick={() => setCurve({ duration: 1.5, bezier: [0.25, 0.1, 0.25, 1] })}>
            Reset (ease)
          </button>
          <button className="btn ghost" onClick={() => setCurve({ ...curve, bezier: [0.42, 0, 0.58, 1] })}>
            Ease-in-out
          </button>
          <button className="btn ghost" onClick={() => setCurve({ ...curve, bezier: [0, 0, 1, 1] })}>
            Linear
          </button>
        </div>
      </div>
      <div>
        <h3>Preview</h3>
        <div className="preview-track">
          <div
            className="preview-dot"
            style={{
              left: `calc(${(eased * 100).toFixed(2)}% - 10px)`,
              transition: playing ? 'none' : 'left 0.15s',
            }}
          />
        </div>
        <div className="row">
          <button className="btn" onClick={() => setPlaying((p) => !p)}>
            {playing ? 'Pause' : 'Play loop'}
          </button>
          <input
            type="range"
            min={0}
            max={1000}
            value={Math.round(progress * 1000)}
            onChange={(e) => {
              setPlaying(false);
              setProgress(+e.target.value / 1000);
            }}
            style={{ flex: 1 }}
          />
        </div>
        <div className="hint mono">css: {bezierToCss(curve.bezier)} · {curve.duration}s loop</div>
        <h3>Remotion export</h3>
        <pre className="code">{snippet}</pre>
        <button className="btn" onClick={() => navigator.clipboard.writeText(snippet)}>
          Copy snippet
        </button>
      </div>
    </div>
  );
}
