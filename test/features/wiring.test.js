// Feature wiring: the app is only whole if every promised capability is actually
// connected end to end. These tests walk the shipped source and fail when a
// feature loses a link in the chain — a preload call with no handler, an organ
// that stopped being loaded, a settings section with no UI, a theme with no CSS.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('../helpers/tmp');
const { DEFAULTS } = require('../../main/kernel/settings');
const { TOOLS } = require('../../main/organs/tools');

const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const PRELOAD = read('preload.js');
const MAIN = read('main', 'main.js');
const ORGANS_INDEX = read('main', 'organs', 'index.js');
const HANDLERS = MAIN + '\n' + ORGANS_INDEX;

// Channels the preload offers to the UI, e.g. call('chat:send').
const exposed = [...new Set([...PRELOAD.matchAll(/call\('([^']+)'\)/g)].map((m) => m[1]))];
// Channels the kernel and the organs register, e.g. h('chat:send', ...).
const handled = new Set([...HANDLERS.matchAll(/\bh\('([^']+)'/g)].map((m) => m[1]));

test('the UI bridge exposes a substantial API', () => {
  assert.ok(exposed.length > 60, `only ${exposed.length} channels exposed; the bridge looks truncated`);
});

test('every call the UI can make has a handler in the kernel or the organs', () => {
  const missing = exposed.filter((ch) => !handled.has(ch));
  assert.deepEqual(missing, [], `these preload calls would reject at runtime: ${missing.join(', ')}`);
});

test('no handler is registered twice', () => {
  const all = [...HANDLERS.matchAll(/\bh\('([^']+)'/g)].map((m) => m[1]);
  const dupes = all.filter((c, i) => all.indexOf(c) !== i);
  assert.deepEqual([...new Set(dupes)], [], 'a duplicate handler silently replaces the first');
});

test('the kernel IPC stays available in safe mode', () => {
  // Everything the recovery screen needs must be registered by the kernel itself,
  // because the organs are exactly what is broken when safe mode kicks in.
  const kernelSide = new Set([...MAIN.matchAll(/\bh\('([^']+)'/g)].map((m) => m[1]));
  for (const ch of ['kernel:state', 'kernel:rollback', 'kernel:resetShipped', 'kernel:relaunch', 'renderer:ready']) {
    assert.ok(kernelSide.has(ch), `${ch} must be handled by the kernel, not by an organ`);
  }
});

test('every organ described in organs.json ships and is loaded by the set', () => {
  const manifest = JSON.parse(read('main', 'organs', 'organs.json'));
  for (const [file, description] of Object.entries(manifest.main)) {
    assert.ok(fs.existsSync(path.join(ROOT, 'main', 'organs', file)), `${file} is documented but missing`);
    assert.ok(description.length > 20, `${file} needs a real description for the agent`);
    if (file === 'index.js') continue;
    const base = file.replace(/\.js$/, '');
    const loaded = fs.readdirSync(path.join(ROOT, 'main', 'organs'))
      .filter((f) => f.endsWith('.js') && f !== file)
      .some((f) => new RegExp(`require\\('\\./${base}'\\)`).test(read('main', 'organs', f)));
    assert.ok(loaded, `${file} is documented but no organ ever loads it`);
  }
});

test('every shipped organ file is documented', () => {
  const manifest = JSON.parse(read('main', 'organs', 'organs.json'));
  for (const f of fs.readdirSync(path.join(ROOT, 'main', 'organs'))) {
    if (!f.endsWith('.js')) continue;
    assert.ok(manifest.main[f], `${f} is shipped but not described in organs.json`);
  }
});

test('the organ set can be torn down again', () => {
  assert.match(ORGANS_INDEX, /dispose/, 'create() must return a dispose() or hot swaps leak');
});

test('every settings section the app defines has a page in the UI', () => {
  const settingsUi = read('renderer', 'settings.js');
  const skip = new Set(['ui']); // internal layout state, not a user-facing page
  for (const section of Object.keys(DEFAULTS)) {
    if (skip.has(section)) continue;
    assert.match(settingsUi, new RegExp(`\\b${section}\\b`), `settings.${section} has no UI in renderer/settings.js`);
  }
});

test('the settings pages call the assistant by name, not "the brain"', () => {
  const ui = read('renderer', 'settings.js');
  const jargon = [...ui.matchAll(/.{0,60}\bbrains?\b.{0,60}/gi)].map((m) => m[0].trim());
  assert.deepEqual(jargon, [], `the settings UI still calls her the brain: ${jargon.join(' | ')}`);
  // And it uses whatever the user named her, rather than hard-coding "Lyra".
  assert.match(ui, /roleBlock\('chat', s\.persona\.name/, 'the chat model should be labelled with her name');
  assert.match(ui, /s\.model\.chat\.provider === p\.id \? s\.persona\.name/, 'the provider badge should use her name');
  assert.match(ui, /\[\(\) => S\(\)\.persona\.name,/, 'the first settings group should be named after her');
});

test('every built-in theme is complete', () => {
  const dir = path.join(ROOT, 'renderer', 'themes');
  const themes = fs.readdirSync(dir).filter((d) => fs.statSync(path.join(dir, d)).isDirectory());
  assert.ok(themes.length >= 3, 'the app ships at least three themes');
  for (const id of themes) {
    const meta = JSON.parse(read('renderer', 'themes', id, 'theme.json'));
    assert.ok(meta.name, `${id} has no display name`);
    assert.ok(['dark', 'light'].includes(meta.scheme), `${id} has an unusable scheme: ${meta.scheme}`);
    assert.ok(fs.existsSync(path.join(dir, id, 'theme.css')), `${id} has no stylesheet`);
  }
  assert.ok(themes.includes(DEFAULTS.appearance.theme), 'the default theme must be one that ships');
});

test('the UI loads every renderer script it ships', () => {
  const html = read('renderer', 'index.html');
  for (const f of fs.readdirSync(path.join(ROOT, 'renderer'))) {
    if (!f.endsWith('.js')) continue;
    assert.ok(html.includes(f), `renderer/${f} is shipped but index.html never loads it`);
  }
  assert.match(html, /styles\.css/);
});

test('the agent guide never names a tool that no longer exists', () => {
  // The full registry is generated live by read_docs("tools"); the guide names the
  // handful of app-control tools in prose, and those must stay real.
  const guide = read('docs', 'AGENT.md');
  const known = new Set(TOOLS.map((t) => t.name));
  // Tool calls in the guide are written as name({…}) or name("…").
  const referenced = [...new Set([...guide.matchAll(/\b([a-z][a-z0-9_]{3,})\(["{]/g)].map((m) => m[1]))];
  const stale = referenced.filter((n) => !known.has(n));
  assert.deepEqual(stale, [], `the docs promise tools that are not registered: ${stale.join(', ')}`);
  assert.ok(referenced.length >= 5, 'the guide should show the agent how to drive the app');
  assert.match(guide, /read_docs\("tools"\)/, 'the guide must point at the live tool list');
});

test('the tools that let the agent change the app are all registered', () => {
  for (const n of ['configure_app', 'apply_changes', 'checkpoint', 'list_checkpoints', 'rollback', 'read_docs', 'app_state', 'read_logs', 'install_extension']) {
    assert.ok(TOOLS.some((t) => t.name === n), `${n} is promised by the docs but missing from the registry`);
  }
});

test('panel headers keep clear of the macOS window buttons', () => {
  const css = read('renderer', 'styles.css');
  const main = read('main', 'main.js');

  // The system draws the traffic lights over the page, inset from the top left.
  const inset = /trafficLightPosition: \{ x: (\d+), y: (\d+) \}/.exec(main);
  assert.ok(inset, 'main.js must position the window buttons for the reserve to be meaningful');
  const buttonsBottom = Number(inset[2]) + 16; // the buttons are about 14px tall
  const reserve = Number(/--titlebar-h: (\d+)px/.exec(css)[1]);
  assert.ok(reserve > buttonsBottom, `only ${reserve}px is reserved for buttons reaching ${buttonsBottom}px`);

  // Both panel headers reserve that space, rather than each guessing its own.
  for (const rule of ['.sidebar-head', '.settings-nav-head']) {
    const decl = new RegExp(`\\${rule} \\{[^}]*\\}`).exec(css);
    assert.ok(decl, `${rule} is missing`);
    assert.match(decl[0], /padding: var\(--titlebar-h\)/, `${rule} must reserve the window-button space`);
  }
});

test('the settings menu title cannot scroll under the window buttons', () => {
  // The menu is long enough to scroll, and it scrolls as one piece, so without a
  // pinned header the title slides up behind the macOS window buttons.
  const css = read('renderer', 'styles.css');
  assert.match(/\.settings-nav \{[^}]*\}/.exec(css)[0], /overflow-y: auto/, 'the menu scrolls, which is what makes this necessary');
  const head = /\.settings-nav-head \{[^}]*\}/.exec(css)[0];
  assert.match(head, /position: sticky/, 'the settings title must stay pinned while the menu scrolls');
  assert.match(head, /top: 0/);
  assert.match(head, /background: var\(--side\)/, 'a pinned header needs an opaque background to cover what scrolls under it');
});

test('the recovery screen exists and does not depend on the organs', () => {
  const recovery = read('main', 'kernel', 'recovery.html');
  assert.ok(recovery.length > 200);
  assert.ok(!/organs\//.test(recovery), 'the recovery screen must stand on its own');
});

test('the version is a single source of truth', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.version, /^\d+\.\d+\.\d+/);
  assert.match(MAIN, /app\.getVersion\(\)/, 'the kernel must read the version from the package, not repeat it');
});

test('the app never ships with node integration switched on in the window', () => {
  assert.match(MAIN, /contextIsolation:\s*true/);
  assert.match(MAIN, /nodeIntegration:\s*false/);
  assert.match(PRELOAD, /contextBridge\.exposeInMainWorld/, 'the UI must reach the kernel only through the bridge');
});
