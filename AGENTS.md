# AGENTS.md — remotion-helper

Helper tool for editing Remotion videos: waypoint picker, tap timer, speed-curve
builder. React + Vite frontend, zero-dependency Node backend.

## Run

- `npm run dev:all` — API (:8787) + frontend (:5173) together (uses `concurrently`)
- `npm run dev:api` — backend only · `npm run dev` — frontend only
- `npm run build` — `tsc -b && vite build`; must pass before committing

## Architecture

- `src/App.tsx` — owns all state (project, waypoints, taps, speedCurve), tab layout
- `src/components/` — one file per tool: `WaypointPicker` (+ shared `WaypointStage`),
  `TapTimer`, `SpeedCurveBuilder`, `MarkerPlane3D` (three.js, local scene state only)
- `src/types.ts` — `HelperContext` is the shared contract; change it with care
- `src/lib/remotionExport.ts` — Remotion snippet formatters · `src/lib/contextSync.ts` — backend push
- `server/context-server.mjs` — plain-Node API, persists to `server/context.json`

## Agent API (source of truth for external agents)

- `GET :8787/api/help` — self-description of every endpoint (point unknown agents here first)
- `GET :8787/api/context` — raw `HelperContext` JSON (project, waypoints, strokes, markers3d, surface, planeView, taps, speedCurve, stageBg)
- `GET :8787/api/agent-context` — prompt-ready text (`?format=json` for text + raw)
- `POST /api/context` — partial patch, merged + timestamped
- `POST /api/stage-bg` — `{ "image": "data:image/<png|jpeg|webp|gif>;base64,..." }` replaces the
  waypoint stage background (or `{ "image": null }` to clear); file served at `GET /api/stage-bg`
- `POST /api/reset` — restore defaults (use sparingly)

## Frontend → backend sync

Frontend is the writer: `App` pushes state via debounced `POST /api/context`.
External agents are readers — never have the agent write context directly while the
UI is open, or the next UI push will overwrite it.

## Performance rule

Interactive gestures (curve-handle drags, stage clicks) must use **local transient
state** and commit to parent/backend once on release. Never `setState` up to `App`
(or trigger a backend push) per pointermove — see `SpeedCurveBuilder` draft pattern.

## Commits

**Atomic commits required.** One logical change per commit (e.g. one tool's behavior,
one endpoint, one fix). Before committing: `npm run build` clean, no stray changes
(`git status`), no secrets, no `dist/` or `node_modules/`. Message format:
`<area>: <what changed>` — e.g. `curve: commit bezier on pointer release`.
