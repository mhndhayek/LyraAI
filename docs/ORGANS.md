# Organs

Organs are the app's own code, shipped inside the bundle and copied to the state folder on first run (and whenever a new app version ships, after a checkpoint). You edit the copies.

## Main organs (`organs/main/`)

Loaded as one set by `index.js`, which exports `create(kernel)` and returns services plus `dispose()`. `organs.json` describes each file. Hot swap = `apply_changes({what:"main"})`: the kernel verifies every file (`node --check`, then a dry `require` of `index.js` with a stubbed electron module), disposes the running set (stops runs, kills the shell, closes browser views), clears the module cache, and calls `create` again. This happens after your turn ends.

The `kernel` object handed to `create` (and reachable from tools as `ctx.kernel`): `settings`, `store`, `paths`, `checkpoints`, `extensions`, `docs`, `guard`, `loader`, `emit(chatId, type, payload)`, `ipc(channel, fn)`, `win()`, `root()`, `appState()`, `log()`.

Adding a tool: push an object into `TOOLS` in `tools.js` with `name`, `key` (settings.tools switch), `icon`, `description`, `parameters` (JSON schema), `risk(args, ctx)` → low/medium/high, `summary(args, ctx)`, `run(args, ctx)` → string. For something new, prefer an extension.

## UI organ (`organs/renderer/`)

Plain HTML/CSS/JS, loaded by the window from the state folder. `apply_changes({what:"renderer"})` reloads the window; the page must call `lyra.kernel.ready()` (app.js does at the end of init) within 10 s, or the kernel rolls the UI back to the last known good checkpoint. Keep that call. See `read_docs("ui")` for the file map and element ids. Styles are CSS variables in `styles.css`; prefer a theme for colours and shapes.

## What not to do

- Do not remove `create`/`dispose` from `index.js` or the ready call from `app.js`.
- Do not edit `settings.json` by hand (use `configure_app`); do not touch `.git`.
- Do not change the preload bridge or the kernel: they live in the bundle and are read-only.
