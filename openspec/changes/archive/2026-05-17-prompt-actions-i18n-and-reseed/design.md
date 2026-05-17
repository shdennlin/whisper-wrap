## Context

`registry/actions.yaml` is loaded once at server startup by `app/services/actions.py` and served verbatim by `GET /actions`. The PWA fetches the list once per page load and renders one chip per action. The schema today requires `label: <string>`.

The PWA already has an i18n runtime in `frontend/src/i18n/`:
- `AVAILABLE_LOCALES = ["en", "zh-TW"]` — exhaustive list
- `DEFAULT_LOCALE = "en"`
- Active locale persisted in `localStorage` under `whisper-wrap.locale`
- `t(key)` looks up a string table, falling back to the `en` value if a key is missing in the active locale's table

Goal: bring chip labels into that same fallback-able, locale-aware system without breaking the YAML file as a portable artifact (operators copy/edit it by hand) and without forcing the API into per-request locale negotiation.

Coupled work: replace the five v2.4 seed actions with a curated set of seven, retiring `summarize` in favor of a more structured `meeting-notes` chip and adding three cleanup-spectrum chips (`cleanup-light`, `punctuate`, `polish`).

## Goals / Non-Goals

**Goals:**

- Allow `registry/actions.yaml` `label` to be either a string OR a mapping of locale → string, without forcing all operators to rewrite existing single-language files.
- Have `GET /actions` carry the full locale mapping so the same response is correct for any locale and remains cacheable.
- Make `ActionsBar` pick the active-locale label with a deterministic fallback (active → en → first available → action id) so an action with a partial label mapping never renders blank.
- Refuse to start on label mappings that are syntactically invalid (empty mapping; non-string values) so operators see the error at boot rather than discovering a blank chip in production.

**Non-Goals:**

- Localizing prompt `template` content. Templates already cover Chinese/English code-switching internally; duplicating them per locale doubles maintenance.
- Server-side `Accept-Language` negotiation. The PWA owns the locale.
- Migrating client-side history rows that reference the retired `summarize` action id. Those rows remain in `localStorage` but no chip will rerun them; no data loss, no rewrite.
- Adding placeholders beyond `{transcript}`. The meeting-notes template is adapted to infer or omit `{meeting_type}`, `{attendees}`, `{date}` rather than extending the contract.

## Decisions

### Allow `label` as a string-or-mapping union, normalize to mapping at load

- A `label: "直接送"` string is shorthand for `label: {en: "直接送"}` (the string becomes the `en` value because `en` is `DEFAULT_LOCALE`).
- A `label: {en: ..., zh-TW: ...}` mapping is stored as-is.
- Reasons: lets existing single-language files keep working untouched; keeps the API response uniform (always a mapping); centralizes the "is this a valid label" check in one loader function.
- Alternative considered — require a mapping always: rejected because it forces every operator to migrate their file even when they only ship one locale.

### Loader validates locale-mapping shape strictly

- Empty mapping `label: {}` → `ActionRegistryError`, server refuses to start.
- Non-string mapping value (e.g., `label: {en: 42}`) → `ActionRegistryError`.
- Unknown locale keys (any string not in `AVAILABLE_LOCALES`) → silently accepted and passed through to clients. This is forward-compat: when a new locale is added to the PWA, deployments don't have to update the loader in lockstep.
- Reasons: keep "broken on disk" loud and "future locale" quiet.

### `GET /actions` returns BOTH `label` (string) and `labels` (mapping) per entry

- `labels` is the canonical mapping the loader produced.
- `label` is set to `labels.en` when present, else the first mapping value in YAML insertion order. This preserves the existing single-string contract for any caller (CLI, future SDK) that already reads `label`.
- Reasons: zero-breakage on the API surface; the new field is additive; new clients can ignore `label`, old clients can ignore `labels`.
- Alternative considered — replace `label` with `labels` and break clients: rejected. There are no external consumers documented today, but the API contract is still public-facing and keeping `label` costs ~5 lines.

### `ActionsBar` resolves label with `labels[active] → labels.en → first mapping entry → label string → action.id`

- Active is `getLocale()` from the existing i18n runtime.
- If `labels` is missing entirely from the response (e.g., a future API regression or an old proxy stripping fields), the bar falls back to the `label` string so the chip still renders.
- Reasons: defense-in-depth so a chip never renders blank.

### Retire `summarize`, introduce `meeting-notes` with a new id (not a rename)

- The v2.4 `summarize` template (single sentence, bullet list, "保留發言者口吻") is a different output contract from the new chief-of-staff template (structured headings, action items table, "[NEEDS CLARIFICATION]" markers). Renaming would let a stale client cache deliver "summarize → meeting-notes" mappings that don't match the user's mental model.
- A new id makes the change visible in history (`action_id` field on each run) — old runs render as `summarize`, new runs as `meeting-notes`, no ambiguity.
- The owner explicitly listed `meeting-notes` as a distinct chip in the requirement.

### Adapt the meeting-notes source template to `{transcript}` only

- The source the owner pasted uses `{meeting_type}`, `{attendees}`, `{date}` as additional placeholders. The actions contract enforces exactly one placeholder (`{transcript}`).
- The adapted template instructs the LLM to infer attendees and date from the transcript when present, and to write `[NEEDS CLARIFICATION]` otherwise. Meeting type is dropped — the structure (key decisions / action items / discussion highlights / parking lot / next meeting) is type-agnostic enough.

## Implementation Contract

**Behavior visible after this change ships:**

- An operator opens `registry/actions.yaml` and sees seven actions (`passthrough`, `cleanup-light`, `punctuate`, `polish`, `meeting-notes`, `translate-en`, `formalize`) in that order. Each action has either a `label: "..."` string OR a `label: {en: ..., zh-TW: ...}` mapping. Both forms load without error.
- A user opens the PWA with `localStorage["whisper-wrap.locale"] = "en"` and sees the seven chips with their English labels. The same user toggles language to 繁中, page reloads, sees the Chinese labels. No content change between toggles.
- `curl -s $HOST/actions | jq '.actions[0] | keys'` returns `["id", "label", "labels", "template"]` for every entry.
- An operator writes `label: {}` in the YAML, restarts the server, observes startup failure with an error message naming the offending action id and the field `label`.
- An operator writes `label: {fr: "Envoyer"}` (unknown locale), restarts, sees the server come up. `GET /actions` returns `labels: {fr: "Envoyer"}` for that entry and the chip renders the action id (since neither `zh-TW` nor `en` is present and the existing fallback chain finds no usable label) — operator-visible but non-fatal.

**Interface / data shape:**

YAML shape per action:
```yaml
- id: <kebab-case>
  label: <string> | <mapping locale → string>
  template: <string containing literal {transcript}>
```

`GET /actions` response shape:
```json
{
  "actions": [
    {
      "id": "passthrough",
      "label": "Send as-is",
      "labels": {"en": "Send as-is", "zh-TW": "直接送"},
      "template": "{transcript}"
    }
  ]
}
```

`ActionTemplate` Python dataclass:
```python
@dataclass(frozen=True)
class ActionTemplate:
    id: str
    label: str             # legacy single string (en preferred, else first available)
    labels: Mapping[str, str]   # canonical locale mapping (always non-empty)
    template: str
```

`ActionTemplate` TS interface in `frontend/src/ui/actions-bar.ts`:
```ts
export interface ActionTemplate {
  id: string;
  label: string;
  labels?: Record<string, string>;
  template: string;
}
```

**Failure modes:**

- Label mapping is empty `{}` → `ActionRegistryError`. Server refuses to start. (New behavior — previously empty string in `label` triggered the existing "missing required field" path; empty mapping is its mapping-equivalent.)
- Label mapping value is non-string (e.g., int, null, list) → `ActionRegistryError`. Server refuses to start.
- Label mapping references unknown locale (not in `AVAILABLE_LOCALES`) → silently passed through to clients. Front-end resolver MAY render the action id as a last-resort fallback when no usable label is found.
- `labels` field absent in `/actions` response (back-compat / proxy strip) → front-end falls back to `label` string.
- Existing all-string `label` files load with no behavior change. The mapping `{en: <string>}` is generated implicitly.

**Acceptance criteria:**

- `uv run pytest tests/test_actions.py` passes with new assertions for: string `label` normalized to `{en: ...}`; mapping `label` loaded as-is; empty mapping rejected; non-string mapping value rejected; unknown locale key accepted; `GET /actions` includes both `label` and `labels` per entry; shipped registry yields exactly the seven new ids in order.
- `cd frontend && bun run test` passes with `actions-and-settings.test.ts` updated to feed `labels` mappings and assert chip text matches the active-locale label, plus fallback when only `en` is present.
- `make lint` clean.
- Manual smoke: start server, `curl /actions` returns seven entries with `labels`, open PWA in en locale (clear `localStorage`), seven English chips render; switch to zh-TW in settings, reload, seven Chinese chips render.

**In scope:**

- `registry/actions.yaml` rewrite to new seven-action content with bilingual labels.
- `app/services/actions.py` schema relaxation + new validation rules + `labels` field on `ActionTemplate`.
- `app/api/actions.py` includes `labels` in the JSON response and computes legacy `label`.
- `frontend/src/ui/actions-bar.ts` resolves label by locale with the fallback chain above.
- `frontend/src/i18n/strings.ts` keeps the existing `actions.passthroughLabel` fallback used when the registry is unreachable.
- `tests/test_actions.py` and `frontend/src/ui/actions-and-settings.test.ts` updated.

**Out of scope:**

- New locales beyond `en` and `zh-TW`.
- Localizing prompt templates.
- Migrating client-side history entries with the retired `summarize` action id.
- Extending the placeholder contract beyond `{transcript}`.
- Any change to `/ask` or other endpoints.
- Settings-panel UI changes (the existing language selector already drives `whisper-wrap.locale`).

## Risks / Trade-offs

- [Risk: an operator ships a `zh-TW`-only `label` mapping and an English-locale user sees the chip with the Chinese text via the en-fallback chain] → Acceptable; matches the "operator chose to ship one locale" intent. Document the fallback order in the spec so the behavior is predictable.
- [Risk: a stale PWA cache reads a response that has `labels` but the runtime doesn't know how to render it] → Service worker bumps on every build; the registered SW update flow already prompts a reload. `labels` is additive so a stale runtime still has `label` to render.
- [Risk: clients that POSTed the old `summarize` id to `/ask` from a stale cache continue to do so] → `/ask` doesn't validate `action_id`, it only receives a fully-substituted prompt string. No server-side breakage. Stale client renders no chip for the retired id; the user picks a different one.
- [Risk: meeting-notes template emits "[NEEDS CLARIFICATION]" too eagerly because attendees/date aren't in the transcript] → Acceptable and arguably desirable — the marker is the documented escape hatch. If it becomes annoying, the template can be relaxed in a follow-up.
