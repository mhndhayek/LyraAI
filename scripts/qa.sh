#!/bin/sh
# The whole quality gate, in the order CI runs it. If this passes locally, the
# pull request will pass too. Usage: npm run qa
set -u

cd "$(dirname "$0")/.." || exit 1

failed=""
step() {
  name="$1"; shift
  printf '\n\033[1m── %s\033[0m\n' "$name"
  if "$@"; then
    printf '\033[32m✓ %s\033[0m\n' "$name"
  else
    printf '\033[31m✗ %s\033[0m\n' "$name"
    failed="$failed\n  - $name"
  fi
}

step "Syntax"       npm run --silent check:syntax
step "Lint"         npm run --silent lint
step "Unit tests"   npm run --silent test:unit
step "Kernel self-test" npm run --silent selftest
step "Smoke test"   npm run --silent smoke

printf '\n'
if [ -n "$failed" ]; then
  printf '\033[31mQA gate failed:\033[0m%b\n' "$failed"
  exit 1
fi
printf '\033[32mQA gate passed: the change is ready for review.\033[0m\n'
