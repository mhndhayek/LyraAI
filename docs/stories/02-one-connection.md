# 02 · One connection: any `/v1` URL + key, auto-detect, logos, true "loaded" · M

*As a user, I paste one base URL ending in `/v1` (plus a key if my server needs one). Lyra works out what's behind it, shows its logo, and only calls a model "loaded" when it really is.*

## What's wrong today (0.9.12)
- **No API key field for local runtimes**: `renderer/setup.js:56` only adds the key field when `runtime === 'openai'`. Your lucix router needs a key (`--api-key-file`; `/v1/models` → 401 without one), so the wizard can't connect to it.
- **You have to pick a runtime first** (the LM Studio / Ollama / llama.cpp / OpenAI segmented control, `setup.js:15-20`), even though `llm.listModels()` already probes all four in order.
- **No logos.** `renderer/icons.js` has none for runtimes.
- **Unloaded models show as loaded**: in `main/organs/llm.js:55` the llama.cpp branch hard-codes `loaded: true` for every `/v1/models` entry. In **router mode** (lucix: `/props` → `"role":"router"`) each entry has `status.value: "loaded" | "unloaded"`, and Lyra ignores it. Ollama (`llm.js:37`) also hard-codes `loaded: true`, even though `/api/ps` reports what's really in memory. Downstream, `agent.js:51` "Auto" picks the first `loaded` model, so it can pick a cold 27B model, and `settings.js:65` labels it "· loaded".
- The Ollama probe (`llm.js:28`) doesn't send the auth header.

## Change
1. **One provider form** (setup + Settings › Model): fields are **Base URL** (placeholder `http://localhost:1234/v1`), **API key (optional)**, **Name (optional)**, and a **Connect** button. The runtime picker goes away. `provider.runtime` becomes *detected*, not chosen: it's stored as `detected: 'lmstudio' | 'ollama' | 'llama.cpp' | 'llama.cpp-router' | 'vllm' | 'openai'` and refreshed on every connect.
   - Normalise input: add `/v1` if it's missing, trim the trailing slash, and add `http://` when the scheme is missing.
   - Quick-fill chips under the field ("LM Studio :1234", "Ollama :11434", "llama.cpp :8080") just fill in the URL.
2. **Detection** (`llm.js`): a `detect({endpoint, apiKey})` returns `{ kind, version?, router?, models[] }`. It probes in parallel with a 3 s timeout, sending auth on **every** probe:
   - LM Studio: `GET /api/v0/models`
   - Ollama: `GET /api/version` + `/api/tags` + `/api/ps`
   - llama.cpp: `GET /props` (with `role === 'router'` → router)
   - vLLM: `GET /version` + `/v1/models` with `owned_by: 'vllm'`
   - anything else: generic `/v1/models`
   - A 401/403 → status **"Needs an API key"** with the key field focused, not "unreachable".
3. **True loaded state** in each branch:
   - LM Studio: `state === 'loaded'` (already correct)
   - llama.cpp router: `status.value === 'loaded'`
   - llama.cpp single model: `loaded: true`
   - Ollama: the model is present in `/api/ps`
   - vLLM and generic: `loaded: null`, shown as no badge, since unknown is better than wrong
   - **Dropdown**: group into *Loaded* and *Available (loads on first use)*. Unloaded entries show "· loads on first use (may be slow)". "Auto" picks only `loaded === true` (or `null`), never `false`.
   - Router extra: show `ctx-size` from `status.args` when there's no `/props` per model.
4. **Logos**: add SVGs for LM Studio, Ollama, llama.cpp (ggml), vLLM and OpenAI-compatible (generic plug) to `renderer/icons.js` or `renderer/brand/`. Use each project's official mark, check its trademark/usage note, and record the licence in `THIRD_PARTY.md`. After connecting, the status line reads: `[logo] Connected · llama.cpp (router) · 2 of 4 models loaded`.
5. **Migration**: existing `providers.list[i].runtime` maps to `detected`. Nothing else changes for current users.

**Owns:** `main/organs/llm.js`, `renderer/setup.js` (`model()` only), `renderer/settings.js` (Model and Provider section), `renderer/icons.js`, `main/kernel/settings.js` (providers migration only), `main/organs/agent.js:36-55` (model resolution only), `THIRD_PARTY.md`.

## QA
1. **Failing-first** `test/organs/llm.test.js`: a fake router server returns the lucix-shaped `/props` (`role: router`) and a `/v1/models` with 2 loaded and 2 unloaded. `listModels` must return exactly 2 `loaded: true`. On `origin/main` this returns 4, which is the bug.
2. Fake server that 401s without `Authorization: Bearer k`: detect returns `needsKey: true`. With the key it returns `ok`.
3. One fake each for LM Studio, Ollama (with `/api/ps`), llama.cpp single, vLLM and generic: each is detected as the right `kind`.
4. Auto-selection test: the first model is unloaded and the second is loaded, so Auto picks the second.
5. URL normalisation table test (`localhost:1234` → `http://localhost:1234/v1`, `…/v1/` → `…/v1`).
6. **Mac demo**: open an SSH tunnel to the lucix router (README), paste `http://localhost:8081/v1` plus the key into the wizard and click Connect. Screenshot the llama.cpp logo, "router", "2 of 4 loaded" and the grouped dropdown. Repeat against LM Studio on the Mac if it's installed.
