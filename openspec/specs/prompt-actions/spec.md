# prompt-actions Specification

## Purpose

TBD - created by archiving change 'v2-4-pwa-listen-client'. Update Purpose after archive.

## Requirements

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


<!-- @trace
source: prompt-actions-i18n-and-reseed
updated: 2026-05-17
code:
  - registry/actions.yaml
  - frontend/src/main.ts
  - frontend/src/ui/history-panel.ts
  - frontend/src/i18n/strings.ts
  - frontend/src/ui/settings-panel.ts
  - frontend/src/ui/actions-bar.ts
  - app/api/actions.py
  - app/main.py
  - frontend/src/style.css
  - app/services/actions.py
tests:
  - frontend/src/i18n/index.test.ts
  - tests/test_actions.py
  - frontend/src/ui/actions-and-settings.test.ts
-->

---
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


<!-- @trace
source: prompt-actions-i18n-and-reseed
updated: 2026-05-17
code:
  - registry/actions.yaml
  - frontend/src/main.ts
  - frontend/src/ui/history-panel.ts
  - frontend/src/i18n/strings.ts
  - frontend/src/ui/settings-panel.ts
  - frontend/src/ui/actions-bar.ts
  - app/api/actions.py
  - app/main.py
  - frontend/src/style.css
  - app/services/actions.py
tests:
  - frontend/src/i18n/index.test.ts
  - tests/test_actions.py
  - frontend/src/ui/actions-and-settings.test.ts
-->

---
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

<!-- @trace
source: prompt-actions-i18n-and-reseed
updated: 2026-05-17
code:
  - registry/actions.yaml
  - frontend/src/main.ts
  - frontend/src/ui/history-panel.ts
  - frontend/src/i18n/strings.ts
  - frontend/src/ui/settings-panel.ts
  - frontend/src/ui/actions-bar.ts
  - app/api/actions.py
  - app/main.py
  - frontend/src/style.css
  - app/services/actions.py
tests:
  - frontend/src/i18n/index.test.ts
  - tests/test_actions.py
  - frontend/src/ui/actions-and-settings.test.ts
-->

---
### Requirement: Action entries SHALL support an optional category field with bilingual display label

Each entry in `registry/actions.yaml` MAY include a `category` field. The field follows the same string-or-mapping shape used by `label`:

- a **string** — interpreted as a kebab-case category id (e.g., `category: cleanup`). Equivalent to a mapping whose `en` value is the same string and whose id is also that string.
- a **mapping** — MUST include an `id` (kebab-case string, used for grouping comparisons) plus a `labels` sub-mapping of locale code → display string. Example:
  ```yaml
  category:
    id: cleanup
    labels:
      en: Cleanup
      zh-TW: 清理
  ```

Validation rules applied by the loader:
- `category` is OPTIONAL. Entries without a `category` SHALL be exposed as `category: null` / `categoryLabels: null` over the API.
- Invalid `category` type (neither string nor mapping) SHALL raise `ActionRegistryError`. The server SHALL refuse to start.
- A mapping `category` missing the `id` key SHALL raise `ActionRegistryError`.
- A mapping `category` with an empty `labels` sub-mapping, or with non-string `labels` values, SHALL raise `ActionRegistryError`. Same shape rules as `label`.
- A `category` whose id is not listed in the top-level `categories:` block SHALL emit a one-line WARNING naming the entry id and the unknown category id, but the entry SHALL still load and the category SHALL be passed through to clients. This is intentional so operators can stage new categories without lock-step changes.

The loaded `ActionTemplate` SHALL expose `category: str | None` (the resolved id) and `category_labels: Mapping[str, str] | None` (always non-empty when `category` is non-null; absent locale keys are NOT auto-filled).

#### Scenario: String category is normalised to id with no display labels

- **WHEN** the loader reads `category: cleanup` on an action
- **THEN** the resulting `ActionTemplate.category` SHALL equal `"cleanup"` and `ActionTemplate.category_labels` SHALL be `None` so the frontend falls back to the top-level `categories:` block for the display string

#### Scenario: Mapping category is loaded verbatim

- **WHEN** the loader reads `category: {id: cleanup, labels: {en: Cleanup, "zh-TW": 清理}}` on an action
- **THEN** `ActionTemplate.category` SHALL equal `"cleanup"` and `ActionTemplate.category_labels` SHALL equal `{"en": "Cleanup", "zh-TW": "清理"}`

#### Scenario: Action without category produces null fields

- **WHEN** the loader reads an action with no `category` key
- **THEN** `ActionTemplate.category` SHALL be `None` and `ActionTemplate.category_labels` SHALL be `None`

#### Scenario: Unknown category id warns but does not block startup

- **WHEN** the loader reads an action whose `category: experimental` does not appear in the top-level `categories:` list
- **THEN** the loader SHALL emit a one-line WARNING naming the action id and the unknown category id, the entry SHALL still load successfully, the server SHALL complete startup, and the API SHALL return the action with `category: "experimental"`

#### Scenario: Invalid category type refuses startup

- **WHEN** the loader reads `category: 42` (number) or `category: [a, b]` (list)
- **THEN** the loader SHALL raise `ActionRegistryError` naming the offending action id and the actual type, and the FastAPI lifespan SHALL fail with a clear startup error


<!-- @trace
source: prompt-actions-categories-and-more-chips
updated: 2026-05-17
code:
  - app/main.py
  - frontend/src/ui/actions-bar.ts
  - frontend/src/ui/history-panel.ts
  - frontend/src/main.ts
  - frontend/src/i18n/strings.ts
  - frontend/src/style.css
  - app/api/actions.py
  - app/services/actions.py
  - registry/actions.yaml
  - frontend/src/ui/settings-panel.ts
tests:
  - frontend/src/i18n/index.test.ts
  - tests/test_actions.py
  - frontend/src/ui/actions-and-settings.test.ts
-->

---
### Requirement: Registry SHALL declare category display order and bilingual labels

`registry/actions.yaml` MAY include an OPTIONAL top-level `categories:` list that pins the display order and bilingual labels of categories. Each entry has:

- `id`: kebab-case string. MUST match the `category` id used by entries in `actions:` for those entries to render under this group's heading.
- `label`: string OR bilingual mapping (same shape as action `label`).

The list determines:
- **Display order** in the PWA chip bar (top-down rendering).
- **Heading text** rendered above each group, picked by the active locale via the existing label fallback chain.

Validation rules:
- The block is OPTIONAL. When absent or empty, the API SHALL return `categories: []` and the PWA SHALL fall back to rendering all chips under a single localised "Misc" heading.
- Duplicate `id` values in `categories:` SHALL raise `ActionRegistryError`. The server SHALL refuse to start.
- Each `id` MUST be a non-empty kebab-case string; missing or empty `id` SHALL raise `ActionRegistryError`.
- Each `label` MUST follow the action-label string-or-mapping rules (empty mapping, non-string values, or neither-string-nor-mapping types SHALL raise `ActionRegistryError`).
- Category ids referenced by `actions[*].category` but absent from `categories:` SHALL emit a WARNING (per the previous requirement) but SHALL NOT block startup.

The loader SHALL expose `load_categories(path)` returning an ordered list of `CategoryDefinition` instances each with `id: str`, `label: str` (legacy single string, en-preferred), and `labels: Mapping[str, str]` (always non-empty).

#### Scenario: Shipped registry declares four categories in display order

- **WHEN** the server starts with the shipped `registry/actions.yaml`
- **THEN** `load_categories(...)` SHALL return four definitions in this exact order: `raw`, `cleanup`, `structure`, `transform`, each with a non-empty bilingual `labels` mapping containing both `en` and `zh-TW`

#### Scenario: Duplicate category id refuses startup

- **WHEN** the server is started with a `categories:` block containing two entries whose `id` is `"cleanup"`
- **THEN** the loader SHALL raise `ActionRegistryError` naming the duplicate id, and the FastAPI lifespan SHALL fail with a clear startup error

#### Scenario: Empty categories block returns empty list

- **WHEN** the server is started with `categories: []` and at least one action that has no `category` field
- **THEN** `GET /actions` SHALL return `categories: []` and every action SHALL carry `category: null`


<!-- @trace
source: prompt-actions-categories-and-more-chips
updated: 2026-05-17
code:
  - app/main.py
  - frontend/src/ui/actions-bar.ts
  - frontend/src/ui/history-panel.ts
  - frontend/src/main.ts
  - frontend/src/i18n/strings.ts
  - frontend/src/style.css
  - app/api/actions.py
  - app/services/actions.py
  - registry/actions.yaml
  - frontend/src/ui/settings-panel.ts
tests:
  - frontend/src/i18n/index.test.ts
  - tests/test_actions.py
  - frontend/src/ui/actions-and-settings.test.ts
-->

---
### Requirement: GET /actions SHALL surface category information for client-side grouping

The system SHALL extend the `GET /actions` JSON response with:
- **Per-entry** `category: <id-string> | null` — the resolved category id (string form), `null` for actions without a category. Frontends SHALL use this id (not display labels) for grouping comparisons.
- **Per-entry** `categoryLabels: {<locale>: <string>, ...} | null` — bilingual display labels lifted from a mapping-form `category`. `null` when the entry used the string-form `category` or had no `category`.
- **Top-level** `categories: [{id: <string>, label: <string>, labels: {<locale>: <string>, ...}}, ...]` — reflects the YAML `categories:` block in declared order. Each entry SHALL include the same back-compat `label` legacy single string used by action labels. Empty array when no top-level block is declared.

Existing per-entry fields (`id`, `label`, `labels`, `template`) and the response container shape (`{"actions": [...]}`) SHALL remain unchanged. Adding the new fields SHALL NOT break clients that ignore unknown keys.

The endpoint SHALL continue to ignore `Accept-Language`; two clients receive byte-identical bodies for the same registry.

#### Scenario: Per-entry category id appears alongside existing label fields

- **WHEN** a client requests `GET /actions` on a server whose shipped registry assigns `category: cleanup` to four actions
- **THEN** every action in the response SHALL carry a `category` field, those four SHALL have `category: "cleanup"`, and at least one action with no YAML `category` SHALL carry `category: null`

#### Scenario: Top-level categories array reflects declared order

- **WHEN** a client requests `GET /actions` on a server whose shipped registry declares `categories:` in the order `raw`, `cleanup`, `structure`, `transform`
- **THEN** the response body SHALL contain `categories: [{id: "raw", ...}, {id: "cleanup", ...}, {id: "structure", ...}, {id: "transform", ...}]` in that exact order, each entry carrying `label` and `labels` per the action-label legacy rule

##### Example: response shape with categories

- **GIVEN** the shipped `registry/actions.yaml`
- **WHEN** a client GETs `/actions`
- **THEN** the response body SHALL match the shape:

```json
{
  "actions": [
    {
      "id": "passthrough",
      "label": "Send as-is",
      "labels": {"en": "Send as-is", "zh-TW": "直接送"},
      "category": "raw",
      "categoryLabels": null,
      "template": "{transcript}"
    }
  ],
  "categories": [
    {"id": "raw", "label": "Raw", "labels": {"en": "Raw", "zh-TW": "原文"}},
    {"id": "cleanup", "label": "Cleanup", "labels": {"en": "Cleanup", "zh-TW": "清理"}},
    {"id": "structure", "label": "Structure", "labels": {"en": "Structure", "zh-TW": "結構化"}},
    {"id": "transform", "label": "Transform", "labels": {"en": "Transform", "zh-TW": "轉換"}}
  ]
}
```


<!-- @trace
source: prompt-actions-categories-and-more-chips
updated: 2026-05-17
code:
  - app/main.py
  - frontend/src/ui/actions-bar.ts
  - frontend/src/ui/history-panel.ts
  - frontend/src/main.ts
  - frontend/src/i18n/strings.ts
  - frontend/src/style.css
  - app/api/actions.py
  - app/services/actions.py
  - registry/actions.yaml
  - frontend/src/ui/settings-panel.ts
tests:
  - frontend/src/i18n/index.test.ts
  - tests/test_actions.py
  - frontend/src/ui/actions-and-settings.test.ts
-->

---
### Requirement: PWA chip bar SHALL render chips grouped by category in the declared order

The PWA's Actions chip bar SHALL group fetched chips by their per-entry `category` id and render each group as a labelled section. Behavior:

- Section render order SHALL follow the top-level `categories` array order from `GET /actions`.
- Each group SHALL render a small heading element above its chips. The heading text SHALL be resolved using the existing locale-fallback chain (`labels[active] → labels.en → first → action's `categoryLabels` if non-null and entry-specific → category id`).
- Chips whose `category` is `null`, or whose `category` id does not appear in the top-level `categories` array, SHALL be collected into a single trailing "Misc" group whose heading is sourced from the i18n string `actions.miscCategoryLabel`.
- The empty-registry fallback (single `passthrough` chip from `t("actions.passthroughLabel")`) SHALL NOT render any category heading.
- Chip text resolution rules from the previous change remain unchanged — only the layout adds category headings.

#### Scenario: Shipped registry renders four category sections in order

- **WHEN** the PWA loads `/actions` populated with the shipped seventeen-chip registry and four-category block
- **THEN** the chip bar SHALL contain four heading-plus-chips sections in this order: `raw`, `cleanup`, `structure`, `transform`, with no "Misc" section because every chip has a known category

#### Scenario: Chip with unknown category falls into Misc

- **WHEN** the PWA loads `/actions` containing one chip with `category: "experimental"` while the top-level `categories` array does not list `experimental`
- **THEN** the chip SHALL render under a trailing "Misc" group whose heading text equals `t("actions.miscCategoryLabel")`

#### Scenario: Empty categories block hides headings entirely

- **WHEN** the PWA loads `/actions` whose top-level `categories` array is empty AND every chip has `category: null`
- **THEN** the chip bar SHALL render all chips under a single trailing "Misc" group, and no other heading SHALL appear

##### Example: rendered group order

| Group order  | Heading text (en)  | Heading text (zh-TW) | Chip ids                                                                                              |
| ------------ | ------------------ | -------------------- | ----------------------------------------------------------------------------------------------------- |
| 1            | Raw                | 原文                 | passthrough                                                                                           |
| 2            | Cleanup            | 清理                 | fix-only-asr, cleanup-light, punctuate, polish                                                        |
| 3            | Structure          | 結構化               | meeting-notes, summary-tldr, bullet-outline, extract-todos, questions-raised, code-spec, 1on1-notes, standup-recap |
| 4            | Transform          | 轉換                 | translate-en, translate-zh, formalize, email-draft                                                    |


<!-- @trace
source: prompt-actions-categories-and-more-chips
updated: 2026-05-17
code:
  - app/main.py
  - frontend/src/ui/actions-bar.ts
  - frontend/src/ui/history-panel.ts
  - frontend/src/main.ts
  - frontend/src/i18n/strings.ts
  - frontend/src/style.css
  - app/api/actions.py
  - app/services/actions.py
  - registry/actions.yaml
  - frontend/src/ui/settings-panel.ts
tests:
  - frontend/src/i18n/index.test.ts
  - tests/test_actions.py
  - frontend/src/ui/actions-and-settings.test.ts
-->

---
### Requirement: Shipped registry SHALL include ten additional chips across the four categories

The repository SHALL update `registry/actions.yaml` to ship **seventeen** actions in this order with bilingual labels and the assigned category. The seven existing chips from the previous change SHALL keep their ids and templates; only their `category` field is added.

- **raw**: `passthrough`
- **cleanup** (in this declared order): `fix-only-asr`, `cleanup-light`, `punctuate`, `polish`
- **structure** (in this declared order): `meeting-notes`, `summary-tldr`, `bullet-outline`, `extract-todos`, `questions-raised`, `code-spec`, `1on1-notes`, `standup-recap`
- **transform** (in this declared order): `translate-en`, `translate-zh`, `formalize`, `email-draft`

Every new chip SHALL include a `{transcript}` placeholder in its template and bilingual `en` + `zh-TW` labels.

New chip templates SHALL define the following observable contracts:
- `fix-only-asr`: fix ASR character errors (Chinese homophones, English split-words). PRESERVE fillers, stutters, and original punctuation absence. No cleanup beyond ASR-character correction.
- `summary-tldr`: produce a one-paragraph summary, target 40-80 words for English / 50-120 字 for Chinese, no bullets, no headings, no markdown.
- `bullet-outline`: produce 3-7 top-level bullets summarising the major points, plain `- ` markdown bullets, no sub-bullets.
- `extract-todos`: emit zero or more `- [ ]` task lines, one per inferred action item, optionally followed by ` (owner: <name or ?>)`. Output empty string when no action items are detectable.
- `email-draft`: output `Subject: <line>\n\n<greeting>,\n\n<body>\n\n<signoff>`, matching the dominant language of the transcript.
- `questions-raised`: produce 3-5 numbered follow-up questions, one per line, no preamble.
- `translate-zh`: mirror of `translate-en` — translate to natural Chinese (zh-TW). Verbatim translation, no commentary.
- `code-spec`: structure the transcript into headings `## Context`, `## Goal`, `## Behaviour`, `## Edge cases`, `## Out of scope`, with `[NEEDS CLARIFICATION]` for any heading whose content is not derivable from the transcript.
- `1on1-notes`: structure into three sections — `## Updates from <them>`, `## My follow-ups`, `## Their follow-ups`. Use `[NEEDS CLARIFICATION]` when an attendee or commitment is ambiguous.
- `standup-recap`: structure into `## Yesterday`, `## Today`, `## Blockers`. Each section is a bullet list or "None.".

#### Scenario: Shipped registry contains seventeen chips in declared order with categories

- **WHEN** the loader processes the shipped `registry/actions.yaml`
- **THEN** the resulting list SHALL contain exactly seventeen `ActionTemplate` instances whose ids equal `["passthrough", "fix-only-asr", "cleanup-light", "punctuate", "polish", "meeting-notes", "summary-tldr", "bullet-outline", "extract-todos", "questions-raised", "code-spec", "1on1-notes", "standup-recap", "translate-en", "translate-zh", "formalize", "email-draft"]` (chips grouped by declared category order, ids declared in YAML insertion order within each category), and every chip's `category` field SHALL be a member of `{"raw", "cleanup", "structure", "transform"}`

<!-- @trace
source: prompt-actions-categories-and-more-chips
updated: 2026-05-17
code:
  - app/main.py
  - frontend/src/ui/actions-bar.ts
  - frontend/src/ui/history-panel.ts
  - frontend/src/main.ts
  - frontend/src/i18n/strings.ts
  - frontend/src/style.css
  - app/api/actions.py
  - app/services/actions.py
  - registry/actions.yaml
  - frontend/src/ui/settings-panel.ts
tests:
  - frontend/src/i18n/index.test.ts
  - tests/test_actions.py
  - frontend/src/ui/actions-and-settings.test.ts
-->