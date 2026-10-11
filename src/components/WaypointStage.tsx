import { useRef } from 'react';
import type { ProjectSettings, Stroke, StrokePoint, Waypoint } from '../types';

export interface StagePoint {
  x: number;
  y: number;
}

interface Props {
  waypoints: Waypoint[];
  strokes: Stroke[];
  draft: StrokePoint[] | null;
  playPos: StrokePoint | null;
  project: ProjectSettings;
  bgUrl: string | null;
  mode: 'click' | 'draw';
  emptyHint: string;
  onPick: (p: StagePoint) => void;
  onStrokeStart: (p: StagePoint) => void;
  onStrokePoint: (p: StagePoint) => void;
  onStrokeEnd: () => void;
}

/** Shared waypoint stage — rendered inline and inside the precision modal. */
export default function WaypointStage({
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
}: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const drawing = useRef(false);

  const toNorm = (clientX: number, clientY: number): StagePoint | null => {
    const el = stageRef.current?.getBoundingClientRect();
    if (!el) return null;
    return {
      x: Math.min(1, Math.max(0, (clientX - el.left) / el.width)),
      y: Math.min(1, Math.max(0, (clientY - el.top) / el.height)),
    };
  };

  return (
    <div
      ref={stageRef}
      className="stage"
      style={{ aspectRatio: `${project.width} / ${project.height}` }}
      onClick={(e) => {
        if (mode !== 'click') return;
        const p = toNorm(e.clientX, e.clientY);
        if (p) onPick(p);
      }}
      onPointerDown={(e) => {
        if (mode !== 'draw') return;
        (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
        const p = toNorm(e.clientX, e.clientY);
        if (!p) return;
        drawing.current = true;
        onStrokeStart(p);
      }}
      onPointerMove={(e) => {
        if (mode !== 'draw' || !drawing.current) return;
        const p = toNorm(e.clientX, e.clientY);
        if (p) onStrokePoint(p);
      }}
      onPointerUp={() => {
        if (!drawing.current) return;
        drawing.current = false;
        onStrokeEnd();
      }}
      onPointerCancel={() => {
        if (!drawing.current) return;
        drawing.current = false;
        onStrokeEnd();
      }}
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
      {(strokes.length > 0 || (draft && draft.length > 1)) && (
        <svg className="stroke-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
          {strokes.map((s) => (
            <polyline
              key={s.id}
              points={s.points.map((p) => `${p.x * 100},${p.y * 100}`).join(' ')}
              fill="none"
              className="stroke-line"
            />
          ))}
          {draft && draft.length > 1 && (
            <polyline
              points={draft.map((p) => `${p.x * 100},${p.y * 100}`).join(' ')}
              fill="none"
              className="stroke-line draft"
            />
          )}
        </svg>
      )}
      {playPos && (
        <div className="play-dot" style={{ left: `${playPos.x * 100}%`, top: `${playPos.y * 100}%` }} />
      )}
      {waypoints.length === 0 && strokes.length === 0 && !draft && (
        <div className="stage-empty">{emptyHint}</div>
      )}
    </div>
  );
}
