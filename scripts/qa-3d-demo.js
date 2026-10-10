#!/usr/bin/env node
// Story-09 demo recording: boot the app in 3D, drive Lyra through
// idle -> thinking -> writing -> speaking, and capture the #stage element
// with Chrome DevTools Protocol. Frames land in <out>/frames and are joined
// into <out>/demo.mp4 with ffmpeg (24 fps).
//   node scripts/qa-3d-demo.js <out-dir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const { ROOT } = require('./electron-run');

const outDir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-3d-demo-'));
const framesDir = path.join(outDir, 'frames');
fs.mkdirSync(framesDir, { recursive: true });

// Seed the profile: setup finished, appearance 3D, so the stage shows the VRM
// immediately and the Welcome overlay never blocks it.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-3d-demo-data-'));
fs.mkdirSync(path.join(dataDir, 'state'), { recursive: true });
fs.writeFileSync(path.join(dataDir, 'state', 'settings.json'), JSON.stringify({
  ui: { setupDone: true },
  appearance: { source: 'vrm', vrmModel: 'builtin:lyra', liveCharacter: true, placement: 'panel' },
  persona: { name: 'Lyra', avatar: 'builtin:lyra' },
}, null, 2));

const bin = require(path.join(ROOT, 'node_modules', 'electron'));
const PORT = 9431 + (process.pid % 100);
const app = spawn(bin, [ROOT, `--user-data-dir=${dataDir}`, '--no-sandbox', `--remote-debugging-port=${PORT}`, '--remote-debugging-address=127.0.0.1', '--window-size=1080,720'], { cwd: ROOT, env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
app.stderr.on('data', (d) => process.stderr.write(d));
const kill = () => { try { app.kill('SIGKILL'); } catch {} };

const get = (u) => new Promise((res, rej) => http.get(u, (r) => { let b = ''; r.on('data', (c) => b += c); r.on('end', () => res(b)); }).on('error', rej));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let ws;
  for (let i = 0; i < 120; i++) {
    try {
      const list = JSON.parse(await get(`http://127.0.0.1:${PORT}/json`));
      const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
      if (page) { ws = await connect(page.webSocketDebuggerUrl); break; }
    } catch {}
    await sleep(500);
  }
  if (!ws) throw new Error('no devtools page');
  let seq = 0; const pending = new Map();
  ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(Object.assign(new Error(m.error.message), { detail: m.error.data || null })) : res(m.result); } });
  const call = (method, p) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params: p || {} })); });
  await call('Runtime.enable');
  const evalJS = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception && r.exceptionDetails.exception.description || 'page error'); return r.result ? r.result.value : undefined; };

  // Wait until the live character exists AND its animation is actually playing.
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    try {
      const ok = await evalJS(`window.LyraApp && window.LyraApp.char() && window.LyraApp.char().anim && window.LyraApp.char().anim.currentAction && window.LyraApp.char().anim.currentAction.isRunning()`);
      if (ok) break;
    } catch {}
    await sleep(500);
  }
  const ready = await evalJS(`window.LyraApp && window.LyraApp.char() && window.LyraApp.char().anim && window.LyraApp.char().anim.currentAction && window.LyraApp.char().anim.currentAction.isRunning()`).catch(() => false);
  if (!ready) throw new Error('animation never started');
  console.log('animation active; recording…');

  // The demo: a few seconds of idle (the idle variant shifts after a while),
  // then one pass through thinking, writing and speaking.
  const plan = [['idle', 14000], ['thinking', 5000], ['writing', 5000], ['speaking', 7000]];
  const rect = await evalJS(`(() => { const r = document.getElementById('stage').getBoundingClientRect(); const d = window.devicePixelRatio || 1; return { x: Math.round(r.x * d), y: Math.round(r.y * d), width: Math.round(r.width * d), height: Math.round(r.height * d) }; })()`);
  console.log('stage clip:', JSON.stringify(rect));
  let n = 0; const boundaries = {}; const recStart = Date.now();
  for (const [state, ms] of plan) {
    boundaries[state] = n;
    await evalJS(`window.LyraApp.char().setState(${JSON.stringify(state)})`);
    const until = Date.now() + ms;
    while (Date.now() < until) {
      let img;
      try { img = await call('Page.captureScreenshot', { format: 'png', clip: { ...rect, scale: 1 } }); } catch (e) { if (n === 0) throw new Error(`capture failed: ${e.message}; detail=${e.detail}; clip ${JSON.stringify(rect)}`); continue; }
      fs.writeFileSync(path.join(framesDir, String(n).padStart(4, '0') + '.png'), Buffer.from(img.data, 'base64'));
      n++;
      await sleep(42); // ~24 fps
    }
  }
  ws.close(); kill();
  // The capture loop runs slower than 24 fps, so the video's framerate is set
  // to the REAL capture rate — the clip plays back at real speed.
  const fps = Math.max(10, Math.round(n / ((Date.now() - recStart) / 1000)));
  console.log(`captured ${n} frames at ${fps} fps`);

  // Burn each section's state name into the top of its frames (PIL — this
  // Mac's ffmpeg has no drawtext). Ranges come from the real frame counts.
  const secs = plan.map(([s], i) => ({ s, from: boundaries[s], to: i + 1 < plan.length ? boundaries[plan[i + 1][0]] : n }));
  const ranges = secs.map((b) => [b.from, b.to, b.s]);
  execFileSync('python3', ['-c', `
import sys, json, glob
from PIL import Image, ImageDraw, ImageFont
d = sys.argv[1]; ranges = json.loads(sys.argv[2])
try: font = ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', 18)
except Exception: font = ImageFont.load_default()
for f in sorted(glob.glob(d + '/[0-9][0-9][0-9][0-9].png')):
    i = int(f.split('/')[-1][:4])
    for a, b, label in ranges:
        if a <= i < b:
            im = Image.open(f).convert('RGB')
            dr = ImageDraw.Draw(im)
            w = dr.textlength(label, font=font)
            dr.rectangle([im.width/2 - w/2 - 8, 6, im.width/2 + w/2 + 8, 30], fill=(0, 0, 0))
            dr.text((im.width/2 - w/2, 9), label, font=font, fill='white')
            im.save(f)
            break
`, framesDir, JSON.stringify(ranges)]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', path.join(framesDir, '%04d.png'), '-vf', 'scale=iw*2:ih*2', '-pix_fmt', 'yuv420p', '-crf', '23', path.join(outDir, 'demo.mp4')]);
  console.log(`✓ demo video: ${path.join(outDir, 'demo.mp4')}`);
}

// Minimal websocket client (client→server frames are masked per RFC 6455 §5.3).
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

main().then(() => process.exit(0)).catch((e) => { console.error('qa-3d-demo failed:', e.message); kill(); process.exit(1); });
