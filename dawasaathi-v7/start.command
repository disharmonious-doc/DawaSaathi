#!/bin/bash
cd "$(dirname "$0")" || exit 1

# Prefer an existing environment variable. If absent, use api_key.txt when present.
if [ -z "$OPENAI_API_KEY" ] && [ -f "api_key.txt" ]; then
  OPENAI_API_KEY="$(tr -d '\r\n' < api_key.txt)"
  export OPENAI_API_KEY
fi

if [ -z "$OPENAI_API_KEY" ]; then
  echo "DawaSaathi needs an OpenAI API key."
  echo "The key is kept in this local server process and is never placed in the webpage."
  printf "OpenAI API key: "
  stty -echo
  read OPENAI_API_KEY
  stty echo
  printf "\n"
  if [ -z "$OPENAI_API_KEY" ]; then
    echo "No API key entered. Exiting."
    read -r -p "Press Enter to close..." _
    exit 1
  fi
  export OPENAI_API_KEY
fi

export OPENAI_MODEL="${OPENAI_MODEL:-gpt-5.6-sol}"
export OPENAI_TTS_MODEL="${OPENAI_TTS_MODEL:-gpt-realtime-2.1-mini}"
export OPENAI_TTS_VOICE="${OPENAI_TTS_VOICE:-marin}"
export PORT="${PORT:-8000}"
echo "Starting DawaSaathi at http://127.0.0.1:${PORT}"
echo "Keep this Terminal window open while using the app. Press Control-C to stop."
python3 server.py
