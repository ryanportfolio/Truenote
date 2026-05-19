# Project-Specific Pitfalls

> Living list. Grows via `/recall save <text>` when something bites you. Read before non-trivial work.

## 2026-05-19 — Replit reserves port 5000 for the webview

The donor `.env.example` defaulted `API_PORT=5000` and `PORT=5173` (Express + Vite local-dev convention). On Replit, **port 5000 is reserved for the public webview** — the rag-app (Vite) must bind 5000 to be reachable, and the api-server has to move.

Working configuration verified end-to-end Phase 1 smoke (2026-05-19):

```
PORT=5000        # rag-app (Vite) — webview, externally exposed
API_PORT=3001    # api-server (Express) — internal only
```

Why it just works without code changes: `artifacts/rag-app/vite.config.ts` reads `API_PORT` at startup and configures the `/api` proxy target accordingly. The frontend doesn't need to know the api-server port at build time.

Side effects to remember:
- `curl /health` smoke tests have to hit `localhost:3001` (or whatever `API_PORT` is set to) from inside the repl — Vite's proxy only forwards `/api/*`, not `/health`.
- If a workflow refuses to start with EADDRINUSE on 5000, that's the webview slot, not a stale process. Use a different port for everything except the public frontend.
