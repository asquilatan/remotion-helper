import { useState } from 'react';

const MODELS = ['tiny', 'base', 'small', 'medium', 'large-v3-turbo', 'turbo'];

type Mode = 'transcribe' | 'align';

interface AlignBody {
  source: string;
  model: string;
  script?: string;
  scriptPath?: string;
  markdown?: boolean;
}

export default function TranscriptTool() {
  const [mode, setMode] = useState<Mode>('align');
  const [source, setSource] = useState('');
  const [model, setModel] = useState('base');
  const [script, setScript] = useState('');
  const [scriptPath, setScriptPath] = useState('');
  const [markdown, setMarkdown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [srt, setSrt] = useState<string | null>(null);
  const [fileName, setFileName] = useState('transcript.srt');

  const cueCount = srt ? (srt.match(/^\d+$/gm) ?? []).length : 0;

  const loadScriptFile = async (file: File | undefined) => {
    if (!file) return;
    setScript(await file.text());
    setScriptPath('');
    if (/\.md$/i.test(file.name)) setMarkdown(true);
  };

  const download = () => {
    if (!srt) return;
    const url = URL.createObjectURL(new Blob([srt], { type: 'application/x-subrip' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    setSrt(null);
    try {
      const src = source.trim();
      if (!src) throw new Error('enter a media source path (repo-relative, e.g. audio/voice.mp3)');
      let res: Response;
      if (mode === 'transcribe') {
        res = await fetch(`/api/transcript?source=${encodeURIComponent(src)}&model=${model}`);
      } else {
        const body: AlignBody = { source: src, model };
        if (script.trim()) body.script = script;
        else if (scriptPath.trim()) body.scriptPath = scriptPath.trim();
        else throw new Error('enter script text or a scriptPath (.txt/.md)');
        if (markdown) body.markdown = true;
        res = await fetch('/api/align', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      }
      if (!res.ok) {
        let msg = `-> ${res.status}`;
        try {
          const j = (await res.json()) as { error?: string };
          if (j?.error) msg = j.error;
        } catch {
          /* non-JSON error */
        }
        throw new Error(msg);
      }
      const text = await res.text();
      const cd = res.headers.get('Content-Disposition');
      setFileName(/filename="([^"]+)"/.exec(cd ?? '')?.[1] ?? 'transcript.srt');
      setSrt(text);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid2">
      <div>
        <div className="hint">
          {mode === 'transcribe'
            ? 'Free transcription: audio/video in, timed .srt out (local whisper).'
            : 'Forced alignment: you know what is said — send the script, get it back timed to the audio.'}
        </div>
        <div className="row" style={{ marginTop: 0, marginBottom: 10 }}>
          <button className={mode === 'align' ? 'btn' : 'btn ghost'} onClick={() => setMode('align')}>
            Align script
          </button>
          <button className={mode === 'transcribe' ? 'btn' : 'btn ghost'} onClick={() => setMode('transcribe')}>
            Transcribe
          </button>
        </div>
        <label className="field grow">
          Source
          <input
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="audio/voice.mp3"
            spellCheck={false}
          />
        </label>
        <div className="row">
          <label className="field">
            Model
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {MODELS.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </label>
        </div>
        {mode === 'align' && (
          <>
            <h3>Script</h3>
            <textarea
              className="scriptbox"
              value={script}
              onChange={(e) => setScript(e.target.value)}
              placeholder={'At its core,\nevery frame is a decision'}
              spellCheck={false}
            />
            <div className="row wrap">
              <label className="btn ghost" style={{ cursor: 'pointer' }}>
                Load .txt/.md…
                <input
                  type="file"
                  accept=".txt,.md"
                  hidden
                  onChange={(e) => {
                    void loadScriptFile(e.target.files?.[0]);
                    e.target.value = '';
                  }}
                />
              </label>
              <label className="field">
                <input
                  type="checkbox"
                  checked={markdown}
                  onChange={(e) => setMarkdown(e.target.checked)}
                />
                markdown
              </label>
            </div>
            <div className="row">
              <label className="field grow">
                …or scriptPath
                <input
                  value={scriptPath}
                  onChange={(e) => setScriptPath(e.target.value)}
                  placeholder="scripts/ep03.md"
                  spellCheck={false}
                />
              </label>
            </div>
          </>
        )}
        <div className="row">
          <button className="btn" onClick={() => void run()} disabled={busy}>
            {busy ? (mode === 'align' ? 'Aligning…' : 'Transcribing…') : mode === 'align' ? 'Align to audio' : 'Transcribe'}
          </button>
        </div>
        {error && <div className="danger-text">{error}</div>}
      </div>
      <div>
        <h3>SRT{cueCount ? ` (${cueCount} cues)` : ''}</h3>
        <pre className="code tall">{srt ?? 'Run it — the timed transcript lands here.'}</pre>
        <div className="row">
          <button className="btn ghost" onClick={download} disabled={!srt}>Download .srt</button>
          <button
            className="btn ghost"
            onClick={() => srt && void navigator.clipboard.writeText(srt)}
            disabled={!srt}
          >
            Copy
          </button>
        </div>
        <div className="hint" style={{ marginTop: 8 }}>
          Same bytes as <code>GET /api/transcript</code> / <code>POST /api/align</code> — agents curl those directly.
        </div>
      </div>
    </div>
  );
}
