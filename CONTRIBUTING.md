# Contributing to Lyra

## Getting set up

```sh
git clone https://github.com/mhndhayek/LyraAI.git
cd LyraAI
npm ci
npm start
```

Optional: `npm run voice:setup` installs the local voice engine.

## Before you open a pull request

```sh
npm run qa
```

That runs the same checks CI does: syntax, lint, the test suite, the kernel
self-test and a smoke test of the real app. If it passes locally it will pass in
CI. See [docs/QA.md](docs/QA.md) for what each step covers and how to add tests.

## How changes are reviewed

- Work on a branch and open a pull request against `main`; direct pushes are
  refused.
- The **QA Gate** check must be green, the branch up to date with `main`, a code
  owner must approve, and review conversations must be resolved.
- New behaviour needs a test that fails without your change.

## Where things live

| Path | What it is |
| --- | --- |
| `main/kernel/` | The kernel: boot, settings, storage, checkpoints, the organ loader, guardrails, extensions. Read-only to the agent at runtime. |
| `main/organs/` | The parts the assistant may rewrite about itself: the agent loop, tools, browser, voice, goals. Described in `main/organs/organs.json`. |
| `renderer/` | The UI: HTML, CSS, the chat page, settings, the live character, themes. |
| `preload.js` | The only bridge between the UI and the kernel. |
| `docs/` | Guides the assistant reads at runtime with `read_docs`. |
| `test/` | The test suite (`kernel/`, `organs/`, `features/`). |
| `scripts/` | The QA gate, build checks and the branch protection setup. |

## House rules

- **The kernel is the safety boundary.** Changes to guardrails, approvals, the
  write budget or the checkpoint flow need a test showing the boundary still
  holds.
- **Add an organ or a tool, update the docs.** `main/organs/organs.json` and
  `docs/AGENT.md` are read by the assistant itself; a feature test fails when
  they fall out of step.
- **Every preload call needs a handler.** A feature test checks this, because a
  missing handler is a button that silently does nothing.
- **Keep dependencies few.** Anything required from `main/` or `preload.js` has
  to be a real dependency, or it will be missing from the packaged app.

## Reporting a bug

Include your platform, the app version (Settings → About), and the relevant part
of the log (Settings → Logs → Copy). If the app started in safe mode, say what it
was doing beforehand.
