import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const STORE_PATH = path.join(__dirname, 'context.json');

/** The shared context shape. Frontend POSTs partial updates, agents GET it. */
const defaultContext = {
  updatedAt: new Date().toISOString(),
  project: { width: 1920, height: 1080, fps: 30 },
  waypoints: [],
  strokes: [],
  taps: { taps: [], unit: 's' },
  speedCurve: { duration: 1.5, bezier: [0.25, 0.1, 0.25, 1.0] },
  stageBg: null,
};

const BG_MIME_TO_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const BG_MIME_TO_CTYPE = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

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
