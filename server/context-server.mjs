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
  taps: { taps: [], unit: 's' },
  speedCurve: { duration: 1.5, bezier: [0.25, 0.1, 0.25, 1.0] },
};

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
  const taps = ctx.taps?.taps ?? [];
  const sc = ctx.speedCurve ?? {};
  const lines = [
    `# remotion-helper live context (${ctx.updatedAt})`,
    `project: ${ctx.project?.width}x${ctx.project?.height} @ ${ctx.project?.fps}fps`,
    ``,
    `## waypoints (${wp.length}) — x,y normalized 0..1, px for project size`,
    ...wp.map((w, i) => {
      const px = Math.round(w.x * (ctx.project?.width ?? 1920));
      const py = Math.round(w.y * (ctx.project?.height ?? 1080));
      return `- [${i}] ${w.label ?? w.id} :: x=${w.x.toFixed(4)} y=${w.y.toFixed(4)} (${px},${py}px)`;
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
    context = save(structuredClone(defaultContext));
    sendJson(res, 200, context);
    return;
  }

  sendJson(res, 404, {
    error: 'not found',
    hint: 'GET /api/context | GET /api/agent-context | POST /api/context',
  });
});

server.listen(PORT, () => {
  console.log(`[remotion-helper api] listening on http://localhost:${PORT}`);
  console.log(`  agent polls -> GET http://localhost:${PORT}/api/context`);
  console.log(`  agent prompt -> GET http://localhost:${PORT}/api/agent-context`);
});
