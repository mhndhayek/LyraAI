// Voice: speaking and listening through a provider (story 04). The on-device
// engine is KittenTTS + Whisper in the Python sidecar under voice/; any other
// server is a provider in voice/providers/ that is detected from its URL. When
// a provider fails, speech falls back to the on-device voice, then to macOS `say`.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { id } = require('./util');
const providers = require('./voice/providers');

// Text as it should be spoken: no code blocks, markdown marks, links, emoji or shortcodes.
function speakable(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' code block omitted. ')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/[*_#>`~]/g, '')
    .replace(/:[a-z0-9_+-]+:/gi, ' ')
    // eslint-disable-next-line no-misleading-character-class -- every part of an emoji sequence, joiners included, is meant to go
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\u200d\ufe0f\u20e3]/gu, ' ')
    .replace(/[\u2600-\u27bf\u2b00-\u2bff\u2190-\u21ff\u2300-\u23ff\u2500-\u25ff\u2700-\u27bf]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
// Anything past this is not spoken; long replies are chunked by the sidecar, but a
// runaway answer should not turn into a twenty-minute monologue.
speakable.LIMIT = 8000;
// The name to show for a provider: what Connect detected (e.g. "OpenAI" for the
// OpenAI-compatible provider), but only if that detection was for this provider.
// A leftover one from a different server would mislabel it.
const labelOf = (detected, provider) => (detected && detected.label && (!detected.id || detected.id === provider.id) ? detected.label : provider.label);

class Voice {
  constructor({ settings, appPath, userData, emit, logs }) {
    this.settings = settings; this.appPath = appPath; this.emit = emit;
    this.logs = logs || { error() {}, warn() {}, info() {} };
    this.errTail = ''; this.warmed = false; this.warming = null;
    this.userData = userData; this.dir = path.join(userData, 'media', 'tts'); fs.mkdirSync(this.dir, { recursive: true });
    this.proc = null; this.pending = new Map(); this.seq = 0; this.ready = null; this.buf = ''; this.last = null; this.installing = null;
    this.capsCache = new Map();
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

  // ---- providers ----
  // The settings for one role: 'tts' (speaking) or 'stt' (listening).
  roleSettings(role) {
    const v = this.settings.get().voice;
    return role === 'stt'
      ? { provider: v.sttProvider || 'on-device', endpoint: v.sttEndpoint, apiKey: v.sttApiKey, model: v.sttRemoteModel, detected: v.sttDetected }
      : { provider: v.provider || 'on-device', endpoint: v.endpoint, apiKey: v.apiKey, model: v.model, detected: v.detected };
  }
  ctxFor(role, over = {}) {
    const r = { ...this.roleSettings(role), ...over };
    const ctx = providers.makeCtx({ endpoint: r.endpoint, apiKey: r.apiKey, outPath: (ext) => this.outPath(ext) });
    ctx.sidecar = this;
    return { r, ctx, provider: providers.byId(r.provider) || providers.byId('on-device') };
  }
  // What the selected server can do. Kept in memory per endpoint + key, and asked
  // again after a restart (the server may have changed since).
  async capsFor(role, { refresh = false } = {}) {
    const { r, ctx, provider } = this.ctxFor(role);
    const key = `${role}|${provider.id}|${ctx.endpoint}|${r.apiKey ? 'k' : ''}`;
    if (!refresh && this.capsCache.has(key)) return this.capsCache.get(key);
    const detected = provider.local ? {} : { tts: role === 'tts', stt: role === 'stt', ...(r.detected || {}) };
    const caps = await provider.capabilities(ctx, detected);
    this.capsCache.set(key, caps);
    return caps;
  }
  // Connect: detect what is behind the URL, remember it, and say what it can do.
  async connect({ role = 'tts', endpoint, apiKey = '' } = {}) {
    const ep = providers.normalize(endpoint);
    const r = await providers.detect({ endpoint: ep, apiKey }, { role });
    const patch = role === 'stt' ? { sttEndpoint: ep, sttApiKey: apiKey } : { endpoint: ep, apiKey };
    if (r.ok) {
      const detected = { id: r.id, label: r.label, logo: r.logo, version: r.version, place: r.place, privacy: r.privacy, summary: providers.summary(r), flavor: r.fullCaps.flavor || null, tts: !!r.fullCaps.tts, stt: !!r.fullCaps.stt, at: Date.now() };
      Object.assign(patch, role === 'stt' ? { sttProvider: r.id, sttDetected: detected } : { provider: r.id, detected });
      this.capsCache.set(`${role}|${r.id}|${ep}|${apiKey ? 'k' : ''}`, r.fullCaps);
      this.logs.info('voice', `Connected ${role === 'stt' ? 'speech to text' : 'text to speech'} to ${r.label} at ${ep}`, providers.summary(r));
    } else this.logs.warn('voice', `Could not connect ${role === 'stt' ? 'speech to text' : 'text to speech'} to ${ep || '(no address)'}: ${r.error}`);
    await this.settings.set({ voice: patch });
    const { fullCaps: _caps, ...out } = r;
    return { ...out, summary: providers.summary(r) };
  }
  // Back to the engine on this computer.
  useOnDevice(role = 'tts') { return this.settings.set({ voice: role === 'stt' ? { sttProvider: 'on-device' } : { provider: 'on-device' } }); }
  // The connection and its abilities, for the Voice page.
  async info(role = 'tts') {
    const { r, provider } = this.ctxFor(role);
    let caps = null, error = null;
    try { caps = providers.strip(await this.capsFor(role)); } catch (e) { error = e.message; }
    return { provider: provider.id, label: provider.local ? provider.label : labelOf(r.detected, provider), logo: provider.logo, local: !!provider.local, hosted: !!provider.hosted, endpoint: r.endpoint, detected: r.detected || null, caps, error, saved: this.savedVoices().filter((s) => s.provider === provider.id && !s.hidden).map((s) => ({ id: s.id, name: s.name, kind: s.kind, prompt: s.prompt })) };
  }
  savedVoices() { return (this.settings.get().voice.savedVoices || []).filter((x) => x && x.id); }
  // Removes a saved voice, and its sample from this computer.
  async deleteSaved(savedId) {
    const all = this.savedVoices(); const s = all.find((x) => x.id === savedId); if (!s) return false;
    const dir = path.join(this.userData, 'media', 'voices') + path.sep;
    if (s.sample && path.resolve(s.sample).startsWith(dir)) { try { fs.rmSync(s.sample, { force: true }); } catch {} }
    const v = this.settings.get().voice;
    await this.settings.set({ voice: { savedVoices: all.filter((x) => x.id !== savedId), ...(v.remoteVoice === `lyra:${savedId}` ? { remoteVoice: '' } : {}) } });
    return true;
  }
  // A saved voice ("lyra:<id>") becomes the options a provider understands.
  resolveVoice(provider, voiceId) {
    if (!voiceId || !String(voiceId).startsWith('lyra:')) return { voice: voiceId };
    const s = this.savedVoices().find((x) => `lyra:${x.id}` === voiceId);
    if (!s) return { voice: '' };
    if (s.kind === 'design') return { design: s.prompt };
    if (s.kind === 'clone') {
      if (!s.consent) throw new Error(`the cloned voice “${s.name}” has no recorded consent`);
      if (s.remoteId) return { voice: s.remoteId };
      return { cloneRef: { path: s.sample, text: s.refText || '' } };
    }
    return { voice: s.remoteId || '' };
  }
  voiceFor(role = 'tts') {
    const v = this.settings.get().voice; const { provider } = this.ctxFor(role);
    return provider.local ? v.voice : v.remoteVoice;
  }

  // ---- speaking ----
  // Speaks with the selected provider; any failure falls back to the voice on
  // this computer, then to the macOS voice, and the log names what failed.
  async tts(text) {
    const v = this.settings.get().voice;
    let clean = Voice.speakable(text);
    if (!clean) return null;
    if (clean.length > speakable.LIMIT) {
      this.logs.warn('voice', `Reply too long to speak in full: said the first ${speakable.LIMIT} of ${clean.length} characters`);
      this.emit(null, 'notice', { text: `That reply was too long to read out in full; ${Math.round((speakable.LIMIT / clean.length) * 100)}% of it was spoken.` });
      clean = clean.slice(0, speakable.LIMIT);
    }
    const { provider } = this.ctxFor('tts');
    if (provider.local) return this.onDeviceTts(clean, v.voice);
    const started = Date.now();
    try {
      const r = await this.speakWith(clean, {});
      this.last = { engine: provider.id, label: r.label, voice: r.voice, at: Date.now(), ms: Date.now() - started };
      this.logs.info('voice', `Spoke ${clean.length} chars with ${r.label}${r.voice ? ` (${r.voice})` : ''}`, `${Date.now() - started} ms`);
      return { path: r.path, engine: provider.id, voice: r.voice };
    } catch (e) {
      const label = labelOf(v.detected, provider);
      this.logs.error('voice', `${label} failed, fell back to the voice on this computer: ${e.message}`, `provider=${provider.id} endpoint=${v.endpoint} voice=${v.remoteVoice || '(default)'} chars=${clean.length}`);
      this.emit(null, 'notice', { text: `${label} failed (${e.message.slice(0, 140)}); used the voice on this computer instead. Settings › Recovery › Logs has the details.` });
      const r = await this.onDeviceTts(clean, v.voice, { quiet: true });
      if (r) this.last = { ...this.last, fellBackFrom: label, error: e.message };
      return r;
    }
  }
  // One request to the selected provider, no fallback: the preview buttons use
  // this so a broken server says so instead of playing a different voice.
  async speakWith(text, { voice, design, cloneRef, speed, emotion, model } = {}) {
    const v = this.settings.get().voice;
    const { ctx, provider, r } = this.ctxFor('tts');
    if (provider.local) { const a = await this.kittenTts(text, voice || v.voice); return { ...a, label: provider.label }; }
    ctx.caps = await this.capsFor('tts');
    const chosen = design || cloneRef ? {} : this.resolveVoice(provider, voice !== undefined ? voice : v.remoteVoice);
    const opts = { text, model: model || r.model || undefined, speed: speed || v.speed || 1, emotion: emotion !== undefined ? emotion : v.emotion, design, cloneRef, ...chosen };
    const out = await provider.speak(ctx, opts);
    return { path: out.path, engine: provider.id, label: labelOf(r.detected, provider), voice: opts.voice || (opts.design ? 'designed voice' : opts.cloneRef ? 'cloned voice' : '') };
  }
  async onDeviceTts(clean, voice, { quiet = false } = {}) {
    const v = this.settings.get().voice;
    const started = Date.now();
    try {
      const r = await this.kittenTts(clean, voice);
      this.last = { engine: 'kitten', label: 'KittenTTS', voice: `${voice} (${r.voice})`, at: Date.now(), ms: Date.now() - started, chunks: r.chunks, seconds: r.seconds };
      this.logs.info('voice', `Spoke ${clean.length} chars with KittenTTS (${voice})`, `${r.chunks} chunk(s), ${r.seconds}s of audio, ${Date.now() - started} ms`);
      return { path: r.path, engine: 'kitten', voice: r.voice };
    } catch (e) {
      this.last = { engine: 'say', label: 'the macOS system voice', voice: 'macOS system voice', error: e.message, at: Date.now(), ms: Date.now() - started };
      this.logs.error('voice', `KittenTTS failed, fell back to the macOS voice: ${e.message}`, `voice=${voice} model=${v.kittenModel} chars=${clean.length} python=${this.python() || 'not found'}\nlast output from the engine:\n${(this.errTail || '(none)').slice(-800)}`);
      if (!quiet) this.emit(null, 'notice', { text: `KittenTTS failed (${e.message.slice(0, 140)}); used the macOS voice. Settings › Recovery › Logs has the details.` });
      try { return await this.sayFallback(clean); } catch (e2) { this.logs.error('voice', `The macOS voice also failed: ${e2.message}`); throw e2; }
    }
  }
  // The sidecar's KittenTTS. Long replies take longer, and the very first call
  // may still be fetching the model.
  async kittenTts(clean, voice) {
    const v = this.settings.get().voice;
    const timeout = this.warmed ? Math.max(180000, clean.length * 300) : 900000;
    // Only when there is an engine to load: without one this call fails at once
    // and falls back to the macOS voice, so "loading…" would be wrong.
    if (!this.warmed && !this.warming && this.available()) this.emit(null, 'notice', { text: 'Loading the voice model for the first time; this reply may take a minute to speak.' });
    const r = await this.call('tts', { text: clean, voice: voice || v.voice, model: v.kittenModel, out: this.outPath('wav') }, timeout);
    this.warmed = true;
    return r;
  }
  sayFallback(text) {
    const out = this.outPath('wav');
    return new Promise((resolve, reject) => {
      execFile('/usr/bin/say', ['--file-format=WAVE', '--data-format=LEI16@22050', '-o', out, text], { timeout: 60000 }, (err) => err ? reject(err) : resolve({ path: out, engine: 'say' }));
    });
  }

  // ---- voice design and cloning ----
  // A prompt ("warm, playful, slight British accent") → a preview to listen to.
  async designPreview({ prompt, text }) {
    const p = String(prompt || '').trim(); if (!p) throw new Error('Describe the voice first.');
    const { ctx, provider } = this.ctxFor('tts'); ctx.caps = await this.capsFor('tts');
    if (!ctx.caps.voiceDesign) throw new Error(`${provider.label} cannot design voices.`);
    const sample = text || `Hi, I’m ${this.settings.get().persona.name}. This is how I sound.`;
    if (provider.design) { const r = await provider.design(ctx, { prompt: p, text: sample }); return { path: r.path, generatedId: r.generatedId || null }; }
    const r = await this.speakWith(sample, { design: p });
    return { path: r.path };
  }
  async saveDesign({ name, prompt, generatedId }) {
    const n = String(name || '').trim(); const p = String(prompt || '').trim();
    if (!n || !p) throw new Error('A designed voice needs a name and a description.');
    const { ctx, provider } = this.ctxFor('tts');
    let remoteId = null;
    if (provider.saveDesign) { if (!generatedId) throw new Error('Preview the voice before saving it.'); remoteId = (await provider.saveDesign(ctx, { name: n, prompt: p, generatedId })).voiceId; }
    return this.addSaved({ kind: 'design', name: n, prompt: p, provider: provider.id, remoteId });
  }
  // A recording or a file, kept under <userData>/media/voices/.
  saveSample({ dataUrl, path: from }) {
    const dir = path.join(this.userData, 'media', 'voices'); fs.mkdirSync(dir, { recursive: true });
    let ext = 'wav', buf;
    if (dataUrl) { const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl); if (!m) throw new Error('That recording could not be read.'); buf = Buffer.from(m[2], 'base64'); ext = /wav/.test(m[1]) ? 'wav' : /mpeg|mp3/.test(m[1]) ? 'mp3' : /webm/.test(m[1]) ? 'webm' : /mp4|m4a/.test(m[1]) ? 'm4a' : 'wav'; }
    else if (from) { buf = fs.readFileSync(from); ext = path.extname(from).slice(1).toLowerCase() || 'wav'; }
    else throw new Error('No recording given.');
    if (buf.length > 20 * 1024 * 1024) throw new Error('That file is too big for a voice sample (over 20 MB).');
    const out = path.join(dir, `${Date.now()}-${id()}.${ext}`);
    fs.writeFileSync(out, buf);
    return { path: out };
  }
  checkSample(samplePath, consent) {
    if (consent !== true) throw new Error('Tick “I have the right to use this voice” first.');
    const dir = path.join(this.userData, 'media', 'voices') + path.sep;
    if (!samplePath || !path.resolve(samplePath).startsWith(dir) || !fs.existsSync(samplePath)) throw new Error('Record or choose the voice sample again.');
  }
  async clonePreview({ samplePath, refText, consent, text }) {
    this.checkSample(samplePath, consent);
    const { ctx, provider } = this.ctxFor('tts'); ctx.caps = await this.capsFor('tts');
    if (!ctx.caps.cloning) throw new Error(`${provider.label} cannot clone voices.`);
    const sample = text || `Hi, I’m ${this.settings.get().persona.name}. This is how I sound.`;
    // A hosted service clones by making a voice on the account; the preview is that voice.
    if (provider.clone) { const s = await this.saveClone({ name: `Lyra preview ${new Date().toISOString().slice(0, 16)}`, samplePath, refText, consent, keep: false }); const r = await this.speakWith(sample, { voice: `lyra:${s.id}` }); return { path: r.path, savedId: s.id }; }
    const r = await this.speakWith(sample, { cloneRef: { path: samplePath, text: refText || '' } });
    return { path: r.path };
  }
  async saveClone({ name, samplePath, refText, consent, keep = true, savedId }) {
    this.checkSample(samplePath, consent);
    const n = String(name || '').trim(); if (!n) throw new Error('Give the cloned voice a name.');
    const { ctx, provider } = this.ctxFor('tts');
    if (savedId) { const list = this.savedVoices().map((x) => (x.id === savedId ? { ...x, name: n, hidden: false } : x)); await this.settings.set({ voice: { savedVoices: list } }); return list.find((x) => x.id === savedId); }
    let remoteId = null;
    if (provider.clone) remoteId = (await provider.clone(ctx, { name: n, path: samplePath })).voiceId;
    this.logs.info('voice', `Saved a cloned voice “${n}” for ${provider.label}`, `consent given ${new Date().toISOString()}; sample ${path.basename(samplePath)}${remoteId ? `; ${provider.label} voice ${remoteId}` : ''}`);
    return this.addSaved({ kind: 'clone', name: n, sample: samplePath, refText: refText || '', consent: true, consentAt: Date.now(), provider: provider.id, remoteId, hidden: !keep });
  }
  async addSaved(entry) {
    const item = { id: id(), at: Date.now(), ...entry };
    const list = [...this.savedVoices(), item];
    await this.settings.set({ voice: { savedVoices: list, ...(item.hidden ? {} : { remoteVoice: `lyra:${item.id}` }) } });
    return item;
  }

  // ---- listening ----
  async stt(filePath) {
    const { ctx, provider, r } = this.ctxFor('stt');
    if (!provider.local && provider.transcribe) {
      try {
        ctx.caps = await this.capsFor('stt');
        const out = await provider.transcribe(ctx, { path: filePath, model: r.model || undefined });
        this.logs.info('voice', `Transcribed a voice message with ${labelOf(r.detected, provider)} (${out.text.length} chars)`);
        return out;
      } catch (e) {
        const label = labelOf(r.detected, provider);
        this.logs.error('voice', `${label} could not transcribe, fell back to Whisper on this computer: ${e.message}`, `provider=${provider.id} endpoint=${r.endpoint}`);
        if (!this.available()) throw e;
      }
    }
    return this.whisperStt(filePath);
  }
  async whisperStt(filePath, language) {
    const v = this.settings.get().voice;
    try {
      const r = await this.call('stt', { path: filePath, model: v.sttModel, ...(language ? { language } : {}) }, 300000);
      this.logs.info('voice', `Transcribed a voice message (${r.text.length} chars)`);
      return { text: r.text, language: r.language };
    } catch (e) { this.logs.error('voice', `Transcription failed: ${e.message}`, `model=${v.sttModel}\n${(this.errTail || '').slice(-600)}`); throw e; }
  }
  async kittenVoices() { const r = await this.call('voices', { model: this.settings.get().voice.kittenModel }, 120000); return r.voices; }
  async voices() {
    try { return await this.kittenVoices(); }
    catch { return providers.byId('on-device').FALLBACK_VOICES; }
  }
  stop() { this.kill('voice engine stopped'); }
}
Voice.speakable = speakable;
module.exports = { Voice, speakable };
