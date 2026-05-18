#!/bin/bash
# =============================================================================
# Model Manager for whisper-wrap v2.1 (CTranslate2 + ggml/Core ML via variants)
#
# Drives `hf download` against `registry/models.yaml`. The v2.1 schema declares
# one or more `variants:` per model — this script iterates the variants list
# for download / list / set / delete, so a single `make download-model MODEL=x`
# fetches every variant of x (typically both a ct2 and a ggml packaging).
#
# YAML parsing is delegated to the project's Python (app.services.registry).
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REGISTRY_FILE="${WHISPER_WRAP_REGISTRY:-$PROJECT_DIR/registry/models.yaml}"
MODELS_DIR="${WHISPER_WRAP_MODELS_DIR:-$PROJECT_DIR/models}"
ENV_FILE="${WHISPER_WRAP_ENV_FILE:-$PROJECT_DIR/.env}"

# Prefer the project's venv python over the system one so imports of
# project-side modules (e.g. app.services.registry → pyyaml) work after a
# fresh `uv sync`. Fall back to system python3 if the venv hasn't been
# created yet — the caller can still override with PYTHON_BIN=...
DEFAULT_PYTHON="$PROJECT_DIR/.venv/bin/python3"
if [ -z "${PYTHON_BIN:-}" ] && [ -x "$DEFAULT_PYTHON" ]; then
    PYTHON_BIN="$DEFAULT_PYTHON"
else
    PYTHON_BIN="${PYTHON_BIN:-python3}"
fi
PYTHONPATH_DIR="${WHISPER_WRAP_PYTHONPATH:-$PROJECT_DIR}"

usage() {
    cat <<EOF
Usage: $0 <command> [args]

Commands:
  list                       List registry models with per-variant install status
  download <name>            Download every variant declared on <name>
  set <name>                 Set MODEL_NAME=<name> in .env (requires ≥1 installed variant)
  delete <name>              Delete every variant's local_dir (refuses if active)
  default                    Print the default model name from the registry

Environment overrides:
  WHISPER_WRAP_REGISTRY      Path to registry yaml (default: registry/models.yaml)
  WHISPER_WRAP_MODELS_DIR    Models root (default: ./models)
  WHISPER_WRAP_ENV_FILE      .env path (default: ./.env)
  WHISPER_WRAP_PYTHONPATH    PYTHONPATH for app.services.registry import
EOF
}

die() { echo "Error: $*" >&2; exit 1; }

# Run python against the registry path with the optional model name as argv[2].
# Stdin: a python snippet that imports load_registry / default_model_name and
# writes to stdout. The snippet receives sys.argv = [<script>, <registry>, <name?>].
py_registry() {
    local extra_arg="${1:-}"
    if [ -n "$extra_arg" ]; then
        PYTHONPATH="$PYTHONPATH_DIR" "$PYTHON_BIN" - "$REGISTRY_FILE" "$extra_arg"
    else
        PYTHONPATH="$PYTHONPATH_DIR" "$PYTHON_BIN" - "$REGISTRY_FILE"
    fi
}

# Validate the registry yaml. Exits non-zero on error.
validate_registry() {
    py_registry <<'PY'
import sys
from app.services.registry import load_registry, RegistryError
try:
    load_registry(sys.argv[1])
except RegistryError as e:
    print(f"Registry validation failed: {e}", file=sys.stderr)
    sys.exit(2)
PY
}

# Print JSON for an entry's variants list (validating registry first).
get_variants_json() {
    local name="$1"
    py_registry "$name" <<'PY'
import json, sys
from app.services.registry import load_registry, RegistryError
try:
    entries = load_registry(sys.argv[1])
except RegistryError as e:
    print(f"Registry validation failed: {e}", file=sys.stderr)
    sys.exit(2)
name = sys.argv[2]
if name not in entries:
    print(f"Unknown model: {name}", file=sys.stderr)
    sys.exit(3)
print(json.dumps(entries[name].get("variants", [])))
PY
}

# variant_installed <variant_local_dir> <variant_format> [variant_filename] [variant_coreml]
#   Returns 0 (true) if the variant's on-disk artefacts satisfy the format's
#   "installed" definition; non-zero otherwise.
variant_installed() {
    local local_dir="$1" fmt="$2" filename="${3:-}" coreml="${4:-}"
    local base="$MODELS_DIR/$local_dir"
    [ -d "$base" ] || return 1
    case "$fmt" in
        ct2)
            [ -f "$base/model.bin" ] || return 1
            { [ -f "$base/tokenizer.json" ] || [ -f "$base/vocabulary.json" ]; } || return 1
            ;;
        ggml)
            [ -n "$filename" ] || return 1
            [ -f "$base/$filename" ] || return 1
            [ -n "$coreml" ] || return 1
            [ -d "$base/$coreml" ] || return 1
            ;;
        *)
            return 1
            ;;
    esac
    return 0
}

# True when at least one variant of <name> is installed.
any_variant_installed() {
    local name="$1"
    local variants_json
    variants_json="$(get_variants_json "$name")"
    "$PYTHON_BIN" - "$variants_json" <<'PY'
import json, sys
print(len(json.loads(sys.argv[1])))
PY
    local count
    count="$("$PYTHON_BIN" -c "import json,sys; print(len(json.loads(sys.argv[1])))" "$variants_json")"
    [ "$count" -gt 0 ] || return 1
    for i in $(seq 0 $((count - 1))); do
        local fmt local_dir filename coreml
        fmt="$("$PYTHON_BIN" -c "import json,sys; print(json.loads(sys.argv[1])[int(sys.argv[2])]['format'])" "$variants_json" "$i")"
        local_dir="$("$PYTHON_BIN" -c "import json,sys; print(json.loads(sys.argv[1])[int(sys.argv[2])]['local_dir'])" "$variants_json" "$i")"
        filename="$("$PYTHON_BIN" -c "import json,sys; print(json.loads(sys.argv[1])[int(sys.argv[2])].get('filename',''))" "$variants_json" "$i")"
        coreml="$("$PYTHON_BIN" -c "import json,sys; print(json.loads(sys.argv[1])[int(sys.argv[2])].get('coreml_encoder',''))" "$variants_json" "$i")"
        if variant_installed "$local_dir" "$fmt" "$filename" "$coreml"; then
            return 0
        fi
    done
    return 1
}

# True when *all* variants of <name> are installed (used by the download skip path).
all_variants_installed() {
    local name="$1"
    local variants_json
    variants_json="$(get_variants_json "$name")"
    local count
    count="$("$PYTHON_BIN" -c "import json,sys; print(len(json.loads(sys.argv[1])))" "$variants_json")"
    [ "$count" -gt 0 ] || return 1
    for i in $(seq 0 $((count - 1))); do
        local fmt local_dir filename coreml
        fmt="$("$PYTHON_BIN" -c "import json,sys; print(json.loads(sys.argv[1])[int(sys.argv[2])]['format'])" "$variants_json" "$i")"
        local_dir="$("$PYTHON_BIN" -c "import json,sys; print(json.loads(sys.argv[1])[int(sys.argv[2])]['local_dir'])" "$variants_json" "$i")"
        filename="$("$PYTHON_BIN" -c "import json,sys; print(json.loads(sys.argv[1])[int(sys.argv[2])].get('filename',''))" "$variants_json" "$i")"
        coreml="$("$PYTHON_BIN" -c "import json,sys; print(json.loads(sys.argv[1])[int(sys.argv[2])].get('coreml_encoder',''))" "$variants_json" "$i")"
        if ! variant_installed "$local_dir" "$fmt" "$filename" "$coreml"; then
            return 1
        fi
    done
    return 0
}

list_entries() {
    # Surface .env's MODEL_NAME / BACKEND_FORMAT to the python snippet so the
    # "Active model" header reflects the same selection the lifespan will use.
    # Existing env vars win (allows `MODEL_NAME=x make models` for a what-if).
    local model_name="${MODEL_NAME:-}"
    local backend_format="${BACKEND_FORMAT:-}"
    # `|| true` swallows grep's exit-1 when the key isn't present; without it,
    # `set -euo pipefail` would kill the script before we even print the table.
    if [ -f "$ENV_FILE" ]; then
        if [ -z "$model_name" ]; then
            model_name=$(grep -E '^MODEL_NAME=' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)
        fi
        if [ -z "$backend_format" ]; then
            backend_format=$(grep -E '^BACKEND_FORMAT=' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)
        fi
    fi

    MODEL_NAME="$model_name" BACKEND_FORMAT="$backend_format" \
    PYTHONPATH="$PYTHONPATH_DIR" "$PYTHON_BIN" - "$REGISTRY_FILE" "$MODELS_DIR" <<'PY'
import os, sys
from app.services.registry import (
    RegistryError,
    default_model_name,
    load_registry,
    resolve_variant,
)
try:
    entries = load_registry(sys.argv[1])
except RegistryError as e:
    print(f"Registry validation failed: {e}", file=sys.stderr)
    sys.exit(2)
models_dir = sys.argv[2]


def variant_label(v: dict) -> str:
    if v["format"] == "ct2":
        return f"ct2 ({v.get('compute_type', '?')})"
    if v["format"] == "ggml":
        return f"ggml ({v.get('quant', '?')})"
    return v["format"]


def variant_installed(v: dict) -> bool:
    base = os.path.join(models_dir, v["local_dir"])
    if not os.path.isdir(base):
        return False
    if v["format"] == "ct2":
        return os.path.isfile(os.path.join(base, "model.bin")) and (
            os.path.isfile(os.path.join(base, "tokenizer.json"))
            or os.path.isfile(os.path.join(base, "vocabulary.json"))
        )
    if v["format"] == "ggml":
        return os.path.isfile(os.path.join(base, v.get("filename", ""))) and os.path.isdir(
            os.path.join(base, v.get("coreml_encoder", ""))
        )
    return False


# ------------ Active model header (resolves same way the lifespan does) ------
active_name = os.environ.get("MODEL_NAME") or ""
if not active_name:
    try:
        active_name = default_model_name(sys.argv[1])
    except RegistryError:
        active_name = ""
backend_format = os.environ.get("BACKEND_FORMAT") or None
plat = "darwin" if sys.platform == "darwin" else "linux"

if active_name and active_name in entries:
    try:
        active_variant = resolve_variant(
            entries[active_name], platform=plat, backend_format=backend_format
        )
        status = "installed" if variant_installed(active_variant) else "NOT INSTALLED — run: make download-model MODEL=" + active_name
        print(f"Active model: {active_name} → {variant_label(active_variant)} [{status}]")
    except RegistryError as e:
        print(f"Active model: {active_name} (variant unresolved: {e})")
elif active_name:
    print(f"Active model: {active_name} (NOT in registry — check MODEL_NAME in .env)")
else:
    print("Active model: <unset> (no default found in registry)")
print()

# ------------ Full registry table -------------------------------------------
print(f"{'MODEL':<22} {'DEFAULT':<8} {'VARIANT':<22} {'INSTALLED':<10} REPO")
for name, e in entries.items():
    default_flag = "*" if e.get("default") else ""
    variants = e.get("variants", [])
    if not variants:
        print(f"{name:<22} {default_flag:<8} (no variants)")
        continue
    for idx, v in enumerate(variants):
        # Only the first variant of each model carries the model name + default flag;
        # subsequent variants show under an indented continuation line for clarity.
        model_col = name if idx == 0 else ""
        default_col = default_flag if idx == 0 else ""
        flag = "yes" if variant_installed(v) else ""
        repo = v.get("repo_id", "")
        print(
            f"{model_col:<22} {default_col:<8} {variant_label(v):<22} {flag:<10} {repo}"
        )
PY
}

cmd_list() {
    validate_registry
    list_entries
}

cmd_default() {
    validate_registry
    py_registry <<'PY'
import sys
from app.services.registry import default_model_name
print(default_model_name(sys.argv[1]))
PY
}

# Internal: download a single variant given its JSON encoding.
download_variant() {
    local variant_json="$1" target_name="$2" variant_index="$3"

    local fmt local_dir repo_id subfolder revision filename coreml
    fmt="$("$PYTHON_BIN" -c "import json,sys; print(json.loads(sys.argv[1])['format'])" "$variant_json")"
    local_dir="$("$PYTHON_BIN" -c "import json,sys; print(json.loads(sys.argv[1])['local_dir'])" "$variant_json")"
    repo_id="$("$PYTHON_BIN" -c "import json,sys; print(json.loads(sys.argv[1]).get('repo_id',''))" "$variant_json")"
    subfolder="$("$PYTHON_BIN" -c "import json,sys; print(json.loads(sys.argv[1]).get('subfolder',''))" "$variant_json")"
    revision="$("$PYTHON_BIN" -c "import json,sys; print(json.loads(sys.argv[1]).get('revision',''))" "$variant_json")"
    filename="$("$PYTHON_BIN" -c "import json,sys; print(json.loads(sys.argv[1]).get('filename',''))" "$variant_json")"
    coreml="$("$PYTHON_BIN" -c "import json,sys; print(json.loads(sys.argv[1]).get('coreml_encoder',''))" "$variant_json")"

    local label
    case "$fmt" in
        ct2)  label="ct2";;
        ggml) label="ggml";;
        *)    die "Unknown variant format '$fmt' on $target_name#$variant_index";;
    esac

    echo
    echo "==> [$target_name] variant #$variant_index ($label) — local_dir=$local_dir"

    if variant_installed "$local_dir" "$fmt" "$filename" "$coreml"; then
        echo "    already installed, skipping."
        return 0
    fi

    [ -n "$repo_id" ] || die "variant #$variant_index of '$target_name' has no repo_id"

    local dest="$MODELS_DIR/$local_dir"
    mkdir -p "$MODELS_DIR"

    local hf_args=(download "$repo_id" --local-dir "$dest")
    if [ -n "$subfolder" ]; then
        hf_args+=(--include "$subfolder/*")
    fi
    if [ -n "$revision" ]; then
        hf_args+=(--revision "$revision")
    fi

    echo "    fetching from $repo_id"
    if command -v hf >/dev/null 2>&1; then
        hf "${hf_args[@]}"
    elif command -v huggingface-cli >/dev/null 2>&1; then
        huggingface-cli "${hf_args[@]}"
    else
        die "Neither 'hf' nor 'huggingface-cli' found on PATH. Install with: pip install huggingface_hub"
    fi

    # If we downloaded with a subfolder, hf places files under $dest/$subfolder/.
    # Hoist them up so resolver finds artefacts at the canonical path.
    if [ -n "$subfolder" ] && [ -d "$dest/$subfolder" ]; then
        echo "    hoisting $subfolder/* up to $dest/"
        ( shopt -s dotglob nullglob
          for f in "$dest/$subfolder"/*; do
              mv -f "$f" "$dest/"
          done )
        rmdir "$dest/$subfolder" 2>/dev/null || true
    fi

    echo "    installed at $dest"
}

cmd_download() {
    [ $# -ge 1 ] || die "download requires <name>"
    local target="$1"

    # Reject URL form explicitly (v2 removed URL-based downloads).
    if [[ "$target" =~ ^https?:// ]]; then
        die "URL-based downloads were removed in v2. Add an entry to registry/models.yaml and run: $0 download <name>"
    fi

    validate_registry
    local variants_json
    variants_json="$(get_variants_json "$target")"

    local count
    count="$("$PYTHON_BIN" -c "import json,sys; print(len(json.loads(sys.argv[1])))" "$variants_json")"
    if [ "$count" -eq 0 ]; then
        die "Model '$target' declares zero variants (registry should have caught this)."
    fi

    echo "Downloading $count variant(s) of '$target' into $MODELS_DIR/"

    for i in $(seq 0 $((count - 1))); do
        local variant_json
        variant_json="$("$PYTHON_BIN" -c "import json,sys; print(json.dumps(json.loads(sys.argv[1])[int(sys.argv[2])]))" "$variants_json" "$i")"
        download_variant "$variant_json" "$target" "$i"
    done

    echo
    echo "OK: '$target' installed (all variants present)"
}

cmd_set() {
    [ $# -ge 1 ] || die "set requires <name>"
    local name="$1"

    validate_registry
    # get_variants_json validates that <name> exists; ignore the actual value.
    get_variants_json "$name" >/dev/null

    if ! any_variant_installed "$name"; then
        die "Model '$name' has no installed variants. Run: $0 download $name"
    fi

    [ -f "$ENV_FILE" ] || die ".env file not found at $ENV_FILE"
    if grep -qE '^MODEL_NAME=' "$ENV_FILE"; then
        local tmp
        tmp="$(mktemp)"
        awk -v new="MODEL_NAME=$name" '/^MODEL_NAME=/ {print new; next} {print}' "$ENV_FILE" > "$tmp"
        mv "$tmp" "$ENV_FILE"
    else
        printf "\nMODEL_NAME=%s\n" "$name" >> "$ENV_FILE"
    fi
    echo "OK: active model set to $name in $ENV_FILE"
}

cmd_delete() {
    [ $# -ge 1 ] || die "delete requires <name>"
    local name="$1"

    validate_registry
    local variants_json
    variants_json="$(get_variants_json "$name")"

    # Refuse to delete the model currently active in .env.
    local active=""
    if [ -f "$ENV_FILE" ]; then
        active="$(grep -E '^MODEL_NAME=' "$ENV_FILE" | tail -1 | cut -d= -f2 | tr -d '\r')"
    fi
    if [ "$active" = "$name" ]; then
        die "Refusing to delete the active model '$name'. Switch with: $0 set <other> first."
    fi

    local count
    count="$("$PYTHON_BIN" -c "import json,sys; print(len(json.loads(sys.argv[1])))" "$variants_json")"
    if [ "$count" -eq 0 ]; then
        die "Model '$name' declares zero variants (nothing to delete)."
    fi

    local removed_any=0
    for i in $(seq 0 $((count - 1))); do
        local local_dir
        local_dir="$("$PYTHON_BIN" -c "import json,sys; print(json.loads(sys.argv[1])[int(sys.argv[2])]['local_dir'])" "$variants_json" "$i")"
        local dest="$MODELS_DIR/$local_dir"
        if [ -d "$dest" ]; then
            rm -rf "$dest"
            echo "OK: removed $dest"
            removed_any=1
        else
            echo "Nothing to delete at $dest"
        fi
    done

    if [ "$removed_any" -eq 0 ]; then
        echo "No variant directories existed for '$name' — nothing removed."
    fi
}

main() {
    local cmd="${1:-}"
    [ -n "$cmd" ] || { usage; exit 0; }
    shift || true
    case "$cmd" in
        list) cmd_list "$@";;
        download) cmd_download "$@";;
        set) cmd_set "$@";;
        delete) cmd_delete "$@";;
        default) cmd_default "$@";;
        -h|--help|help) usage;;
        *) usage; die "Unknown command: $cmd";;
    esac
}

main "$@"
