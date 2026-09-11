const crypto = require('crypto');
const path = require('path');
const os = require('os');

const id = () => crypto.randomBytes(8).toString('hex');
const now = () => Date.now();
const expandHome = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
const estimateTokens = (s) => Math.ceil((s || '').length / 4);
const clampText = (s, max) => (s && s.length > max ? s.slice(0, max) + `\n…[truncated ${s.length - max} chars]` : s || '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hostOf = (url) => { try { return new URL(url).host; } catch { return url; } };

module.exports = { id, now, expandHome, estimateTokens, clampText, sleep, hostOf };
