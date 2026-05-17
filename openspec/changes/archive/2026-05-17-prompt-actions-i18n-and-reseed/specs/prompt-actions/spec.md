## MODIFIED Requirements

### Requirement: Prompt action templates loaded from registry/actions.yaml

The system SHALL load named prompt action templates from `registry/actions.yaml` at server startup. The file SHALL declare a top-level `actions:` key whose value is a list of objects, each with the required fields `id` (string, kebab-case, unique within the file), `label`, and `template` (string containing the literal placeholder `{transcript}`).

The `label` field SHALL be either:
- a **string** — interpreted as shorthand for the single-locale mapping `{en: <string>}`, OR
- a **mapping** of locale code (string) to display string (UTF-8). Locale codes SHALL be passed through as written; the loader SHALL NOT reject unknown locale keys.

The loader SHALL emit `ActionTemplate` dataclass instances exposing `id: str`, `label: str`, `labels: Mapping[str, str]`, and `template: str` to the rest of the application. The `labels` field SHALL always be a non-empty mapping. The `label` field SHALL be set to `labels["en"]` when present, else to the first value of `labels` in YAML insertion order.

The loader SHALL apply these validation rules:

- **Missing file**: emit a one-line WARNING naming the expected path, return an empty list. The server SHALL still start; `GET /actions` SHALL return an empty `actions: []`.
- **Malformed YAML** (parse failure): emit a one-line WARNING naming the error, return an empty list. The server SHALL still start.
- **Duplicate `id`**: raise a load error naming the duplicate id. The server SHALL refuse to start so the operator notices and fixes the file.
- **Missing `{transcript}` placeholder in `template`**: raise a load error naming the offending action id. The server SHALL refuse to start.
- **Missing required field** (`id`, `label`, or `template`): raise a load error naming the offending entry index and missing field. The server SHALL refuse to start.
- **Label is neither a string nor a mapping** (e.g., list, number, null): raise a load error naming the offending action id and the actual type. The server SHALL refuse to start.
- **Label is an empty string**: raise a load error naming the offending action id (covered by the existing "missing required field" path).
- **Label mapping is empty** (`label: {}`): raise a load error naming the offending action id. The server SHALL refuse to start.
- **Label mapping value is not a string** (e.g., `label: {en: 42}`): raise a load error naming the offending action id and the offending locale key. The server SHALL refuse to start.

The loader SHALL ignore unrecognised top-level keys in the YAML so future extensions can add fields without breaking older deployments.

The repository SHALL ship `registry/actions.yaml` with seven built-in actions in this exact order: `passthrough` (template equals `{transcript}`), `cleanup-light` (light cleanup that removes fillers and fixes ASR errors without adding punctuation), `punctuate` (adds Chinese or English punctuation based on dominant language plus ASR fixes), `polish` (rewrites for clarity with hard constraints against hallucination), `meeting-notes` (chief-of-staff structured meeting summary with key decisions, action items table, and discussion highlights), `translate-en` (translate to natural English), `formalize` (rewrite to formal written tone). Each shipped action SHALL provide bilingual labels with at least `en` and `zh-TW` keys.

#### Scenario: Built-in actions load successfully on startup

- **WHEN** the server starts with the shipped `registry/actions.yaml`
- **THEN** the loader SHALL return exactly seven `ActionTemplate` instances with the ids `passthrough`, `cleanup-light`, `punctuate`, `polish`, `meeting-notes`, `translate-en`, `formalize` in that order, each with a `labels` mapping containing at least `en` and `zh-TW` keys, and no WARNING or error SHALL be emitted

#### Scenario: String label normalizes to en-only mapping

- **WHEN** the loader reads an action with `label: "Send as-is"` (string shorthand)
- **THEN** the resulting `ActionTemplate.labels` SHALL equal `{"en": "Send as-is"}` and `ActionTemplate.label` SHALL equal `"Send as-is"`

#### Scenario: Bilingual mapping label loaded verbatim

- **WHEN** the loader reads an action with `label: {en: "Send as-is", "zh-TW": "直接送"}`
- **THEN** the resulting `ActionTemplate.labels` SHALL contain both locale keys with their string values, and `ActionTemplate.label` SHALL equal `"Send as-is"`

##### Example: label-form normalization

| YAML `label`                                        | Resulting `labels`                                  | Resulting `label`     |
| --------------------------------------------------- | --------------------------------------------------- | --------------------- |
| `"直接送"`                                          | `{"en": "直接送"}`                                  | `"直接送"`            |
| `{en: "Send as-is", "zh-TW": "直接送"}`             | `{"en": "Send as-is", "zh-TW": "直接送"}`           | `"Send as-is"`        |
| `{"zh-TW": "直接送"}`                               | `{"zh-TW": "直接送"}`                               | `"直接送"`            |
| `{en: "Send", fr: "Envoyer"}`                       | `{"en": "Send", "fr": "Envoyer"}`                   | `"Send"`              |

#### Scenario: Empty label mapping refuses startup

- **WHEN** the server is started with an `actions.yaml` where one entry has `label: {}`
- **THEN** the loader SHALL raise a load error naming the offending action id, and the FastAPI lifespan SHALL fail with a clear startup error

#### Scenario: Non-string label-mapping value refuses startup

- **WHEN** the server is started with an `actions.yaml` where one entry has `label: {en: 42}` (or any non-string value)
- **THEN** the loader SHALL raise a load error naming the offending action id and the offending locale key, and the FastAPI lifespan SHALL fail with a clear startup error

#### Scenario: Unknown locale key is accepted

- **WHEN** the server is started with an `actions.yaml` where one entry has `label: {fr: "Envoyer"}` (a locale not in the PWA's `AVAILABLE_LOCALES`)
- **THEN** the loader SHALL accept the entry without error, `ActionTemplate.labels` SHALL contain `fr` verbatim, and the server SHALL complete startup successfully

#### Scenario: Duplicate id refuses startup

- **WHEN** the server is started with an `actions.yaml` file containing two entries with the same `id` value
- **THEN** the loader SHALL raise an error naming the duplicate id, and the FastAPI lifespan SHALL fail with a clear startup error

#### Scenario: Missing {transcript} placeholder refuses startup

- **WHEN** the server is started with an `actions.yaml` where one entry's `template` does not contain the literal substring `{transcript}`
- **THEN** the loader SHALL raise an error naming the offending action id, and the FastAPI lifespan SHALL fail with a clear startup error

#### Scenario: Missing file warns but does not fail startup

- **WHEN** the server is started with no `registry/actions.yaml` file present
- **THEN** the loader SHALL emit a one-line WARNING naming the expected path, the server SHALL still complete startup, and `GET /actions` SHALL return `{"actions": []}`

### Requirement: GET /actions endpoint exposes loaded templates

The system SHALL expose `GET /actions` returning a JSON document of shape `{"actions": [{"id": str, "label": str, "labels": {<locale>: str, ...}, "template": str}, ...]}`. The list SHALL contain the same entries the loader produced at startup, in the same order they appear in `registry/actions.yaml`.

Each entry SHALL include both:
- `label`: a single string set to `labels["en"]` when present, else to the first value of `labels` in insertion order. Kept for compatibility with clients that read the single-string field.
- `labels`: a mapping of locale code to display string, always non-empty. This is the canonical localized label set.

The endpoint SHALL be reachable without authentication. There SHALL be no write endpoints: editing the actions registry is performed by editing `registry/actions.yaml` and restarting the server. The endpoint SHALL NOT include any per-user state, timestamps, or pagination — the response is a static reflection of the loaded templates. The endpoint SHALL NOT perform locale negotiation based on the request `Accept-Language` header; the same response is returned regardless of client locale.

#### Scenario: Default registry serves the seven built-in actions

- **WHEN** a client requests `GET /actions` on a server started with the shipped `registry/actions.yaml`
- **THEN** the response SHALL be HTTP 200 with `Content-Type: application/json` and the body SHALL be `{"actions": [{...}, ...]}` containing exactly seven entries in the order `passthrough`, `cleanup-light`, `punctuate`, `polish`, `meeting-notes`, `translate-en`, `formalize`, each carrying the literal `id`, `label`, `labels`, and `template` fields derived from the YAML

##### Example: response shape

- **GIVEN** the shipped `registry/actions.yaml` with bilingual labels for every action
- **WHEN** a client GETs `/actions`
- **THEN** the response body SHALL match the shape:

```json
{
  "actions": [
    {
      "id": "passthrough",
      "label": "Send as-is",
      "labels": {"en": "Send as-is", "zh-TW": "直接送"},
      "template": "{transcript}"
    },
    {
      "id": "cleanup-light",
      "label": "Light cleanup (no punctuation)",
      "labels": {"en": "Light cleanup (no punctuation)", "zh-TW": "輕度整理（不加標點）"},
      "template": "...{transcript}..."
    }
  ]
}
```

#### Scenario: Empty registry returns empty list

- **WHEN** the server is started with `registry/actions.yaml` missing AND a client requests `GET /actions`
- **THEN** the response SHALL be HTTP 200 with body `{"actions": []}` and the response SHALL NOT be a 404 or 500

#### Scenario: Same response regardless of Accept-Language

- **WHEN** two clients request `GET /actions` from the same server, one sending `Accept-Language: en` and the other sending `Accept-Language: zh-TW`
- **THEN** both clients SHALL receive byte-identical JSON bodies containing the full `labels` mapping for every action

## ADDED Requirements

### Requirement: PWA chip bar renders the active-locale label with deterministic fallback

The PWA's Actions chip bar (`frontend/src/ui/actions-bar.ts`) SHALL render each chip's text by resolving the active locale's label from the `/actions` response using this fallback chain, in order:

1. `action.labels[activeLocale]` — where `activeLocale` is the value returned by the PWA i18n runtime's `getLocale()`.
2. `action.labels["en"]` — the default-locale fallback.
3. The first value of `action.labels` in iteration order.
4. `action.label` — for back-compat with a response that omits the `labels` field entirely.
5. `action.id` — last-resort so a chip never renders blank.

The chip bar SHALL NOT issue a network request to re-fetch `/actions` when the locale changes; the existing page-reload-on-locale-change flow re-fetches naturally.

When the `/actions` endpoint is unreachable or returns an empty list, the chip bar SHALL fall back to a single built-in `passthrough` chip whose label is the i18n string key `actions.passthroughLabel` (resolved through the existing `t()` runtime). This preserves the v2.4 fallback behavior.

#### Scenario: Active-locale label renders when present

- **WHEN** the PWA renders chips with `activeLocale = "zh-TW"` and an action whose `labels = {en: "Send as-is", "zh-TW": "直接送"}`
- **THEN** the chip's text content SHALL equal `"直接送"`

#### Scenario: Falls back to en when active locale is missing

- **WHEN** the PWA renders chips with `activeLocale = "zh-TW"` and an action whose `labels = {en: "Send as-is"}` (no `zh-TW` key)
- **THEN** the chip's text content SHALL equal `"Send as-is"`

#### Scenario: Falls back to label string when labels field is absent

- **WHEN** the PWA renders chips against an `/actions` response that returns each entry without a `labels` field (e.g., an older or stripped proxy response) and an action has `label: "Send as-is"`
- **THEN** the chip's text content SHALL equal `"Send as-is"`

##### Example: fallback chain

| activeLocale | `action.labels`                   | `action.label` | chip text     |
| ------------ | --------------------------------- | -------------- | ------------- |
| `"en"`       | `{en: "Send", "zh-TW": "送出"}`   | `"Send"`       | `"Send"`      |
| `"zh-TW"`    | `{en: "Send", "zh-TW": "送出"}`   | `"Send"`       | `"送出"`      |
| `"zh-TW"`    | `{en: "Send"}`                    | `"Send"`       | `"Send"`      |
| `"en"`       | `{"zh-TW": "送出"}`               | `"送出"`       | `"送出"`      |
| `"en"`       | `undefined`                       | `"Send"`       | `"Send"`      |
| `"en"`       | `{}` (impossible from server)     | `undefined`    | `action.id`   |
