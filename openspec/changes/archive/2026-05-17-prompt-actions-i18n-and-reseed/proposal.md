## Why

The Actions chip bar reads labels from `registry/actions.yaml`, which currently allows only a single label string per action. The PWA already supports two UI locales (`en`, `zh-TW`) via `frontend/src/i18n/`, but the shipped chip labels are Chinese-only. An English-locale user sees an English UI with Chinese chips, which is jarring and reduces usability for non-Chinese readers.

At the same time, the five seed prompts shipped with v2.4 (`cleanup`, `summarize`, `translate-en`, `formalize`, `passthrough`) lack the rigor the project owner now expects: missing ASR-error-fix rules, no code-switching guidance, no hard constraints against hallucination. The owner has hand-curated three new English prompts (LIGHT cleanup, punctuation-only, polished rewrite) and a new chief-of-staff meeting-notes prompt that better match real production needs.

Bundling i18n labels with a content refresh is cheap (both touch the same YAML + same spec) and avoids two churn cycles on the registry.

## What Changes

- **BREAKING (internal schema)**: `registry/actions.yaml` `label` field SHALL accept either a string (back-compat shorthand for `{en: string}`) OR a mapping of locale code → display string. Locales are restricted to those listed in `frontend/src/i18n/index.ts` `AVAILABLE_LOCALES` (currently `en`, `zh-TW`).
- **BREAKING (API)**: `GET /actions` SHALL include a new `labels` mapping per entry alongside the existing `label` string. `label` is kept (set to the `en` value, or to the locale-mapping's first value when `en` is absent) so any external consumer that still reads `label` keeps working.
- **Frontend**: `ActionsBar` SHALL read `labels[activeLocale]` (falling back to `labels.en`, then `label`, then the action `id`). The hard-coded `actions.passthroughLabel` fallback string SHALL stay in `frontend/src/i18n/strings.ts` for the offline/empty-registry path.
- **Reseed**: `registry/actions.yaml` SHALL ship seven actions in order: `passthrough`, `cleanup-light` (LIGHT cleanup, no punctuation, ASR fixes), `punctuate` (adds Chinese/English punctuation, ASR fixes), `polish` (rewrite for clarity with hard constraints), `meeting-notes` (chief-of-staff template adapted to `{transcript}` only), `translate-en` (kept verbatim), `formalize` (kept verbatim). The `summarize` id is RETIRED in favor of `meeting-notes`.
- **Loader validation**: when `label` is a mapping, an empty mapping or non-string values SHALL raise `ActionRegistryError` (server refuses to start). Unknown locale keys SHALL be ignored (forward-compat).
- **Pytest**: update `tests/test_actions.py` (and any spec-shape tests) for new validation rules + new seed list.
- **Vitest**: update `frontend/src/ui/actions-and-settings.test.ts` for the new labels mapping shape.
- Templates stay single-language English — they already handle Chinese/English code-switching internally, so duplicating the long prompts per locale would only add maintenance cost.

## Non-Goals

- Adding new locales beyond `en` and `zh-TW`. Future locales will be added by editing `AVAILABLE_LOCALES` and the YAML labels; no schema change is required.
- Adding per-locale `template` fields. Templates are single-string. The cleanup / punctuate / polish prompts already include both Chinese and English handling rules; localizing them would double maintenance for no UX gain.
- Adding additional placeholders beyond `{transcript}` (the owner's meeting-notes source template referenced `{meeting_type}`, `{attendees}`, `{date}`, but extending the placeholder contract is out of scope — the meeting-notes prompt is adapted to infer those from the transcript or omit them).
- Server-side locale negotiation via `Accept-Language` header. The PWA picks the locale from `localStorage` and renders client-side; the API returns all locales so the same response can be cached across users.
- Migrating the existing `summarize` action's persisted history. History entries reference `action_id`, so any history rows pointing at `summarize` will simply not match any current chip — they remain readable but un-rerunnable. No migration script is needed because history is client-side `localStorage` only.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `prompt-actions`: relaxes the `label` field to allow a locale mapping, adds the `labels` field to `GET /actions`, changes the shipped seed list from 5 to 7 actions with new ids and content.

## Impact

- Affected specs: `prompt-actions`
- Affected code:
  - Modified:
    - registry/actions.yaml
    - app/services/actions.py
    - app/api/actions.py
    - frontend/src/ui/actions-bar.ts
    - frontend/src/ui/actions-and-settings.test.ts
    - frontend/src/i18n/strings.ts
    - tests/test_actions.py
  - New: (none)
  - Removed: (none)
