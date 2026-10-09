#!/bin/bash
# Installs the review loop's cron job into one Hermes profile.
#   bash docs/install-agent-review.sh claudia
#   bash docs/install-agent-review.sh lucima
# Re-running it replaces the job, so it is also how the prompt gets updated.
set -eu
AGENT="${1:?usage: install-agent-review.sh claudia|lucima}"
case "$AGENT" in claudia|lucima) ;; *) echo "agent must be claudia or lucima"; exit 2 ;; esac
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE_DIR="$HOME/.hermes/profiles/$AGENT"
[ -d "$PROFILE_DIR" ] || { echo "no Hermes profile at $PROFILE_DIR"; exit 1; }
WORK="$HOME/claude/LyraAI-wt"
NAME="lyra-review-$AGENT"

mkdir -p "$PROFILE_DIR/scripts" "$WORK"
cp "$ROOT/docs/agent-review-gate.sh" "$PROFILE_DIR/scripts/$NAME.sh"
cp "$ROOT/scripts/agent-review.js" "$PROFILE_DIR/scripts/lyra-agent-review.cjs"
rm -f "$PROFILE_DIR/scripts/lyra-agent-review.js"
chmod +x "$PROFILE_DIR/scripts/$NAME.sh"

PROMPT=$(sed -e "s/{{AGENT}}/$AGENT/g" "$ROOT/docs/agent-review-prompt.md")

# Replace an existing job of the same name.
for id in $(hermes -p "$AGENT" cron list 2>/dev/null | awk -v n="$NAME" '/^  [0-9a-f]{12} /{id=$1} $1=="Name:" && $2==n {print id}'); do
  hermes -p "$AGENT" cron remove "$id" >/dev/null
done

hermes -p "$AGENT" cron create "every 15m" "$PROMPT" \
  --name "$NAME" \
  --script "$NAME.sh" \
  --skill github-code-review \
  --workdir "$WORK" \
  --deliver local

echo "Installed $NAME for $AGENT (every 15 min, works in $WORK)."
