"""GET /actions — prompt-action templates registry.

Serves the templates loaded at lifespan startup from `registry/actions.yaml`.
The PWA fetches this list once per page load to populate the Actions chip bar.

No write endpoints exist: editing actions is performed by editing the YAML and
restarting the server. No authentication is enforced.

Per-entry fields:
  - `id`, `template`: unchanged across schema revisions
  - `label`, `labels`: legacy single string + canonical locale mapping
  - `category`: resolved id string or `null` (used by frontend for grouping)
  - `categoryLabels`: bilingual display mapping or `null` (lifted from a
    mapping-form category; null when the action used the string-form)

Top-level `categories` array reflects the YAML `categories:` block in declared
display order, each entry carrying `id`, `label` (legacy single string) and
`labels` (canonical mapping). Empty when no `categories:` block is declared.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request

router = APIRouter()


@router.get("/actions")
async def list_actions(request: Request) -> dict[str, Any]:
    actions = getattr(request.app.state, "actions", []) or []
    categories = getattr(request.app.state, "action_categories", []) or []
    return {
        "actions": [
            {
                "id": a.id,
                "label": a.label,
                "labels": dict(a.labels),
                "template": a.template,
                "category": a.category,
                "categoryLabels": (
                    dict(a.category_labels) if a.category_labels is not None else None
                ),
                "description": a.description,
                "descriptionLabels": (
                    dict(a.description_labels)
                    if a.description_labels is not None
                    else None
                ),
            }
            for a in actions
        ],
        "categories": [
            {"id": c.id, "label": c.label, "labels": dict(c.labels)} for c in categories
        ],
    }
