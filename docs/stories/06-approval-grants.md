# 06 · Approvals: once / this session / always-this-command · M · ✅ approved

*As a user in "Ask" mode, when Lyra needs to read 30 files I can say "allow reads for this session" once, instead of clicking Approve 30 times. I can trust one exact command for the rest of the session and revoke it any time.*

## Decisions (Hanood, Oct 8)
- **Nothing survives a restart.** Every grant lives in memory and is gone when Lyra quits.
- **High-risk can be granted.** If the user explicitly picks "always" for a high-risk action, honour it for the session.
- **Exact match** for commands (no prefixes or wildcards).

## What's wrong today (0.9.12)
- `main/organs/approvals.js`: `decide()` knows only the mode (`ask`/`auto`/`none`) and smart approvals for low risk. Everything else gets a card.
- `renderer/app.js:178-184`: the card has just **Approve** and **Deny**, and nothing is remembered.

## Change
1. **Approval card**: **Approve** · **Deny**, plus a ▾ menu with:
   - *Allow `<tool>` for this chat*: every call of that tool in this chat
   - *Always allow this exact command (until Lyra restarts)*: commands only, matched on the normalised command string
   - *Always allow `<tool>` in this folder (until Lyra restarts)*: file tools only, matched on a directory prefix
   - High-risk cards show the same options, with an extra line: *"This is a high-risk action. You're allowing it without asking until Lyra restarts."*
2. **Grants live in the kernel, in memory** (new `main/kernel/grants.js`):
   - `[{ id, scope: 'chat' | 'session', chatId?, tool, match: { command? | pathPrefix? }, risk, createdAt }]`. There's no file and no persistence.
   - Grants are created **only** by the `approvals:respond` IPC from the renderer with `remember: {...}`. The agent can't create grants: no tool exists for it, and `filterPatch` strips any `approvalGrants` key. Organ hot-reloads don't drop grants (they live in the kernel), but quitting the app does.
3. **`decide()` order**: mobile high-risk deny → mode → **matching grant** → smart approvals → ask. Phone sessions never use desktop grants for high-risk actions (the mobile rule wins).
4. **Command normalisation for exact match**: trim, collapse whitespace, reject (never match) anything containing `;`, `&&`, `||`, `|`, `` ` ``, `$(`, `>`, `<` or a newline. So `git status` matches `git  status ` but never `git status; rm -rf ~`.
5. **Path prefix**: `path.resolve` + `realpath` both sides, and match only on a separator boundary.
6. **Settings › Safety › Allowed this session**: a list of active grants with **Revoke** for each and **Revoke all**, plus the note *"These clear when Lyra restarts."*
7. The step's activity line shows *"approved by your rule: git status (this session)"*.

**Owns:** `main/organs/approvals.js`, new `main/kernel/grants.js`, `main/kernel/settings.js` (`filterPatch` only), `renderer/app.js` (`approvalCard`/`resolveApproval` only), `renderer/settings.js` (Safety section only), `preload.js`, `main/organs/index.js` (IPC), `docs/SECURITY.md`.

## QA
1. **Failing-first** `test/organs/approvals.test.js`: a chat grant for `read_file` auto-approves a second `read_file` in the same chat and does **not** apply in another chat.
2. Restart: build new `Grants()` + `Approvals()` instances, and no grant survives. Assert nothing was written to `state/`.
3. Exact command: `git status` matches `git  status `, but **not** `git status; rm -rf ~`, `git status && curl x`, `git status | sh`, `git status $(id)` or `git status\nrm x`.
4. Folder: `/a/b` matches `/a/b/c.txt`, not `/a/bc/x`, not `/a/b/../../etc/passwd`, and not a symlink inside `/a/b` that points outside.
5. High-risk: a session grant on a high-risk command auto-approves it. The same grant **doesn't** apply when `origin === 'mobile'`.
6. Boundary: the agent's `filterPatch({ approvalGrants: [...] })` is stripped. Add this to `scripts/selftest.js`.
7. **Mac demo**: in Ask mode, *"read every .md file in docs/ and summarise"* → *Allow read_file for this chat* once → the rest run without cards. Revoke it in Settings → the next read asks. Quit and reopen Lyra → the list is empty. Attach screenshots.
