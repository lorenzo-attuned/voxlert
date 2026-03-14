#!/usr/bin/env bash
# voxlert-listener.sh — Receives phrase text from a remote voxlert instance,
# generates speech locally via the Qwen TTS server, and plays via afplay.
#
# Prerequisites:
#   - Qwen TTS server running locally (./qwen3-tts-server/run.sh)
#   - jq installed (brew install jq)
#
# Usage:
#   ./voxlert-listener.sh [port]    (default: 7890)
#
# On the remote machine, set in ~/.voxlert/config.json:
#   "remote_playback_url": "http://<mac-ip-or-tailscale>:7890/play"

PORT="${1:-7890}"
TTS_URL="${VOXLERT_TTS_URL:-http://localhost:8100/tts}"
TMPDIR="${TMPDIR:-/tmp}"

echo "voxlert-listener: listening on port $PORT"
echo "  TTS server: $TTS_URL"
echo "  Configure remote voxlert with:"
echo "    remote_playback_url: http://<this-machine>:$PORT/play"
echo ""
echo "  Press Ctrl+C to stop."
echo ""

cleanup() {
  echo "Shutting down."
  exit 0
}
trap cleanup INT TERM

while true; do
  BODYFILE="$TMPDIR/voxlert-body-$$.tmp"
  WAVFILE="$TMPDIR/voxlert-$(date +%s%N 2>/dev/null || date +%s).wav"

  # Accept one HTTP request, save the JSON body, respond 200
  {
    read -r REQUEST_LINE
    CONTENT_LENGTH=0
    while IFS= read -r HEADER; do
      HEADER="${HEADER%%$'\r'}"
      [ -z "$HEADER" ] && break
      case "$HEADER" in
        Content-Length:*|content-length:*)
          CONTENT_LENGTH="${HEADER#*: }"
          CONTENT_LENGTH="${CONTENT_LENGTH%%$'\r'}"
          ;;
      esac
    done

    if [ "$CONTENT_LENGTH" -gt 0 ] 2>/dev/null; then
      dd bs=1 count="$CONTENT_LENGTH" of="$BODYFILE" 2>/dev/null
    fi

    printf "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK"
  } < <(nc -l "$PORT") | cat

  # Parse phrase from JSON body and generate speech locally
  if [ -f "$BODYFILE" ] && [ -s "$BODYFILE" ]; then
    PHRASE=$(jq -r '.phrase // empty' "$BODYFILE" 2>/dev/null)
    VOLUME=$(jq -r '.volume // 0.5' "$BODYFILE" 2>/dev/null)
    rm -f "$BODYFILE"

    if [ -n "$PHRASE" ]; then
      echo "  >> $PHRASE"
      # Generate speech via local TTS server
      curl -s -X POST "$TTS_URL" \
        -H 'Content-Type: application/json' \
        -d "{\"text\": $(echo "$PHRASE" | jq -Rs .)}" \
        --output "$WAVFILE" 2>/dev/null

      if [ -f "$WAVFILE" ] && [ -s "$WAVFILE" ]; then
        afplay -v "$VOLUME" "$WAVFILE" 2>/dev/null &
        PLAY_PID=$!
        (wait "$PLAY_PID" 2>/dev/null; rm -f "$WAVFILE") &
      else
        rm -f "$WAVFILE" 2>/dev/null
      fi
    fi
  else
    rm -f "$BODYFILE" 2>/dev/null
  fi
done
