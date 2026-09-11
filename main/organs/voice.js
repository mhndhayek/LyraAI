// Voice: KittenTTS / custom TTS endpoint / macOS `say` fallback, and Whisper STT
// through the Python sidecar in voice/.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { id } = require('./util');

// Text as it should be spoken: no code blocks, markdown marks, links, emoji or shortcodes.
function speakable(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' code block omitted. ')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/[*_#>`~]/g, '')
    .replace(/:[a-z0-9_+-]+:/gi, ' ')
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\u200d\ufe0f\u20e3]/gu, ' ')
    .replace(/[\u2600-\u27bf\u2b00-\u2bff\u2190-\u21ff\u2300-\u23ff\u2500-\u25ff\u2700-\u27bf]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
// Anything past this is not spoken; long replies are chunked by the sidecar, but a
// runaway answer should not turn into a twenty-minute monologue.
speakable.LIMIT = 8000;

class Voice {
  constructor({ settings, appPath, userData, emit, logs }) {
    this.settings = settings; this.appPath = appPath; this.emit = emit;
    this.logs = logs || { error() {}, warn() {}, info() {} };
    this.errTail = ''; this.warmed = false; this.warming = null;
    this.userData = userData; this.dir = path.join(userData, 'media', 'tts'); fs.mkdirSync(this.dir, { recursive: true });
    this.proc = null; this.pending = new Map(); this.seq = 0; this.ready = null; this.buf = ''; this.last = null; this.installing = null;
  }
  // The sidecar's Python: an explicit setting, the dev checkout's venv, or a venv under the app data folder.
  unpacked(p) { return p.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`); }
  candidates() {
    const s = this.settings.get().voice; let sourceDir = null;
    try { sourceDir = require(path.join(this.appPath, 'package.json')).sourceDir || null; } catch {}
    return [s.sidecarPython, path.join(this.userData, 'voice', '.venv', 'bin', 'python'), path.join(this.appPath, 'voice', '.venv', 'bin', 'python'), sourceDir && path.join(sourceDir, 'voice', '.venv', 'bin', 'python')].filter(Boolean).map((p) => this.unpacked(p));
  }
  python() { return this.candidates().find((p) => fs.existsSync(p)) || null; }
  status() { return { available: !!this.python(), python: this.python(), candidates: this.candidates(), last: this.last, installing: !!this.installing }; }
  // One-click install of the sidecar environment under the app data folder (works for the packaged app).
  setup() {
    if (this.installing) return this.installing;
    const target = path.join(this.userData, 'voice', '.venv'); fs.mkdirSync(path.dirname(target), { recursive: true });
    const script = this.unpacked(path.join(this.appPath, 'voice', 'setup.sh'));
    this.emit(null, 'notice', { text: 'Installing the voice engine (KittenTTS + Whisper)… this takes a few minutes.' });
    this.installing = new Promise((resolve) => {
      const env = { ...process.env, PATH: ['/opt/homebrew/bin', '/usr/local/bin', path.join(require('os').homedir(), '.local', 'bin'), ...(process.env.PATH || '').split(':')].join(':') };
      const p = spawn('/bin/sh', [script, target], { env, cwd: path.dirname(script) }); let out = '';
      p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
      p.on('exit', (code) => { this.installing = null; const ok = code === 0 && fs.existsSync(path.join(target, 'bin', 'python')); this.stop(); this.emit(null, 'notice', { text: ok ? 'Voice engine installed. Replies now use KittenTTS.' : `Voice engine install failed (exit ${code}). ${out.slice(-300)}` }); this.emit(null, 'voice', { available: ok }); resolve({ ok, code, log: out.slice(-4000) }); });
    });
    return this.installing;
  }
  serverScript() { return this.unpacked(path.join(this.appPath, 'voice', 'server.py')); }
  available() { return !!this.python(); }
  // Kills the sidecar and clears state so the next call starts a fresh one.
  kill(why) {
    if (this.killTimer) { clearTimeout(this.killTimer); this.killTimer = null; }
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(why || 'voice sidecar stopped')); }
    this.pending.clear();
    try { this.proc && this.proc.kill('SIGKILL'); } catch {}
    this.proc = null; this.ready = null; this.buf = ''; this.warmed = false;
  }
  ensure() {
    if (this.ready) return this.ready;
    const py = this.python();
    if (!py) return Promise.reject(new Error('Voice sidecar not installed. Run: npm run voice:setup'));
    // Apps launched from Finder get a bare PATH; espeak-ng (needed by KittenTTS) lives under Homebrew.
    const extra = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin'].filter((d) => fs.existsSync(d));
    const env = { ...process.env, PYTHONUNBUFFERED: '1', PATH: [...extra, ...(process.env.PATH || '').split(':')].filter((x, i, a) => x && a.indexOf(x) === i).join(':') };
    const lib = ['/opt/homebrew/lib/libespeak-ng.dylib', '/usr/local/lib/libespeak-ng.dylib'].find((f) => fs.existsSync(f)); if (lib && !env.PHONEMIZER_ESPEAK_LIBRARY) env.PHONEMIZER_ESPEAK_LIBRARY = lib;
    const script = this.serverScript(); let errTail = '';
    this.logs.info('voice', `Starting the voice engine: ${path.basename(py)}`, `${py}\n${script}`);
    this.proc = spawn(py, [script], { stdio: ['pipe', 'pipe', 'pipe'], env, cwd: this.userData });
    this.ready = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`did not start within 30 s (${py}): ${errTail.trim().slice(-300) || 'no output'}`)), 30000);
      this.proc.on('error', (e) => { clearTimeout(t); this.proc = null; this.ready = null; reject(new Error(`Voice sidecar failed to launch: ${e.message}`)); });
      this.proc.stdout.on('data', (d) => {
        this.buf += d.toString();
        let i;
        while ((i = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
          if (!line) continue;
          let j; try { j = JSON.parse(line); } catch { continue; }
          if (j.ready) { clearTimeout(t); resolve(); continue; }
          const p = this.pending.get(j.id); if (!p) continue;
          this.pending.delete(j.id); clearTimeout(p.timer);
          j.ok ? p.resolve(j) : p.reject(new Error(j.error));
        }
      });
      this.proc.stderr.on('data', (d) => { const s = d.toString(); errTail = (errTail + s).slice(-2000); this.errTail = errTail; if (/error|traceback/i.test(s)) this.logs.warn('voice', 'Voice engine reported a problem', s.trim().slice(-600)); });
      this.proc.on('exit', (code) => { clearTimeout(t); if (code) this.logs.error('voice', `Voice engine stopped (exit ${code})`, errTail.trim().slice(-800)); this.proc = null; this.ready = null; this.warmed = false; for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(`voice engine stopped (exit ${code})`)); } this.pending.clear(); });
    }).catch((e) => { this.kill(); throw new Error(`Voice engine ${e.message}`); });
    return this.ready;
  }
  // Loads the models in the background so the first spoken reply is not slow.
  warm() {
    if (this.warmed || this.warming || !this.available()) return this.warming || Promise.resolve(false);
    this.warming = this.call('warmup', { model: this.settings.get().voice.kittenModel }, 900000)
      .then(() => { this.warmed = true; this.logs.info('voice', 'Voice engine ready'); return true; })
      .catch((e) => { this.logs.error('voice', `Voice engine could not load its model: ${e.message}`, this.errTail.slice(-800)); return false; })
      .finally(() => { this.warming = null; });
    return this.warming;
  }
  async call(cmd, params, timeoutMs = 120000) {
    await this.ensure();
    const reqId = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(reqId); const hint = this.warmed ? '' : ' (the model may still be downloading on first use)'; reject(new Error(`${cmd} timed out after ${Math.round(timeoutMs / 1000)} s${hint}`)); }, timeoutMs);
      this.pending.set(reqId, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ id: reqId, cmd, ...params }) + '\n');
    });
  }
  outPath(ext = 'wav') { return path.join(this.dir, `${Date.now()}-${id()}.${ext}`); }

  async tts(text) {
    const v = this.settings.get().voice;
    let clean = Voice.speakable(text);
    if (!clean) return null;
    if (clean.length > speakable.LIMIT) {
      this.logs.warn('voice', `Reply too long to speak in full: said the first ${speakable.LIMIT} of ${clean.length} characters`);
      this.emit(null, 'notice', { text: `That reply was too long to read out in full; ${Math.round((speakable.LIMIT / clean.length) * 100)}% of it was spoken.` });
      clean = clean.slice(0, speakable.LIMIT);
    }
    if (v.engine === 'custom') { const r = await this.customTts(clean, v); this.last = { engine: 'custom', voice: v.customVoice, at: Date.now() }; return r; }
    const started = Date.now();
    try {
      const out = this.outPath('wav');
      // Long replies take longer, and the very first call may still be fetching the model.
      const timeout = this.warmed ? Math.max(180000, clean.length * 300) : 900000;
      if (!this.warmed && !this.warming) this.emit(null, 'notice', { text: 'Loading the voice model for the first time; this reply may take a minute to speak.' });
      const r = await this.call('tts', { text: clean, voice: v.voice, model: v.kittenModel, out }, timeout);
      this.warmed = true;
      this.last = { engine: 'kitten', voice: `${v.voice} (${r.voice})`, at: Date.now(), ms: Date.now() - started, chunks: r.chunks, seconds: r.seconds };
      this.logs.info('voice', `Spoke ${clean.length} chars with KittenTTS (${v.voice})`, `${r.chunks} chunk(s), ${r.seconds}s of audio, ${Date.now() - started} ms`);
      return { path: r.path, engine: 'kitten', voice: r.voice };
    } catch (e) {
      this.last = { engine: 'say', voice: 'macOS system voice', error: e.message, at: Date.now(), ms: Date.now() - started };
      this.logs.error('voice', `KittenTTS failed, fell back to the macOS voice: ${e.message}`, `voice=${v.voice} model=${v.kittenModel} chars=${clean.length} python=${this.python() || 'not found'}\nlast output from the engine:\n${(this.errTail || '(none)').slice(-800)}`);
      this.emit(null, 'notice', { text: `KittenTTS failed (${e.message.slice(0, 140)}); used the macOS voice. Settings › Recovery › Logs has the details.` });
      try { return await this.sayFallback(clean); } catch (e2) { this.logs.error('voice', `The macOS voice also failed: ${e2.message}`); throw e2; }
    }
  }
  sayFallback(text) {
    const out = this.outPath('wav');
    return new Promise((resolve, reject) => {
      execFile('/usr/bin/say', ['--file-format=WAVE', '--data-format=LEI16@22050', '-o', out, text], { timeout: 60000 }, (err) => err ? reject(err) : resolve({ path: out, engine: 'say' }));
    });
  }
  async customTts(text, v) {
    const r = await fetch(`${v.customEndpoint.replace(/\/$/, '')}/audio/speech`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: v.customModel, input: text, voice: v.customVoice, response_format: 'wav' }), signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`TTS endpoint ${r.status}`);
    const ct = r.headers.get('content-type') || '';
    const out = this.outPath(ct.includes('mpeg') ? 'mp3' : 'wav');
    fs.writeFileSync(out, Buffer.from(await r.arrayBuffer()));
    return { path: out, engine: 'custom' };
  }
  async stt(filePath) {
    const v = this.settings.get().voice;
    try {
      const r = await this.call('stt', { path: filePath, model: v.sttModel }, 300000);
      this.logs.info('voice', `Transcribed a voice message (${r.text.length} chars)`);
      return { text: r.text, language: r.language };
    } catch (e) { this.logs.error('voice', `Transcription failed: ${e.message}`, `model=${v.sttModel}\n${(this.errTail || '').slice(-600)}`); throw e; }
  }
  async voices() {
    try { const r = await this.call('voices', { model: this.settings.get().voice.kittenModel }, 120000); return r.voices; }
    catch { return ['Rosie', 'Bella', 'Jasmine', 'Luna', 'Jasper', 'Leo', 'Ben', 'Axel']; }
  }
  stop() { this.kill('voice engine stopped'); }
}
Voice.speakable = speakable;
module.exports = { Voice, speakable };
