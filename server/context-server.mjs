import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
const execFile = promisify(execFileCb);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const STORE_PATH = path.join(__dirname, 'context.json');
/** Project root: `source=` paths for /api/transcript resolve under here. */
const ROOT = path.dirname(__dirname);

/** The shared context shape. Frontend POSTs partial updates, agents GET it. */
const defaultContext = {
  updatedAt: new Date().toISOString(),
  project: { width: 1920, height: 1080, fps: 30 },
  waypoints: [],
  strokes: [],
  markers3d: [],
  surface: 'plane',
  planeView: { position: [1.1, -1.7, 1.5], target: [0, 0, 0] },
  taps: { taps: [], unit: 's' },
  speedCurve: { duration: 1.5, bezier: [0.25, 0.1, 0.25, 1.0] },
  stageBg: null,
};

const BG_MIME_TO_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const BG_MIME_TO_CTYPE = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

/** Local speech-to-text for GET /api/transcript (audio in, .srt bytes out). */
const TRANSCRIBE_SCRIPT = path.join(__dirname, 'transcribe.py');
/** Forced alignment for POST /api/align (known script + audio in, timed .srt out). */
const ALIGN_SCRIPT = path.join(__dirname, 'align.py');
const SCRIPT_MAX_CHARS = 100_000;
const TRANSCRIBE_TIMEOUT_MS = Number(process.env.TRANSCRIBE_TIMEOUT_MS ?? 600_000);
const FFMPEG_TIMEOUT_MS = Number(process.env.FFMPEG_TIMEOUT_MS ?? 300_000);
const WHISPER_MODEL_DEFAULT = process.env.WHISPER_MODEL ?? 'base';
const WHISPER_MODELS = new Set([
  'tiny', 'tiny.en', 'base', 'base.en', 'small', 'small.en',
  'medium', 'medium.en', 'large-v1', 'large-v2', 'large-v3',
  'large-v3-turbo', 'turbo',
]);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'wma', 'aiff', 'aif']);
const VIDEO_EXTS = new Set(['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'mpg', 'mpeg']);

function whisperPython() {
  if (process.env.WHISPER_PYTHON && fs.existsSync(process.env.WHISPER_PYTHON)) {
    return process.env.WHISPER_PYTHON;
  }
  const venv =
    process.platform === 'win32'
      ? path.join(__dirname, '.tools', 'whisper-env', 'Scripts', 'python.exe')
      : path.join(__dirname, '.tools', 'whisper-env', 'bin', 'python');
  if (fs.existsSync(venv)) return venv;
  return 'python'; // last resort: whatever python is on PATH
}

/** Resolve a repo-relative `source=` value to a real media file under ROOT. */
function resolveMediaSource(source) {
  const bad = (status, error) => ({ ok: false, status, error });
  if (typeof source !== 'string' || !source.trim()) {
    return bad(400, 'missing ?source= — repo-relative media path, e.g. /api/transcript?source=audio/01-at_its_core.mp3');
  }
  const s = source.trim().replace(/^\/+/, '');
  if (/^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('\\\\') || path.isAbsolute(s) || /:\/\/|\0/.test(s)) {
    return bad(400, 'source must be a repo-relative path, not an absolute path or URL');
  }
  const norm = path.normalize(s);
  if (norm === '..' || norm.startsWith(`..${path.sep}`)) {
    return bad(400, 'source must stay inside the project directory');
  }
  const abs = path.join(ROOT, norm);
  const rootWithSep = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
  if (abs.toLowerCase() !== ROOT.toLowerCase() && !abs.toLowerCase().startsWith(rootWithSep.toLowerCase())) {
    return bad(400, 'source must stay inside the project directory');
  }
  const isFile = (p) => {
    try {
      return fs.statSync(p).isFile() ? p : null;
    } catch {
      return null;
    }
  };
  const direct = isFile(abs);
  if (direct) return { ok: true, file: direct };
  // Basename without extension: probe known media extensions (audio first).
  if (!path.extname(abs)) {
    for (const ext of [...AUDIO_EXTS, ...VIDEO_EXTS]) {
      const hit = isFile(`${abs}.${ext}`);
      if (hit) return { ok: true, file: hit };
    }
  }
  return bad(404, `no such media file: ${norm} (resolved inside project root)`);
}

/** Resolve a repo-relative text `scriptPath=` value to a real .txt file under ROOT. */
function resolveScriptPath(p) {
  const bad = (status, error) => ({ ok: false, status, error });
  if (typeof p !== 'string' || !p.trim()) {
    return bad(400, 'scriptPath must be a repo-relative path to a .txt or .md file');
  }
  const s = p.trim().replace(/^\/+/, '');
  if (/^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('\\\\') || path.isAbsolute(s) || /:\/\/|\0/.test(s)) {
    return bad(400, 'scriptPath must be a repo-relative path, not an absolute path or URL');
  }
  const norm = path.normalize(s);
  if (norm === '..' || norm.startsWith(`..${path.sep}`)) {
    return bad(400, 'scriptPath must stay inside the project directory');
  }
  const abs = path.join(ROOT, norm);
  const rootWithSep = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
  if (abs.toLowerCase() !== ROOT.toLowerCase() && !abs.toLowerCase().startsWith(rootWithSep.toLowerCase())) {
    return bad(400, 'scriptPath must stay inside the project directory');
  }
  const withExt = path.extname(abs) ? abs : `${abs}.txt`;
  if (!['.txt', '.md'].includes(path.extname(withExt).toLowerCase())) {
    return bad(415, 'scriptPath must point to a .txt or .md file');
  }
  try {
    if (!fs.statSync(withExt).isFile()) return bad(404, `no such script file: ${norm}`);
  } catch {
    return bad(404, `no such script file: ${norm}`);
  }
  return { ok: true, file: withExt };
}

function srtDownloadName(file) {
  const base = path.basename(file, path.extname(file)).replace(/["\r\n\\]/g, '_') || 'transcript';
  return `${base}.srt`;
}

function assertMediaExt(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (!AUDIO_EXTS.has(ext) && !VIDEO_EXTS.has(ext)) {
    const err = new Error(`unsupported media type .${ext} — audio: ${[...AUDIO_EXTS].join(', ')}; video: ${[...VIDEO_EXTS].join(', ')}`);
    err.status = 415;
    throw err;
  }
}

/** Normalize any audio/video file to 16kHz mono wav in a fresh temp dir. */
async function prepareWav(file) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-'));
  const wav = path.join(tmp, 'audio.wav');
  try {
    await execFile('ffmpeg', ['-y', '-v', 'error', '-i', file, '-ac', '1', '-ar', '16000', wav], {
      timeout: FFMPEG_TIMEOUT_MS,
    });
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (e?.code === 'ENOENT') {
      const err = new Error('ffmpeg not found on PATH — install it (e.g. winget install Gyan.FFmpeg)');
      err.status = 503;
      throw err;
    }
    if (e?.killed) {
      const err = new Error('ffmpeg timed out');
      err.status = 504;
      throw err;
    }
    const detail = String(e?.stderr ?? e?.message ?? e).slice(-500).trim();
    const err = new Error(detail ? `audio extraction failed: ${detail}` : 'audio extraction failed');
    err.status = 500;
    throw err;
  }
  return { tmp, wav };
}

function mapEngineError(e, what) {
  if (e?.code === 'ENOENT') {
    const err = new Error(
      `transcription engine not found (${e.path ?? 'python/faster-whisper missing'}) — ` +
        'create server/.tools/whisper-env with faster-whisper, or set WHISPER_PYTHON',
    );
    err.status = 503;
    return err;
  }
  if (e?.killed) {
    const err = new Error(`${what} timed out`);
    err.status = 504;
    return err;
  }
  if (e?.code === 4) {
    const err = new Error('no speech detected in audio');
    err.status = 422;
    return err;
  }
  const detail = String(e?.stderr ?? e?.message ?? e).slice(-500).trim();
  const err = new Error(detail ? `${what} failed: ${detail}` : `${what} failed`);
  err.status = 500;
  return err;
}

/** Align a known script to `file`'s audio; returns timed .srt bytes. */
async function alignToSrt(file, script, model, stripMarkdown = false) {
  assertMediaExt(file);
  if (!fs.existsSync(ALIGN_SCRIPT)) {
    const err = new Error('aligner missing: server/align.py not found');
    err.status = 503;
    throw err;
  }
  const { tmp, wav } = await prepareWav(file);
  try {
    const scriptPath = path.join(tmp, 'script.txt');
    fs.writeFileSync(scriptPath, script, 'utf8');
    const srtPath = path.join(tmp, 'out.srt');
    const args = [ALIGN_SCRIPT, wav, '--script-file', scriptPath, '--model', model, '--output', srtPath];
    if (stripMarkdown) args.push('--strip-markdown');
    await execFile(whisperPython(), args, { timeout: TRANSCRIBE_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 });
    return fs.readFileSync(srtPath);
  } catch (e) {
    if (e?.status) throw e;
    throw mapEngineError(e, 'alignment');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Transcribe `file` (audio, or video via ffmpeg audio extraction) to .srt bytes. */
async function transcribeToSrt(file, model) {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (!AUDIO_EXTS.has(ext) && !VIDEO_EXTS.has(ext)) {
    const err = new Error(`unsupported media type .${ext} — audio: ${[...AUDIO_EXTS].join(', ')}; video: ${[...VIDEO_EXTS].join(', ')}`);
    err.status = 415;
    throw err;
  }
  if (!fs.existsSync(TRANSCRIBE_SCRIPT)) {
    const err = new Error('transcriber missing: server/transcribe.py not found');
    err.status = 503;
    throw err;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-'));
  try {
    // Normalize everything (incl. video) to 16kHz mono wav for whisper.
    const wav = path.join(tmp, 'audio.wav');
    await execFile('ffmpeg', ['-y', '-v', 'error', '-i', file, '-ac', '1', '-ar', '16000', wav], {
      timeout: FFMPEG_TIMEOUT_MS,
    });
    const srtPath = path.join(tmp, 'out.srt');
    const args = [TRANSCRIBE_SCRIPT, wav, '--model', model, '--output', srtPath];
    await execFile(whisperPython(), args, { timeout: TRANSCRIBE_TIMEOUT_MS });
    return fs.readFileSync(srtPath);
  } catch (e) {
    if (e?.code === 'ENOENT' && e?.path === 'ffmpeg') {
      const err = new Error('ffmpeg not found on PATH — install it (e.g. winget install Gyan.FFmpeg)');
      err.status = 503;
      throw err;
    }
    if (e?.code === 'ENOENT') {
      const err = new Error(
        `transcription engine not found (${e.path ?? 'python/faster-whisper missing'}) — ` +
          'create server/.tools/whisper-env with faster-whisper, or set WHISPER_PYTHON',
      );
      err.status = 503;
      throw err;
    }
    if (e?.killed) {
      const err = new Error('transcription timed out');
      err.status = 504;
      throw err;
    }
    const detail = String(e?.stderr ?? e?.message ?? e).slice(-500).trim();
    const err = new Error(detail ? `transcription failed: ${detail}` : 'transcription failed');
    err.status = 500;
    throw err;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function bgFile() {
  try {
    const hit = fs.readdirSync(__dirname).find((f) => f.startsWith('stage-bg.'));
    return hit ? path.join(__dirname, hit) : null;
  } catch {
    return null;
  }
}

function clearBgFiles(except = null) {
  try {
    for (const f of fs.readdirSync(__dirname)) {
      if (f.startsWith('stage-bg.') && f !== except) fs.unlinkSync(path.join(__dirname, f));
    }
  } catch {
    /* ignore */
  }
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    return structuredClone(defaultContext);
  }
}

function save(ctx) {
  ctx.updatedAt = new Date().toISOString();
  fs.writeFileSync(STORE_PATH, JSON.stringify(ctx, null, 2));
  return ctx;
}

let context = load();

/** Machine-readable API description so polling agents can discover capabilities. */
const apiHelp = {
  name: 'remotion-helper api',
  version: 1,
  contract:
    'The React UI is the writer: it pushes state via POST /api/context. ' +
    'External agents are readers — do not POST /api/context while the UI is open, ' +
    'or the next UI push will overwrite it.',
  endpoints: [
    {
      method: 'GET',
      path: '/api/help',
      description: 'This document.',
    },
    {
      method: 'GET',
      path: '/api/health',
      description: 'Liveness check.',
      response: '{ "ok": true, "port": 8787, "updatedAt": "<iso>" }',
    },
    {
      method: 'GET',
      path: '/api/context',
      description: 'Raw HelperContext JSON — the main polling endpoint.',
      response:
        '{ updatedAt, project: { width, height, fps }, ' +
        'waypoints: [{ id, x, y, label }] (x/y normalized 0..1), ' +
        'strokes: [{ id, label, points: [{ x, y, t }] }] (t = seconds since pen-down, the speed profile), ' +
        'planeView: { position: [x,y,z], target: [x,y,z] } (world-space camera angle), ' +
        'markers3d: [{ id, label, position: [x,y,z], normal: [x,y,z] }], ' +
        'surface: "plane"|"sphere"|"cube"|"cylinder"|"torus"|"cone", ' +
        'taps: { taps: [seconds...], unit }, ' +
        'speedCurve: { duration, bezier: [x1, y1, x2, y2] }, ' +
        'stageBg: { url, updatedAt } | null }',
    },
    {
      method: 'GET',
      path: '/api/agent-context',
      description: 'Pre-rendered prompt text: project, waypoints (+px), strokes summary, taps, speed curve.',
      query: { format: '"json" returns { prompt, context } instead of plain text' },
    },
    {
      method: 'POST',
      path: '/api/context',
      description: 'Partial patch: top-level keys are shallow-merged, re-timestamped, persisted.',
      body: '{ "waypoints": [...], "taps": {...}, ... } — any subset of HelperContext keys',
      response: 'The merged HelperContext.',
    },
    {
      method: 'POST',
      path: '/api/project',
      description: 'Agent-settable project settings. Validated, merged into context.project.',
      body: '{ "width"?: 1..16384, "height"?: 1..16384, "fps"?: 1..240 } — any subset',
      response: '{ "project": { width, height, fps }, "context": <HelperContext> }',
    },
    {
      method: 'POST',
      path: '/api/stage-bg',
      description: 'Replace (or with {"image": null}, clear) the waypoint stage background.',
      body: '{ "image": "data:image/<png|jpeg|webp|gif>;base64,..." } — max ~10MB decoded',
      response: '{ "url": "/api/stage-bg" | null, "context": <HelperContext> }',
    },
    {
      method: 'GET',
      path: '/api/stage-bg',
      description: 'Serve the current stage background image file (404 if none set).',
    },
    {
      method: 'POST',
      path: '/api/reset',
      description: 'Restore default context AND delete the stored background image. Use sparingly.',
    },
    {
      method: 'GET',
      path: '/api/transcript?source=<relative-path>[&model=<size>]',
      description:
        'Transcribe an audio (or video, audio-extracted via ffmpeg) file to SubRip bytes ' +
        'with local whisper. source is a repo-relative media path, extension optional ' +
        '(e.g. ?source=audio/01-at_its_core). Fresh transcription per request (no cache).',
      query: { source: 'required, repo-relative media path', model: `"base" default; one of ${[...WHISPER_MODELS].join(', ')}` },
      response:
        'Raw .srt bytes: Content-Type application/x-subrip, ' +
        'Content-Disposition attachment, ETag (If-None-Match -> 304). Errors are JSON.',
    },
    {
      method: 'POST',
      path: '/api/align',
      description:
        'Forced alignment: you already know what is said, so send the script and get it ' +
        'back timed to the audio (whisper word timestamps matched to your sentences). ' +
        'Each script sentence is one SRT cue; newlines force cue breaks.',
      body: `{ "source": "<repo-relative media path, extension optional>", "script"?: "<inline text>", "scriptPath"?: "<repo-relative .txt/.md>", "model"?: "<size>", "markdown"?: true } — script or scriptPath (not both); .md files are stripped of formatting automatically; max ~${2_000_000}B body`,
      response:
        'Raw .srt bytes with YOUR script text, timed: Content-Type application/x-subrip, ' +
        'Content-Disposition attachment, ETag (If-None-Match -> 304). Errors are JSON.',
    },
  ],
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

/** Agent-friendly rendering: compact prompt + raw numbers. */
function agentView(ctx) {
  const wp = ctx.waypoints ?? [];
  const strokes = ctx.strokes ?? [];
  const markers3d = ctx.markers3d ?? [];
  const pv = ctx.planeView ?? {};
  const surface = ctx.surface ?? 'plane';
  const taps = ctx.taps?.taps ?? [];
  const sc = ctx.speedCurve ?? {};
  const lines = [
    `# remotion-helper live context (${ctx.updatedAt})`,
    `project: ${ctx.project?.width}x${ctx.project?.height} @ ${ctx.project?.fps}fps`,
    ``,
    `## waypoints (${wp.length}) — x,y normalized 0..1, px for project size`,
    ctx.stageBg
      ? `- stage bg: ${ctx.stageBg.url} (updated ${ctx.stageBg.updatedAt})`
      : `- stage bg: none`,
    ...wp.map((w, i) => {
      const px = Math.round(w.x * (ctx.project?.width ?? 1920));
      const py = Math.round(w.y * (ctx.project?.height ?? 1080));
      return `- [${i}] ${w.label ?? w.id} :: x=${w.x.toFixed(4)} y=${w.y.toFixed(4)} (${px},${py}px)`;
    }),
    ``,
    `## strokes (${strokes.length}) — freehand paths, x,y normalized 0..1, t = seconds since pen-down (the speed profile)`,
    ...strokes.map((s, i) => {
      const pts = s.points ?? [];
      const dur = pts.length ? pts[pts.length - 1].t : 0;
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      const bbox =
        pts.length
          ? `x[${Math.min(...xs).toFixed(2)}..${Math.max(...xs).toFixed(2)}] y[${Math.min(...ys).toFixed(2)}..${Math.max(...ys).toFixed(2)}]`
          : 'empty';
      return `- [${i}] ${s.label ?? s.id} :: ${pts.length} pts, ${dur.toFixed(2)}s, ${bbox} (full points in /api/context JSON)`;
    }),
    ``,
    `## 3d markers (${markers3d.length}) on '${surface}' — world-space position + normal`,
    Array.isArray(pv.position)
      ? `- camera: pos(${pv.position.join(', ')}) tgt(${Array.isArray(pv.target) ? pv.target.join(', ') : '?'})`
      : `- camera: ?`,
    ...markers3d.map((m, i) => {
      const fmt = (v) => (Array.isArray(v) ? v.map((n) => (+n).toFixed(3)).join(', ') : '?');
      return `- [${i}] ${m.label ?? m.id} :: pos(${fmt(m.position)}) normal(${fmt(m.normal)})`;
    }),
    ``,
    ``,
    `## tap timer (${taps.length} taps) — absolute seconds + deltas`,
    taps.length
      ? `- abs: [${taps.map((t) => t.toFixed(3)).join(', ')}]`
      : `- (no taps yet)`,
    taps.length > 1
      ? `- deltas: [${taps
          .slice(1)
          .map((t, i) => (t - taps[i]).toFixed(3))
          .join(', ')}]`
      : ``,
    ``,
    `## speed curve — cubic-bezier over duration ${sc.duration ?? '?'}s`,
    `- bezier(${Array.isArray(sc.bezier) ? sc.bezier.join(', ') : '?'})`,
    `- remotion: Easing.bezier(${Array.isArray(sc.bezier) ? sc.bezier.join(', ') : ''})`,
  ];
  return lines.filter((l) => l !== undefined).join('\n');
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true, port: PORT, updatedAt: context.updatedAt });
    return;
  }

  // Self-description for agents that don't know this API yet.
  if (req.method === 'GET' && (url.pathname === '/api/help' || url.pathname === '/api')) {
    sendJson(res, 200, apiHelp);
    return;
  }

  // Main endpoint your agent polls.
  if (req.method === 'GET' && url.pathname === '/api/context') {
    sendJson(res, 200, context);
    return;
  }

  // Pre-rendered prompt text for the agent (plus raw JSON if ?format=json).
  if (req.method === 'GET' && url.pathname === '/api/agent-context') {
    if (url.searchParams.get('format') === 'json') {
      sendJson(res, 200, { prompt: agentView(context), context });
    } else {
      sendText(res, 200, agentView(context));
    }
    return;
  }

  // Frontend pushes state here (debounced POST from the React app).
  if (req.method === 'POST' && url.pathname === '/api/context') {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1_000_000) req.destroy();
    });
    req.on('end', () => {
      try {
        const patch = raw ? JSON.parse(raw) : {};
        context = save({ ...context, ...patch });
        sendJson(res, 200, context);
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body' });
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/reset') {
    clearBgFiles();
    context = save(structuredClone(defaultContext));
    sendJson(res, 200, context);
    return;
  }

  // Replace (or clear, with { "image": null }) the waypoint stage background.
  // Body: { "image": "data:image/png;base64,...." } — png/jpeg/webp/gif, ~10MB max.
  if (req.method === 'POST' && url.pathname === '/api/stage-bg') {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 15_000_000) req.destroy();
    });
    req.on('end', () => {
      try {
        const { image } = raw ? JSON.parse(raw) : {};
        if (image === null || image === undefined || image === '') {
          clearBgFiles();
          context = save({ ...context, stageBg: null });
          sendJson(res, 200, { url: null, context });
          return;
        }
        const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(image);
        if (!m) {
          sendJson(res, 400, { error: 'expected { "image": "data:image/<png|jpeg|webp|gif>;base64,..." } or { "image": null }' });
          return;
        }
        const ext = BG_MIME_TO_EXT[m[1]];
        const buf = Buffer.from(m[2], 'base64');
        if (!buf.length || buf.length > 10_000_000) {
          sendJson(res, 400, { error: 'image empty or over 10MB' });
          return;
        }
        const name = `stage-bg.${ext}`;
        fs.writeFileSync(path.join(__dirname, name), buf);
        clearBgFiles(name);
        context = save({
          ...context,
          stageBg: { url: '/api/stage-bg', updatedAt: new Date().toISOString() },
        });
        sendJson(res, 200, { url: context.stageBg.url, context });
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body' });
      }
    });
    return;
  }

  // Serve the current stage background (with ?v= cache-buster from the UI).
  if (req.method === 'GET' && url.pathname === '/api/stage-bg') {
    const file = bgFile();
    if (!file) {
      sendJson(res, 404, { error: 'no stage background set — POST /api/stage-bg first' });
      return;
    }
    const ext = path.extname(file).slice(1);
    try {
      const buf = fs.readFileSync(file);
      res.writeHead(200, {
        'Content-Type': BG_MIME_TO_CTYPE[ext] ?? 'application/octet-stream',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        'Content-Length': buf.length,
      });
      res.end(buf);
    } catch {
      sendJson(res, 500, { error: 'could not read stage background' });
    }
    return;
  }

  // Agent-settable project settings (w/h/fps). Validated, merged, persisted.
  if (req.method === 'POST' && url.pathname === '/api/project') {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 10_000) req.destroy();
    });
    req.on('end', () => {
      try {
        const body = raw ? JSON.parse(raw) : {};
        const clean = {};
        for (const [k, min, max] of [
          ['width', 1, 16384],
          ['height', 1, 16384],
          ['fps', 1, 240],
        ]) {
          if (body[k] === undefined) continue;
          const v = Math.round(Number(body[k]));
          if (!Number.isFinite(v) || v < min || v > max) {
            sendJson(res, 400, { error: `${k} must be a number ${min}..${max}` });
            return;
          }
          clean[k] = v;
        }
        context = save({ ...context, project: { ...context.project, ...clean } });
        sendJson(res, 200, { project: context.project, context });
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body' });
      }
    });
    return;
  }

  // Audio/video in, .srt file bytes out (curl -o'able). No cache: fresh transcription.
  if (req.method === 'GET' && url.pathname === '/api/transcript') {
    (async () => {
      const model = url.searchParams.get('model') ?? WHISPER_MODEL_DEFAULT;
      if (!WHISPER_MODELS.has(model)) {
        sendJson(res, 400, { error: `unknown model "${model}" — one of ${[...WHISPER_MODELS].join(', ')}` });
        return;
      }
      const found = resolveMediaSource(url.searchParams.get('source'));
      if (!found.ok) {
        sendJson(res, found.status, { error: found.error });
        return;
      }
      try {
        const srt = await transcribeToSrt(found.file, model);
        const etag = `"${crypto.createHash('sha1').update(srt).digest('hex')}"`;
        if (req.headers['if-none-match'] === etag) {
          res.writeHead(304, { ETag: etag, 'Access-Control-Allow-Origin': '*' });
          res.end();
          return;
        }
        const name = srtDownloadName(found.file);
        res.writeHead(200, {
          'Content-Type': 'application/x-subrip; charset=utf-8',
          'Content-Disposition': `attachment; filename="${name}"`,
          ETag: etag,
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
          'Content-Length': srt.length,
        });
        res.end(srt);
      } catch (e) {
        if (!res.writableEnded) sendJson(res, e?.status ?? 500, { error: e?.message ?? 'transcription failed' });
      }
    })().catch((e) => {
      if (!res.writableEnded) sendJson(res, 500, { error: e?.message ?? 'transcription failed' });
    });
    return;
  }

  // Known script + audio in, timed .srt file bytes out (curl -o'able via POST).
  if (req.method === 'POST' && url.pathname === '/api/align') {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 2_000_000) req.destroy();
    });
    req.on('end', () => {
      (async () => {
        let body;
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          sendJson(res, 400, { error: 'invalid JSON body' });
          return;
        }
        const model = body.model ?? WHISPER_MODEL_DEFAULT;
        if (!WHISPER_MODELS.has(model)) {
          sendJson(res, 400, { error: `unknown model "${model}" — one of ${[...WHISPER_MODELS].join(', ')}` });
          return;
        }
        if (typeof body.script !== 'string' || !body.script.trim()) {
          if (typeof body.scriptPath === 'string' && body.scriptPath.trim()) {
            const sp = resolveScriptPath(body.scriptPath);
            if (!sp.ok) {
              sendJson(res, sp.status, { error: sp.error });
              return;
            }
            try {
              const text = fs.readFileSync(sp.file, 'utf8');
              if (!text.trim()) {
                sendJson(res, 400, { error: `script file is empty: ${body.scriptPath}` });
                return;
              }
              if (text.length > SCRIPT_MAX_CHARS) {
                sendJson(res, 400, { error: `script file too long (${text.length} chars, max ${SCRIPT_MAX_CHARS})` });
                return;
              }
              body.script = text;
              // .md script files are markdown: strip formatting before aligning.
              if (sp.file.toLowerCase().endsWith('.md')) body.markdown = true;
            } catch {
              sendJson(res, 500, { error: `could not read script file: ${body.scriptPath}` });
              return;
            }
          } else {
            sendJson(res, 400, { error: 'missing "script" (inline text) or "scriptPath" (repo-relative .txt/.md) — e.g. { "source": "audio/voice.mp3", "script": "At its core, ..." }' });
            return;
          }
        } else if (typeof body.scriptPath === 'string' && body.scriptPath.trim()) {
          sendJson(res, 400, { error: 'pass either "script" or "scriptPath", not both' });
          return;
        }
        if (body.script.length > SCRIPT_MAX_CHARS) {
          sendJson(res, 400, { error: `script too long (${body.script.length} chars, max ${SCRIPT_MAX_CHARS})` });
          return;
        }
        const found = resolveMediaSource(body.source);
        if (!found.ok) {
          sendJson(res, found.status, { error: found.error });
          return;
        }
        try {
          const srt = await alignToSrt(found.file, body.script, model, body.markdown === true);
          const etag = `"${crypto.createHash('sha1').update(srt).digest('hex')}"`;
          if (req.headers['if-none-match'] === etag) {
            res.writeHead(304, { ETag: etag, 'Access-Control-Allow-Origin': '*' });
            res.end();
            return;
          }
          const name = srtDownloadName(found.file);
          res.writeHead(200, {
            'Content-Type': 'application/x-subrip; charset=utf-8',
            'Content-Disposition': `attachment; filename="${name}"`,
            ETag: etag,
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*',
            'Content-Length': srt.length,
          });
          res.end(srt);
        } catch (e) {
          if (!res.writableEnded) sendJson(res, e?.status ?? 500, { error: e?.message ?? 'alignment failed' });
        }
      })().catch((e) => {
        if (!res.writableEnded) sendJson(res, 500, { error: e?.message ?? 'alignment failed' });
      });
    });
    return;
  }

  sendJson(res, 404, {
    error: 'not found',
    hint: 'GET /api/help for the full endpoint list',
  });
});

server.listen(PORT, () => {
  console.log(`[remotion-helper api] listening on http://localhost:${PORT}`);
  console.log(`  agent polls -> GET http://localhost:${PORT}/api/context`);
  console.log(`  agent prompt -> GET http://localhost:${PORT}/api/agent-context`);
});
