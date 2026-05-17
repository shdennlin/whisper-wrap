"""Tests for the prompt-actions YAML loader and GET /actions endpoint.

Covers the `Prompt action templates loaded from registry/actions.yaml` and
`GET /actions endpoint exposes loaded templates` requirements in
openspec/specs/prompt-actions/spec.md.
"""

from __future__ import annotations

import logging
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

# ---------- YAML loader: happy path + structural validation ----------


def test_loader_happy_path(tmp_path: Path):
    """A valid YAML with three entries loads to three ActionTemplate instances
    in declaration order."""
    from app.services.actions import ActionTemplate, load_actions

    yaml_file = tmp_path / "actions.yaml"
    yaml_file.write_text(
        """\
actions:
  - id: first
    label: First action
    template: "wrap {transcript} here"
  - id: second
    label: Second action
    template: "another {transcript}"
  - id: third
    label: Third action
    template: "{transcript}"
""",
        encoding="utf-8",
    )

    result = load_actions(yaml_file)
    assert len(result) == 3
    assert all(isinstance(a, ActionTemplate) for a in result)
    assert [a.id for a in result] == ["first", "second", "third"]
    assert result[0].label == "First action"
    assert result[2].template == "{transcript}"


def test_loader_missing_file_warns_and_returns_empty(tmp_path: Path, caplog):
    """Missing file → one-line WARNING + empty list. Server SHALL still start."""
    from app.services.actions import load_actions

    missing = tmp_path / "does-not-exist.yaml"
    with caplog.at_level(logging.WARNING, logger="app.services.actions"):
        result = load_actions(missing)
    assert result == []
    warns = [r for r in caplog.records if r.levelno >= logging.WARNING]
    assert len(warns) == 1
    assert str(missing) in warns[0].getMessage()


def test_loader_malformed_yaml_warns_and_returns_empty(tmp_path: Path, caplog):
    """Malformed YAML → one-line WARNING + empty list. Server SHALL still start."""
    from app.services.actions import load_actions

    yaml_file = tmp_path / "broken.yaml"
    yaml_file.write_text("actions: [{id: foo, label: 'unterminated", encoding="utf-8")
    with caplog.at_level(logging.WARNING, logger="app.services.actions"):
        result = load_actions(yaml_file)
    assert result == []
    warns = [r for r in caplog.records if r.levelno >= logging.WARNING]
    assert len(warns) == 1


def test_loader_duplicate_id_raises(tmp_path: Path):
    """Duplicate `id` SHALL raise so the operator notices the misconfiguration."""
    from app.services.actions import ActionRegistryError, load_actions

    yaml_file = tmp_path / "dup.yaml"
    yaml_file.write_text(
        """\
actions:
  - id: same
    label: A
    template: "{transcript}"
  - id: same
    label: B
    template: "x {transcript}"
""",
        encoding="utf-8",
    )
    with pytest.raises(ActionRegistryError) as exc_info:
        load_actions(yaml_file)
    assert "same" in str(exc_info.value)


def test_loader_missing_transcript_placeholder_raises(tmp_path: Path):
    """A template without the literal `{transcript}` substring SHALL raise."""
    from app.services.actions import ActionRegistryError, load_actions

    yaml_file = tmp_path / "no_placeholder.yaml"
    yaml_file.write_text(
        """\
actions:
  - id: broken
    label: Broken
    template: "this has no placeholder"
""",
        encoding="utf-8",
    )
    with pytest.raises(ActionRegistryError) as exc_info:
        load_actions(yaml_file)
    assert "broken" in str(exc_info.value)
    assert "transcript" in str(exc_info.value)


def test_loader_missing_required_field_raises(tmp_path: Path):
    """Missing `id`, `label`, or `template` SHALL raise naming the offending entry."""
    from app.services.actions import ActionRegistryError, load_actions

    yaml_file = tmp_path / "missing_field.yaml"
    yaml_file.write_text(
        """\
actions:
  - id: ok
    label: OK
    template: "{transcript}"
  - id: missing-label
    template: "{transcript}"
""",
        encoding="utf-8",
    )
    with pytest.raises(ActionRegistryError) as exc_info:
        load_actions(yaml_file)
    msg = str(exc_info.value)
    assert "label" in msg or "missing-label" in msg


def test_loader_ignores_unrecognised_top_level_keys(tmp_path: Path):
    """Unknown top-level YAML keys SHALL be silently ignored so future
    extensions do not break older deployments."""
    from app.services.actions import load_actions

    yaml_file = tmp_path / "with_extra.yaml"
    yaml_file.write_text(
        """\
version: 2
future_extension: { foo: bar }
actions:
  - id: only
    label: Only
    template: "{transcript}"
""",
        encoding="utf-8",
    )
    result = load_actions(yaml_file)
    assert len(result) == 1
    assert result[0].id == "only"


# ---------- i18n label schema: string-or-mapping union (tasks 1.1, 1.2, 1.3) ----------


def test_action_template_exposes_labels_mapping(tmp_path: Path):
    """ActionTemplate SHALL expose `labels` mapping alongside legacy `label` string
    for prompt action templates loaded from registry/actions.yaml."""
    from app.services.actions import ActionTemplate, load_actions

    yaml_file = tmp_path / "actions.yaml"
    yaml_file.write_text(
        """\
actions:
  - id: only
    label: Send as-is
    template: "{transcript}"
""",
        encoding="utf-8",
    )
    result = load_actions(yaml_file)
    assert len(result) == 1
    only: ActionTemplate = result[0]
    assert only.labels == {"en": "Send as-is"}
    assert only.label == "Send as-is"


def test_string_label_normalizes_to_en_mapping(tmp_path: Path):
    """A YAML `label: "..."` shorthand SHALL normalize to `{en: "..."}`."""
    from app.services.actions import load_actions

    yaml_file = tmp_path / "actions.yaml"
    yaml_file.write_text(
        """\
actions:
  - id: zh-only
    label: 直接送
    template: "{transcript}"
""",
        encoding="utf-8",
    )
    result = load_actions(yaml_file)
    assert result[0].labels == {"en": "直接送"}
    assert result[0].label == "直接送"


def test_mapping_label_loaded_verbatim(tmp_path: Path):
    """A YAML mapping label SHALL be loaded verbatim. Mirrors the spec's
    label-form normalization example table."""
    from app.services.actions import load_actions

    yaml_file = tmp_path / "actions.yaml"
    yaml_file.write_text(
        """\
actions:
  - id: bilingual
    label:
      en: Send as-is
      zh-TW: 直接送
    template: "{transcript}"
  - id: en-only
    label:
      en: Send
    template: "{transcript}"
  - id: zh-only-mapping
    label:
      zh-TW: 直接送
    template: "{transcript}"
  - id: en-plus-fr
    label:
      en: Send
      fr: Envoyer
    template: "{transcript}"
""",
        encoding="utf-8",
    )
    result = load_actions(yaml_file)
    by_id = {a.id: a for a in result}

    assert by_id["bilingual"].labels == {"en": "Send as-is", "zh-TW": "直接送"}
    assert by_id["bilingual"].label == "Send as-is"

    assert by_id["en-only"].labels == {"en": "Send"}
    assert by_id["en-only"].label == "Send"

    assert by_id["zh-only-mapping"].labels == {"zh-TW": "直接送"}
    assert by_id["zh-only-mapping"].label == "直接送"

    assert by_id["en-plus-fr"].labels == {"en": "Send", "fr": "Envoyer"}
    assert by_id["en-plus-fr"].label == "Send"


# ---------- i18n label validation (tasks 2.1, 2.2, 2.3, 2.4) ----------


def test_empty_label_mapping_refuses_startup(tmp_path: Path):
    """`label: {}` SHALL raise ActionRegistryError naming the offending action id —
    loader validates locale-mapping shape strictly."""
    from app.services.actions import ActionRegistryError, load_actions

    yaml_file = tmp_path / "empty_mapping.yaml"
    yaml_file.write_text(
        """\
actions:
  - id: blank-mapping
    label: {}
    template: "{transcript}"
""",
        encoding="utf-8",
    )
    with pytest.raises(ActionRegistryError) as exc_info:
        load_actions(yaml_file)
    assert "blank-mapping" in str(exc_info.value)


def test_non_string_label_value_refuses_startup(tmp_path: Path):
    """A mapping value that is not a string SHALL raise ActionRegistryError naming
    the offending action id AND the offending locale key."""
    from app.services.actions import ActionRegistryError, load_actions

    yaml_file = tmp_path / "non_string_value.yaml"
    yaml_file.write_text(
        """\
actions:
  - id: bad-en-value
    label:
      en: 42
    template: "{transcript}"
""",
        encoding="utf-8",
    )
    with pytest.raises(ActionRegistryError) as exc_info:
        load_actions(yaml_file)
    msg = str(exc_info.value)
    assert "bad-en-value" in msg
    assert "en" in msg


@pytest.mark.parametrize(
    "bad_label,description",
    [
        ("[a, b]", "list"),
        ("42", "int"),
        ("null", "null literal"),
    ],
)
def test_invalid_label_type_refuses_startup(
    tmp_path: Path, bad_label: str, description: str
):
    """When `label` is neither a string nor a mapping, the loader SHALL raise
    ActionRegistryError naming the offending action id and the actual type."""
    from app.services.actions import ActionRegistryError, load_actions

    yaml_file = tmp_path / f"invalid_{description.replace(' ', '_')}.yaml"
    yaml_file.write_text(
        f"""\
actions:
  - id: weird-label
    label: {bad_label}
    template: "{{transcript}}"
""",
        encoding="utf-8",
    )
    with pytest.raises(ActionRegistryError) as exc_info:
        load_actions(yaml_file)
    assert "weird-label" in str(exc_info.value)


def test_unknown_locale_key_accepted(tmp_path: Path):
    """Unknown locale keys SHALL be passed through to clients without error —
    forward-compat clause of the locale-mapping validation."""
    from app.services.actions import load_actions

    yaml_file = tmp_path / "unknown_locale.yaml"
    yaml_file.write_text(
        """\
actions:
  - id: french-only
    label:
      fr: Envoyer
    template: "{transcript}"
""",
        encoding="utf-8",
    )
    result = load_actions(yaml_file)
    assert len(result) == 1
    assert result[0].labels == {"fr": "Envoyer"}
    assert result[0].label == "Envoyer"


# ---------- Shipped registry (task 4.1 + 4.2) ----------

SEVENTEEN_BUILTIN_IDS = [
    "passthrough",
    "fix-only-asr",
    "cleanup-light",
    "punctuate",
    "polish",
    "meeting-notes",
    "summary-tldr",
    "bullet-outline",
    "extract-todos",
    "questions-raised",
    "code-spec",
    "1on1-notes",
    "standup-recap",
    "translate-en",
    "translate-zh",
    "formalize",
    "email-draft",
]


def test_shipped_registry_contains_seventeen_chips_in_order():
    """The repository SHALL ship registry/actions.yaml with seventeen built-in
    actions in the documented category-grouped order, each carrying bilingual
    `labels` (`en` + `zh-TW`) and a `category` id from the four-bucket set."""
    from app.services.actions import DEFAULT_REGISTRY_PATH, load_actions

    shipped = Path(__file__).resolve().parent.parent / DEFAULT_REGISTRY_PATH
    result = load_actions(shipped)
    assert [a.id for a in result] == SEVENTEEN_BUILTIN_IDS
    passthrough = result[0]
    assert passthrough.template.strip() == "{transcript}"
    valid_categories = {"raw", "cleanup", "structure", "transform"}
    for a in result:
        assert "{transcript}" in a.template, f"{a.id} missing {{transcript}}"
        assert set(a.labels.keys()) >= {"en", "zh-TW"}, (
            f"{a.id} labels missing en or zh-TW"
        )
        assert a.labels["en"], f"{a.id} en label is empty"
        assert a.labels["zh-TW"], f"{a.id} zh-TW label is empty"
        assert a.category in valid_categories, (
            f"{a.id} has category {a.category!r}, expected one of {valid_categories}"
        )


def test_meeting_notes_template_uses_only_transcript_placeholder():
    """The meeting-notes template SHALL consume only `{transcript}` — the source
    template's `{meeting_type}`, `{attendees}`, `{date}` placeholders SHALL be
    adapted out."""
    from app.services.actions import DEFAULT_REGISTRY_PATH, load_actions

    shipped = Path(__file__).resolve().parent.parent / DEFAULT_REGISTRY_PATH
    result = load_actions(shipped)
    meeting_notes = next(a for a in result if a.id == "meeting-notes")
    assert "{transcript}" in meeting_notes.template
    for forbidden in ("{meeting_type}", "{attendees}", "{date}"):
        assert forbidden not in meeting_notes.template, (
            f"meeting-notes template still references {forbidden}"
        )


# ---------- GET /actions HTTP contract (tasks 3.1, 3.2) ----------


@pytest.fixture
def stubbed_app(monkeypatch):
    """Boot the FastAPI app with a stubbed Whisper backend so we exercise only the
    actions surface; the lifespan loads the shipped registry/actions.yaml."""
    monkeypatch.setattr(
        "app.main._build_backend",
        lambda **kw: (
            MagicMock(name="WhisperBackend"),
            {
                "backend": "ctranslate2",
                "format": "ct2",
                "compute_type": "default",
                "local_dir": "/fake",
            },
        ),
    )
    from app.main import app

    return app


def test_get_actions_http_contract_populated(stubbed_app):
    """GET /actions returns the loaded templates in registry order with all
    expected fields including `labels`, `category`, `categoryLabels`."""
    with TestClient(stubbed_app) as c:
        resp = c.get("/actions")
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("application/json")
        body = resp.json()
        assert "actions" in body
        ids = [a["id"] for a in body["actions"]]
        assert ids == SEVENTEEN_BUILTIN_IDS
        for a in body["actions"]:
            assert set(a.keys()) >= {
                "id",
                "label",
                "labels",
                "template",
                "category",
                "categoryLabels",
            }
            assert "{transcript}" in a["template"]


def test_actions_endpoint_includes_labels_field(stubbed_app):
    """`GET /actions` returns BOTH `label` (string) and `labels` (mapping) per
    entry."""
    with TestClient(stubbed_app) as c:
        body = c.get("/actions").json()
        for a in body["actions"]:
            assert isinstance(a["label"], str) and a["label"], (
                f"{a['id']} legacy label is empty"
            )
            assert isinstance(a["labels"], dict) and a["labels"], (
                f"{a['id']} labels mapping is empty"
            )
            assert all(isinstance(v, str) and v for v in a["labels"].values())


def test_actions_endpoint_ignores_accept_language(stubbed_app):
    """The endpoint SHALL NOT perform Accept-Language negotiation: two requests
    with different Accept-Language headers return byte-identical bodies."""
    with TestClient(stubbed_app) as c:
        en_body = c.get("/actions", headers={"Accept-Language": "en"}).content
        zh_body = c.get("/actions", headers={"Accept-Language": "zh-TW"}).content
        assert en_body == zh_body


def test_get_actions_http_contract_empty_when_missing(monkeypatch):
    """When the registry file is missing at lifespan time, GET /actions SHALL
    return HTTP 200 with an empty list (NOT 404 or 500)."""
    monkeypatch.setattr(
        "app.main._build_backend",
        lambda **kw: (
            MagicMock(name="WhisperBackend"),
            {
                "backend": "ctranslate2",
                "format": "ct2",
                "compute_type": "default",
                "local_dir": "/fake",
            },
        ),
    )
    monkeypatch.setattr(
        "app.services.actions.DEFAULT_REGISTRY_PATH",
        Path("/nonexistent/actions.yaml"),
    )
    from app.main import app

    with TestClient(app) as c:
        resp = c.get("/actions")
        assert resp.status_code == 200
        assert resp.json() == {"actions": [], "categories": []}


def test_get_actions_no_auth_required(stubbed_app):
    """The endpoint SHALL be reachable without an Authorization header."""
    with TestClient(stubbed_app) as c:
        resp = c.get("/actions")
        assert resp.status_code == 200


# ---------- Section 1: per-action `category` field ----------


def test_action_template_exposes_category_fields(tmp_path: Path):
    """Action entries SHALL support an optional category field with bilingual
    display label: ActionTemplate exposes both `category` and `category_labels`
    with `None` defaults when no YAML category is provided."""
    from app.services.actions import load_actions

    yaml_file = tmp_path / "actions.yaml"
    yaml_file.write_text(
        """\
actions:
  - id: no-cat
    label: No category
    template: "{transcript}"
""",
        encoding="utf-8",
    )
    result = load_actions(yaml_file)
    assert hasattr(result[0], "category")
    assert hasattr(result[0], "category_labels")
    assert result[0].category is None
    assert result[0].category_labels is None


def test_string_category_normalises_to_id_only(tmp_path: Path):
    """String-form `category: cleanup` normalises to id only — no labels."""
    from app.services.actions import load_actions

    yaml_file = tmp_path / "actions.yaml"
    yaml_file.write_text(
        """\
actions:
  - id: stringy
    label: Stringy
    category: cleanup
    template: "{transcript}"
""",
        encoding="utf-8",
    )
    result = load_actions(yaml_file)
    assert result[0].category == "cleanup"
    assert result[0].category_labels is None


def test_mapping_category_loaded_verbatim(tmp_path: Path):
    """Mapping-form category with `id` and `labels` loads verbatim."""
    from app.services.actions import load_actions

    yaml_file = tmp_path / "actions.yaml"
    yaml_file.write_text(
        """\
actions:
  - id: mapped
    label: Mapped
    category:
      id: cleanup
      labels:
        en: Cleanup
        zh-TW: 清理
    template: "{transcript}"
""",
        encoding="utf-8",
    )
    result = load_actions(yaml_file)
    assert result[0].category == "cleanup"
    assert result[0].category_labels == {"en": "Cleanup", "zh-TW": "清理"}


@pytest.mark.parametrize(
    "bad_category,description",
    [
        ("42", "int"),
        ("[a, b]", "list"),
    ],
)
def test_invalid_category_type_refuses_startup(
    tmp_path: Path, bad_category: str, description: str
):
    """Non-string non-mapping `category` SHALL raise ActionRegistryError."""
    from app.services.actions import ActionRegistryError, load_actions

    yaml_file = tmp_path / f"invalid_cat_{description}.yaml"
    yaml_file.write_text(
        f"""\
actions:
  - id: bad-cat
    label: Bad
    category: {bad_category}
    template: "{{transcript}}"
""",
        encoding="utf-8",
    )
    with pytest.raises(ActionRegistryError) as exc_info:
        load_actions(yaml_file)
    assert "bad-cat" in str(exc_info.value)


def test_mapping_category_validation_refuses_startup(tmp_path: Path):
    """Mapping category missing `id`, empty `labels`, or non-string `labels`
    value SHALL raise ActionRegistryError."""
    from app.services.actions import ActionRegistryError, load_actions

    # Missing id
    yaml_file = tmp_path / "no_id.yaml"
    yaml_file.write_text(
        """\
actions:
  - id: missing-cat-id
    label: x
    category:
      labels:
        en: Cleanup
    template: "{transcript}"
""",
        encoding="utf-8",
    )
    with pytest.raises(ActionRegistryError) as exc_info:
        load_actions(yaml_file)
    assert "missing-cat-id" in str(exc_info.value)

    # Empty labels
    yaml_file2 = tmp_path / "empty_labels.yaml"
    yaml_file2.write_text(
        """\
actions:
  - id: empty-cat-labels
    label: x
    category:
      id: cleanup
      labels: {}
    template: "{transcript}"
""",
        encoding="utf-8",
    )
    with pytest.raises(ActionRegistryError) as exc_info:
        load_actions(yaml_file2)
    assert "empty-cat-labels" in str(exc_info.value)

    # Non-string labels value
    yaml_file3 = tmp_path / "bad_labels.yaml"
    yaml_file3.write_text(
        """\
actions:
  - id: bad-cat-labels
    label: x
    category:
      id: cleanup
      labels:
        en: 42
    template: "{transcript}"
""",
        encoding="utf-8",
    )
    with pytest.raises(ActionRegistryError) as exc_info:
        load_actions(yaml_file3)
    assert "bad-cat-labels" in str(exc_info.value)


def test_unknown_category_id_warns_and_passes_through(tmp_path: Path, caplog):
    """An action whose `category` id is not in the top-level `categories:` block
    SHALL emit a WARNING and still load with the category passed through."""
    from app.services.actions import load_actions

    yaml_file = tmp_path / "unknown_cat.yaml"
    yaml_file.write_text(
        """\
categories:
  - id: cleanup
    label: Cleanup
actions:
  - id: exp-action
    label: Experimental
    category: experimental
    template: "{transcript}"
""",
        encoding="utf-8",
    )
    with caplog.at_level(logging.WARNING, logger="app.services.actions"):
        result = load_actions(yaml_file)
    assert result[0].category == "experimental"
    warns = [
        r for r in caplog.records
        if r.levelno >= logging.WARNING
        and "exp-action" in r.getMessage()
        and "experimental" in r.getMessage()
    ]
    assert len(warns) == 1


# ---------- Section 2: top-level `categories:` block ----------


def test_load_categories_returns_ordered_definitions(tmp_path: Path):
    """The registry SHALL declare category display order and bilingual labels
    via a top-level `categories:` block; load_categories returns them in YAML
    order with non-empty labels mapping."""
    from app.services.actions import load_categories

    yaml_file = tmp_path / "actions.yaml"
    yaml_file.write_text(
        """\
categories:
  - id: raw
    label:
      en: Raw
      zh-TW: 原文
  - id: cleanup
    label:
      en: Cleanup
      zh-TW: 清理
  - id: structure
    label: Structure
  - id: transform
    label:
      en: Transform
      zh-TW: 轉換
actions: []
""",
        encoding="utf-8",
    )
    result = load_categories(yaml_file)
    assert [c.id for c in result] == ["raw", "cleanup", "structure", "transform"]
    assert result[0].labels == {"en": "Raw", "zh-TW": "原文"}
    assert result[0].label == "Raw"
    assert result[2].labels == {"en": "Structure"}  # string shorthand
    assert result[3].label == "Transform"


def test_duplicate_category_id_refuses_startup(tmp_path: Path):
    """Duplicate `categories.id` SHALL raise ActionRegistryError."""
    from app.services.actions import ActionRegistryError, load_categories

    yaml_file = tmp_path / "dup_cat.yaml"
    yaml_file.write_text(
        """\
categories:
  - id: cleanup
    label: First
  - id: cleanup
    label: Second
""",
        encoding="utf-8",
    )
    with pytest.raises(ActionRegistryError) as exc_info:
        load_categories(yaml_file)
    assert "cleanup" in str(exc_info.value)


@pytest.mark.parametrize(
    "snippet,description,marker",
    [
        ("- label: NoId", "missing-id", "missing"),
        ("- id: ''\n    label: Empty", "empty-id", ""),
        ("- id: a\n    label: {}", "empty-mapping-label", "a"),
        ("- id: b\n    label:\n      en: 42", "non-string-label-value", "b"),
        ("- id: c\n    label: 42", "non-string-non-mapping-label", "c"),
    ],
)
def test_invalid_category_definition_refuses_startup(
    tmp_path: Path, snippet: str, description: str, marker: str
):
    """Invalid `categories:` entries SHALL raise ActionRegistryError."""
    from app.services.actions import ActionRegistryError, load_categories

    yaml_file = tmp_path / f"bad_cat_{description}.yaml"
    yaml_file.write_text(
        f"""\
categories:
  {snippet}
""",
        encoding="utf-8",
    )
    with pytest.raises(ActionRegistryError):
        load_categories(yaml_file)


def test_missing_categories_block_returns_empty_list(tmp_path: Path):
    """Absent or empty `categories:` block SHALL return [] without raising."""
    from app.services.actions import load_categories

    yaml_absent = tmp_path / "absent.yaml"
    yaml_absent.write_text("actions: []\n", encoding="utf-8")
    assert load_categories(yaml_absent) == []

    yaml_empty = tmp_path / "empty.yaml"
    yaml_empty.write_text("categories: []\nactions: []\n", encoding="utf-8")
    assert load_categories(yaml_empty) == []


# ---------- Section 3: API surface ----------


def test_get_actions_includes_per_entry_category_fields(stubbed_app):
    """GET /actions SHALL surface category information for client-side grouping:
    every entry includes `category` and `categoryLabels` (may be null)."""
    with TestClient(stubbed_app) as c:
        body = c.get("/actions").json()
        for a in body["actions"]:
            assert "category" in a, f"{a['id']} missing 'category' field"
            assert "categoryLabels" in a, f"{a['id']} missing 'categoryLabels' field"


def test_get_actions_includes_top_level_categories(stubbed_app):
    """GET /actions SHALL include a top-level `categories` array in declared
    order, mirroring the YAML categories block."""
    with TestClient(stubbed_app) as c:
        body = c.get("/actions").json()
        assert "categories" in body
        assert [c["id"] for c in body["categories"]] == [
            "raw",
            "cleanup",
            "structure",
            "transform",
        ]
        for c in body["categories"]:
            assert {"id", "label", "labels"} <= set(c.keys())
            assert isinstance(c["labels"], dict) and c["labels"]
            assert c["label"]


def test_get_actions_legacy_keys_still_present(stubbed_app):
    """Adding `category`/`categoryLabels` SHALL NOT remove existing
    {id, label, labels, template} keys per entry — backward compatibility."""
    with TestClient(stubbed_app) as c:
        body = c.get("/actions").json()
        for a in body["actions"]:
            assert {"id", "label", "labels", "template"} <= set(a.keys())


# ---------- Section 4: shipped registry assignment + new chip contracts ----------


def test_shipped_registry_declares_four_categories():
    """The shipped registry SHALL declare four categories in this exact order:
    raw, cleanup, structure, transform — each with bilingual labels."""
    from app.services.actions import DEFAULT_REGISTRY_PATH, load_categories

    shipped = Path(__file__).resolve().parent.parent / DEFAULT_REGISTRY_PATH
    cats = load_categories(shipped)
    assert [c.id for c in cats] == ["raw", "cleanup", "structure", "transform"]
    for c in cats:
        assert set(c.labels.keys()) >= {"en", "zh-TW"}, (
            f"category {c.id!r} missing en or zh-TW label"
        )


def _shipped_actions():
    from app.services.actions import DEFAULT_REGISTRY_PATH, load_actions

    shipped = Path(__file__).resolve().parent.parent / DEFAULT_REGISTRY_PATH
    return {a.id: a for a in load_actions(shipped)}


def test_existing_chips_keep_ids_and_templates():
    """The existing seven chips SHALL keep their ids and templates; only the
    new `category` field is added to each."""
    actions = _shipped_actions()
    expected = {
        "passthrough": "raw",
        "cleanup-light": "cleanup",
        "punctuate": "cleanup",
        "polish": "cleanup",
        "meeting-notes": "structure",
        "translate-en": "transform",
        "formalize": "transform",
    }
    for action_id, category in expected.items():
        assert action_id in actions, f"{action_id} missing from shipped registry"
        assert actions[action_id].category == category, (
            f"{action_id} expected category {category!r}, got {actions[action_id].category!r}"
        )


def test_fix_only_asr_contract():
    """`fix-only-asr` template SHALL fix ASR errors only AND preserve fillers —
    lighter than cleanup-light. Template references ASR and filler preservation."""
    actions = _shipped_actions()
    assert "fix-only-asr" in actions
    template = actions["fix-only-asr"].template
    assert "{transcript}" in template
    assert "asr" in template.lower() or "ASR" in template
    assert "preserve" in template.lower() and "filler" in template.lower()
    assert actions["fix-only-asr"].category == "cleanup"


@pytest.mark.parametrize(
    "chip_id,must_contain",
    [
        ("summary-tldr", "TL;DR"),
        ("bullet-outline", "bullet"),
        ("extract-todos", "- [ ]"),
        ("questions-raised", "question"),
        ("code-spec", "[NEEDS CLARIFICATION]"),
        ("1on1-notes", "[NEEDS CLARIFICATION]"),
        ("standup-recap", "## Yesterday"),
    ],
)
def test_structure_chips_have_required_headings_or_format(chip_id, must_contain):
    """Each new structure chip's template SHALL include its contract marker
    (heading, format hint, or output sigil) per the spec."""
    actions = _shipped_actions()
    assert chip_id in actions, f"{chip_id} missing from shipped registry"
    assert "{transcript}" in actions[chip_id].template
    assert actions[chip_id].category == "structure"
    template = actions[chip_id].template
    assert must_contain.lower() in template.lower(), (
        f"{chip_id} template missing required marker {must_contain!r}"
    )


def test_action_description_is_optional_and_normalised(tmp_path: Path):
    """Description follows the same string-or-mapping rules as label. Absent →
    `description` and `description_labels` are both None; string → en mapping;
    mapping → loaded verbatim."""
    from app.services.actions import load_actions

    yaml_file = tmp_path / "actions.yaml"
    yaml_file.write_text(
        """\
actions:
  - id: no-desc
    label: "No desc"
    template: "{transcript}"
  - id: string-desc
    label: String
    description: A short description.
    template: "{transcript}"
  - id: mapping-desc
    label: Mapping
    description:
      en: English description.
      zh-TW: 中文說明。
    template: "{transcript}"
""",
        encoding="utf-8",
    )
    by_id = {a.id: a for a in load_actions(yaml_file)}

    assert by_id["no-desc"].description is None
    assert by_id["no-desc"].description_labels is None

    assert by_id["string-desc"].description == "A short description."
    assert by_id["string-desc"].description_labels == {"en": "A short description."}

    assert by_id["mapping-desc"].description == "English description."
    assert by_id["mapping-desc"].description_labels == {
        "en": "English description.",
        "zh-TW": "中文說明。",
    }


def test_invalid_description_refuses_startup(tmp_path: Path):
    """Empty string OR empty mapping OR non-string mapping value all raise."""
    from app.services.actions import ActionRegistryError, load_actions

    for bad_yaml in (
        'description: ""',
        "description: {}",
        "description:\n      en: 42",
    ):
        yaml_file = tmp_path / f"bad_{hash(bad_yaml)}.yaml"
        yaml_file.write_text(
            f"""\
actions:
  - id: bad-desc
    label: x
    {bad_yaml}
    template: "{{transcript}}"
""",
            encoding="utf-8",
        )
        with pytest.raises(ActionRegistryError) as exc_info:
            load_actions(yaml_file)
        assert "bad-desc" in str(exc_info.value)


def test_get_actions_includes_description_fields(stubbed_app):
    """GET /actions per entry SHALL include `description` (legacy single string)
    and `descriptionLabels` (bilingual mapping), or both null when absent."""
    with TestClient(stubbed_app) as c:
        body = c.get("/actions").json()
        for a in body["actions"]:
            assert "description" in a, f"{a['id']} missing 'description' field"
            assert "descriptionLabels" in a, (
                f"{a['id']} missing 'descriptionLabels' field"
            )
        # In the shipped registry every chip has a description.
        for a in body["actions"]:
            assert isinstance(a["description"], str) and a["description"]
            assert isinstance(a["descriptionLabels"], dict)
            assert "en" in a["descriptionLabels"] and "zh-TW" in a["descriptionLabels"]


def test_transform_new_chips_contracts():
    """`translate-zh` SHALL translate to Chinese; `email-draft` SHALL output
    Subject line plus greeting/body/closing."""
    actions = _shipped_actions()

    assert "translate-zh" in actions
    tz = actions["translate-zh"]
    assert "{transcript}" in tz.template
    assert tz.category == "transform"
    assert "chinese" in tz.template.lower() or "zh-tw" in tz.template.lower()

    assert "email-draft" in actions
    ed = actions["email-draft"]
    assert "{transcript}" in ed.template
    assert ed.category == "transform"
    assert "subject:" in ed.template.lower()
    assert "closing" in ed.template.lower() or "signoff" in ed.template.lower() or "sign-off" in ed.template.lower()
