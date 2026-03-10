## 1. WhisperClient — Forward inference parameters

- [x] 1.1 [P] Update `WhisperClient.transcribe()` to accept optional `language` and `prompt` keyword arguments and forward them via form data (WhisperClient forwards inference parameters, forward parameters via form data)
- [x] 1.2 [P] Add tests for `WhisperClient.transcribe()` with language and prompt parameters

## 2. API Endpoints — Language parameter and prompt parameter

- [x] 2.1 [P] Add optional `language` query parameter (default `auto`) to `POST /transcribe` and `POST /transcribe-raw`, forwarded to `whisper_client.transcribe()` (language parameter on transcribe endpoints, default language to auto)
- [x] 2.2 [P] Add optional `prompt` query parameter to `POST /transcribe` and `POST /transcribe-raw`, forwarded to `whisper_client.transcribe()` (prompt parameter on transcribe endpoints, prompt as optional with no default)
- [x] 2.3 Add API endpoint tests for language and prompt query parameters on both endpoints
