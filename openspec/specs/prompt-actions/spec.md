# prompt-actions Specification

## Purpose

TBD - created by archiving change 'v2-4-pwa-listen-client'. Update Purpose after archive.

## Requirements

### Requirement: Prompt action templates loaded from registry/actions.yaml

The system SHALL load named prompt action templates from `registry/actions.yaml` at server startup. The file SHALL declare a top-level `actions:` key whose value is a list of objects, each with the required fields `id` (string, kebab-case, unique within the file), `label` (UTF-8 display string), and `template` (string containing the literal placeholder `{transcript}`).

The loader SHALL emit `ActionTemplate` dataclass instances exposing `id: str`, `label: str`, and `template: str` to the rest of the application. The loader SHALL apply these validation rules:

- **Missing file**: emit a one-line WARNING naming the expected path, return an empty list. The server SHALL still start; `GET /actions` SHALL return an empty `actions: []`.
- **Malformed YAML** (parse failure): emit a one-line WARNING naming the error, return an empty list. The server SHALL still start.
- **Duplicate `id`**: raise a load error naming the duplicate id. The server SHALL refuse to start so the operator notices and fixes the file.
- **Missing `{transcript}` placeholder in `template`**: raise a load error naming the offending action id. The server SHALL refuse to start.
- **Missing required field** (`id`, `label`, or `template`): raise a load error naming the offending entry index and missing field. The server SHALL refuse to start.

The loader SHALL ignore unrecognised top-level keys in the YAML so future extensions can add fields without breaking older deployments.

The repository SHALL ship `registry/actions.yaml` with five built-in actions: `passthrough` (template equals `{transcript}`), `cleanup` (add punctuation / smooth phrasing), `summarize` (整理會議重點 — bullet list), `translate-en` (翻譯成英文), `formalize` (改寫得更專業).

#### Scenario: Built-in actions load successfully on startup

- **WHEN** the server starts with the shipped `registry/actions.yaml`
- **THEN** the loader SHALL return exactly five `ActionTemplate` instances with the ids `passthrough`, `cleanup`, `summarize`, `translate-en`, `formalize`, and no WARNING or error SHALL be emitted

#### Scenario: Duplicate id refuses startup

- **WHEN** the server is started with an `actions.yaml` file containing two entries with the same `id` value
- **THEN** the loader SHALL raise an error naming the duplicate id, and the FastAPI lifespan SHALL fail with a clear startup error

#### Scenario: Missing {transcript} placeholder refuses startup

- **WHEN** the server is started with an `actions.yaml` where one entry's `template` does not contain the literal substring `{transcript}`
- **THEN** the loader SHALL raise an error naming the offending action id, and the FastAPI lifespan SHALL fail with a clear startup error

#### Scenario: Missing file warns but does not fail startup

- **WHEN** the server is started with no `registry/actions.yaml` file present
- **THEN** the loader SHALL emit a one-line WARNING naming the expected path, the server SHALL still complete startup, and `GET /actions` SHALL return `{"actions": []}`


<!-- @trace
source: v2-4-pwa-listen-client
updated: 2026-05-17
code:
  - frontend/package.json
  - app/api/status.py
  - frontend/src/capture/downsample.ts
  - README.md
  - docs/INSTALLATION.md
  - frontend/src/capture/listen-socket.ts
  - docs/HTTPS-TAILSCALE.md
  - frontend/src/ui/transcript-view.ts
  - frontend/src/storage/history-store.ts
  - registry/actions.yaml
  - frontend/src/ui/connection-indicator.ts
  - app/api/actions.py
  - frontend/src/main.ts
  - frontend/CHECKLIST.md
  - frontend/src/capture/audio-worklet.ts
  - app/main.py
  - frontend/src/ui/actions-bar.ts
  - frontend/public/icons/icon-192.png
  - frontend/tsconfig.json
  - frontend/src/capture/mic-pipeline.ts
  - frontend/src/style.css
  - frontend/index.html
  - frontend/src/ui/settings-panel.ts
  - frontend/src/ui/history-panel.ts
  - app/services/actions.py
  - frontend/src/export/subtitle-export.ts
  - CLAUDE.md
  - frontend/src/types/audioworklet.d.ts
  - Makefile
  - frontend/public/icons/icon-512.png
  - frontend/vite.config.ts
tests:
  - frontend/src/export/subtitle-export.test.ts
  - tests/test_actions.py
  - frontend/src/capture/downsample.test.ts
  - frontend/src/ui/ui-components.test.ts
  - frontend/src/ui/actions-and-settings.test.ts
  - frontend/src/storage/history-store.test.ts
  - frontend/src/capture/listen-socket.test.ts
  - tests/test_status.py
-->

---
### Requirement: GET /actions endpoint exposes loaded templates

The system SHALL expose `GET /actions` returning a JSON document of shape `{"actions": [{"id": str, "label": str, "template": str}, ...]}`. The list SHALL contain the same entries the loader produced at startup, in the same order they appear in `registry/actions.yaml`.

The endpoint SHALL be reachable without authentication. There SHALL be no write endpoints: editing the actions registry is performed by editing `registry/actions.yaml` and restarting the server. The endpoint SHALL NOT include any per-user state, timestamps, or pagination — the response is a static reflection of the loaded templates.

#### Scenario: Default registry serves the five built-in actions

- **WHEN** a client requests `GET /actions` on a server started with the shipped `registry/actions.yaml`
- **THEN** the response SHALL be HTTP 200 with `Content-Type: application/json` and the body SHALL be `{"actions": [{...}, ...]}` containing exactly five entries in the order `passthrough`, `cleanup`, `summarize`, `translate-en`, `formalize`, each carrying the literal `id`, `label`, and `template` strings from the YAML

##### Example: response shape

- **GIVEN** the shipped `registry/actions.yaml`
- **WHEN** a client GETs `/actions`
- **THEN** the response body SHALL match the shape:

```json
{
  "actions": [
    {"id": "passthrough", "label": "直接送", "template": "{transcript}"},
    {"id": "cleanup", "label": "加標點 / 改寫流暢", "template": "...{transcript}..."},
    {"id": "summarize", "label": "整理會議重點", "template": "...{transcript}..."},
    {"id": "translate-en", "label": "翻譯成英文", "template": "...{transcript}..."},
    {"id": "formalize", "label": "改寫得更專業", "template": "...{transcript}..."}
  ]
}
```

#### Scenario: Empty registry returns empty list

- **WHEN** the server is started with `registry/actions.yaml` missing AND a client requests `GET /actions`
- **THEN** the response SHALL be HTTP 200 with body `{"actions": []}` and the response SHALL NOT be a 404 or 500

<!-- @trace
source: v2-4-pwa-listen-client
updated: 2026-05-17
code:
  - frontend/package.json
  - app/api/status.py
  - frontend/src/capture/downsample.ts
  - README.md
  - docs/INSTALLATION.md
  - frontend/src/capture/listen-socket.ts
  - docs/HTTPS-TAILSCALE.md
  - frontend/src/ui/transcript-view.ts
  - frontend/src/storage/history-store.ts
  - registry/actions.yaml
  - frontend/src/ui/connection-indicator.ts
  - app/api/actions.py
  - frontend/src/main.ts
  - frontend/CHECKLIST.md
  - frontend/src/capture/audio-worklet.ts
  - app/main.py
  - frontend/src/ui/actions-bar.ts
  - frontend/public/icons/icon-192.png
  - frontend/tsconfig.json
  - frontend/src/capture/mic-pipeline.ts
  - frontend/src/style.css
  - frontend/index.html
  - frontend/src/ui/settings-panel.ts
  - frontend/src/ui/history-panel.ts
  - app/services/actions.py
  - frontend/src/export/subtitle-export.ts
  - CLAUDE.md
  - frontend/src/types/audioworklet.d.ts
  - Makefile
  - frontend/public/icons/icon-512.png
  - frontend/vite.config.ts
tests:
  - frontend/src/export/subtitle-export.test.ts
  - tests/test_actions.py
  - frontend/src/capture/downsample.test.ts
  - frontend/src/ui/ui-components.test.ts
  - frontend/src/ui/actions-and-settings.test.ts
  - frontend/src/storage/history-store.test.ts
  - frontend/src/capture/listen-socket.test.ts
  - tests/test_status.py
-->