#!/bin/bash
# Hermes cron pre-run gate for the LyraAI agent review loop (docs/agent-review.md).
#
# Installed as ~/.hermes/profiles/<agent>/scripts/lyra-review-<agent>.sh by
# docs/install-agent-review.sh; the agent's name comes from that file name.
# It prints that agent's review queue and its own pull requests that were sent
# back, as JSON. When both are empty, the last line is {"wakeAgent": false}, so
# Hermes skips the model run and an idle tick costs nothing.
set -u
ME="${LYRA_AGENT:-$(basename "$0" .sh | sed -E 's/^lyra-review-//')}"
REPO="mhndhayek/LyraAI"
export PATH="/opt/homebrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
HERE="$(cd "$(dirname "$0")" && pwd)"

# The agent's own GitHub identity (docs/agent-review.md, "Who posts as whom").
# A cron job starts with a bare environment, where gh and git fall back to the
# owner's login. <agent>-gh-env.sh in the profile's scripts folder sets
# GH_CONFIG_DIR, the git author and LYRA_GH_LOGIN; when it names a login, the
# gate refuses to run as anyone else, so nothing is posted under the wrong name.
[ -f "$HERE/$ME-gh-env.sh" ] && . "$HERE/$ME-gh-env.sh"
if [ -n "${LYRA_GH_LOGIN:-}" ]; then
  WHO="$(gh api user --jq .login 2>/dev/null)"
  [ "$WHO" = "$LYRA_GH_LOGIN" ] || { echo "gh is logged in as '${WHO:-nobody}', not $LYRA_GH_LOGIN; refusing to run the review"; exit 1; }
fi

# The newest copy of the router on main wins; the installed copy covers the
# time before this loop is merged, and the case where GitHub is unreachable.
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
# .cjs, not .js: outside the repo a stray package.json higher up (say "type":
# "module" in the home folder) would otherwise decide how Node loads it.
if gh api "repos/$REPO/contents/scripts/agent-review.js?ref=main" -H 'Accept: application/vnd.github.raw' > "$TMP/agent-review.cjs" 2>/dev/null && [ -s "$TMP/agent-review.cjs" ]; then
  ROUTER="$TMP/agent-review.cjs"
else
  ROUTER="$HERE/lyra-agent-review.cjs"
fi

Q=$(node "$ROUTER" queue --me "$ME" --repo "$REPO") || { echo "queue lookup failed (gh auth? network?)"; exit 1; }
M=$(node "$ROUTER" mine --me "$ME" --repo "$REPO") || { echo "sent-back lookup failed"; exit 1; }
echo "AGENT: $ME"
echo "REVIEW_QUEUE: $Q"
echo "SENT_BACK_TO_ME: $M"
if [ "$(echo "$Q" | tr -d '[:space:]')" = "[]" ] && [ "$(echo "$M" | tr -d '[:space:]')" = "[]" ]; then
  echo '{"wakeAgent": false}'
fi
