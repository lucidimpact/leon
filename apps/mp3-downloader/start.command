#!/bin/bash
# Double-click this file on a Mac to start the app.
# It runs from wherever the folder lives, so you can move the folder anywhere.

cd "$(dirname "$0")" || exit 1

if ! command -v node > /dev/null 2>&1; then
  echo "Node is not installed. Install it with:  brew install node"
  echo
  read -r -p "Press return to close."
  exit 1
fi

# `pip install --user` puts tools like whisper-ctranslate2 in a per-Python
# folder your Mac doesn't check by default. If nothing on PATH already
# provides a transcriber, look there before giving up.
if ! command -v whisper-ctranslate2 > /dev/null 2>&1 && ! command -v whisper > /dev/null 2>&1; then
  for bin_dir in "$HOME"/Library/Python/*/bin; do
    for name in whisper-ctranslate2 whisper; do
      if [ -x "$bin_dir/$name" ]; then
        export MP3_DL_WHISPER_BIN="$bin_dir/$name"
        break 2
      fi
    done
  done
fi

node server.js
