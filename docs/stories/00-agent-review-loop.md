# 00 · Agent review loop (Claudia ⇄ Lucima) · M · ✅ approved

*As Hanood, I want whichever agent finishes a story to open a PR, have the other agent review it automatically, and only bother me for the final approve and merge.*

## Decisions (Hanood, Oct 8)
- **In the repo.** All of the review-loop plumbing ships on **one branch / one PR**: `claudia/lyr-00-review-loop`.
- The reviewer **polls every 15 min**.
- **`main` is protected; nothing is pushed to `main` directly, ever**, by agents or by Hanood. Every change goes through a PR.

## How it works

```
author agent finishes story ──► opens PR from claudia/… or lucima/…
        │                         (template filled, QA output pasted, demo screenshot attached)
        ▼
GitHub Action "route-review" (on pull_request: opened / synchronize / ready_for_review)
   └─ labels the PR  needs-review:lucima  (branch claudia/*)
                     needs-review:claudia (branch lucima/*)
        ▼
Hermes cron in the reviewer's profile, every 15 min:
   gh pr list -R mhndhayek/LyraAI --label needs-review:<me> --json number,headRefOid
   └─ for each PR whose head SHA it hasn't reviewed yet:
        run the github-code-review skill + that story's QA section
        post the review as a PR comment (verdict + quoted command output)
        set the commit status  agent-review = success | failure
        swap the label to  reviewed:<me>  ;  on failure add  changes-requested
        ▼
author agent's cron sees  changes-requested  on its own PR ──► fixes, pushes ──► loop repeats
        ▼
Hanood gets one notification ("PR #N reviewed: ship it") ──► approves + merges
```

## Constraints this design works around
- **Both agents push as the same GitHub user (`mhndhayek`).** GitHub doesn't let you approve your own PR, so the agents post *comment reviews* plus an `agent-review` commit status. The real approval stays with Hanood, so the agents can't merge anything themselves.
- **`main` has no branch protection today** (`gh api …/branches/main/protection` → 404). This story turns it on.
- **Lucima** is the `lucima` Hermes profile on this Mac. The reviewer runs on the Mac, and **lucix is not involved**.
- **No secrets in prompts.** The cron uses the existing `gh` login, and nothing gets written into story files or PR bodies.

## Tasks (all on `claudia/lyr-00-review-loop`)
1. `.github/workflows/route-review.yml`: label the PR by branch prefix. Only `GITHUB_TOKEN` with `pull-requests: write`.
2. `scripts/setup-labels.sh`: creates `needs-review:claudia`, `needs-review:lucima`, `reviewed:claudia`, `reviewed:lucima` and `changes-requested` (idempotent, `--force`).
3. `scripts/agent-review.md`: the reviewer prompt. It's a checklist built from the README QA contract: run the gate, prove the new test fails on `origin/main`, run the story checks, check the demo screenshot exists, scan for secrets and emails, look for files owned by another story.
4. `docs/AGENTS.md` + a section in `CONTRIBUTING.md` covering branch prefixes, labels, review rules and the "never push to main" rule.
5. **After the PR merges** (run from the Mac, not committed):
   - `sh scripts/setup-labels.sh`
   - `sh scripts/setup-branch-protection.sh`, extended to require the `QA Gate` + `agent-review` checks, 1 approval, up-to-date branches, `enforce_admins: true` (so Hanood can't push to main either) and no force-pushes
   - Hermes cron in `claudia` and `lucima`: `*/15 * * * *`, running `scripts/agent-review.md`, delivering to Hanood only when a verdict is posted

## QA
1. Dummy PR from `claudia/lyr-00-smoke` changing one word in a doc: within 1 min it has `needs-review:lucima`.
2. Within 15 min the Lucima cron posts a verdict, the `agent-review` status appears and the label flips to `reviewed:lucima`.
3. Push a lint-breaking commit: on the next pass the status is `failure` and `changes-requested` is added.
4. Running the cron again on the same head SHA posts nothing (idempotent).
5. A `lucima/…` PR routes to Claudia.
6. `git push origin HEAD:main` from the Mac is **refused**. `gh api …/branches/main/protection` shows the required checks and `enforce_admins.enabled: true`.
