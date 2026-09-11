# Extensions

An extension is a folder `extensions/<id>/` under the state folder with:

```
manifest.json   required
main.js         optional: tools for the agent (main process, Node)
panel.html      optional: a panel shown in the Live panel tabs (sandboxed iframe)
```

## manifest.json

```json
{ "id": "hello-panel", "name": "Hello panel", "version": "1.0.0", "description": "Shows a greeting and counts clicks.",
  "capabilities": ["settings"], "main": "main.js", "panel": "panel.html" }
```

`id` must equal the folder name. Capabilities are disclosed to the user and approved once: `settings` (read app settings), `shell` (run commands), `network` (fetch), `files` (files outside the workspace), `browser` (drive Lyra's browser), `ui` (panel). Tools of an extension that declares `shell` or `files` are high-risk by default.

## main.js

```js
module.exports = {
  tools: [
    { name: 'greet', description: 'Say hello to someone.', parameters: { type: 'object', properties: { who: { type: 'string' } }, required: ['who'] },
      risk: 'low', summary: (a) => `Greet ${a.who}`,
      async run(args, api) { api.store.set('count', (api.store.get('count', 0)) + 1); return `Hello, ${args.who}!`; } },
  ],
  activate(api) { api.log('ready'); },
  dispose() {},
};
```

The `api` object: `id`, `dir`, `workspace()`, `settings()` (needs `settings`), `runShell(cmd, timeoutMs)` (needs `shell`), `fetch(...)` (needs `network`), `browser()` (needs `browser`), `store.get/set` (a small key-value store for the extension), `log(text)`, `notice(text)` (a toast in the chat). Tool names must not collide with built-in tools. Runtime exceptions count as failures; five of them quarantine the extension.

## panel.html

A plain HTML page in a sandboxed iframe (no Node, no parent DOM). It talks to its own tools through `postMessage`:

```js
function call(tool, args) { return new Promise((res) => { const id = Math.random().toString(36).slice(2); const h = (e) => { if (e.data && e.data.lyra === 'result' && e.data.id === id) { window.removeEventListener('message', h); res(e.data); } }; window.addEventListener('message', h); parent.postMessage({ lyra: 'call', id, tool, args }, '*'); }); }
```

The reply is `{lyra:'result', id, ok, result|error}`. Panel calls run without an approval prompt (the user clicked), but only tools of the same extension are reachable.

## Lifecycle

`install_extension({id})` validates the manifest, asks the user to approve the capabilities, and loads it. `set_extension({id, enabled})` toggles it. `apply_changes({what:"extensions"})` reloads all of them after edits. `list_extensions()` shows status: active, disabled, pending-approval, quarantined (load error or repeated failures; enabling again clears it), broken (bad manifest).
