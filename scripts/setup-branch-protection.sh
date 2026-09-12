#!/bin/sh
# Locks the default branch so nothing merges until the QA gate is green.
#
# Run once, by someone with admin rights on the repository:
#   sh scripts/setup-branch-protection.sh
#
# Needs the GitHub CLI, authenticated: https://cli.github.com
set -eu

BRANCH="${BRANCH:-main}"
REPO="${REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
# The one required check. It only passes when every job in ci.yml passed, so new
# jobs are covered automatically without touching this rule again.
CHECK="QA Gate"

printf 'Protecting %s on %s so merges need "%s"...\n' "$BRANCH" "$REPO" "$CHECK"

gh api -X PUT "repos/$REPO/branches/$BRANCH/protection" \
  -H "Accept: application/vnd.github+json" \
  --input - <<JSON
{
  "required_status_checks": {
    "strict": true,
    "checks": [{ "context": "$CHECK" }]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": true
  },
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true,
  "block_creations": false,
  "restrictions": null
}
JSON

printf '\nDone. On %s:\n' "$BRANCH"
printf '  - pull requests are required; direct pushes are refused\n'
printf '  - "%s" must pass before the merge button turns green\n' "$CHECK"
printf '  - the branch must be up to date with %s first\n' "$BRANCH"
printf '  - unresolved review conversations block the merge\n'
printf '  - the rule applies to administrators too\n'
