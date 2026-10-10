// The in-app llama.cpp engine for "Help me choose": downloads a pinned
// llama-server build and a tested model, verifies both against pinned SHA-256s,
// runs the server on 127.0.0.1 only with a fresh key every launch, and registers
// it as the provider "Local (llama.cpp)". It runs only while Lyra is open.
// Rules: docs/SECURITY.md › "The local engine".
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { Readable } = require('stream');

const MANAGED_ID = 'local-llamacpp';
const MANAGED_NAME = 'Local (llama.cpp)';
const HEALTH_TIMEOUT_MS = 180000;

const execText = (cmd, args, opts = {}) => new Promise((resolve, reject) => execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts }, (e, out, err) => (e ? reject(Object.assign(e, { stderr: String(err || '') })) : resolve(String(out)))));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
async function sha256File(file) {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })) h.update(chunk);
  return h.digest('hex');
}
function dirBytes(p) {
  let n = 0; if (!fs.existsSync(p)) return 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) { const f = path.join(p, e.name); if (e.isDirectory()) n += dirBytes(f); else if (e.isFile()) n += fs.statSync(f).size; }
  return n;
}
function freePort() {
  return new Promise((resolve, reject) => { const s = net.createServer(); s.unref(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}
// The llama-server command line, shared with scripts/fitness.js so a row is
// tested with exactly the flags Lyra runs it with. Thinking stays on, with a
// budget: small reasoning models otherwise think until they run out of tokens
// and never answer.
const REASONING_BUDGET = 1024;
function serverArgs(row, { gguf, mmproj, port, keyFile }) {
  const a = ['-m', gguf, '--host', '127.0.0.1', '--port', String(port), '-c', String(row.context || 8192), '--jinja', '-ngl', '999', '--api-key-file', keyFile, '--alias', row.label, '--no-webui',
    '--reasoning-budget', String(row.reasoningBudget || REASONING_BUDGET), '--reasoning-budget-message', ' Okay, time to answer.'];
  if (mmproj) a.push('--mmproj', mmproj);
  return a;
}
const hfUrl = (repo, file) => `https://huggingface.co/${repo}/resolve/main/${encodeURIComponent(file)}`;

class LocalEngine {
  constructor({ userData, settings, matrix, emit, logs }) {
    this.userData = userData; this.settings = settings; this.matrix = matrix;
    this.emit = emit || (() => {}); this.logs = logs || { info() {}, warn() {}, error() {} };
    this.root = path.join(userData, 'runtime', 'llama.cpp');
    this.modelsDir = path.join(userData, 'models');
    this.logFile = path.join(userData, 'logs', 'llama-server.log');
    this.proc = null; this.watcher = null; this.port = null; this.busy = null; this.abort = null; this.lastError = null;
  }

  /* ---- what is pinned, and where it goes ---- */
  platformKey() { return `${process.platform}-${process.arch}`; }
  asset() { const e = this.matrix.engine || {}; return (e.assets || {})[this.platformKey()] || null; }
  supported() { return !!this.asset(); }
  row(id) { const m = (this.matrix.models || []).find((x) => x.id === id); if (!m) throw new Error(`Unknown model "${id}"`); return m; }
  tagDir(tag = this.matrix.engine.tag) { return path.join(this.root, tag); }
  stateFile() { return path.join(this.root, 'engine.json'); }
  pidFile() { return path.join(this.root, 'server.pid'); }
  keyFile() { return path.join(this.root, 'api-key'); }
  readState() { try { return JSON.parse(fs.readFileSync(this.stateFile(), 'utf8')); } catch { return null; } }
  writeState(patch) { fs.mkdirSync(this.root, { recursive: true }); const s = { ...(this.readState() || {}), ...patch }; fs.writeFileSync(this.stateFile(), JSON.stringify(s, null, 2)); return s; }
  binary(tag) { return path.join(this.tagDir(tag), process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'); }
  engineInstalled(tag = this.matrix.engine.tag) { return fs.existsSync(this.binary(tag)); }
  modelFile(m) { return path.join(this.modelsDir, m.file); }
  // Projector files share one name across repos, so they are prefixed with their model.
  mmprojFile(m) { return m.mmproj ? path.join(this.modelsDir, `${m.file.replace(/\.gguf$/i, '')}.${m.mmproj.file}`) : null; }
  modelInstalled(m) { return fs.existsSync(this.modelFile(m)) && (!m.mmproj || fs.existsSync(this.mmprojFile(m))); }

  // Screen 4's table: exactly what is downloaded, from where, how big, and where it lands.
  plan(id) {
    const a = this.asset(); if (!a) throw new Error('The in-app engine is coming soon for this system.');
    const m = this.row(id); const GB = 1024 ** 3; const tag = this.matrix.engine.tag;
    const rows = [];
    if (!this.engineInstalled()) rows.push({ item: `llama-server ${tag}`, what: `llama.cpp llama-server ${tag} (${this.platformKey()})`, from: a.url, bytes: Math.round((a.sizeMB || 1) * 1024 * 1024), to: this.tagDir(tag), sha256: a.sha256 });
    rows.push({ item: m.file, what: `${m.label} ${m.quant || ''} (${m.file})`.replace(/\s+\(/, ' ('), from: m.url || hfUrl(m.hf, m.file), bytes: Math.round(m.sizeGB * GB), to: this.modelsDir, sha256: m.sha256 });
    if (m.mmproj) rows.push({ item: `${m.label} vision projector`, what: `${m.label} vision projector (${m.mmproj.file})`, from: m.mmproj.url || hfUrl(m.hf, m.mmproj.file), bytes: Math.round(m.mmproj.sizeGB * GB), to: this.modelsDir, sha256: m.mmproj.sha256 });
    // When the engine is already there, the table still shows it, as installed.
    if (this.engineInstalled()) rows.unshift({ item: `llama-server ${tag}`, what: `llama.cpp llama-server ${tag} (${this.platformKey()})`, from: a.url, bytes: 0, to: this.tagDir(tag), sha256: a.sha256, installed: true });
    return rows.map((r) => ({ ...r, bytes: r.installed ? 0 : r.bytes || 1 }));
  }

  /* ---- downloads ---- */
  // Resumes a .part file with a Range request, then verifies the whole file.
  // A mismatch deletes the download: nothing unverified is kept or run.
  async download({ url, dest, sha256, item }) {
    if (!/^[0-9a-f]{64}$/.test(sha256 || '')) throw new Error(`${item}: no pinned SHA-256, refusing to download`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const part = `${dest}.part`; let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
    this.abort = new AbortController();
    const r = await fetch(url, { headers: have ? { range: `bytes=${have}-` } : {}, signal: this.abort.signal, redirect: 'follow' });
    if (!(r.status === 200 || r.status === 206)) throw new Error(`${item}: download failed (HTTP ${r.status})`);
    if (r.status === 200) have = 0; // the server ignored the range: start over
    const total = have + Number(r.headers.get('content-length') || 0);
    const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
    let received = have; const started = Date.now(); let lastEmit = 0;
    const report = (force) => { const now = Date.now(); if (!force && now - lastEmit < 250) return; lastEmit = now; const secs = Math.max(0.001, (now - started) / 1000); this.emit(null, 'engine', { phase: 'download', item, received, total, speed: Math.round((received - have) / secs) }); };
    try {
      for await (const chunk of Readable.fromWeb(r.body)) { if (!out.write(chunk)) await new Promise((res) => out.once('drain', res)); received += chunk.length; report(false); }
      await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
    } catch (e) { out.destroy(); throw e.name === 'AbortError' ? Object.assign(new Error(`${item}: download ${this.cancelled ? 'cancelled' : 'paused'}`), { paused: !this.cancelled }) : e; }
    report(true);
    this.emit(null, 'engine', { phase: 'verify', item });
    const got = await sha256File(part);
    if (got !== sha256) { fs.rmSync(part, { force: true }); this.logs.error('engine', `${item}: SHA-256 mismatch, download deleted`, `expected ${sha256}\ngot      ${got}\nfrom     ${url}`); throw new Error(`${item}: the SHA-256 does not match the pinned value, so the download was deleted and nothing was installed`); }
    fs.renameSync(part, dest);
    this.emit(null, 'engine', { phase: 'verified', item });
    this.logs.info('engine', `${item}: downloaded and verified`, `${url}\nsha256 ${got}`);
    return dest;
  }

  // Lists the archive before extracting: every entry must sit inside the one
  // release folder. Then extracts into a staging folder and checks symlinks too.
  async installEngine() {
    const a = this.asset(); if (!a) throw new Error('The in-app engine is coming soon for this system.');
    const tag = this.matrix.engine.tag; if (this.engineInstalled(tag)) return this.tagDir(tag);
    fs.mkdirSync(this.root, { recursive: true });
    const archive = path.join(this.root, a.file);
    const stage = path.join(this.root, `.extract-${tag}`);
    try {
      await this.download({ url: a.url, dest: archive, sha256: a.sha256, item: `llama-server ${tag}` });
      this.emit(null, 'engine', { phase: 'extract', item: `llama-server ${tag}` });
      const entries = (await execText('tar', ['-tzf', archive])).split('\n').map((x) => x.trim()).filter(Boolean);
      const top = `llama-${tag}`;
      const bad = entries.find((e) => path.isAbsolute(e) || e.split(/[\\/]/).includes('..') || !(e === `${top}/` || e === top || e.startsWith(`${top}/`)));
      if (bad) throw new Error(`the engine archive has an entry outside its folder (${bad}); refused`);
      fs.rmSync(stage, { recursive: true, force: true }); fs.mkdirSync(stage, { recursive: true });
      await execText('tar', ['-xzf', archive, '-C', stage]);
      const src = path.join(stage, top);
      for (const f of fs.readdirSync(src, { recursive: true })) {
        const p = path.join(src, f); const st = fs.lstatSync(p);
        if (st.isSymbolicLink()) { const target = path.resolve(path.dirname(p), fs.readlinkSync(p)); if (!target.startsWith(src + path.sep)) throw new Error(`the engine archive links outside its folder (${f}); refused`); }
      }
      if (!fs.existsSync(path.join(src, path.basename(this.binary(tag))))) throw new Error('the engine archive has no llama-server in it');
      // Only the files we just verified lose the download quarantine.
      if (process.platform === 'darwin') { try { await execText('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', src]); } catch {} }
      fs.renameSync(src, this.tagDir(tag));
      this.writeState({ tag });
      return this.tagDir(tag);
    } finally {
      fs.rmSync(stage, { recursive: true, force: true }); fs.rmSync(archive, { force: true });
    }
  }

  async installModel(id) {
    const m = this.row(id);
    if (!fs.existsSync(this.modelFile(m))) await this.download({ url: m.url || hfUrl(m.hf, m.file), dest: this.modelFile(m), sha256: m.sha256, item: m.file });
    if (m.mmproj && !fs.existsSync(this.mmprojFile(m))) await this.download({ url: m.mmproj.url || hfUrl(m.hf, m.mmproj.file), dest: this.mmprojFile(m), sha256: m.mmproj.sha256, item: `${m.label} vision projector` });
    return this.modelFile(m);
  }

  // Engine + model, as one job the UI can pause, resume and cancel.
  install(id) {
    if (this.busy) return this.busy;
    this.cancelled = false; this.lastError = null;
    this.busy = (async () => {
      try { await this.installEngine(); await this.installModel(id); this.writeState({ tag: this.matrix.engine.tag, model: id, autoStart: true }); this.emit(null, 'engine', { phase: 'installed', model: id }); return this.status(); }
      catch (e) { this.lastError = e.message; this.emit(null, 'engine', { phase: e.paused ? 'paused' : 'error', error: e.message }); throw e; }
      finally { this.busy = null; this.abort = null; }
    })();
    return this.busy;
  }
  pause() { this.cancelled = false; if (this.abort) this.abort.abort(); return true; }
  cancel() {
    this.cancelled = true; if (this.abort) this.abort.abort();
    // Partial downloads go too: cancel means nothing is left behind.
    for (const d of [this.root, this.modelsDir]) if (fs.existsSync(d)) for (const f of fs.readdirSync(d)) if (f.endsWith('.part')) fs.rmSync(path.join(d, f), { force: true });
    return true;
  }

  /* ---- the process ---- */
  args({ port = this.port || 0, keyFile = this.keyFile() } = {}) {
    const st = this.readState() || {}; const m = this.row(st.model);
    return serverArgs(m, { gguf: this.modelFile(m), mmproj: m.mmproj && fs.existsSync(this.mmprojFile(m)) ? this.mmprojFile(m) : null, port, keyFile });
  }

  // A server from an earlier run that Lyra did not get to stop (a crash, a
  // force quit): only killed if it really is our llama-server.
  async killOrphan() {
    let pid = null; try { pid = Number(fs.readFileSync(this.pidFile(), 'utf8').trim()); } catch {}
    if (!pid || !alive(pid) || (this.proc && this.proc.pid === pid)) { fs.rmSync(this.pidFile(), { force: true }); return false; }
    let cmd = ''; try { cmd = (await execText('ps', ['-p', String(pid), '-o', 'command='])).trim(); } catch {}
    if (!cmd.includes(this.root)) { fs.rmSync(this.pidFile(), { force: true }); return false; }
    try { process.kill(pid, 'SIGTERM'); } catch {}
    for (let i = 0; i < 20 && alive(pid); i++) await sleep(100);
    if (alive(pid)) try { process.kill(pid, 'SIGKILL'); } catch {}
    fs.rmSync(this.pidFile(), { force: true });
    this.logs.warn('engine', `Stopped a llama-server left over from an earlier run (pid ${pid})`);
    return true;
  }

  async start({ parentPid = process.pid } = {}) {
    if (this.proc) return this.status();
    const st = this.readState(); if (!st || !st.model) throw new Error('No local model is installed yet.');
    const m = this.row(st.model); const tag = st.tag || this.matrix.engine.tag;
    if (!this.engineInstalled(tag) || !this.modelInstalled(m)) throw new Error('The local engine or its model is missing; set it up again from Help me choose.');
    await this.killOrphan();
    this.port = await freePort();
    // A fresh key every launch, in a file only this user can read, never on
    // the command line where any process could see it with ps.
    const key = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(this.keyFile(), key, { mode: 0o600 }); fs.chmodSync(this.keyFile(), 0o600);
    fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
    const log = fs.openSync(this.logFile, 'a');
    fs.writeSync(log, `\n==== ${new Date().toISOString()} starting llama-server ${tag} on 127.0.0.1:${this.port} with ${m.file}\n`);
    const proc = spawn(this.binary(tag), this.args({ port: this.port }), { cwd: this.tagDir(tag), stdio: ['ignore', log, log], env: { ...process.env, LLAMA_ARG_HOST: '127.0.0.1' } });
    fs.closeSync(log);
    this.proc = proc; this.startedAt = Date.now();
    fs.writeFileSync(this.pidFile(), String(proc.pid));
    this.watch(parentPid, proc.pid);
    proc.on('exit', (code, sig) => {
      if (this.proc !== proc) return;
      this.proc = null; this.port = null; this.stopWatch(); fs.rmSync(this.pidFile(), { force: true });
      if (!this.stopping) { this.lastError = `llama-server stopped unexpectedly (${sig || `exit ${code}`}); see ${this.logFile}`; this.logs.error('engine', this.lastError); }
      this.emit(null, 'engine', { phase: 'stopped', status: this.status() });
    });
    await this.waitHealthy(proc);
    await this.register(key);
    this.logs.info('engine', `llama-server running on 127.0.0.1:${this.port} (${m.label})`);
    this.emit(null, 'engine', { phase: 'running', status: this.status() });
    return this.status();
  }

  async waitHealthy(proc) {
    const until = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < until) {
      if (this.proc !== proc) throw new Error(`llama-server exited while starting; see ${this.logFile}`);
      try { const r = await fetch(`http://127.0.0.1:${this.port}/health`, { signal: AbortSignal.timeout(1500) }); if (r.status === 200) return; } catch {}
      this.emit(null, 'engine', { phase: 'loading' });
      await sleep(250);
    }
    await this.stop(); throw new Error('llama-server did not become healthy in time');
  }

  // A tiny shell loop that outlives a crash of Lyra: when Lyra's pid is gone, it
  // stops the server (TERM, then KILL). It exits on its own once the server does.
  watch(parentPid, serverPid) {
    if (process.platform === 'win32') return;
    const script = 'while kill -0 "$1" 2>/dev/null && kill -0 "$2" 2>/dev/null; do sleep 1; done; if kill -0 "$2" 2>/dev/null; then kill "$2"; sleep 3; kill -9 "$2" 2>/dev/null; fi';
    this.watcher = spawn('/bin/sh', ['-c', script, 'lyra-engine-watchdog', String(parentPid), String(serverPid)], { detached: true, stdio: 'ignore' });
    this.watcher.unref();
  }
  stopWatch() { if (this.watcher) { try { process.kill(this.watcher.pid, 'SIGKILL'); } catch {} this.watcher = null; } }

  async register(key) {
    const s = this.settings.get(); const list = s.providers.list.filter((p) => p.id !== MANAGED_ID);
    list.push({ id: MANAGED_ID, name: MANAGED_NAME, runtime: 'llamacpp', detected: 'llama.cpp', endpoint: `http://127.0.0.1:${this.port}/v1`, apiKey: key, managed: true });
    await this.settings.set({ providers: { list } });
  }
  async unregister() {
    const s = this.settings.get(); const list = s.providers.list.filter((p) => p.id !== MANAGED_ID);
    if (list.length === s.providers.list.length) return;
    const patch = { providers: { list: list.length ? list : s.providers.list.filter((p) => p.id !== MANAGED_ID) } };
    const fb = list[0] ? list[0].id : null; const mp = {};
    for (const role of ['chat', 'vision']) if (s.model[role] && s.model[role].provider === MANAGED_ID && fb) mp[role] = { provider: fb, model: '' };
    if (Object.keys(mp).length) patch.model = mp;
    await this.settings.set(patch);
  }

  async stop() {
    this.stopping = true;
    try {
      const p = this.proc; this.stopWatch();
      if (p) {
        const gone = new Promise((r) => p.once('exit', r));
        try { p.kill('SIGTERM'); } catch {}
        await Promise.race([gone, sleep(5000)]);
        if (this.proc === p) { try { p.kill('SIGKILL'); } catch {} await Promise.race([gone, sleep(2000)]); }
      }
      this.proc = null; this.port = null; fs.rmSync(this.pidFile(), { force: true });
    } finally { this.stopping = false; }
    this.emit(null, 'engine', { phase: 'stopped', status: this.status() });
    return this.status();
  }
  // For app quit and organ disposal: no awaiting possible, so TERM now; the
  // watchdog finishes the job if the server does not go quietly.
  stopSync() { this.stopping = true; const p = this.proc; this.proc = null; if (p) { try { p.kill('SIGTERM'); } catch {} } }

  async update() {
    const st = this.readState() || {}; const tag = this.matrix.engine.tag;
    if (st.tag === tag && this.engineInstalled(tag)) return { updated: false, tag };
    const was = !!this.proc; if (was) await this.stop();
    await this.installEngine();
    const old = st.tag; this.writeState({ tag });
    if (old && old !== tag) fs.rmSync(this.tagDir(old), { recursive: true, force: true });
    if (was) await this.start();
    return { updated: true, tag, from: old || null };
  }

  async remove() {
    if (this.busy) { this.cancel(); try { await this.busy; } catch {} }
    await this.stop();
    const freedBytes = dirBytes(this.root) + dirBytes(this.modelsDir);
    fs.rmSync(this.root, { recursive: true, force: true }); fs.rmSync(this.modelsDir, { recursive: true, force: true });
    await this.unregister();
    this.logs.info('engine', `Removed the local engine and its models (${Math.round(freedBytes / 1024 / 1024)} MB freed)`);
    this.emit(null, 'engine', { phase: 'removed', freedBytes, status: this.status() });
    return { freedBytes };
  }

  async memoryMB() {
    if (!this.proc) return null;
    try { return Math.round(Number((await execText('ps', ['-p', String(this.proc.pid), '-o', 'rss='])).trim()) / 1024); } catch { return null; }
  }

  status() {
    const st = this.readState() || {}; let model = null;
    try { if (st.model) { const m = this.row(st.model); model = { id: m.id, label: m.label, quant: m.quant, file: m.file, context: m.context, vision: !!m.vision, installed: this.modelInstalled(m) }; } } catch {}
    return {
      supported: this.supported(), engineInstalled: !!st.tag && this.engineInstalled(st.tag), tag: st.tag || null, pinnedTag: this.matrix.engine ? this.matrix.engine.tag : null,
      model, running: !!this.proc, pid: this.proc ? this.proc.pid : null, port: this.port, host: '127.0.0.1', startedAt: this.proc ? this.startedAt : null,
      busy: !!this.busy, lastError: this.lastError, autoStart: st.autoStart !== false, folders: { engine: this.root, models: this.modelsDir }, log: this.logFile,
      diskBytes: dirBytes(this.root) + dirBytes(this.modelsDir),
    };
  }
}

module.exports = { LocalEngine, MANAGED_ID, MANAGED_NAME, sha256File, serverArgs };
