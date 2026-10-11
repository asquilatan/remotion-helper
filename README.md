# remotion-helper

A little thing I use to help with agent context for animations in Remotion.

Run via `npm run dev:all`.

## API (port 8787)

- `GET /api/help` — full endpoint list, start here.
- `GET /api/health` — liveness check.
- `GET /api/context` — raw `HelperContext` JSON.
- `GET /api/agent-context` — prompt-ready text (`?format=json` for text + raw).
- `POST /api/context` — partial patch, merged + timestamped.
- `POST /api/project` — set `{width?, height?, fps?}` (validated).
- `GET /api/stage-bg` — serves the waypoint stage background image.
- `POST /api/stage-bg` — replace with `{ "image": "data:image/<png|jpeg|webp|gif>;base64,..." }`, or clear with `{ "image": null }`.
- `POST /api/reset` — restore defaults.
