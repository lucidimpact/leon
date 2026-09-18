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

node server.js
