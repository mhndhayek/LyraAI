# Agent review: Claudia ⇄ Lucima

Two agents work on this repo in parallel: **Claudia** and **Lucima**. Each one reviews the other's
pull requests. Hanood merges.

## The rules

1. **`main` is protected.** Nothing is pushed to it directly, not by an agent and not by Hanood.
   Every change is a pull request, and `QA Gate` must pass before it can merge.
2. **The branch name says who wrote it.** `claudia/lyr-NN-short-name` or `lucima/lyr-NN-short-name`.
   One story per branch. Branch from the latest `origin/main`.
3. **The author never reviews their own pull request.** The routing workflow labels each pull
   request for the other agent. Other branches (Dependabot, a person) go to Claudia.
4. **Changing `version` in `package.json` cuts a release.** Agents never change it. Hanood does,
   in a pull request of its own.
5. **Demo first.** Before marking a pull request ready, the author runs the app on the Mac and
   attaches what the story's QA asks for: screenshots or a short recording.

## How a pull request moves

```
author opens PR ─► workflow labels it needs-review:<other> ─► reviewer's cron finds it (≤ 15 min)
      ▲                                                              │
      │                                                   reviews the head commit
      │                                                              │
      └── changes-requested ◄── 🔁 fail ──────────── verdict ─────── ✅ pass ──► Hanood merges
          (author's cron picks it up)              (comment + "agent-review" status)
```

Every new push puts the pull request back in the reviewer's queue. A verdict covers only
the commit it reviewed.

Both agents push as the same GitHub account, and GitHub won't let an account approve its own
pull request. So a verdict is a **comment** plus an **`agent-review` commit status**, not a
GitHub "Approve". The required check is still `QA Gate`; `agent-review` is what Hanood reads
before merging.

## Reviewing (what the reviewer's cron does)

```sh
node scripts/agent-review.js queue --me lucima          # what's waiting for me
```

For each pull request in the queue:

1. Check it out in a **separate worktree**, never in the working copy you're developing in:
   `git worktree add ../review-<N> origin/<branch>`, then `npm ci`.
2. Run the gates: `npm run lint`, `npm test`, `npm run smoke`. If any fail, the verdict is a fail.
3. Open the story file the pull request names, then go through its **QA** checklist one item at
   a time and through the general checklist below. Every item gets ✅, ❌ or ⚠️ with a
   one-line reason.
4. Write the review to a file and post it, using the **exact head commit you reviewed**:
   ```sh
   node scripts/agent-review.js verdict --pr <N> --sha <sha> --me lucima --result pass|fail --body-file review.md
   ```
   If the author pushed while you were reviewing, this refuses. Review the new head.
5. Remove the worktree.

**Fail it** for: a failing gate, a QA item that doesn't hold, a security or data-loss risk, or
a change outside the story's scope. **Pass it with notes** for style nits and follow-up ideas.
Don't hold a pull request for those.

### General checklist (on top of the story's QA)

- [ ] It does what the story says, and only that. No drive-by refactors.
- [ ] Tests cover the new behaviour (assert behaviour, don't snapshot values).
- [ ] No secrets, tokens, personal emails or machine paths in the diff or the screenshots.
- [ ] Nothing user-facing breaks for someone upgrading: their settings still load.
- [ ] `version` in `package.json` is unchanged.
- [ ] The demo in the pull request shows the change running on the Mac.

## Getting sent back (what the author's cron does)

```sh
node scripts/agent-review.js mine --me claudia          # my pull requests with changes requested
```

Read the review, fix it on the same branch, and push. The push re-queues it for review.
If you disagree with the reviewer, reply on the pull request and tag Hanood. Don't argue in a loop.

## The cron jobs

Each agent runs one Hermes cron job every 15 minutes. A script runs first and prints
`{"wakeAgent": false}` when there's nothing to do, so an idle tick costs no tokens. Set up with
`docs/install-agent-review.sh`.
