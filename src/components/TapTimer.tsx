import { useCallback, useEffect, useRef } from 'react';
import type { TapState } from '../types';
import { tapsToDeltas, tapsToRemotion } from '../lib/remotionExport';

interface Props {
  taps: TapState;
  setTaps: (t: TapState) => void;
  fps: number;
}

export default function TapTimer({ taps, setTaps, fps }: Props) {
  const startRef = useRef<number | null>(null);
  const arr = taps.taps;
  const deltas = tapsToDeltas(arr);

  const tap = useCallback(() => {
    const now = performance.now() / 1000;
    if (startRef.current === null) {
      startRef.current = now;
      setTaps({ taps: [0] });
    } else {
      setTaps({ taps: [...arr, +(now - startRef.current).toFixed(3)] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arr, setTaps]);

  const reset = () => {
    startRef.current = null;
    setTaps({ taps: [] });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space' && (e.target as HTMLElement)?.tagName !== 'TEXTAREA') {
        e.preventDefault();
        tap();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tap]);

  const max = arr.length ? Math.max(...arr, 0.001) : 1;
  const snippet = tapsToRemotion(arr, fps);

  return (
    <div className="grid2">
      <div>
        <div className="hint">
          Tap the pad (or press <kbd>Space</kbd>) in rhythm — e.g. click.click.......click. First
          tap = 0.000s.
        </div>
        <button className="tappad" onClick={tap}>
          TAP
          <span className="dim">{arr.length ? `${arr.length} taps · last ${arr[arr.length - 1].toFixed(3)}s` : 'no taps yet'}</span>
        </button>
        <div className="row">
          <button className="btn ghost" onClick={reset} disabled={!arr.length}>Reset</button>
          <button
            className="btn ghost"
            onClick={() => {
              startRef.current = null;
              setTaps({ taps: arr.slice(0, -1) });
            }}
            disabled={!arr.length}
          >
            Undo last
          </button>
        </div>
        {arr.length > 1 && (
          <div className="timeline">
            {arr.map((t, i) => (
              <div
                key={i}
                className="tick"
                style={{ left: `${(t / max) * 100}%` }}
                title={`${t.toFixed(3)}s${i ? ` (+${deltas[i - 1].toFixed(3)})` : ''}`}
              />
            ))}
            <div className="timeline-label">
              0.000s → {max.toFixed(3)}s · deltas: [{deltas.map((d) => d.toFixed(3)).join(', ')}]
            </div>
          </div>
        )}
      </div>
      <div>
        <h3>Chain ({arr.length})</h3>
        <ol className="chain mono">
          {arr.map((t, i) => (
            <li key={i}>
              <code>
                {t.toFixed(3)}s
                {i > 0 && <span className="dim"> (+{deltas[i - 1].toFixed(3)}s)</span>}
                <span className="dim"> · f{Math.round(t * fps)}</span>
              </code>
            </li>
          ))}
          {arr.length === 0 && <li className="dim">Tap to start chaining intervals.</li>}
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
