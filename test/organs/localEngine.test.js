// Story 03: the in-app llama.cpp engine. Everything runs against throwaway
// servers on 127.0.0.1 and a stand-in "llama-server" (a small Node script that
// speaks the same /health, /v1/models and --api-key protocol), so it needs no
// network, no GPU and no real model.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { tmpdir, cleanup } = require('../helpers/tmp');
const { LocalEngine, MANAGED_ID } = require('../../main/organs/localEngine');

test.after(cleanup);
const servers = [];
test.after(() => { for (const s of servers) s.close(); });
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const isWin = process.platform === 'win32';
// Any server a test starts is killed afterwards, even when the test fails, so a
// regression shows up as a failure and never as a hung run.
const started = new Set();
test.afterEach(() => { for (const pid of started) { try { process.kill(pid, 'SIGKILL'); } catch {} } started.clear(); });
const T = { timeout: 30000 };
const track = (st) => { started.add(st.pid); return st; };

// Serves files with Range support, and counts what it was asked for.
async function fileServer(files) {
  const seen = [];
  const s = http.createServer((req, res) => {
    const body = files[req.url]; seen.push({ url: req.url, range: req.headers.range || null });
    if (!body) { res.writeHead(404).end(); return; }
    const m = /bytes=(\d+)-/.exec(req.headers.range || '');
    if (m) { const from = Number(m[1]); res.writeHead(206, { 'content-length': body.length - from, 'content-range': `bytes ${from}-${body.length - 1}/${body.length}` }); res.end(body.subarray(from)); return; }
    res.writeHead(200, { 'content-length': body.length }); res.end(body);
  });
  servers.push(s); await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { url: (p) => `http://127.0.0.1:${s.address().port}${p}`, seen };
}

// The stand-in llama-server shared with the smoke test.
const FAKE_SERVER = fs.readFileSync(path.join(__dirname, '..', 'helpers', 'fake-llama-server.js'), 'utf8');

// A release tarball shaped like llama.cpp's: one top folder holding the binary.
function makeTarball(dir, tag, { evil = false } = {}) {
  const src = path.join(dir, 'src'); const top = path.join(src, `llama-${tag}`);
  fs.mkdirSync(top, { recursive: true });
  fs.writeFileSync(path.join(top, 'llama-server'), FAKE_SERVER, { mode: 0o755 });
  fs.writeFileSync(path.join(top, 'LICENSE'), 'MIT');
  const out = path.join(dir, `llama-${tag}.tar.gz`);
  // The evil one carries a second top-level entry next to the release folder.
  if (evil) fs.writeFileSync(path.join(dir, 'evil.txt'), 'x');
  execFileSync('tar', ['-czf', out, '-C', src, `llama-${tag}`, ...(evil ? ['-C', dir, 'evil.txt'] : [])]);
  return fs.readFileSync(out);
}

function fakeSettings(initial = {}) {
  let data = { providers: { list: [{ id: 'lmstudio', name: 'LM Studio', endpoint: 'http://localhost:1234/v1', apiKey: '' }] }, model: { chat: { provider: 'lmstudio', model: '' }, vision: { provider: 'lmstudio', model: '' } }, ...initial };
  const merge = (a, b) => { const o = { ...a }; for (const [k, v] of Object.entries(b)) o[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' ? merge(a[k], v) : v; return o; };
  return { get: () => data, set: async (p) => { data = merge(data, p); return data; } };
}

async function engineWith(files, matrixPatch = {}) {
  const userData = tmpdir(); const work = tmpdir();
  const tag = 'b1';
  const tarball = makeTarball(work, tag);
  const gguf = Buffer.from('GGUF' + 'x'.repeat(200000));
  const srv = await fileServer({ '/engine.tgz': tarball, '/model.gguf': gguf, ...(files ? files(tarball, gguf) : {}) });
  const matrix = {
    engine: { tag, assets: { [`${process.platform}-${process.arch}`]: { file: 'engine.tgz', url: srv.url('/engine.tgz'), sha256: sha(tarball) } } },
    models: [{ id: 'tiny', label: 'Tiny', hf: 'test/tiny', file: 'model.gguf', url: srv.url('/model.gguf'), sha256: sha(gguf), sizeGB: 0.0002, context: 4096 }],
    ...matrixPatch,
  };
  const events = [];
  const settings = fakeSettings();
  const eng = new LocalEngine({ userData, settings, matrix, emit: (c, t, p) => events.push({ type: t, ...p }), logs: { info() {}, warn() {}, error() {} } });
  return { eng, userData, srv, tarball, gguf, matrix, events, settings };
}

test('the transparency table says what, from where, how big and where it goes', async () => {
  const { eng, userData } = await engineWith();
  const rows = eng.plan('tiny');
  assert.equal(rows.length, 2);
  assert.match(rows[0].what, /llama-server b1/); assert.match(rows[0].from, /^http:\/\/127\.0\.0\.1:\d+\/engine\.tgz$/);
  assert.equal(rows[0].to, path.join(userData, 'runtime', 'llama.cpp', 'b1'));
  assert.equal(rows[1].to, path.join(userData, 'models'));
  assert.ok(rows.every((r) => r.bytes > 0));
});

test('an engine download with the wrong SHA-256 is refused and deleted, and nothing is extracted', async () => {
  const { eng, userData, matrix } = await engineWith();
  matrix.engine.assets[`${process.platform}-${process.arch}`].sha256 = 'f'.repeat(64);
  await assert.rejects(eng.installEngine(), /SHA-256/);
  const rt = path.join(userData, 'runtime', 'llama.cpp');
  const left = fs.existsSync(rt) ? fs.readdirSync(rt, { recursive: true }) : [];
  assert.deepEqual(left, [], `left behind: ${left.join(', ')}`);
  assert.equal(eng.status().engineInstalled, false);
});

test('a model download with the wrong SHA-256 is refused and deleted', async () => {
  const { eng, userData, matrix } = await engineWith();
  matrix.models[0].sha256 = '0'.repeat(64);
  await assert.rejects(eng.installModel('tiny'), /SHA-256/);
  const left = fs.existsSync(path.join(userData, 'models')) ? fs.readdirSync(path.join(userData, 'models')) : [];
  assert.deepEqual(left, []);
});

test('an archive that tries to write outside its folder is refused', { skip: isWin, ...T }, async () => {
  const work = tmpdir();
  const evil = makeTarball(work, 'b1', { evil: true });
  const { eng, userData, matrix } = await engineWith(() => ({ '/engine.tgz': evil }));
  matrix.engine.assets[`${process.platform}-${process.arch}`].sha256 = sha(evil);
  await assert.rejects(eng.installEngine(), /outside/);
  assert.equal(fs.existsSync(path.join(userData, 'runtime', 'llama.cpp', 'b1')), false);
});

test('a paused download resumes with a Range request and still verifies', async () => {
  const { eng, srv, userData, gguf } = await engineWith();
  const part = path.join(userData, 'models', 'model.gguf.part');
  fs.mkdirSync(path.dirname(part), { recursive: true }); fs.writeFileSync(part, gguf.subarray(0, 50000));
  await eng.installModel('tiny');
  assert.ok(srv.seen.some((s) => s.url === '/model.gguf' && s.range === 'bytes=50000-'), 'resumed where the partial file ended');
  assert.deepEqual(fs.readFileSync(path.join(userData, 'models', 'model.gguf')), gguf);
  assert.equal(fs.existsSync(part), false);
});

test('progress events report bytes, total and speed', async () => {
  const { eng, events } = await engineWith();
  await eng.installModel('tiny');
  const p = events.filter((e) => e.type === 'engine' && e.phase === 'download');
  assert.ok(p.length >= 1);
  const last = p[p.length - 1];
  assert.equal(last.received, last.total); assert.ok(last.total > 0); assert.equal(typeof last.speed, 'number');
});

test('lifecycle: starts on 127.0.0.1 with a per-launch key, registers the provider, and stops with no orphan', { skip: isWin, ...T }, async () => {
  const { eng, settings } = await engineWith();
  await eng.install('tiny');
  const st = track(await eng.start());
  try {
    assert.equal(st.running, true); assert.ok(st.port > 0); assert.ok(st.pid > 0);
    const health = await fetch(`http://127.0.0.1:${st.port}/health`); assert.equal(health.status, 200);
    const noKey = await fetch(`http://127.0.0.1:${st.port}/v1/models`); assert.equal(noKey.status, 401, 'requests without the per-launch key are refused');
    const prov = settings.get().providers.list.find((p) => p.id === MANAGED_ID);
    assert.ok(prov, 'the engine shows up as a provider');
    assert.equal(prov.name, 'Local (llama.cpp)'); assert.equal(prov.endpoint, `http://127.0.0.1:${st.port}/v1`);
    const withKey = await fetch(`${prov.endpoint}/models`, { headers: { authorization: `Bearer ${prov.apiKey}` } }); assert.equal(withKey.status, 200);
    try {
      const lsof = execFileSync('lsof', ['-nP', '-a', '-p', String(st.pid), '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' });
      assert.match(lsof, new RegExp(`127\\.0\\.0\\.1:${st.port} \\(LISTEN\\)`)); assert.doesNotMatch(lsof, /\*:\d+ \(LISTEN\)/, 'never on all interfaces');
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    assert.doesNotMatch(eng.args().join(' '), new RegExp(prov.apiKey), 'the key is not on the command line where ps can read it');
  } finally { await eng.stop(); }
  assert.equal(eng.status().running, false);
  assert.throws(() => process.kill(st.pid, 0), /ESRCH/, 'the server process is gone');
});

test('a server left behind by a crash is cleaned up on the next start', { skip: isWin, ...T }, async () => {
  const { eng, userData, matrix, settings } = await engineWith();
  await eng.install('tiny');
  const first = track(await eng.start());
  // Simulate a crash of Lyra: the engine object is dropped without stop().
  const again = new LocalEngine({ userData, settings, matrix, emit() {}, logs: { info() {}, warn() {}, error() {} } });
  const second = track(await again.start());
  try {
    assert.throws(() => process.kill(first.pid, 0), /ESRCH/, 'the orphan was killed');
    assert.notEqual(second.pid, first.pid);
  } finally { await again.stop(); }
});

test('the watchdog stops the server when Lyra itself dies without cleaning up', { skip: isWin, ...T }, async () => {
  const { eng } = await engineWith();
  await eng.install('tiny');
  // A stand-in for the Lyra process: the watchdog follows this pid.
  const lyra = require('child_process').spawn('sleep', ['60'], { stdio: 'ignore' });
  const st = track(await eng.start({ parentPid: lyra.pid }));
  lyra.kill('SIGKILL');
  let alive = true;
  for (let i = 0; i < 40 && alive; i++) { await new Promise((r) => setTimeout(r, 250)); try { process.kill(st.pid, 0); } catch { alive = false; } }
  assert.equal(alive, false, 'llama-server outlived the app');
  await eng.stop();
});

test('remove deletes the engine and the models, reports the space freed, and the provider disappears', { skip: isWin, ...T }, async () => {
  const { eng, userData, settings, gguf } = await engineWith();
  await eng.install('tiny');
  await eng.start();
  await settings.set({ model: { chat: { provider: MANAGED_ID, model: '' } } });
  const r = await eng.remove();
  assert.ok(r.freedBytes >= gguf.length);
  assert.equal(fs.existsSync(path.join(userData, 'runtime', 'llama.cpp')), false);
  assert.equal(fs.existsSync(path.join(userData, 'models')), false);
  assert.equal(settings.get().providers.list.some((p) => p.id === MANAGED_ID), false);
  assert.equal(settings.get().model.chat.provider, 'lmstudio', 'the chat falls back to a provider that still exists');
  assert.equal(eng.status().running, false);
});
