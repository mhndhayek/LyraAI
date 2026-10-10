#!/usr/bin/env node
// Fitness test for docs/recommendations.json. A model row only ships after this
// passes on a real machine: it starts the pinned llama-server with the row's
// model (the same flags Lyra uses), runs five scripted turns, measures speed,
// and with --write records fitness, tokPerSec, testedWith and testedOn.
//
//   node scripts/fitness.js --engine <dir with llama-server> --models <dir with the .gguf files> [--only id,id] [--write]
//
// Turns: 1 chat · 2 one tool call · 3 a tool call with JSON arguments ·
// 4 recall from a 4k-token context · 5 vision (only if the row has an mmproj).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const net = require('net');

const ROOT = path.join(__dirname, '..');
const MATRIX = path.join(ROOT, 'docs', 'recommendations.json');
const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const flag = (k) => process.argv.includes(`--${k}`);
const engineDir = arg('engine'); const modelsDir = arg('models');
if (!engineDir || !modelsDir) { console.error('usage: node scripts/fitness.js --engine <dir> --models <dir> [--only id,id] [--write]'); process.exit(2); }
const only = arg('only') ? arg('only').split(',') : null;
const matrix = JSON.parse(fs.readFileSync(MATRIX, 'utf8'));
const pkg = require(path.join(ROOT, 'package.json'));
const { serverArgs } = require(path.join(ROOT, 'main', 'organs', 'localEngine'));

const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function machine() {
  if (process.platform !== 'darwin') return `${os.type()} ${os.arch()}, ${Math.round(os.totalmem() / 2 ** 30)} GB`;
  const chip = (() => { try { return execFileSync('sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8' }).trim(); } catch { return 'Apple silicon'; } })();
  return `MacBook Pro (${chip}, ${Math.round(os.totalmem() / 2 ** 30)} GB)`;
}

// Where a row's files are, under --models: the bare name, or the prefixed
// projector name Lyra uses, or a projector in a sub-folder named after the size.
function findFile(name, alsoTry = []) { for (const n of [name, ...alsoTry]) { const p = path.join(modelsDir, n); if (fs.existsSync(p)) return p; } return null; }

const TOOLS = [
  { type: 'function', function: { name: 'get_weather', description: 'Current weather for a city.', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } },
  { type: 'function', function: { name: 'create_event', description: 'Put an event in the calendar.', parameters: { type: 'object', properties: { title: { type: 'string' }, date: { type: 'string', description: 'YYYY-MM-DD' }, attendees: { type: 'array', items: { type: 'string' } }, reminderMinutes: { type: 'integer' } }, required: ['title', 'date', 'attendees', 'reminderMinutes'] } } },
];

async function chat(base, key, body) {
  const t0 = Date.now();
  const r = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ temperature: 0.7, max_tokens: 3072, ...body }), signal: AbortSignal.timeout(300000) });
  const j = await r.json(); if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  const msg = j.choices[0].message; const tm = j.timings || {};
  return { msg, text: (msg.content || '').trim(), tools: msg.tool_calls || [], ms: Date.now() - t0, tokPerSec: tm.predicted_per_second || null, promptTokens: j.usage && j.usage.prompt_tokens };
}

// A 4k-token haystack with one fact in the middle.
function haystack() {
  const lines = []; const words = ['amber', 'river', 'lantern', 'meadow', 'copper', 'harbor', 'violet', 'orchard', 'granite', 'willow'];
  for (let i = 0; i < 260; i++) lines.push(`Log ${i}: the ${words[i % 10]} crew moved ${(i * 37) % 101} crates past the ${words[(i * 3) % 10]} gate before noon.`);
  lines.splice(130, 0, 'Note: the vault code for the north tower is 7316-KESTREL.');
  return lines.join('\n');
}

// A tiny PNG made on the spot: a red square on white. Encoded by hand so the
// script has no image dependency.
function redSquarePng() {
  const w = 64, h = 64; const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; const red = x > 12 && x < 52 && y > 12 && y < 52; raw[o] = 255; raw[o + 1] = red ? 0 : 255; raw[o + 2] = red ? 0 : 255; } }
  const zlib = require('zlib'); const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function testRow(row) {
  const gguf = findFile(row.file); if (!gguf) return { skipped: `missing ${row.file}` };
  const mmproj = row.mmproj ? findFile(`${row.file.replace(/\.gguf$/i, '')}.${row.mmproj.file}`, [`mm${row.label.match(/(\d+)B/)[1]}/${row.mmproj.file}`]) : null;
  if (row.mmproj && !mmproj) return { skipped: `missing projector for ${row.file}` };
  const port = await freePort(); const key = crypto.randomBytes(16).toString('hex');
  const keyFile = path.join(os.tmpdir(), `fitness-key-${port}`); fs.writeFileSync(keyFile, key, { mode: 0o600 });
  const args = serverArgs(row, { gguf, mmproj, port, keyFile });
  const logFile = path.join(os.tmpdir(), `fitness-${row.id}.log`); const log = fs.openSync(logFile, 'w');
  const proc = spawn(path.join(engineDir, 'llama-server'), args, { cwd: engineDir, stdio: ['ignore', log, log] });
  const base = `http://127.0.0.1:${port}`; const turns = []; const speeds = [];
  try {
    const t0 = Date.now();
    for (;;) { if (proc.exitCode !== null) throw new Error(`llama-server exited (${proc.exitCode}); see ${logFile}`); try { if ((await fetch(`${base}/health`)).status === 200) break; } catch {} if (Date.now() - t0 > 300000) throw new Error('not healthy after 5 min'); await sleep(300); }
    const loadMs = Date.now() - t0;
    const turn = async (name, fn) => { try { const r = await fn(); turns.push({ name, pass: r.pass, note: r.note }); if (r.tps) speeds.push(r.tps); } catch (e) { turns.push({ name, pass: false, note: e.message.slice(0, 160) }); } };
    await turn('chat', async () => { const r = await chat(base, key, { messages: [{ role: 'user', content: 'In two or three sentences, tell me why the sky is blue.' }] }); return { pass: r.text.length > 40 && /scatter|wavelength|light/i.test(r.text), note: `${r.text.length} chars`, tps: r.tokPerSec }; });
    await turn('tool call', async () => { const r = await chat(base, key, { messages: [{ role: 'user', content: 'What is the weather in Lisbon right now? Use the tool.' }], tools: TOOLS, tool_choice: 'auto' }); const c = r.tools[0]; const a = c ? JSON.parse(c.function.arguments || '{}') : {}; return { pass: !!c && c.function.name === 'get_weather' && /lisbon/i.test(a.city || ''), note: c ? `${c.function.name}(${c.function.arguments})` : `no tool call: ${r.text.slice(0, 80)}`, tps: r.tokPerSec }; });
    await turn('JSON-args tool call', async () => { const r = await chat(base, key, { messages: [{ role: 'user', content: 'Book "Design review" on 2026-11-03 with ana@example.com and raj@example.com, remind me 15 minutes before.' }], tools: TOOLS }); const c = r.tools.find((x) => x.function.name === 'create_event'); let a = {}; try { a = JSON.parse(c.function.arguments); } catch {} return { pass: !!c && a.date === '2026-11-03' && Array.isArray(a.attendees) && a.attendees.length === 2 && Number(a.reminderMinutes) === 15 && /design review/i.test(a.title || ''), note: c ? c.function.arguments : 'no create_event call', tps: r.tokPerSec }; });
    await turn('4k-context recall', async () => { const r = await chat(base, key, { messages: [{ role: 'system', content: 'Answer from the document only. Reply with the code alone.' }, { role: 'user', content: `${haystack()}\n\nWhat is the vault code for the north tower?` }] }); return { pass: /7316-KESTREL/i.test(r.text), note: `${r.promptTokens} prompt tokens → ${r.text.slice(0, 40)}`, tps: r.tokPerSec }; });
    if (row.vision) await turn('vision', async () => { const img = `data:image/png;base64,${redSquarePng().toString('base64')}`; const r = await chat(base, key, { messages: [{ role: 'user', content: [{ type: 'text', text: 'What colour is the square in this picture? One word.' }, { type: 'image_url', image_url: { url: img } }] }] }); return { pass: /red/i.test(r.text), note: r.text.slice(0, 40), tps: r.tokPerSec }; });
    const passed = turns.filter((t) => t.pass).length;
    const tokPerSec = speeds.length ? Math.round(speeds.reduce((a, b) => a + b, 0) / speeds.length) : 0;
    return { turns, fitness: `${passed}/${turns.length}`, ok: passed === turns.length, tokPerSec, loadMs };
  } finally {
    proc.kill('SIGTERM'); await Promise.race([new Promise((r) => proc.once('exit', r)), sleep(5000)]); if (proc.exitCode === null) proc.kill('SIGKILL');
    fs.rmSync(keyFile, { force: true });
  }
}

(async () => {
  const testedOn = machine(); const results = {}; const done = new Map();
  for (const row of matrix.models) {
    if (only && !only.includes(row.id)) continue;
    // Rows that share a file and context are one test: run it once.
    const sig = `${row.file}|${row.context}|${!!row.vision}`;
    process.stdout.write(`\n▶ ${row.id}: ${row.label} ${row.quant} (${row.file}, ${row.context} ctx)\n`);
    const r = done.get(sig) || await testRow(row); done.set(sig, r); results[row.id] = r;
    if (r.skipped) { console.log(`  – skipped: ${r.skipped}`); continue; }
    for (const t of r.turns) console.log(`  ${t.pass ? '✓' : '✗'} ${t.name.padEnd(20)} ${t.note}`);
    console.log(`  = ${r.fitness} · ${r.tokPerSec} tok/s · loaded in ${(r.loadMs / 1000).toFixed(1)} s`);
  }
  const failed = Object.entries(results).filter(([, r]) => !r.skipped && !r.ok);
  if (flag('write')) {
    for (const row of matrix.models) { const r = results[row.id]; if (!r || r.skipped || !r.ok) continue; Object.assign(row, { fitness: r.fitness, tokPerSec: r.tokPerSec, testedWith: pkg.version, testedOn, testedAt: new Date().toISOString().slice(0, 10), engineTag: matrix.engine.tag }); }
    fs.writeFileSync(MATRIX, JSON.stringify(matrix, null, 2) + '\n');
    console.log(`\nWrote results for ${Object.values(results).filter((r) => r.ok).length} row(s) to docs/recommendations.json`);
  }
  console.log(failed.length ? `\n✗ ${failed.length} row(s) failed: ${failed.map(([id]) => id).join(', ')}` : '\n✓ every tested row passed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
