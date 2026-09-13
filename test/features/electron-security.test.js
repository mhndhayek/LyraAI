// Electron's defaults are generous: a renderer can be given Node, a page can be
// handed the microphone, a window can open another window. This file pins the
// choices that keep that from happening, so the next window or the next organ
// cannot quietly opt out of them. It replaces a third-party Electron scanner
// that stopped being maintained in 2023.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('../helpers/tmp');
const { decide, APP, WEB, PERMISSIONS } = require('../../main/kernel/permissions');

const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

// Every JavaScript file in the main process, so a window created somewhere new
// is covered without this test having to be told about it.
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, out);
    else if (e.name.endsWith('.js')) out.push(abs);
  }
  return out;
}
const MAIN_FILES = walk(path.join(ROOT, 'main')).concat([path.join(ROOT, 'preload.js')]);
const MAIN_SRC = MAIN_FILES.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
// The options every window and view is built with, one entry per call site.
const WEB_PREFS = MAIN_FILES.flatMap((f) => {
  const src = fs.readFileSync(f, 'utf8');
  return [...src.matchAll(/webPreferences:\s*\{([^}]*)\}/g)].map((m) => ({ file: path.relative(ROOT, f), body: m[1] }));
});

test('the kernel installs a permission policy at startup', () => {
  const main = read('main', 'main.js');
  assert.match(main, /require\('\.\/kernel\/permissions'\)/, 'main.js does not load the permission policy');
  assert.match(main, /permissions\.install\(/, 'the policy is loaded but never installed');
});

test('the policy is kernel-owned, so the agent cannot edit it away', () => {
  // Organs are copied into the state folder and the agent may rewrite them. A
  // control that lives there could be removed by the thing it is meant to limit.
  assert.ok(fs.existsSync(path.join(ROOT, 'main', 'kernel', 'permissions.js')), 'the policy must live in the kernel');
  for (const f of MAIN_FILES.filter((x) => x.includes(`${path.sep}organs${path.sep}`))) {
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(!/setPermission(Request|Check)Handler/.test(src), `${path.relative(ROOT, f)} sets a permission handler; that belongs to the kernel`);
  }
});

test('the app window may have the microphone, and nothing it does not need', () => {
  const origin = 'file:///Applications/Lyra.app/renderer/index.html';
  assert.equal(decide(APP, 'media', origin, { mediaTypes: ['audio'] }), true, 'the user must be able to talk to Lyra');
  assert.equal(decide(APP, 'clipboard-sanitized-write', origin, {}), true, 'the copy buttons must keep working');
  assert.equal(decide(APP, 'media', origin, { mediaTypes: ['video'] }), false, 'nothing here needs a camera');
  assert.equal(decide(APP, 'media', origin, { mediaTypes: ['audio', 'video'] }), false, 'a camera must not ride along with the microphone');
  for (const p of ['geolocation', 'usb', 'serial', 'hid', 'midiSysex', 'display-capture', 'notifications', 'clipboard-read']) {
    assert.equal(decide(APP, p, origin, {}), false, `the app window was granted ${p}, which it never asks for`);
  }
});

test('web content gets nothing at all, wherever it was loaded from', () => {
  // The agent's browser loads whatever page it was pointed at, and the agent can
  // point it at a local file as easily as at a site — so the empty allowlist has
  // to be what refuses these, not the origin check that happens to sit after it.
  for (const origin of ['https://example.test', 'file:///tmp/page.html', 'null', 'about:blank']) {
    const granted = PERMISSIONS.filter((p) => decide(WEB, p, origin, { mediaTypes: ['audio'], mediaType: 'audio' }));
    assert.deepEqual(granted, [], `web content at ${origin} was granted: ${granted.join(', ')}`);
  }
});

test('only the build itself counts as the app', () => {
  // An extension panel is an iframe loading a URL the extension chose. Sandboxed,
  // it asks as "null"; unsandboxed it asks as its own site. Neither is us.
  for (const origin of ['null', 'https://example.test', 'http://localhost:8765', 'data:text/html,x', '', null, undefined]) {
    assert.equal(decide(APP, 'media', origin, { mediaTypes: ['audio'] }), false, `${String(origin)} was treated as the app's own window`);
  }
});

test('a media request that names nothing is refused', () => {
  assert.equal(decide(APP, 'media', 'file:///a/index.html', {}), false);
  assert.equal(decide(APP, 'media', 'file:///a/index.html', { mediaTypes: [] }), false);
});

test('every window keeps context isolation on and Node out of the renderer', () => {
  assert.ok(WEB_PREFS.length >= 3, `only ${WEB_PREFS.length} window configurations found; the scan looks broken`);
  for (const { file, body } of WEB_PREFS) {
    assert.match(body, /contextIsolation:\s*true/, `${file} builds a window without context isolation`);
    assert.ok(!/nodeIntegration:\s*true/.test(body), `${file} gives a renderer Node`);
  }
  assert.ok(!/enableRemoteModule/.test(MAIN_SRC), 'the remote module must stay out of this app');
});

test('the agent browser sandboxes the pages it loads', () => {
  const browser = path.join(ROOT, 'main', 'organs', 'browser.js');
  const prefs = WEB_PREFS.filter((p) => p.file === path.relative(ROOT, browser));
  assert.ok(prefs.length >= 2, 'the visible view and the headless window should both be found');
  for (const { body } of prefs) {
    assert.match(body, /sandbox:\s*true/, 'untrusted pages must load in a sandboxed renderer');
    assert.match(body, /partition:/, 'untrusted pages must not share the app session');
  }
});

test('web security is never switched off', () => {
  for (const bad of [/webSecurity:\s*false/, /allowRunningInsecureContent:\s*true/, /experimentalFeatures:\s*true/]) {
    assert.ok(!bad.test(MAIN_SRC), `the main process sets ${bad.source}`);
  }
});

test('a page can never open a window of its own', () => {
  for (const f of ['main/main.js', 'main/organs/browser.js']) {
    const src = read(...f.split('/'));
    assert.match(src, /setWindowOpenHandler/, `${f} creates web contents without deciding what window.open does`);
    assert.match(src, /action:\s*'deny'/, `${f} lets a page open a window`);
  }
});

test('the renderer ships a policy that cannot run injected script', () => {
  const html = read('renderer', 'index.html');
  const meta = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i.exec(html);
  assert.ok(meta, 'renderer/index.html has no Content-Security-Policy');
  const directives = Object.fromEntries(meta[1].split(';').map((d) => d.trim()).filter(Boolean)
    .map((d) => { const [name, ...rest] = d.split(/\s+/); return [name, rest.join(' ')]; }));
  assert.ok(directives['default-src'], 'the policy has no default-src to fall back on');
  const script = directives['script-src'];
  assert.ok(script, 'the policy does not restrict script-src');
  // style-src needs 'unsafe-inline' because themes set CSS variables inline, but
  // script is where an injection would actually run.
  for (const hole of ["'unsafe-inline'", "'unsafe-eval'", '*']) {
    assert.ok(!script.split(/\s+/).includes(hole), `script-src allows ${hole}`);
  }
});
