<!-- SPECTRA:START v1.0.2 -->

# Spectra Instructions

This project uses Spectra for Spec-Driven Development(SDD). Specs live in `openspec/specs/`, change proposals in `openspec/changes/`.

## Use `/spectra-*` skills when:

- A discussion needs structure before coding → `/spectra-discuss`
- User wants to plan, propose, or design a change → `/spectra-propose`
- Tasks are ready to implement → `/spectra-apply`
- There's an in-progress change to continue → `/spectra-ingest`
- User asks about specs or how something works → `/spectra-ask`
- Implementation is done → `/spectra-archive`
- Commit only files related to a specific change → `/spectra-commit`

## Workflow

discuss? → propose → apply ⇄ ingest → archive

- `discuss` is optional — skip if requirements are clear
- Requirements change mid-work? Plan mode → `ingest` → resume `apply`

## Parked Changes

Changes can be parked（暫存）— temporarily moved out of `openspec/changes/`. Parked changes won't appear in `spectra list` but can be found with `spectra list --parked`. To restore: `spectra unpark <name>`. The `/spectra-apply` and `/spectra-ingest` skills handle parked changes automatically.

<!-- SPECTRA:END -->

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Spec changes go through `/spectra-propose` → `/spectra-apply` → `/spectra-archive` (see the SPECTRA block above). Do not hand-edit `openspec/specs/*/spec.md` — the archive step rebuilds them from the change deltas.

## Project Overview

whisper-wrap is the open-core (GPLv3) home of the v3 **Rust engine** for audio
transcription, live captioning, and LLM-backed Q&A, plus the PWA frontend that
is its reference client. The closed macOS desktop shell lives separately in the
private umbrella repo and runs the engine as an out-of-process sidecar.

```
engine/          Rust cargo workspace (GPLv3) — the open core
  core/          ASR, audio, VAD, diarization, registry, streaming
  server/        HTTP/WebSocket API server (whisper-wrap-server binary)
  cli/           command-line front-end (whisper-wrap-cli binary)
  scripts/       license-guard.sh — asserts core/server/cli are GPLv3
frontend/        Vite + TypeScript PWA → builds to app/static/app/
registry/        models.yaml + actions.yaml
```

> **Note:** This file is an interim stub. The previous body documented the
> retired v2 Python/FastAPI server, which has been removed. A full v3
> contributor guide is a pending follow-up; until then see `AGENTS.md`, the
> per-crate sources under `engine/`, and the umbrella-root `Makefile` for the
> build/run/test targets.

## Build, test & run

The engine builds and runs from this repo; the integrated targets (frontend +
engine, desktop bundling) live in the umbrella-root `Makefile`.

```bash
cd engine && cargo build --release          # build the open-core engine
cd engine && cargo test -p whisper-wrap-server   # server integration tests
cd frontend && bun install && bun run build # rebuild the PWA bundle → app/static/app/
```
