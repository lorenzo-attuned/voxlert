# Voxlert — voice notifications for Claude Code

# Start both the Qwen TTS server and the remote playback listener
serve port="7890":
    #!/usr/bin/env bash
    trap 'kill 0' INT TERM EXIT
    cd qwen3-tts-server && ./run.sh &
    sleep 3
    voxlert listen {{port}}
