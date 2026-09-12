// The log: one place where every error, warning and notable event lands, so a
// failure that falls back silently (a voice engine, a model call, an extension)
// leaves a trace the user and the agent can both read afterwards.
const fs = require('fs');
const path = require('path');

const LEVELS = { error: 3, warn: 2, info: 1, debug: 0 };
const KEEP_DAYS = 7;
const RING = 2000;
const REDACT = [
  [/\b(sk-[A-Za-z0-9_-]{6,})/g, 'sk-[redacted]'],
  [/\b(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, '$1[redacted]'],
  [/("?(?:api[_-]?key|apikey|token|password)"?\s*[:=]\s*"?)([^"\s,}]{6,})/gi, '$1[redacted]'],
];

const redact = (s) => REDACT.reduce((acc, [re, to]) => acc.replace(re, to), String(s == null ? '' : s));
const clip = (s, n) => (s.length > n ? s.slice(0, n) + `…[+${s.length - n}]` : s);

class Logs {
  constructor(dir, { emit = () => {}, mirror = true } = {}) {
    this.dir = dir; this.emit = emit; this.mirror = mirror; this.ring = []; this.seq = 0;
    fs.mkdirSync(dir, { recursive: true });
    this.sweep();
  }
  file(d = new Date()) { return path.join(this.dir, `lyra-${d.toISOString().slice(0, 10)}.jsonl`); }
  sweep() {
    try {
      const cutoff = Date.now() - KEEP_DAYS * 86400000;
      for (const f of fs.readdirSync(this.dir)) {
        if (!/^(lyra|nova)-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) continue;
        if (fs.statSync(path.join(this.dir, f)).mtimeMs < cutoff) fs.unlinkSync(path.join(this.dir, f));
      }
    } catch {}
  }
  write(level, source, message, detail) {
    const entry = {
      id: ++this.seq, at: Date.now(), level: LEVELS[level] === undefined ? 'info' : level,
      source: String(source || 'app').slice(0, 32),
      message: clip(redact(message), 2000),
      detail: detail === undefined || detail === null ? undefined : clip(redact(typeof detail === 'string' ? detail : (detail instanceof Error ? (detail.stack || detail.message) : JSON.stringify(detail, null, 1))), 4000),
    };
    this.ring.push(entry); if (this.ring.length > RING) this.ring.shift();
    try { fs.appendFileSync(this.file(), JSON.stringify(entry) + '\n'); } catch {}
    if (this.mirror) {
      const line = `[${entry.source}] ${entry.message}`;
      if (entry.level === 'error') console.error(line, entry.detail || ''); else if (entry.level === 'warn') console.warn(line); else console.log(line);
    }
    if (entry.level === 'error' || entry.level === 'warn') this.emit(null, 'log', { entry });
    return entry;
  }
  error(source, message, detail) { return this.write('error', source, message, detail); }
  warn(source, message, detail) { return this.write('warn', source, message, detail); }
  info(source, message, detail) { return this.write('info', source, message, detail); }

  // Reads the ring first and falls back to the day files when more history is asked for.
  list({ level = 'info', source = null, limit = 100, sinceMinutes = null, search = null, days = 2 } = {}) {
    const min = LEVELS[level] === undefined ? LEVELS.info : LEVELS[level];
    const since = sinceMinutes ? Date.now() - sinceMinutes * 60000 : 0;
    let rows = this.ring;
    const needFiles = limit > this.ring.length || (sinceMinutes && this.ring.length && this.ring[0].at > since);
    if (needFiles) {
      rows = [];
      for (let i = days - 1; i >= 0; i--) {
        const f = this.file(new Date(Date.now() - i * 86400000));
        try { for (const l of fs.readFileSync(f, 'utf8').split('\n')) { if (!l.trim()) continue; try { rows.push(JSON.parse(l)); } catch {} } } catch {}
      }
      if (!rows.length) rows = this.ring;
    }
    const q = search ? String(search).toLowerCase() : null;
    const out = rows.filter((e) => LEVELS[e.level] >= min
      && (!source || e.source === source)
      && (!since || e.at >= since)
      && (!q || (e.message + ' ' + (e.detail || '')).toLowerCase().includes(q)));
    return out.slice(-Math.max(1, Math.min(limit, 1000)));
  }
  counts(sinceMinutes = 60 * 24) {
    const rows = this.list({ level: 'debug', limit: 1000, sinceMinutes });
    return rows.reduce((a, e) => { a[e.level] = (a[e.level] || 0) + 1; return a; }, {});
  }
  clear() { this.ring = []; try { for (const f of fs.readdirSync(this.dir)) if (/^(lyra|nova)-.*\.jsonl$/.test(f)) fs.unlinkSync(path.join(this.dir, f)); } catch {} }
  text(opts) { return this.list(opts).map((e) => `${new Date(e.at).toISOString().replace('T', ' ').slice(0, 19)} ${e.level.toUpperCase().padEnd(5)} ${e.source}: ${e.message}${e.detail ? '\n    ' + e.detail.replace(/\n/g, '\n    ') : ''}`).join('\n'); }
}
module.exports = { Logs, LEVELS };
