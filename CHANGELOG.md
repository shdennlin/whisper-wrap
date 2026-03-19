# Changelog

All notable changes to this project will be documented in this file.

---

## [v1.2.0] — 2026-03-19

### Developer Changelog

#### Features

- **whisper**: add auto-restart process manager for whisper-server (927e846)
- **config**: enable auto-restart by default and skip managed start if server is healthy (490943d)

#### Bug Fixes

- **transcribe, whisper_manager**: handle `audio/x-m4a` MIME type and external whisper-server processes (9720159)

#### Refactoring

- **whisper**: make server lifecycle async and introduce typed errors (12a190a)

---

### What's New

whisper-wrap can now manage the whisper-server process directly. When the server crashes or becomes unresponsive, whisper-wrap automatically restarts it and retries your transcription request — no manual intervention needed. This feature is enabled out of the box, so existing deployments will benefit immediately after upgrading.

### Fixed

iOS devices that send audio with the `audio/x-m4a` content type will now be handled correctly. Previously, those requests could fail due to an unrecognized MIME type.

The service also now detects whisper-server processes that were started externally (e.g. via `make dev`) and cleans them up properly on shutdown, preventing orphaned processes.

### Improved

The internal whisper-server connection layer was rewritten to be fully asynchronous. Error handling is now backed by distinct exception types (`WhisperServerError`, `WhisperConnectError`, `WhisperTimeoutError`) instead of string matching. A file-handle leak during transcription was also fixed.

---

## [v1.1.0] — 2026-03-10

### Developer Changelog

#### Features

- **registry**: add breeze-asr-25-q8 model and archive multi-model-support change (9fa32b3)
- **forward-language-prompt**: add language/prompt params and punctuation normalization (01a7249)
- Add multi-model support with registry and model manager (8e91e19)

#### Bug Fixes

_None in this release._

#### Documentation

- **openspec**: add multi-model support spec and update README (23f6702)

#### Tests

- **tests**: add tests for language and prompt parameter forwarding (a6d7ee6)

---

### What's New

This release introduces multi-model support, making it easy to select and manage different Whisper models from a central registry. A new `breeze-asr-25-q8` model has been added to the registry alongside the existing default. You can now pass a `language` parameter directly when requesting a transcription, letting the service skip auto-detection and deliver faster, more accurate results for known languages. A `prompt` parameter is also available to guide the model with context or terminology hints.

### Fixed

No user-visible bug fixes in this release.

### Improved

Transcription output is now automatically cleaned up with punctuation normalization, producing more consistent and readable text without extra post-processing on your end. Under the hood, the model manager script and registry configuration make it straightforward to add, switch, and maintain Whisper models as the project grows.

---
