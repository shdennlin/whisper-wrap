# API Reference

**English** | [繁體中文](API.zh-TW.md)

The whisper-wrap engine exposes an HTTP/WebSocket/SSE API for transcription,
live captioning, meeting jobs, history, model management, and LLM-backed Q&A.

The **authoritative, machine-readable contract** is the OpenAPI 3.1 document —
this page is only a pointer to it. Do not hand-maintain an endpoint catalog
here; it drifts. The document is generated from the router itself, so it is
always in sync with the running code.

## The OpenAPI contract

- **Checked-in artifact:** [`openapi.json`](openapi.json) in this directory — the
  full OpenAPI 3.1 spec covering every route (paths, parameters, request/response
  shapes, error responses, and the `engine_token` security scheme). Feed it to a
  client generator, an API explorer, or import it into Postman/Insomnia.
- **Interactive explorer (dev builds only):** a debug build serves a
  [Scalar](https://scalar.com) UI at **`GET /docs`** and the raw spec at
  **`GET /openapi.json`**. These routes are compiled out of release builds
  (`make server` / `make desktop`), so a shipped binary returns `404` for both —
  read the checked-in `openapi.json` instead.

  > Under `make dev`, reach these on the **engine's own port** (`API_PORT`,
  > default `12000` in the dev loop) — e.g. `http://localhost:12000/docs` — not
  > the Vite dev server at `:5173`. Vite serves the PWA under `/app/` and only
  > proxies the API routes the frontend calls; `/docs` and `/openapi.json` are
  > not on that allowlist, so `:5173/docs` won't reach the engine.

Regenerate the checked-in artifact after changing any route or schema:

```bash
cd engine
cargo run -p whisper-wrap-server --bin whisper-wrap-server -- --dump-openapi ../docs/openapi.json
```

A golden-file test fails CI if `openapi.json` is out of sync with the router.

## Base URL

```
http://localhost:8000
```

The port is `API_PORT` (default `8000`); the host is `API_HOST` (default
`0.0.0.0`).

## Authentication

Authentication is **optional** and off by default. When the engine is started
with a non-empty `ENGINE_TOKEN` (the desktop shell sets this for its sidecar),
every route except `GET /`, `GET /status`, `GET /openapi.json`, `GET /docs`, and
the `/app/*` bundle requires the token, presented as **either**:

- an `Authorization: Bearer <token>` header, **or**
- an `engine_token` cookie (the `/app` response sets this for the webview).

Without a valid token these routes return `401`. When `ENGINE_TOKEN` is unset
(self-host / web), the gate is inert and all routes are open.

## Configuration (environment variables)

| Variable | Default | Purpose |
| --- | --- | --- |
| `API_PORT` | `8000` | HTTP listen port |
| `API_HOST` | `0.0.0.0` | HTTP listen host |
| `ENGINE_TOKEN` | _(unset)_ | Enables the auth gate when set |
| `DATA_DIR` | `data` | History DB + stored audio |
| `MODELS_DIR` | `models` | Downloaded model weights |
| `MODEL_NAME` | `breeze-asr-25` | Active ASR model on boot |
| `MAX_FILE_SIZE_MB` | `100` | Upload size limit |

See `engine/core/src/config.rs` for the full set (LLM provider, diarization
paths, meeting-job limits, etc.).
