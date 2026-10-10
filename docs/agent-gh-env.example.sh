# Template for an agent's own GitHub identity (docs/agent-review.md, "Who posts as whom").
# Copy it to ~/.hermes/profiles/AGENT/scripts/AGENT-gh-env.sh (AGENT = claudia or
# lucima), replace the CHANGE-ME values, and log that profile's gh in once:
#   GH_CONFIG_DIR=~/.hermes/profiles/AGENT/gh gh auth login
# The review gate (agent-review-gate.sh) loads it before every run and refuses
# to run when gh is logged in as anyone other than LYRA_GH_LOGIN.
export LYRA_GH_LOGIN="CHANGE-ME-github-login"
export GH_CONFIG_DIR="$HOME/.hermes/profiles/CHANGE-ME-agent/gh"
unset GH_TOKEN GITHUB_TOKEN
export GIT_AUTHOR_NAME="$LYRA_GH_LOGIN" GIT_COMMITTER_NAME="$LYRA_GH_LOGIN"
# The noreply address GitHub shows under Settings › Emails, never a personal one.
export GIT_AUTHOR_EMAIL="CHANGE-ME-id+login@users.noreply.github.com"
export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
# Push with this profile's gh token, not the owner's macOS keychain entry.
export GIT_CONFIG_COUNT=2
export GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0=
export GIT_CONFIG_KEY_1=credential.helper GIT_CONFIG_VALUE_1='!gh auth git-credential'
