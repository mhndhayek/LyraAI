// The phone companion: an HTTPS server on the Tailscale address that serves a small
// web app and a chat API. Nothing is exposed to the internet: the socket is bound to
// the tailnet interface, TLS uses a real certificate issued by Tailscale, and every
// call needs a device token handed out by scanning the pairing code.
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const CLI = ['tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.webm': 'audio/webm', '.m4a': 'audio/mp4' };
const run = (bin, args, timeout = 45000) => new Promise((resolve, reject) => execFile(bin, args, { timeout, maxBuffer: 4 << 20 }, (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout))));
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const token = (n = 24) => crypto.randomBytes(n).toString('base64url');
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no look-alikes
const code = (n = 6) => Array.from(crypto.randomBytes(n)).map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');

class Companion {
  constructor(ctx) {
    this.ctx = ctx; // settings, store, kernel, emit, agent...
    this.k = ctx.kernel; this.logs = this.k.logs;
    this.server = null; this.clients = new Set(); this.pairing = null; this.attempts = [];
    this.status = { running: false, url: null, host: null, ip: null, cert: null, error: null, devices: 0 };
    this.dir = path.join(this.k.paths.state, 'mobile');
    this.webDir = path.join(this.k.paths.organsRenderer, 'mobile');
    this.unhook = null;
  }

  /* ---------- tailscale ---------- */
  async cli(args) {
    let last = null;
    for (const bin of CLI) { try { return await run(bin, args); } catch (e) { last = e; if (/not found|ENOENT/i.test(e.message)) continue; throw e; } }
    throw new Error(`Tailscale command not found. Install Tailscale, then try again. (${last ? last.message : ''})`);
  }
  async tailnet() {
    const j = JSON.parse(await this.cli(['status', '--json']));
    if (!j.Self) throw new Error('Tailscale is installed but not logged in. Open Tailscale and sign in.');
    if (j.BackendState && j.BackendState !== 'Running') throw new Error(`Tailscale is ${j.BackendState}. Open Tailscale and connect.`);
    const host = (j.Self.DNSName || '').replace(/\.$/, '');
    const ip = (j.Self.TailscaleIPs || []).find((a) => a.includes('.')) || null;
    if (!host || !ip) throw new Error('Tailscale has no MagicDNS name yet. Enable MagicDNS in the Tailscale admin console.');
    const certOk = Array.isArray(j.CertDomains) && j.CertDomains.includes(host);
    const devices = Object.values(j.Peer || {}).map((p) => ({ name: p.HostName, os: p.OS, online: !!p.Online, ip: (p.TailscaleIPs || [])[0] }));
    return { host, ip, certOk, devices, tailnet: j.MagicDNSSuffix };
  }
  certPaths() { return { cert: path.join(this.dir, 'cert.pem'), key: path.join(this.dir, 'key.pem') }; }
  certExpiry() {
    const { cert } = this.certPaths(); if (!fs.existsSync(cert)) return null;
    const m = fs.readFileSync(cert, 'utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/);
    if (!m) return null;
    try { const x = new crypto.X509Certificate(m[0]); return { validTo: x.validTo, days: Math.round((new Date(x.validTo) - Date.now()) / 86400000), subject: x.subject }; } catch { return null; }
  }
  // Tailscale issues a real Let's Encrypt certificate for the MagicDNS name, so the
  // phone gets a green padlock, which the microphone and home-screen install require.
  async ensureCert(host, { force = false } = {}) {
    fs.mkdirSync(this.dir, { recursive: true });
    const { cert, key } = this.certPaths();
    const exp = this.certExpiry();
    const subjectOk = !exp || (exp.subject || '').includes(host);
    if (!force && exp && exp.days > 21 && subjectOk && fs.existsSync(key)) return exp;
    this.logs.info('mobile', `Requesting a TLS certificate for ${host}`);
    try { await this.cli(['cert', '--cert-file', cert, '--key-file', key, host]); }
    catch (e) {
      const hint = /HTTPS|not enabled|feature/i.test(e.message) ? 'Enable HTTPS certificates for your tailnet in the Tailscale admin console (DNS tab), then try again.' : e.message;
      throw new Error(`Could not get a certificate: ${hint}`);
    }
    const fresh = this.certExpiry();
    this.logs.info('mobile', `Certificate ready, valid for ${fresh ? fresh.days : '?'} days`);
    return fresh;
  }

  /* ---------- devices ---------- */
  devices() { return this.ctx.store.kvGet('mobile:devices', []) || []; }
  saveDevices(list) { this.ctx.store.kvSet('mobile:devices', list); this.status.devices = list.length; this.k.emit(null, 'mobile', this.state()); }
  addDevice(name, ua) {
    const t = token(); const dev = { id: token(8), name: name || 'Phone', ua: String(ua || '').slice(0, 120), tokenHash: sha(t), created: Date.now(), lastSeen: Date.now() };
    this.saveDevices([...this.devices(), dev]);
    this.logs.info('mobile', `Paired a new device: ${dev.name}`);
    return { token: t, device: dev };
  }
  revoke(id) { this.saveDevices(this.devices().filter((d) => d.id !== id)); this.logs.info('mobile', `Removed a paired device (${id})`); }
  deviceFor(t) {
    if (!t) return null; const h = sha(t); const list = this.devices(); const d = list.find((x) => x.tokenHash === h);
    if (d && Date.now() - (d.lastSeen || 0) > 60000) { d.lastSeen = Date.now(); this.ctx.store.kvSet('mobile:devices', list); }
    return d || null;
  }
  newPairingCode() {
    this.pairing = { code: code(), expires: Date.now() + 15 * 60000 };
    return this.pairing;
  }
  pairingCode() {
    if (!this.pairing || this.pairing.expires < Date.now()) this.newPairingCode();
    return this.pairing;
  }

  /* ---------- lifecycle ---------- */
  state() {
    const p = this.pairingCode(); const exp = this.certExpiry();
    return { ...this.status, cert: exp, pairing: this.status.running ? p.code : null, url: this.status.url, pairUrl: this.status.url ? `${this.status.url}/#p=${p.code}` : null, devices: this.devices().map(({ tokenHash, ...d }) => d) };
  }
  async start() {
    if (this.server) return this.state();
    const s = this.ctx.settings.get().mobile;
    this.status.error = null;
    try {
      const net = await this.tailnet();
      await this.ensureCert(net.host);
      const { cert, key } = this.certPaths();
      const opts = { cert: fs.readFileSync(cert), key: fs.readFileSync(key) };
      await new Promise((resolve, reject) => {
        this.server = https.createServer(opts, (req, res) => this.handle(req, res).catch((e) => { this.logs.error('mobile', `Request failed: ${e.message}`, `${req.method} ${req.url}`); if (!res.headersSent) this.send(res, 500, { error: e.message }); }));
        this.server.on('error', (e) => {
          const msg = e.code === 'EADDRINUSE' ? `Port ${s.port} is already in use. Another copy of Lyra may be running, or something else has the port. Change the port below and try again.`
            : e.code === 'EADDRNOTAVAIL' ? 'The Tailscale address is not available yet. Open Tailscale, make sure it is connected, and try again.'
            : e.code === 'EACCES' ? `Port ${s.port} needs administrator rights. Use a port above 1024.` : e.message;
          this.status.error = msg; this.logs.error('mobile', `Could not start phone access: ${msg}`, e.stack || e.code); reject(new Error(msg));
        });
        // Bound to the tailnet address only: nothing on the local wifi or the internet can reach it.
        this.server.listen(s.port, net.ip, () => resolve());
      });
      this.status = { ...this.status, running: true, host: net.host, ip: net.ip, url: `https://${net.host}:${s.port}`, devices: this.devices().length };
      this.newPairingCode();
      // Developer flag for testing on this machine; never on by default.
      if (process.argv.includes('--debug-pair')) console.log(`[pair] ${this.status.url}/#p=${this.pairing.code}`);
      this.unhook = this.k.onEvent((e) => this.broadcast(e));
      this.logs.info('mobile', `Phone access is on at ${this.status.url}`, `bound to ${net.ip}:${s.port}`);
      this.k.emit(null, 'mobile', this.state());
      return this.state();
    } catch (e) {
      this.status.running = false; this.status.error = e.message;
      try { this.server && this.server.close(); } catch {}
      this.server = null;
      this.logs.error('mobile', `Could not start phone access: ${e.message}`);
      this.k.emit(null, 'mobile', this.state());
      throw e;
    }
  }
  stop() {
    if (this.unhook) { this.unhook(); this.unhook = null; }
    for (const c of this.clients) { try { c.res.end(); } catch {} }
    this.clients.clear();
    if (this.server) { try { this.server.close(); } catch {} this.server = null; this.logs.info('mobile', 'Phone access stopped'); }
    this.status = { ...this.status, running: false, url: null };
    this.k.emit(null, 'mobile', this.state());
    return this.state();
  }

  /* ---------- plumbing ---------- */
  send(res, status, body, headers = {}) {
    const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...headers });
    res.end(data);
  }
  body(req, limit = 24 << 20) {
    return new Promise((resolve, reject) => {
      let n = 0; const chunks = [];
      req.on('data', (c) => { n += c.length; if (n > limit) { reject(new Error('payload too large')); req.destroy(); return; } chunks.push(c); });
      req.on('end', () => { const raw = Buffer.concat(chunks).toString('utf8'); if (!raw) return resolve({}); try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('bad JSON')); } });
      req.on('error', reject);
    });
  }
  auth(req, url) {
    const h = req.headers.authorization || '';
    const t = h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('token');
    return this.deviceFor(t);
  }
  broadcast(e) {
    if (!this.clients.size) return;
    const data = `data: ${JSON.stringify(e)}\n\n`;
    for (const c of this.clients) { if (!c.chatId || !e.chatId || c.chatId === e.chatId) { try { c.res.write(data); } catch {} } }
  }

  /* ---------- routes ---------- */
  async handle(req, res) {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const p = url.pathname;
    if (req.method === 'OPTIONS') return this.send(res, 204, '');

    // static shell (no token needed; it is only the empty app and the pairing screen)
    if ((req.method === 'GET' || req.method === 'HEAD') && (p === '/' || !p.startsWith('/api/'))) return this.static(p, res, req.method === 'HEAD');

    const dev = this.auth(req, url);
    if (p === '/api/pair' && req.method === 'POST') return this.pair(req, res);
    if (!dev) return this.send(res, 401, { error: 'not paired' });

    const s = this.ctx.settings.get();
    if (p === '/api/state') {
      const chats = this.ctx.store.listChats().slice(0, 50);
      return this.send(res, 200, { persona: { name: s.persona.name, avatar: s.persona.avatar }, chats, device: { name: dev.name }, voice: { stt: s.voice.stt, readAloud: s.voice.readAloud }, allowHighRisk: !!s.mobile.allowHighRiskTools });
    }
    if (p.startsWith('/api/chat/')) {
      const id = p.split('/')[3]; const tail = p.split('/')[4];
      if (req.method === 'GET' && !tail) return this.send(res, 200, { chat: this.ctx.store.getChat(id), messages: this.ctx.store.listMessages(id), context: await this.ctx.agent.contextInfo(id).catch(() => null) });
      if (req.method === 'POST' && tail === 'send') {
        const b = await this.body(req);
        const r = await this.ctx.send({ chatId: id, text: b.text || '', images: b.images || [], audio: b.audio || null, origin: 'mobile' });
        return this.send(res, 200, r);
      }
      if (req.method === 'POST' && tail === 'stop') { this.ctx.agent.stop(id); return this.send(res, 200, { ok: true }); }
    }
    if (p === '/api/chat' && req.method === 'POST') { const c = this.ctx.store.createChat(); this.k.emit(null, 'chats', {}); return this.send(res, 200, c); }
    if (p === '/api/approval' && req.method === 'POST') { const b = await this.body(req); this.ctx.approvals.respond(b.id, b.decision); return this.send(res, 200, { ok: true }); }
    if (p === '/api/media') {
      const f = url.searchParams.get('f') || '';
      const abs = path.resolve(f);
      const ok = [this.k.paths.media, this.k.root()].some((rootDir) => { const rel = path.relative(rootDir, abs); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); });
      if (!ok || !fs.existsSync(abs)) return this.send(res, 404, { error: 'not found' });
      const stat = fs.statSync(abs);
      res.writeHead(200, { 'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream', 'content-length': stat.size, 'cache-control': 'private, max-age=86400' });
      return fs.createReadStream(abs).pipe(res);
    }
    if (p === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' });
      res.write(': connected\n\n');
      const client = { res, chatId: url.searchParams.get('chatId') || null };
      this.clients.add(client);
      const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
      req.on('close', () => { clearInterval(beat); this.clients.delete(client); });
      return undefined;
    }
    return this.send(res, 404, { error: 'no such endpoint' });
  }
  async pair(req, res) {
    const now = Date.now();
    this.attempts = this.attempts.filter((t) => now - t < 300000);
    if (this.attempts.length >= 10) { this.logs.warn('mobile', 'Too many pairing attempts; pairing is locked for a few minutes'); return this.send(res, 429, { error: 'too many attempts, try again in a few minutes' }); }
    this.attempts.push(now);
    const b = await this.body(req, 1 << 16);
    const want = this.pairingCode();
    if (!b.code || String(b.code).toUpperCase().trim() !== want.code) { this.logs.warn('mobile', 'A device tried to pair with the wrong code'); return this.send(res, 403, { error: 'wrong or expired code' }); }
    const { token: t, device } = this.addDevice(b.name, req.headers['user-agent']);
    this.newPairingCode();
    this.k.emit(null, 'mobile', this.state());
    return this.send(res, 200, { token: t, device: { id: device.id, name: device.name }, persona: this.ctx.settings.get().persona.name });
  }
  static(p, res, headOnly = false) {
    const file = p === '/' ? 'index.html' : p.replace(/^\//, '');
    const abs = path.join(this.webDir, path.normalize(file).replace(/^(\.\.[\\/])+/, ''));
    if (!abs.startsWith(this.webDir) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
      if (file.startsWith('avatar')) { const a = path.join(this.k.paths.organsRenderer, 'character', 'catgirl', 'avatar.png'); if (fs.existsSync(a)) { res.writeHead(200, { 'content-type': 'image/png' }); return fs.createReadStream(a).pipe(res); } }
      return this.send(res, 404, 'not found', { 'content-type': 'text/plain' });
    }
    const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
    // The page may only talk to its own origin, and may not be framed.
    const csp = "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'";
    res.writeHead(200, { 'content-type': type, 'content-length': fs.statSync(abs).size, 'cache-control': 'no-cache', 'content-security-policy': csp, 'x-content-type-options': 'nosniff' });
    if (headOnly) return res.end();
    return fs.createReadStream(abs).pipe(res);
  }
}
module.exports = { Companion };
