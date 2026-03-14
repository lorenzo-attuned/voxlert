#!/usr/bin/env bash
# voxlert-listener.sh — Receives phrase text from a remote voxlert instance,
# generates speech locally via the Qwen TTS server, plays via afplay,
# and sends a rich push notification via ntfy.
#
# Prerequisites:
#   - Qwen TTS server running locally (./qwen3-tts-server/run.sh)
#   - jq installed (brew install jq)
#
# Usage:
#   ./voxlert-listener.sh [port]    (default: 7890)
#
# Environment variables:
#   VOXLERT_TTS_URL    TTS server URL (default: http://localhost:8100/tts)
#   VOXLERT_NTFY_TOPIC ntfy topic for push notifications (optional)
#
# On the remote machine, set in ~/.voxlert/config.json:
#   "remote_playback_url": "http://<mac-ip-or-tailscale>:7890/play"

PORT="${1:-7890}"
TTS_URL="${VOXLERT_TTS_URL:-http://localhost:8100/tts}"
NTFY_TOPIC="${VOXLERT_NTFY_TOPIC:-}"
TMPDIR="${TMPDIR:-/tmp}"

# Category → human-readable label
category_label() {
  case "$1" in
    task.complete)   echo "Task complete" ;;
    task.error)      echo "Error" ;;
    input.required)  echo "Input needed" ;;
    session.start)   echo "Session started" ;;
    session.end)     echo "Session ended" ;;
    resource.limit)  echo "Context limit" ;;
    notification)    echo "Notification" ;;
    *)               echo "$1" ;;
  esac
}

echo "voxlert-listener: listening on port $PORT"
echo "  TTS server: $TTS_URL"
[ -n "$NTFY_TOPIC" ] && echo "  ntfy topic: $NTFY_TOPIC"
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

  # Parse JSON body
  if [ -f "$BODYFILE" ] && [ -s "$BODYFILE" ]; then
    PHRASE=$(jq -r '.phrase // empty' "$BODYFILE" 2>/dev/null)
    VOLUME=$(jq -r '.volume // 0.5' "$BODYFILE" 2>/dev/null)
    EVENT=$(jq -r '.event // empty' "$BODYFILE" 2>/dev/null)
    CATEGORY=$(jq -r '.category // empty' "$BODYFILE" 2>/dev/null)
    PROJECT=$(jq -r '.project // empty' "$BODYFILE" 2>/dev/null)
    PACK_ID=$(jq -r '.pack_id // empty' "$BODYFILE" 2>/dev/null)
    CONTEXT=$(jq -r '.context // empty' "$BODYFILE" 2>/dev/null)
    rm -f "$BODYFILE"

    if [ -n "$PHRASE" ]; then
      LABEL=$(category_label "$CATEGORY")
      echo "  [$PROJECT] $LABEL: $PHRASE"

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

      # Send ntfy push notification with rich context
      if [ -n "$NTFY_TOPIC" ]; then
        NTFY_TITLE="${PROJECT:+$PROJECT — }$LABEL"
        # Build notification body
        NTFY_BODY=""
        if [ -n "$CONTEXT" ]; then
          # Truncate context to first 200 chars for readability
          NTFY_BODY="$(echo "$CONTEXT" | head -c 200)"
          NTFY_BODY="${NTFY_BODY}

"
        fi
        NTFY_BODY="${NTFY_BODY}🎙 ${PHRASE}"

        curl -s \
          -H "Title: $NTFY_TITLE" \
          -H "Tags: ${CATEGORY}" \
          -d "$NTFY_BODY" \
          "https://ntfy.sh/$NTFY_TOPIC" > /dev/null &
      fi
    fi
  else
    rm -f "$BODYFILE" 2>/dev/null
  fi
done
