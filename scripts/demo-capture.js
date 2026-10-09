#!/usr/bin/env node
// Capture the live 3D character panel for the story-08 PR demo: the VRM in the
// app, neutral (idle) and "happy" (speaking), same camera. Drives the real app
// over Chrome DevTools Protocol and screenshots the #stage element.
//   node scripts/demo-capture.js <out.png> <state: idle|speaking> [userDataDir]
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { ROOT } = require('./electron-run');

const [,, out, state, seed] = process.argv;
if (!out || !state) { console.error('usage: demo-capture <out.png> <idle|speaking> [userDataDir]'); process.exit(2); }
const dataDir = seed || fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-demo-'));

// Seed the live character as 3D so the panel mounts the VRM on boot.
const stateDir = path.join(dataDir, 'state');
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(path.join(stateDir, 'settings.json'), JSON.stringify({
  ui: { setupDone: true },
  appearance: { source: 'vrm', vrmModel: 'builtin:lyra', liveCharacter: true, placement: 'panel' },
  persona: { name: 'Lyra', avatar: 'builtin:catgirl' },
}, null, 2));

const bin = require(path.join(ROOT, 'node_modules', 'electron'));
const PORT = 9321 + (process.pid % 100);
const app = spawn(bin, [ROOT, `--user-data-dir=${dataDir}`, '--no-sandbox', `--remote-debugging-port=${PORT}`, '--remote-debugging-address=127.0.0.1', '--window-size=1080,720'], { cwd: ROOT, env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
app.stderr.on('data', (d) => process.stderr.write(d));

const get = (u) => new Promise((res, rej) => http.get(u, (r) => { let b = ''; r.on('data', (c) => b += c); r.on('end', () => res(b)); }).on('error', rej));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 1) wait for the DevTools target
  let ws;
  for (let i = 0; i < 60; i++) {
    try {
      const list = JSON.parse(await get(`http://127.0.0.1:${PORT}/json`));
      const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
      if (page) { ws = page.webSocketDebuggerUrl; break; }
    } catch { /* not up yet */ }
    await sleep(500);
  }
  if (!ws) throw new Error('no DevTools page target appeared');

  // 2) minimal CDP client over the websocket (the app has no ws dep, so hand-roll
  //    just enough: HTTP upgrade + frame encode/decode for small JSON messages).
  const wsClient = await connect(ws);

  let seq = 0; const pending = new Map();
  wsClient.on('message', (data) => {
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.id && pending.has(msg.id)) { const { resolve } = pending.get(msg.id); pending.delete(msg.id); resolve(msg); }
  });
  const call = (method, params = {}) => new Promise((resolve) => { const id = ++seq; pending.set(id, { resolve }); wsClient.send(JSON.stringify({ id, method, params })); });

  await call('Page.enable');
  await call('Runtime.enable');
  // Let the kernel boot and the VRM mount (it's a 16.7 MB file + shader compile).
  await sleep(9000);

  // 3) force the live panel + VRM and the requested state.
  const force = `
    (async () => {
      const a = window.LyraApp.settings().appearance;
      await window.LyraApp.set({ appearance: { source: 'vrm', vrmModel: 'builtin:lyra', liveCharacter: true, placement: 'panel' } });
      await window.LyraApp.set({ ui: { livePanel: true } });
      // wait for the VRM to actually mount
      for (let i = 0; i < 40; i++) {
        const c = window.LyraApp.char();
        if (c && c.vrm) return 'mounted';
        await new Promise((r) => setTimeout(r, 300));
      }
      return c && c.vrm ? 'mounted' : 'timeout';
    })()
  `;
  const mount = await call('Runtime.evaluate', { expression: force, awaitPromise: true, returnByValue: true });
  console.error('mount:', mount.result && mount.result.result && mount.result.result.value);
  // Let the pose/animation settle before the "speaking" capture.
  await call('Runtime.evaluate', { expression: `window.LyraApp.char().setState(${JSON.stringify(state)})` });
  await sleep(state === 'speaking' ? 2600 : 1500);

  // 4) screenshot the #stage element (the character viewport) — same camera for
  //    every capture because the camera is derived from fixed stage dimensions.
  const shot = await call('Runtime.evaluate', { expression: `
    (() => {
      const el = document.querySelector('#stage');
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    })()
  `, returnByValue: true });
  const rect = shot.result.result.value;
  const img = await call('Page.captureScreenshot', { format: 'png', clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: 1 } });
  fs.writeFileSync(out, Buffer.from(img.result.data, 'base64'));
  console.log(`wrote ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
  wsClient.close();
  app.kill('SIGKILL');
}

// Tiny websocket client (Node has no built-in; the app has no ws dep either).
// Client→server frames MUST be masked (RFC 6455 §5.3); Chromium drops unmasked
// ones and closes the socket, so the payload is XOR-masked with a random key.
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    const key = Buffer.from(require('crypto').randomBytes(16)).toString('base64');
    const req = http.request({ host: u.hostname, port: u.port || 80, path: u.pathname + u.search, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': 13 } });
    req.on('upgrade', (res, socket) => {
      const client = { socket, send(s) {
        const payload = Buffer.from(s); const len = payload.length;
        const mask = require('crypto').randomBytes(4);
        const masked = Buffer.from(payload); for (let i = 0; i < len; i++) masked[i] ^= mask[i % 4];
        const header = Buffer.alloc(len < 126 ? 6 : len < 65536 ? 8 : 14);
        header[0] = 0x81; header[1] = 0x80 | (len < 126 ? len : len < 65536 ? 126 : 127);
        if (len >= 126 && len < 65536) header.writeUInt16BE(len, 2);
        if (len >= 65536) header.writeUInt32BE(len, 4);
        const keyOff = len < 126 ? 2 : len < 65536 ? 4 : 10;
        mask.copy(header, keyOff);
        socket.write(Buffer.concat([header, masked]));
      }, close() { socket.end(); }, on(ev, cb) { (client._h = client._h || {})[ev] = cb; } };
      let buf = Buffer.alloc(0);
      socket.on('data', (c) => { buf = Buffer.concat([buf, c]); let off = 0; while (buf.length - off >= 2) { const l1 = buf[off + 1] & 0x7f; let len = l1, hd = 2; if (l1 === 126) { if (buf.length < off + 4) return; len = buf.readUInt16BE(off + 2); hd = 4; } else if (l1 === 127) { if (buf.length < off + 10) return; len = Number(buf.readBigUInt64BE(off + 2)); hd = 10; } if (buf.length < off + hd + len) return; const payload = buf.slice(off + hd, off + hd + len); client._h && client._h.message && client._h.message(payload); off += hd + len; } });
      resolve(client);
    });
    req.on('error', reject); req.end();
  });
}

main().then(() => process.exit(0)).catch((e) => { console.error('demo capture failed:', e.message); app.kill('SIGKILL'); process.exit(1); });
