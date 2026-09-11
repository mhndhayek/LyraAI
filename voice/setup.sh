#!/bin/sh
# Creates the Python environment for Lyra's voice sidecar (KittenTTS + faster-whisper).
# Usage: setup.sh [target-venv-dir]   (default: voice/.venv next to this script)
# Needs: uv (https://docs.astral.sh/uv/) or python3, and espeak-ng (brew install espeak-ng).
set -e
cd "$(dirname "$0")"
TARGET="${1:-.venv}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
if command -v uv >/dev/null 2>&1; then
  uv venv --python 3.11 "$TARGET"
  uv pip install --python "$TARGET/bin/python" -r requirements.txt || uv pip install --python "$TARGET/bin/python" https://github.com/KittenML/KittenTTS/releases/download/0.1/kittentts-0.1.0-py3-none-any.whl faster-whisper soundfile numpy
else
  python3 -m venv "$TARGET"
  "$TARGET/bin/pip" install -r requirements.txt
fi
echo "voice sidecar ready at $TARGET"
