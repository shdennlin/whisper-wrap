#!/bin/bash
# =============================================================================
# record-and-transcribe.sh — record from the mic and post to POST /transcribe.
#
# Usage:   bash scripts/record-and-transcribe.sh [duration_seconds]
# Defaults: 10 s, device ":1" (MacBook Pro Microphone), language=zh.
# Override via env: WHISPER_WRAP_SERVER, WHISPER_WRAP_AUDIO_DEVICE, WHISPER_WRAP_LANG.
# =============================================================================
set -euo pipefail

DURATION="${1:-10}"
DEVICE="${WHISPER_WRAP_AUDIO_DEVICE:-:1}"
SERVER="${WHISPER_WRAP_SERVER:-http://localhost:8000}"
LANG="${WHISPER_WRAP_LANG:-zh}"

command -v ffmpeg >/dev/null || { echo "ffmpeg required (brew install ffmpeg)"; exit 1; }
command -v jq     >/dev/null || { echo "jq required (brew install jq)"; exit 1; }

TMP="$(mktemp -t whisper-wrap-rec.XXXXXX).wav"
trap 'rm -f "$TMP"' EXIT

echo "Recording ${DURATION}s from avfoundation device $DEVICE..."
echo "(speak now; sample list: ffmpeg -f avfoundation -list_devices true -i \"\")"
ffmpeg -hide_banner -loglevel error \
       -f avfoundation -i "$DEVICE" \
       -t "$DURATION" \
       -ar 16000 -ac 1 -y "$TMP"
echo "Recorded $(stat -f%z "$TMP") bytes."

echo "Posting to $SERVER/transcribe..."
RESPONSE="$(curl -s -X POST \
    -H "Content-Type: audio/wav" \
    --data-binary @"$TMP" \
    "$SERVER/transcribe?language=$LANG")"
echo "$RESPONSE" | jq '{text, language, segments: (.segments | length)}'
