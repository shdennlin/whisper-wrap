#!/bin/bash
# =============================================================================
# fetch-samples.sh — populate ./samples/ with audio clips for local testing.
#
# v1 strategy: generate Taiwanese Mandarin samples via macOS `say` covering
# Breeze ASR 25's strong cases (Taiwanese Mandarin, code-switching). Real
# human recordings always outperform synthetic TTS — drop your own .wav files
# into ./samples/ to extend the set; this script never overwrites existing
# files.
# =============================================================================

set -euo pipefail

SAMPLES_DIR="${SAMPLES_DIR:-./samples}"
mkdir -p "$SAMPLES_DIR"

if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "This generator uses macOS \`say\`. On Linux, drop your own WAV files into $SAMPLES_DIR/" >&2
    exit 1
fi

if ! command -v ffmpeg >/dev/null; then
    echo "ffmpeg required to convert AIFF -> 16 kHz mono WAV. Install via 'make install-system-deps'." >&2
    exit 1
fi

# (voice|filename|text) tuples
declare -a SAMPLES=(
    "Meijia|01-greeting-zhtw.wav|你好，今天天氣很好，適合出門散步。"
    "Meijia|02-tech-zhtw.wav|語音辨識的技術近年來進步很快，許多模型都可以即時轉錄。"
    "Meijia|03-codeswitch-zhtw.wav|我覺得 OpenAI 的 Whisper 還不錯，不過台灣腔調有時候會辨識錯。"
    "Meijia|04-question-zhtw.wav|請問附近有什麼好吃的餐廳推薦嗎？我想找一家咖啡廳。"
    "Meijia|05-news-zhtw.wav|根據今天的氣象預報，明天會有陣雨，請大家記得帶傘出門。"
)

generate() {
    local voice="$1" filename="$2" text="$3"
    local dest="$SAMPLES_DIR/$filename"
    local tmp_aiff
    tmp_aiff="$(mktemp -t whisper-sample.XXXXXX).aiff"

    if [ -f "$dest" ]; then
        echo "skip   $filename (already present)"
        return 0
    fi

    say -v "$voice" "$text" -o "$tmp_aiff"
    ffmpeg -y -loglevel error -i "$tmp_aiff" -ar 16000 -ac 1 -f wav "$dest"
    rm -f "$tmp_aiff"
    local bytes
    bytes=$(stat -f%z "$dest" 2>/dev/null || stat -c%s "$dest")
    echo "ok     $filename  (${bytes} bytes, voice=$voice)"
}

echo "Generating Taiwanese Mandarin samples into $SAMPLES_DIR/"
echo
for entry in "${SAMPLES[@]}"; do
    IFS='|' read -r voice filename text <<< "$entry"
    generate "$voice" "$filename" "$text"
done

echo
echo "Done. Quick test against a running server:"
echo "  curl -X POST -H 'Content-Type: audio/wav' \\"
echo "       --data-binary @$SAMPLES_DIR/01-greeting-zhtw.wav \\"
echo "       'http://localhost:8000/transcribe?language=zh' | jq"
echo
echo "Note: synthetic TTS produces stiffer phrasing than real speech; Breeze"
echo "ASR 25 typically scores much higher on human recordings. Drop your own"
echo "WAV files into $SAMPLES_DIR/ to extend the test set."
