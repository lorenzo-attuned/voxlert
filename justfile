# Voxlert — voice notifications for Claude Code

# Start both the Qwen TTS server and the remote playback listener
set positional-arguments

repo_dir := justfile_directory()

serve port="7890":
    #!/usr/bin/env bash
    trap 'kill 0' INT TERM EXIT
    cd "{{repo_dir}}/qwen3-tts-server" && ./run.sh &
    sleep 3
    node "{{repo_dir}}/src/cli.js" listen {{port}}
