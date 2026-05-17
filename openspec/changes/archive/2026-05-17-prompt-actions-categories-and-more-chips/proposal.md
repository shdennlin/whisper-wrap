## Why

The previous change (`prompt-actions-i18n-and-reseed`, archived as the active baseline) shipped seven curated chips with bilingual labels. The owner has now committed to adding ten more chips covering common transcript-post-processing workflows: short summaries, outlines, action-item extraction, email drafting, follow-up questions, English→Chinese translation, ASR-only fixes, voice-to-spec, 1-on-1 notes, and standup recaps.

Seventeen chips in a single flat horizontal bar is visually unscannable. To keep the UI usable as the chip count grows, the registry needs a way to group chips into semantic buckets (raw / cleanup / structure / transform) and the chip bar needs to render each bucket as its own labelled row. The categorisation also gives operators a single place to see "what does each chip do at a glance" without reading every template.

## What Changes

- **Registry schema (additive)**: each entry in `registry/actions.yaml` MAY include a new `category` field. It accepts the same string-or-i18n-mapping shape as `label` (e.g., `category: cleanup` shorthand for `{en: "cleanup"}`, or `category: {en: "...", "zh-TW": "..."}` for a bilingual display string).
- **Registry top-level (additive)**: a new optional top-level `categories:` list defines the **display order and bilingual labels** of categories. Each entry has `id` (kebab-case string matching the `category` value used by actions) and `label` (string or `{en, zh-TW}` mapping). The list also pins the on-screen order of category groups (entries not in the list are appended at the end in YAML insertion order).
- **API**: `GET /actions` response gains:
  - per-entry `category: <id-string or null>`. The string form is the resolved id from YAML (mapping form is normalized to id at load), so frontend grouping never has to compare display strings.
  - per-entry `categoryLabels: {en: str, "zh-TW": str} | null` mapping, mirroring the `labels` field, so the frontend can render category headings without a second lookup.
  - top-level `categories: [{id, labels}]` array reflecting the declared order. Empty when the YAML has no `categories:` block.
- **Frontend**: `ActionsBar` groups chips by their `category` id, rendering each group as a small heading label followed by its chips. The grouping order follows the top-level `categories` array; chips with no category go into a final "Misc" bucket whose heading is sourced from the i18n string `actions.miscCategoryLabel` (so it auto-localises).
- **Ten new actions** added to `registry/actions.yaml` with bilingual labels:
  - **structure**: `summary-tldr`, `bullet-outline`, `extract-todos`, `questions-raised`, `code-spec`, `1on1-notes`, `standup-recap`
  - **transform**: `translate-zh`, `email-draft`
  - **cleanup**: `fix-only-asr`
- **Category assignment** for the existing seven plus new ten (17 total chips):
  - `raw`: passthrough
  - `cleanup`: fix-only-asr, cleanup-light, punctuate, polish
  - `structure`: meeting-notes, summary-tldr, bullet-outline, extract-todos, questions-raised, code-spec, 1on1-notes, standup-recap
  - `transform`: translate-en, translate-zh, formalize, email-draft
- **Loader validation**: when a YAML action's `category` references an id not listed in top-level `categories:`, the loader emits a one-line WARNING (not an error) and still passes the category through. This lets operators experiment with new categories before committing them to the categories list. Invalid category types (non-string, non-mapping) raise `ActionRegistryError` — same rule as `label`.
- **i18n strings**: add `actions.miscCategoryLabel` (`Misc` / `其他`) to `frontend/src/i18n/strings.ts`.

## Non-Goals

- Drag-to-reorder, filter, search, or favorite-pin UI for chips. The four-bucket grouping is the entire UX scope; further chip-bar interaction is a separate change.
- Per-category enable/disable toggles in settings. If a chip is unwanted, the operator removes it from YAML; no per-user hide.
- Persisting "last used chip" or per-user chip reordering.
- Localizing chip prompt templates (still single-language English — same rationale as the previous change: templates handle code-switching internally).
- Renaming or removing any existing chip. `summarize` stays retired (from the previous change), but all seven current chips keep their ids.
- Server-side category negotiation by `Accept-Language` (categories are returned with full bilingual labels, frontend picks).

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `prompt-actions`: extends the YAML schema with an optional per-entry `category` field and a top-level `categories` list; the `GET /actions` response gains `category`, `categoryLabels`, and top-level `categories`; the shipped registry grows from seven to seventeen actions across four named categories; the PWA chip bar groups chips by category.

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
    - frontend/src/style.css
    - tests/test_actions.py
  - New: (none)
  - Removed: (none)
