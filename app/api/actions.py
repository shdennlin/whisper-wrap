"""GET /actions — prompt-action templates registry.

Serves the templates loaded at lifespan startup from `registry/actions.yaml`.
The PWA fetches this list once per page load to populate the Actions chip bar.

No write endpoints exist: editing actions is performed by editing the YAML and
restarting the server. No authentication is enforced.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request

router = APIRouter()


@router.get("/actions")
async def list_actions(request: Request) -> dict[str, Any]:
    actions = getattr(request.app.state, "actions", []) or []
    return {
        "actions": [
            {"id": a.id, "label": a.label, "template": a.template} for a in actions
        ]
    }
