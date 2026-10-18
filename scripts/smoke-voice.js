#!/usr/bin/env node
// Story 04 QA 2: the Voice page shows only what the connected server can do.
// Boots the real app twice against a fake OmniVoice server: one whose OpenAPI
// lists a clone route and one whose OpenAPI doesn't. It opens Settings › Voice
// over the DevTools protocol and checks that the Clone panel is there in the
// first run and absent in the second, and that the design panel and voice list
// follow the server too.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { ROOT } = require('./electron-run');

const WAV = Buffer.concat([Buffer.from('RIFF\x24\x08\x00\x00WAVEfmt ', 'binary'), Buffer.alloc(2100)]);
const json = (res, obj, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

// What omnivoice-server answers. Design comes from the `instructions` field and
// cloning from the /v1/audio/speech/clone route, both read from its OpenAPI.
function omnivoice(withClone) {
  const paths = {
    '/health': { get: {} }, '/v1/voices': { get: {} },
    '/v1/audio/speech': { post: { requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { model: {}, input: {}, voice: {}, instructions: {}, speed: {} } } } } } } },
    ...(withClone ? { '/v1/audio/speech/clone': { post: { requestBody: { content: { 'multipart/form-data': { schema: { type: 'object', properties: { text: {}, ref_audio: { format: 'binary' }, ref_text: {} } } } } } } } } : {}),
  };
  const server = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    if (p === '/health') return json(res, { status: 'ok' });
    if (p === '/openapi.json') return json(res, { openapi: '3.1.0', info: { title: 'OmniVoice Server', version: '0.2.1' }, paths });
    if (p === '/v1/voices') return json(res, { voices: [{ id: 'alloy', type: 'preset' }, { id: 'nova', type: 'preset' }, { id: 'design:<attributes>', type: 'design' }] });
    if (req.method === 'POST' && p === '/v1/audio/speech') { res.writeHead(200, { 'content-type': 'audio/wav' }); return res.end(WAV); }
    return json(res, { detail: 'Not Found' }, 404);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, endpoint: `http://127.0.0.1:${server.address().port}/v1` })));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (u) => new Promise((res, rej) => http.get(u, (r) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej));
const headless = process.platform === 'linux' && !process.env.DISPLAY;

async function runOnce(withClone, port) {
  const { server, endpoint } = await omnivoice(withClone);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-voice-'));
  fs.mkdirSync(path.join(dataDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'state', 'settings.json'), JSON.stringify({
    ui: { setupDone: true },
    voice: { provider: 'omnivoice', endpoint, detected: { id: 'omnivoice', label: 'OmniVoice', summary: 'OmniVoice · 2 voices', tts: true } },
  }));
  const bin = require(path.join(ROOT, 'node_modules', 'electron'));
  let cmd = bin; let args = [ROOT, `--user-data-dir=${dataDir}`, '--no-sandbox', `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'];
  if (headless) { args = ['-a', '--server-args=-screen 0 1280x900x24', cmd, ...args, '--disable-gpu']; cmd = 'xvfb-run'; }
  const app = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }, stdio: 'ignore' });
  try {
    let wsUrl = null;
    for (let i = 0; i < 120 && !wsUrl; i++) {
      try { const t = (await getJson(`http://127.0.0.1:${port}/json`)).find((x) => x.type === 'page' && /index\.html/.test(x.url)); if (t) wsUrl = t.webSocketDebuggerUrl; } catch { /* not up yet */ }
      if (!wsUrl) await sleep(500);
    }
    if (!wsUrl) throw new Error('no DevTools page target appeared');
    // Node 22 has a WebSocket client built in.
    // eslint-disable-next-line no-undef -- global in Node 22+, which CI and the repo require
    const ws = new WebSocket(wsUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let seq = 0; const pending = new Map();
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
    const ev = (expression) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); }).then((d) => d.result && d.result.result && d.result.result.value);
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) { ready = await ev('!!(window.Settings && window.LyraApp && window.LyraApp.settings())'); if (!ready) await sleep(500); }
    if (!ready) throw new Error('the UI never finished loading');
    await ev("window.Settings.open('voice')");
    let dom = null;
    for (let i = 0; i < 40; i++) {
      dom = await ev(`(() => { const c = document.querySelector('#settings-content'); const conn = c && c.querySelector('.voice-conn[data-role="tts"] .status-line'); return { status: conn ? conn.textContent : '', clone: !!(c && c.querySelector('[data-panel="clone"]')), design: !!(c && c.querySelector('[data-panel="design"]')), consent: !!(c && c.querySelector('.voice-consent input[type=checkbox]')), voices: c ? [...c.querySelectorAll('select option')].map((o) => o.value) : [], error: c && c.querySelector('.md.error') ? c.querySelector('.md.error').textContent : '' }; })()`);
      if (dom && (dom.status.includes('Connected') || dom.error)) break;
      await sleep(250);
    }
    ws.close();
    return dom;
  } finally {
    try { app.kill('SIGKILL'); } catch { /* gone already */ }
    server.close();
    await sleep(500);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows may still hold a file */ }
  }
}

(async () => {
  const fail = (m) => { console.error(`✗ ${m}`); process.exitCode = 1; };
  const port = 9400 + (process.pid % 200);
  const a = await runOnce(true, port);
  console.log('server with a clone route:', JSON.stringify(a));
  if (!a || a.error) fail(`the Voice page did not render: ${a && a.error}`);
  else {
    if (!a.status.includes('Connected')) fail(`the connection card does not say Connected: "${a.status}"`); else console.log(`✓ connection card: ${a.status.trim()}`);
    if (!a.clone) fail('the Clone panel is missing although the server lists a clone route'); else console.log('✓ Clone panel shown for a server whose OpenAPI lists a clone route');
    if (!a.consent) fail('the Clone panel has no consent checkbox'); else console.log('✓ Clone panel has the consent checkbox');
    if (!a.design) fail('the Design panel is missing although the speech route takes `instructions`'); else console.log('✓ Design panel shown (speech route takes `instructions`)');
    if (!a.voices.includes('alloy') || a.voices.some((v) => v.includes('<'))) fail(`voice list is wrong: ${a.voices.join(', ')}`); else console.log('✓ the server\'s voices are listed, the design placeholder is not');
  }
  const b = await runOnce(false, port + 1);
  console.log('server without a clone route:', JSON.stringify(b));
  if (!b || b.error) fail(`the Voice page did not render: ${b && b.error}`);
  else if (b.clone) fail('the Clone panel is shown although the server has no clone route');
  else console.log('✓ no Clone panel for a server without a clone route');
  if (!process.exitCode) console.log('\n✓ voice smoke passed');
  else console.error('\n✗ voice smoke failed');
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
