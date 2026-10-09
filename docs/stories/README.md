# LyraAI — Oct 8 test round → stories

Source: Hanood's first walkthrough of **0.9.12** (fresh install, Oct 8 2026).
Every story starts from `origin/main` at `ef831aa` (0.9.12). Do **not** branch from the local
checkout `~/claude/LyraAI`: it is on the stale `fix/live2d-unsafe-eval` branch at 0.9.11.

Sizes: **S** ≤ half a day · **M** 1–2 days · **L** 3–5 days.
🔒 = blocked on a decision from Hanood. Nothing 🔒 gets coded until approved. Decisions from Oct 8 are recorded at the top of each story.

**House rules (Hanood, Oct 8):** `main` is protected and **never pushed to directly**. Every change is a PR. Build and test on the **Mac**, and leave the AI server (lucix) alone unless a story says otherwise.

| # | Story | Size | Branch | Owner | Status |
|---|---|---|---|---|---|
| 00 | [Agent review loop (Claudia ⇄ Lucima)](00-agent-review-loop.md) | M | `claudia/lyr-00-review-loop` | Claudia | ✅ ready, **do first** |
| 01 | [3D-first identity: welcome, look, retire 2D](01-3d-first-identity.md) | S | `*/lyr-01-3d-identity` | any | ✅ ready |
| 02 | [One connection: any `/v1` URL + key, auto-detect, logos, true "loaded"](02-one-connection.md) | M | `*/lyr-02-one-connection` | any | ✅ ready |
| 03 | ["Help me choose" + in-app llama.cpp for newbies](03-help-me-choose.md) | L | `*/lyr-03-help-me-choose` | any | ✅ ready (after 02) |
| 04 | [Voice providers: detect + configure all the common TTS/STT APIs](04-voice-providers.md) | L | `*/lyr-04-voice-providers` | any | ✅ ready (4.5 🔒) |
| 05 | [Speak while writing: streamed sentence-by-sentence voice](05-streamed-speech.md) | M | `*/lyr-05-streamed-speech` | any | ✅ ready |
| 06 | [Approvals: once / this chat / this session](06-approval-grants.md) | M | `*/lyr-06-approval-grants` | any | ✅ ready |
| 07 | [Desktop companion: Lyra on the desktop + mini chat, walk toggle](07-desktop-companion.md) | L | `*/lyr-07-desktop-companion` | any | ✅ ready (after 01) |
| 08 | [Avatar color: 10% darker skin (`#fad5b9` → `#e1bda2`), blush](08-avatar-color.md) | S | `*/lyr-08-avatar-color` | any | ✅ ready |
| 09 | [3D animation library + state machine](09-3d-animation.md) | L | `*/lyr-09-3d-animation` | any | ✅ ready (after 08) |

`*` = the agent's prefix: `claudia/` or `lucima/`. The author of a PR is never its reviewer (see story 00).

## Running stories in parallel

Each story names the files it **owns**. Two stories that own the same file must not run at the same time, or they need to agree on a seam first:

```
Lane 0 (process):      00            merge first, so every later PR gets reviewed
Lane A (UI shell):     01 ──► 07
Lane B (brain):        02 ──► 03
Lane C (voice):        04  ∥  05     05 only touches agent.js / app.js / a new speech-queue.js, and calls voice.tts(text) as it is today
Lane D (safety):       06
Lane E (3D asset):     08 ──► 09     09 rebuilds on 08's lyra.vrm
```

Shared hot files and who owns them:

| File | Owner | Others may touch? |
|---|---|---|
| `renderer/setup.js` | 01 (welcome, look) · 02 (model page) · 03 (Help me choose button in `model()`) | 02 must not edit `welcome()`/`look()`; 01 must not edit `model()`. 03 starts after 02 merges. |
| `renderer/app.js` | 05 (audio queue, `case 'tts'`), 06 (`approvalCard`) | Disjoint functions only. Whoever merges second rebases. 07 doesn't touch it (it has its own `companion.js`). |
| `renderer/settings.js` | 02 (Model page), 04 (Voice page), 06 (Safety page) | Disjoint sections only. |
| `main/organs/voice.js` | 04 | 05 must not edit it. |
| `main/organs/llm.js` | 02 | — |
| `renderer/character.js` | 09 | 07 may only add a full-body framing option; 08 may only change lights + blush. |
| `main/main.js` | 07 (companion window + tray) | — |

Merge order where there's a dependency: **00 first** · **01 before 07** · **02 before 03** · **08 before 09** · **04 and 05 in either order** (05 keeps the `voice.tts()` signature).

## The QA contract every story follows

Every story has a **QA** section with three parts. The reviewer (the other agent) runs all three and quotes the output in the PR review.

1. **Gate**: `npm run qa` is green (syntax, lint, unit, self-test, smoke). New behaviour comes with a test that fails on `origin/main`. The PR says which test that is, and the reviewer checks out `origin/main`, runs that test alone and confirms it fails.
2. **Story checks**: the numbered acceptance checks in the story, each with the exact command or click path and the expected result.
3. **Demo on the Mac**: Hanood's rule is no merge until it has run on the Mac. Build with `npm run dist:mac:adhoc`, install into `/Applications`, launch it, and attach a screenshot (or a short screen recording for 05/07/09) to the PR. Renderer edits need `<userData>/state/organs/VERSION` deleted before the running app picks them up.

The reviewer's verdict is one of `ship it` · `changes requested: <list>` · `blocked: needs Hanood`. The final approve and merge always come from Hanood (see story 00 for why).

## Test environment notes (checked Oct 8)

- lucix llama-server runs in **router mode** on `127.0.0.1:8081` and needs an API key. `/v1/models` lists 4 models, each with `status.value` `loaded`/`unloaded`; `/props` returns `role: "router"`. This is the data behind the "unloaded shown as loaded" bug (story 02).
- On lucix, OmniVoice is on `127.0.0.1:8880` with `/v1/audio/speech`, `/v1/voices` and `/health`. I didn't find a Fish Speech process listening during the check, so confirm its port before story 04's test.
- The llama router and OmniVoice both bind to **localhost** on lucix, so the Mac can't reach them directly. For testing, either use `tailscale serve` on lucix or an SSH tunnel (`ssh -N -L 8081:127.0.0.1:8081 -L 8880:127.0.0.1:8880 root@100.109.92.88`).
