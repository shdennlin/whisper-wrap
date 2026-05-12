#!/bin/bash
# =============================================================================
# Model Manager for whisper-wrap v2 (CTranslate2 + Hugging Face)
#
# Drives `hf download` against `registry/models.yaml`. YAML parsing is delegated
# to the project's Python (PyYAML), keeping this script focused on download/
# install/activate/delete flows.
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REGISTRY_FILE="${WHISPER_WRAP_REGISTRY:-$PROJECT_DIR/registry/models.yaml}"
MODELS_DIR="${WHISPER_WRAP_MODELS_DIR:-$PROJECT_DIR/models}"
ENV_FILE="${WHISPER_WRAP_ENV_FILE:-$PROJECT_DIR/.env}"

PYTHON_BIN="${PYTHON_BIN:-python3}"
PYTHONPATH_DIR="${WHISPER_WRAP_PYTHONPATH:-$PROJECT_DIR}"

usage() {
    cat <<EOF
Usage: $0 <command> [args]

Commands:
  list                       List registry entries and download status
  download <name>            Download a model by name (CT2 directory)
  download <url>             REJECTED in v2: URL-based downloads are not supported
  set <name>                 Set MODEL_NAME=<name> in .env (only if installed)
  delete <name>              Delete a downloaded model (refuses if active)
  default                    Print the default model name from the registry

Environment overrides:
  WHISPER_WRAP_REGISTRY      Path to registry yaml (default: registry/models.yaml)
  WHISPER_WRAP_MODELS_DIR    Models root (default: ./models)
  WHISPER_WRAP_ENV_FILE      .env path (default: ./.env)
  WHISPER_WRAP_PYTHONPATH    PYTHONPATH for app.services.registry import
EOF
}

die() { echo "Error: $*" >&2; exit 1; }

# Validate the registry yaml. Exits non-zero on error.
validate_registry() {
    PYTHONPATH="$PYTHONPATH_DIR" "$PYTHON_BIN" - "$REGISTRY_FILE" <<'PY'
import sys
from app.services.registry import load_registry, RegistryError
try:
    load_registry(sys.argv[1])
except RegistryError as e:
    print(f"Registry validation failed: {e}", file=sys.stderr)
    sys.exit(2)
PY
}

# Emit a JSON dict for one entry (or fail with exit 3 if not found).
get_entry_json() {
    local name="$1"
    PYTHONPATH="$PYTHONPATH_DIR" "$PYTHON_BIN" - "$REGISTRY_FILE" "$name" <<'PY'
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
print(json.dumps(entries[name]))
PY
}

list_entries() {
    PYTHONPATH="$PYTHONPATH_DIR" "$PYTHON_BIN" - "$REGISTRY_FILE" "$MODELS_DIR" <<'PY'
import os, sys
from app.services.registry import load_registry, RegistryError
try:
    entries = load_registry(sys.argv[1])
except RegistryError as e:
    print(f"Registry validation failed: {e}", file=sys.stderr)
    sys.exit(2)
models_dir = sys.argv[2]
print(f"{'NAME':<22} {'DEFAULT':<8} {'INSTALLED':<10} {'SIZE':<8} REPO")
for name, e in entries.items():
    local = os.path.join(models_dir, e["local_dir"])
    model_bin = os.path.join(local, "model.bin")
    tokenizer = os.path.join(local, "tokenizer.json")
    vocab = os.path.join(local, "vocabulary.json")
    installed = os.path.isfile(model_bin) and (os.path.isfile(tokenizer) or os.path.isfile(vocab))
    default = "*" if e.get("default") else ""
    flag = "yes" if installed else ""
    print(f"{name:<22} {default:<8} {flag:<10} {e['size']:<8} {e['repo_id']}")
PY
}

cmd_list() {
    validate_registry
    list_entries
}

cmd_default() {
    validate_registry
    PYTHONPATH="$PYTHONPATH_DIR" "$PYTHON_BIN" - "$REGISTRY_FILE" <<'PY'
import sys
from app.services.registry import default_model_name
print(default_model_name(sys.argv[1]))
PY
}

cmd_download() {
    [ $# -ge 1 ] || die "download requires <name>"
    local target="$1"

    # Reject URL form explicitly (v2 removes URL-based downloads).
    if [[ "$target" =~ ^https?:// ]]; then
        die "URL-based downloads were removed in v2. Add an entry to registry/models.yaml and run: $0 download <name>"
    fi

    validate_registry
    local entry_json
    entry_json="$(get_entry_json "$target")"

    local repo_id local_dir subfolder revision
    repo_id="$("$PYTHON_BIN" -c "import json,sys; print(json.loads(sys.argv[1])['repo_id'])" "$entry_json")"
    local_dir="$("$PYTHON_BIN" -c "import json,sys; print(json.loads(sys.argv[1])['local_dir'])" "$entry_json")"
    subfolder="$("$PYTHON_BIN" -c "import json,sys; print(json.loads(sys.argv[1]).get('subfolder',''))" "$entry_json")"
    revision="$("$PYTHON_BIN" -c "import json,sys; print(json.loads(sys.argv[1]).get('revision',''))" "$entry_json")"

    local dest="$MODELS_DIR/$local_dir"
    mkdir -p "$MODELS_DIR"

    local hf_args=(download "$repo_id" --local-dir "$dest")
    if [ -n "$subfolder" ]; then
        hf_args+=(--include "$subfolder/*")
    fi
    if [ -n "$revision" ]; then
        hf_args+=(--revision "$revision")
    fi

    echo "Downloading $target from $repo_id into $dest"
    if command -v hf >/dev/null 2>&1; then
        hf "${hf_args[@]}"
    elif command -v huggingface-cli >/dev/null 2>&1; then
        huggingface-cli "${hf_args[@]}"
    else
        die "Neither 'hf' nor 'huggingface-cli' found on PATH. Install with: pip install huggingface_hub"
    fi

    # If we downloaded with a subfolder, hf places files under $dest/$subfolder/.
    # Move them up to $dest/ so the resolver finds model.bin at the canonical path.
    if [ -n "$subfolder" ] && [ -d "$dest/$subfolder" ]; then
        echo "Hoisting $subfolder/* up to $dest/"
        ( shopt -s dotglob nullglob
          for f in "$dest/$subfolder"/*; do
              mv -f "$f" "$dest/"
          done )
        rmdir "$dest/$subfolder" 2>/dev/null || true
    fi

    echo "OK: $target installed at $dest"
}

cmd_set() {
    [ $# -ge 1 ] || die "set requires <name>"
    local name="$1"

    validate_registry
    local entry_json
    entry_json="$(get_entry_json "$name")"

    local local_dir
    local_dir="$("$PYTHON_BIN" -c "import json,sys; print(json.loads(sys.argv[1])['local_dir'])" "$entry_json")"
    local dest="$MODELS_DIR/$local_dir"

    if [ ! -f "$dest/model.bin" ]; then
        die "Model '$name' is not installed at $dest. Run: $0 download $name"
    fi

    # Update or append MODEL_NAME in .env atomically (portable across BSD/GNU sed).
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
    local entry_json
    entry_json="$(get_entry_json "$name")"

    # Refuse to delete the model currently active in .env.
    local active=""
    if [ -f "$ENV_FILE" ]; then
        active="$(grep -E '^MODEL_NAME=' "$ENV_FILE" | tail -1 | cut -d= -f2 | tr -d '\r')"
    fi
    if [ "$active" = "$name" ]; then
        die "Refusing to delete the active model '$name'. Switch with: $0 set <other> first."
    fi

    local local_dir
    local_dir="$("$PYTHON_BIN" -c "import json,sys; print(json.loads(sys.argv[1])['local_dir'])" "$entry_json")"
    local dest="$MODELS_DIR/$local_dir"
    if [ ! -d "$dest" ]; then
        echo "Nothing to delete: $dest does not exist."
        return 0
    fi
    rm -rf "$dest"
    echo "OK: removed $dest"
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
