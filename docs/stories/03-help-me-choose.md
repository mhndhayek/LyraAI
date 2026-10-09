# 03 · "Help me choose" + in-app llama.cpp for newbies · L · ✅ approved (build & test on the Mac only)

*As someone brand new to local AI, I click **Help me choose** on the Model step. Lyra looks at my computer, recommends a model we've tested, and sets llama.cpp up for me inside the app: no terminal, no separate installer, and nothing that looks shady.*

## Decisions (Hanood, Oct 8)
- **Hardware detection is on** (one consent line shown, plus a "Skip, I'll choose myself" link).
- **llama.cpp for everyone.** No LM Studio or Ollama recommendations.
- **Lyra installs it in-app, for newbies only**: the help-me-choose flow offers it. Users who already run a server just paste their URL (story 02). It must feel transparent and trustworthy, never like a hidden miner: show exactly what's downloaded, from where, how big, where it goes, and that it only runs while Lyra is open.
- **Build and test on the Mac.** **Don't touch the AI server (lucix)** for this story.
- Include remote/hosted as the fallback card when nothing local fits.

## Flow
**Screen 1 — "Let me look at this computer"** (automatic; *"This stays on your computer."*)
- OS/arch/CPU: `process.platform`, `process.arch`, `os.cpus()[0].model`
- RAM: `os.totalmem()`. Free disk: `fs.statfs(userData)`
- GPU: `app.getGPUInfo('complete')`. On macOS add `system_profiler SPDisplaysDataType -json` (chip + GPU cores; Apple silicon shares memory with the GPU). On Windows/Linux, `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader` if present.
- Already running? Probe `:8080`, `:1234`, `:11434`. If one answers, offer "Use the one you already have" (→ story 02 flow).

**Screen 2 — two questions**: *What for?* Chat & companion · Coding & tools · Both. *Speed or smarts?* Snappy · Balanced · Smartest that fits.

**Screen 3 — "Here's what I'd do"**: one card, e.g. *"Qwen3 8B · Q4_K_M · 5.0 GB download · 32k context · runs on your M-series GPU"*, plus one line of *why* and an alternative link.
- If nothing fits (too little RAM/disk), show the fallback card: *"Your computer is a bit small for a local model. Connect to a server or API instead"* (→ story 02 form).

**Screen 4 — "Set it up for me"** (the transparency screen, before anything downloads):

| What | From | Size | Goes to |
|---|---|---|---|
| llama.cpp `llama-server` b#### (macOS arm64) | github.com/ggml-org/llama.cpp releases | ~N MB | `<userData>/runtime/llama.cpp/b####/` |
| Qwen3-8B-Q4_K_M.gguf | huggingface.co/<org>/<repo> | 5.0 GB | `<userData>/models/` |

- Then: *"It runs only while Lyra is open, uses only `127.0.0.1:<port>` (nothing on your network can reach it), and you can remove it all from Settings › Model › Local engine."*
- Buttons: **Download and start** · Cancel. Progress bars show bytes and speed, with pause/cancel. The SHA-256 is verified after download.

## In-app llama.cpp runtime: `main/organs/localEngine.js` (new)
- **Binary**: download the official release asset for the platform. Verified Oct 8: releases publish `llama-<tag>-bin-macos-arm64.tar.gz` and `…-macos-x64.tar.gz` for every build (latest `b11515`). Releases are marked *pre-release* and ship several a day, so **pin a tested tag** in `docs/recommendations.json` and only bump it after the fitness test passes.
  - Verify the archive with a SHA-256 we pin next to the tag (computed when we test that tag), so a tampered download is refused.
  - Extract with `tar` into `<userData>/runtime/llama.cpp/<tag>/` and remove the quarantine xattr only on files we just verified.
  - Windows/Linux: same flow with their assets. For v1 only the Mac path is built and tested, and the others show "coming soon".
- **Model**: download the GGUF from Hugging Face over HTTPS with resume (`Range`), and verify its SHA-256 against the HF LFS oid or our pinned value.
- **Process**:
  - spawn `llama-server -m <gguf> --host 127.0.0.1 --port <free port> -c <ctx> --jinja -ngl 999 --api-key <random per-launch key>`
  - start it when Lyra starts and **kill it when Lyra quits** (also on crash, via the watchdog)
  - log to `<userData>/logs/llama-server.log`, health-check with `GET /health`
  - it auto-registers as a provider "Local (llama.cpp)" through story 02's provider model
- **Settings › Model › Local engine**: status, version, model, port, RAM in use, **Stop**, **Start**, **Update engine**, **Remove engine and models** (deletes both folders and shows the freed space).

## Tested matrix: `docs/recommendations.json` (shipped)
```json
{ "engine": { "tag": "b11515", "assets": { "darwin-arm64": { "file": "llama-b11515-bin-macos-arm64.tar.gz", "sha256": "<pinned when tested>" } } },
  "models": [
    { "id": "mac-16-balanced", "when": { "os": "darwin", "arch": "arm64", "minMemGB": 16, "maxMemGB": 31 },
      "goal": ["chat", "both"], "speed": "balanced",
      "hf": "<org>/<repo>", "file": "<file>.gguf", "sha256": "<pinned>", "sizeGB": 5.0, "context": 32768,
      "testedWith": "0.9.13", "testedOn": "MacBook Pro (Apple silicon)", "fitness": "5/5", "tokPerSec": 0 } ] }
```
Rows only get in after **`scripts/fitness.js`** passes on the Mac: 5 scripted turns (chat, one tool call, JSON-args tool call, 4k-context recall, vision if the model has it), recording tok/s. Start with Mac rows for 8 / 16 / 32+ GB. NVIDIA rows come later and aren't tested on lucix in this story.

**Owns:** new `main/organs/localEngine.js`, new `main/organs/hardware.js`, new `renderer/choose.js`, `renderer/setup.js` (a "Help me choose" button inside `model()`, coordinate with 02), `docs/recommendations.json`, new `scripts/fitness.js`, `main/organs/organs.json`, `docs/AGENT.md`, `docs/SECURITY.md` (the download/verify/run rules). **Depends on 02** (the provider model).

## QA
1. **Failing-first** `test/organs/recommend.test.js`: fixtures for Mac 8 GB, 16 GB and 36 GB, and an Intel Mac 8 GB → each maps to the expected row or the fallback card.
2. `hardware.js` with fake `getGPUInfo`/`system_profiler` JSON returns `{ os, arch, memGB, gpu, freeDiskGB }`, and a missing `nvidia-smi` doesn't throw.
3. Download verification: a fake server serves a tarball with the wrong SHA-256 → refused and deleted, nothing extracted.
4. Process lifecycle: start → `/health` OK, it binds to `127.0.0.1` only (assert with `lsof -iTCP -sTCP:LISTEN -P` in the smoke test), it's killed on app quit with no orphan `llama-server` left (`pgrep` empty), and requests without the per-launch key get 401.
5. Remove: "Remove engine and models" deletes both folders and the provider disappears.
6. **Mac demo** (screen recording, fresh install with the data folder moved aside): Help me choose → hardware screen → 2 answers → recommendation → transparency table → download with progress → Lyra answers a chat on the local model. Then quit Lyra and `pgrep llama-server` is empty. Lucix isn't used at all.
