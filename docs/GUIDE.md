# Lyra user guide

The long version of how Lyra works, page by page. The short version is the [README](../README.md).

## Run it

```bash
cd lyra
npm install            # Electron + a few pure-JS libraries
npm run voice:setup    # optional: KittenTTS + Whisper sidecar (needs uv and `brew install espeak-ng`)
npm start
npm run selftest       # optional: proves the safety nets (verify, rollback, quarantine, guards)
```

Make a `Lyra AI Agent.app` bundle with `npm run dist` (lands in `dist/mac-arm64/`).

Lyra reads the real context length from the server: LM Studio, llama.cpp (`/props`), Ollama, or any OpenAI-compatible API that reports it. The number in use is always visible: a meter under the message box shows tokens used against the context with the compression mark, and *Settings › Memory & context* breaks it down into persona, tools, conversation and summary.

Lyra talks to any OpenAI-compatible local runtime. LM Studio on `http://localhost:1234/v1` is the default; it also reports context length and which models are vision models, so *Settings › Model* can auto-detect them. Ollama and llama.cpp work too (*Settings › Provider*).

## What is where

- **Chat** – text, pictures (attach, paste or drop), and voice messages (tap the mic, tap again to send; the transcript shows under the bubble). Replies stream, tool steps show as activity lines, and anything that needs approval shows a card with a countdown.
- **Live panel** – the character (built-in vector or pixel version depending on the theme, a GIF pack, or a Live2D model), its state, and what Lyra is doing right now.
- **Lyra's browser** – when Lyra browses in *visible* mode the panel opens inside the app with the page it is driving; *Take over* lets you use it yourself, *Stop* halts the agent's browsing for the turn. In *headless* mode you only see a status line in the chat.
- **Profiles** (*Settings › Profiles*) – keep more than one assistant. Each profile has its own soul, appearance, voice, animation, goals and model, and its own chats and memory; switching swaps all of it at once. Safety, the workspace, the browser and phone access are yours and shared by every profile.
- **Setup guide** – the first start opens a short guide: the model, her name and look, voice, image generation, safety, and tools. Skip it whenever you like; everything in it is under Settings, and the guide itself is under *Settings › About*.
- **Settings** (gear, or ⌘,) – grouped into Lyra (Model, Provider, Memory & context, Tools, Image generation), Character (Persona & chat, Appearance, Voice, AI goals), Around it (Workspace, Browser, Safety, Notifications, Mobile) and App (Extensions, Recovery, About).

## Kernel, organs, extensions

Lyra is built so the assistant inside it can customize and extend it safely.

- **Kernel** (read-only, in the app bundle: `main/main.js`, `main/kernel/`): boot, settings and data storage, git checkpoints of the state folder, the organ loader with two-phase apply, the extensions manager, the watchdog, safe mode and the recovery screen.
- **Organs** (shipped in `main/organs/` and `renderer/`, copied on first run to `~/Library/Application Support/Lyra/state/organs/`): everything the user experiences. The agent edits the live copies; `apply_changes` verifies them in a throwaway process, then hot-swaps the main organs (after the agent's turn) or reloads the UI (which must report ready within 10 s). Failures roll back to the last known good checkpoint; if even that fails, the next start opens safe mode.
- **Extensions** (`state/extensions/<id>/`): a manifest, optional `main.js` exporting tools, optional `panel.html` shown as a tab in the Live panel. Capabilities are approved once; loading errors or five runtime failures quarantine an extension. See `docs/EXTENSIONS.md` and `docs/examples/hello-panel`.
- **Guardrails**: the agent cannot change its name, the safety section, providers or API keys, kernel settings, or the master tool switches; model changes are queued until it is idle; shell commands that would kill the app, delete it, or drive the checkpoint repository are refused; writes to the bundle are refused; a daily self-modification budget applies.
- **Agent toolkit**: `edit_file`, `search_files`, `find_files`, `http_get`, `todo`, `read_docs`, `app_state`, `configure_app`, `apply_changes`, `checkpoint`, `list_checkpoints`, `rollback`, `list_extensions`, `install_extension`, `set_extension`, on top of the file, shell, browser, memory, vision and image tools. The docs the agent reads live in `docs/`.
- **Recovery** (Settings › Recovery): checkpoints with roll back, reload UI, hot-swap organs, verify, reset organs to shipped, budget, health log. `npm run start:safe` opens the recovery screen; `npm run selftest` runs the kernel self-test that breaks organs on purpose and checks every safety net.

## Memory

Only Lyra writes to memory (the `remember` tool). Long-term entries are shared across all chats and loaded into every system prompt up to the memory budget; short-term notes live in one chat. Storage is SQLite (built into Electron's Node) or a JSON file; switching migrates the data. Everything lives in `~/Library/Application Support/Lyra/`.

## How far a turn goes

*Settings › Model › How far Lyra goes in one turn* sets two limits: **tool steps** (default 30, up to 500) and a **time limit** (default 30 minutes). One step is one round of tool calls, so editing several files or working through a site takes many. When a turn hits the step limit Lyra says so and offers to carry on, and the header and the Live panel show the count while it works.

## Your phone

*Settings › Mobile* (beta) serves the same chat to your phone over your private Tailscale network. Switch it on, point the phone camera at the QR code, and Safari opens paired. The socket is bound to the tailnet address only, never to the wifi or the internet, and Tailscale issues a real HTTPS certificate for the machine's MagicDNS name, which is what lets the phone use the microphone and install to the home screen.

- On the phone, once: install Tailscale and sign in with the same account, scan the code, then **Share › Add to Home Screen** in Safari (three dots › Add to Home screen in Chrome).
- Each phone gets its own token, listed under *Paired phones* with a Remove button. The pairing code rotates and expires after fifteen minutes.
- Risky actions (shell, code, editing the app) are refused from a phone session unless you allow them there. Approvals can still be answered from the phone.
- Chats, memory and files never leave the Mac; the phone is a window onto it. The Mac has to be awake.

## Logs

Everything that fails leaves a line: `Settings › Recovery › Logs` shows errors, warnings and events from the kernel, the agent, the voice engine, model calls, tools, the browser, extensions and the window itself, filterable by level, source and text, with a copy button. Files live in `logs/` under the app data folder as one JSONL file per day, kept for a week, with API keys redacted. Lyra reads the same log with its `read_logs` tool, so you can ask it why something broke, including in a later session.

## Approvals

Three modes under *Safety*: ask, auto-approve, no restrictions. With *Smart approvals* on (Model), low-risk actions (reads, browsing, writes inside the workspace) run on their own; shell commands, code execution, writes outside the workspace and form submissions ask. Requests time out after the configured wait and are then denied or approved, your choice.

## Themes

A theme is a folder with `theme.json` and `theme.css`. The base UI is built on CSS variables and stable class names, so a theme can change fonts, shapes, borders, animation and the character, not just colours. Built-in: Lyra Dark, Lyra Light, and Pixel (bundled Pixelify Sans font, hard edges, pixel-art character). Your own go in `~/Library/Application Support/Lyra/themes/<id>/` (*Settings › Appearance › Open themes folder*); copy a built-in one from `renderer/themes/` to start.

```json
{ "name": "My theme", "scheme": "dark", "character": "default", "vars": { "bg": "#111", "side": "#181818", "accent": "#ff8800", "text": "#eee" } }
```

`character` may be `default` or `pixel`; `vars` only feeds the swatches in the theme picker.

## Voice

Text to speech uses KittenTTS through the Python sidecar in `voice/`. In the packaged app, press **Install voice engine** under *Settings › Voice* once: it builds the environment under Lyra's data folder (needs uv or python3, and `brew install espeak-ng`). Without it, replies fall back to the macOS voice, which ignores the voice choice, and the Voice page says so. Emoji, code blocks and markdown marks are never read aloud. Replies longer than about 450 characters are split into sentences and joined, because KittenTTS synthesises one pass at a time. Text to speech otherwise (friendly names such as Rosie map to KittenTTS voices in `voice/server.py`); if the sidecar is missing, macOS `say` is used. *Your own* points at any OpenAI-compatible `/v1/audio/speech` endpoint. Speech to text uses faster-whisper in the same sidecar.

## Live2D

Choose a `.model3.json` under *Appearance › Live character › Live2D* and put `live2dcubismcore.min.js` (from the Live2D website, it is not redistributable) in the same folder. Motion groups named Idle/Think/Tap/Speak are used for the states; lip sync drives `ParamMouthOpenY`. GIF packs are simpler: a folder with `idle.gif`, `thinking.gif`, `writing.gif`, `speaking.gif`.

## AI goals

About ten minutes after a chat with at least four messages goes quiet, Lyra reflects on it and may add up to two goals (improve / explore / surprise). You cannot add goals, only archive them or press *Work on it now*. With autonomy on, Lyra picks an open goal and works on it in its own goal chat (visible in the sidebar, marked ◆) for up to the daily budget, under the same safety rules.
