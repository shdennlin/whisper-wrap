#!/bin/bash
# =============================================================================
# Model Manager for whisper-wrap
# Handles downloading, listing, activating, and deleting GGML models.
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REGISTRY_FILE="$PROJECT_DIR/registry/models.yaml"
MODELS_DIR="$PROJECT_DIR/models"
ENV_FILE="$PROJECT_DIR/.env"

# =============================================================================
# YAML Parsing (flat structure, no external dependencies)
# =============================================================================

# Get list of model names from registry
get_model_names() {
    grep -E '^  [a-zA-Z]' "$REGISTRY_FILE" | sed 's/:.*//' | sed 's/^  //'
}

# Get a field value for a specific model
get_model_field() {
    local model="$1"
    local field="$2"
    local in_model=0

    while IFS= read -r line; do
        if echo "$line" | grep -qE "^  ${model}:$"; then
            in_model=1
            continue
        fi
        if [ "$in_model" -eq 1 ]; then
            # Check if we've hit the next model (non-indented or 2-space indent key)
            if echo "$line" | grep -qE '^  [a-zA-Z]'; then
                break
            fi
            # Match the field
            if echo "$line" | grep -qE "^    ${field}:"; then
                echo "$line" | sed "s/^    ${field}: *//" | sed 's/^"//' | sed 's/"$//'
                return 0
            fi
        fi
    done < "$REGISTRY_FILE"
    return 1
}

# Get the default model name
get_default_model() {
    local model_names
    model_names=$(get_model_names)
    for model in $model_names; do
        local default_val
        default_val=$(get_model_field "$model" "default" 2>/dev/null || echo "")
        if [ "$default_val" = "true" ]; then
            echo "$model"
            return 0
        fi
    done
    echo ""
    return 1
}

# Get active model name from .env
get_active_model() {
    if [ -f "$ENV_FILE" ]; then
        grep -E '^MODEL_NAME=' "$ENV_FILE" 2>/dev/null | sed 's/MODEL_NAME=//' || echo ""
    else
        echo ""
    fi
}

# Get active model path from .env
get_active_model_path() {
    if [ -f "$ENV_FILE" ]; then
        grep -E '^MODEL_PATH=' "$ENV_FILE" 2>/dev/null | sed 's/MODEL_PATH=//' || echo ""
    else
        echo ""
    fi
}

# Check if a model file is installed
is_model_installed() {
    local model="$1"
    local filename
    filename=$(get_model_field "$model" "filename" 2>/dev/null || echo "")
    if [ -n "$filename" ] && [ -f "$MODELS_DIR/$filename" ]; then
        return 0
    fi
    return 1
}

# =============================================================================
# Commands
# =============================================================================

cmd_list() {
    if [ ! -f "$REGISTRY_FILE" ]; then
        echo "Error: Registry file not found at $REGISTRY_FILE"
        exit 1
    fi

    local active_model
    active_model=$(get_active_model)
    local model_names
    model_names=$(get_model_names)
    local total_size=0

    echo ""
    echo "  whisper-wrap Model Registry"
    echo "  ════════════════════════════════════════════════════════════════"
    echo ""

    for model in $model_names; do
        local filename size description languages
        filename=$(get_model_field "$model" "filename" 2>/dev/null || echo "unknown")
        size=$(get_model_field "$model" "size" 2>/dev/null || echo "?")
        description=$(get_model_field "$model" "description" 2>/dev/null || echo "")
        languages=$(get_model_field "$model" "languages" 2>/dev/null || echo "[]")

        local status_icon="○"
        local status_text=""

        if is_model_installed "$model"; then
            status_icon="◐"
            status_text=" [installed]"
            # Add file size to total
            if [ -f "$MODELS_DIR/$filename" ]; then
                local file_bytes
                file_bytes=$(stat -f%z "$MODELS_DIR/$filename" 2>/dev/null || stat --printf="%s" "$MODELS_DIR/$filename" 2>/dev/null || echo 0)
                total_size=$((total_size + file_bytes))
            fi
        fi

        if [ "$model" = "$active_model" ]; then
            status_icon="●"
            status_text=" [installed] [active]"
        fi

        printf "  %s %-20s [%-6s]%s\n" "$status_icon" "$model" "$size" "$status_text"
        printf "    %s\n" "$description"
        echo ""
    done

    # Show summary
    local total_size_human=""
    if [ "$total_size" -gt 0 ]; then
        if [ "$total_size" -gt 1073741824 ]; then
            total_size_human="$(echo "scale=1; $total_size / 1073741824" | bc)GB"
        elif [ "$total_size" -gt 1048576 ]; then
            total_size_human="$(echo "scale=0; $total_size / 1048576" | bc)MB"
        else
            total_size_human="${total_size}B"
        fi
        total_size_human=" ($total_size_human used)"
    fi

    echo "  ────────────────────────────────────────────────────────────────"
    printf "  Active: %s · Models dir: %s/%s\n" "${active_model:-none}" "$MODELS_DIR" "$total_size_human"
    echo ""
    echo "  make download-model MODEL=<name>   Download a model"
    echo "  make set-model MODEL=<name>        Switch active model"
    echo "  make delete-model MODEL=<name>     Remove a model"
    echo ""
}

cmd_download() {
    local model_arg="$1"

    if [ -z "$model_arg" ]; then
        echo "Error: No model specified."
        echo "Usage: make download-model MODEL=<name-or-url>"
        exit 1
    fi

    local url=""
    local filename=""

    # Check if argument is a URL
    if echo "$model_arg" | grep -qE '^https?://'; then
        url="$model_arg"
        filename=$(basename "$url")
        echo "Downloading from URL: $url"
    else
        # Look up in registry
        url=$(get_model_field "$model_arg" "url" 2>/dev/null || echo "")
        filename=$(get_model_field "$model_arg" "filename" 2>/dev/null || echo "")

        if [ -z "$url" ] || [ -z "$filename" ]; then
            echo "Error: Model '$model_arg' not found in registry."
            echo "Available models:"
            get_model_names | sed 's/^/  - /'
            echo ""
            echo "Or provide a direct URL: make download-model MODEL=https://..."
            exit 1
        fi

        # Check if already installed
        if [ -f "$MODELS_DIR/$filename" ]; then
            echo "Model '$model_arg' is already installed at $MODELS_DIR/$filename"
            echo "To re-download, delete it first: make delete-model MODEL=$model_arg"
            return 0
        fi

        local size description
        size=$(get_model_field "$model_arg" "size" 2>/dev/null || echo "unknown")
        description=$(get_model_field "$model_arg" "description" 2>/dev/null || echo "")
        echo "Downloading: $model_arg ($size)"
        echo "  $description"
    fi

    # Ensure models directory exists
    mkdir -p "$MODELS_DIR"

    # Download with progress
    echo ""
    echo "Saving to: $MODELS_DIR/$filename"
    echo ""

    if ! curl -L --progress-bar -o "$MODELS_DIR/$filename" "$url"; then
        echo "Error: Download failed."
        rm -f "$MODELS_DIR/$filename"
        exit 1
    fi

    echo ""
    echo "Download complete: $MODELS_DIR/$filename"

    # Show file size
    local file_bytes
    file_bytes=$(stat -f%z "$MODELS_DIR/$filename" 2>/dev/null || stat --printf="%s" "$MODELS_DIR/$filename" 2>/dev/null || echo 0)
    if [ "$file_bytes" -gt 1073741824 ]; then
        echo "Size: $(echo "scale=1; $file_bytes / 1073741824" | bc)GB"
    elif [ "$file_bytes" -gt 1048576 ]; then
        echo "Size: $(echo "scale=0; $file_bytes / 1048576" | bc)MB"
    fi
}

cmd_set() {
    local model_arg="$1"

    if [ -z "$model_arg" ]; then
        echo "Error: No model specified."
        echo "Usage: make set-model MODEL=<name>"
        exit 1
    fi

    local filename=""
    local model_name="$model_arg"

    # Check if it's a registry model or a filename
    filename=$(get_model_field "$model_arg" "filename" 2>/dev/null || echo "")

    if [ -n "$filename" ]; then
        # Found in registry
        model_name="$model_arg"
    elif [ -f "$MODELS_DIR/$model_arg" ]; then
        # It's a direct filename
        filename="$model_arg"
        model_name="$model_arg"
    else
        echo "Error: Model '$model_arg' not found in registry and no file at $MODELS_DIR/$model_arg"
        echo ""
        echo "Available models:"
        get_model_names | sed 's/^/  - /'
        echo ""
        echo "Download first: make download-model MODEL=$model_arg"
        exit 1
    fi

    local model_path="$MODELS_DIR/$filename"

    # Verify the file exists
    if [ ! -f "$model_path" ]; then
        echo "Error: Model file not found at $model_path"
        echo "Download first: make download-model MODEL=$model_arg"
        exit 1
    fi

    # Update .env file
    if [ -f "$ENV_FILE" ]; then
        # Remove existing MODEL_NAME and MODEL_PATH lines
        local temp_env
        temp_env=$(grep -v '^MODEL_NAME=' "$ENV_FILE" | grep -v '^MODEL_PATH=' || true)
        echo "$temp_env" > "$ENV_FILE"
    fi

    # Append new values (use relative path for portability)
    local relative_path="./models/$filename"
    echo "MODEL_NAME=$model_name" >> "$ENV_FILE"
    echo "MODEL_PATH=$relative_path" >> "$ENV_FILE"

    echo "Active model set to: $model_name"
    echo "  MODEL_NAME=$model_name"
    echo "  MODEL_PATH=$relative_path"
}

cmd_delete() {
    local model_arg="$1"

    if [ -z "$model_arg" ]; then
        echo "Error: No model specified."
        echo "Usage: make delete-model MODEL=<name>"
        exit 1
    fi

    # Check if it's the active model
    local active_model
    active_model=$(get_active_model)
    if [ "$model_arg" = "$active_model" ]; then
        echo "Error: Cannot delete the active model '$model_arg'."
        echo "Switch to another model first: make set-model MODEL=<other-model>"
        exit 1
    fi

    local filename=""
    filename=$(get_model_field "$model_arg" "filename" 2>/dev/null || echo "")

    if [ -z "$filename" ]; then
        # Try as direct filename
        if [ -f "$MODELS_DIR/$model_arg" ]; then
            filename="$model_arg"
        else
            echo "Error: Model '$model_arg' not found in registry or models directory."
            exit 1
        fi
    fi

    local model_path="$MODELS_DIR/$filename"

    if [ ! -f "$model_path" ]; then
        echo "Model '$model_arg' is not installed."
        return 0
    fi

    rm -f "$model_path"
    echo "Deleted: $model_path"
}

cmd_download_default() {
    local default_model
    default_model=$(get_default_model)

    if [ -z "$default_model" ]; then
        echo "Error: No default model configured in registry."
        exit 1
    fi

    echo "Downloading default model: $default_model"
    cmd_download "$default_model"
}

# =============================================================================
# Main
# =============================================================================

usage() {
    echo "Usage: model-manager.sh <command> [args]"
    echo ""
    echo "Commands:"
    echo "  list              List all models with install/active status"
    echo "  download <name>   Download a model by name or URL"
    echo "  set <name>        Set the active model"
    echo "  delete <name>     Delete a downloaded model"
    echo "  download-default  Download the default model"
}

command="${1:-}"
shift || true

case "$command" in
    list)
        cmd_list
        ;;
    download)
        cmd_download "${1:-}"
        ;;
    set)
        cmd_set "${1:-}"
        ;;
    delete)
        cmd_delete "${1:-}"
        ;;
    download-default)
        cmd_download_default
        ;;
    *)
        usage
        exit 1
        ;;
esac
