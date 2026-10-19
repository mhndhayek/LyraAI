// Shared plumbing for the voice providers: one context per endpoint + key,
// probes that never throw (status 0 when unreachable), the auth headers every
// request carries, and turning an audio response into a file on disk.
const fs = require('fs');

const PROBE_MS = 3000;
// Hosts typed without a scheme that only speak HTTPS.
const HTTPS_HOSTS = ['api.openai.com', 'api.elevenlabs.io'];

// "localhost:8880", "http://host:8080/v1/", "api.elevenlabs.io" → a /v1 base URL.
function normalize(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    const host = s.split(/[/:]/)[0].toLowerCase();
    s = `${HTTPS_HOSTS.includes(host) ? 'https' : 'http'}://${s}`;
  }
  s = s.replace(/\/+$/, '');
  if (!/\/v\d+$/.test(s)) s += '/v1';
  return s;
}

// Where the server is, which decides what the UI says about data leaving the Mac:
// this-mac (loopback), network (LAN, tailnet, .local) or internet.
function placeOf(endpoint) {
  let h;
  try { h = new URL(endpoint).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { return 'unknown'; }
  if (h === 'localhost' || h === '::1' || /^127\./.test(h)) return 'this-mac';
  if (/^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
    || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h) || /\.(local|lan|home|ts\.net)$/.test(h) || !h.includes('.')) return 'network';
  return 'internet';
}

const ok = (p) => p.status >= 200 && p.status < 300 && p.body && typeof p.body === 'object';
const denied = (p) => p.status === 401 || p.status === 403;
// A route exists when the server answers it with anything but "no such route".
// LM Studio answers unknown routes with 200 + {"error": "Unexpected endpoint"}.
const routeExists = (p) => p.status !== 0 && p.status !== 404 && p.status !== 405 && !denied(p)
  && !(p.status === 200 && p.body && typeof p.body.error === 'string' && /unexpected endpoint|not found/i.test(p.body.error));

async function probe(url, { method = 'GET', headers = {}, body, timeoutMs = PROBE_MS } = {}) {
  try {
    const r = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
    const ctype = r.headers.get('content-type') || '';
    let text = ''; let json = null;
    if (/audio|octet-stream/.test(ctype)) { try { await r.arrayBuffer(); } catch {} } else {
      try { text = await r.text(); } catch {}
      try { json = JSON.parse(text); } catch {}
    }
    return { status: r.status, body: json, text, ctype };
  } catch (e) { return { status: 0, body: null, text: '', ctype: '', error: e.cause && e.cause.code ? e.cause.code : e.message }; }
}

function makeCtx({ endpoint, apiKey = '', outPath = null, caps = null, timeoutMs = 120000 } = {}) {
  const v1 = normalize(endpoint);
  const base = v1.replace(/\/v\d+$/, '');
  let hostname = ''; try { hostname = new URL(v1).hostname.toLowerCase(); } catch {}
  const memo = new Map(); const seen = [];
  // The key goes on every request, in the style the server expects: a bearer
  // token for nearly everything, xi-api-key for ElevenLabs.
  const headers = (extra = {}, auth = 'bearer') => ({ ...(apiKey ? (auth === 'xi' ? { 'xi-api-key': apiKey } : { Authorization: `Bearer ${apiKey}` }) : {}), ...extra });
  const remember = (pr) => pr.then((r) => { seen.push(r); return r; });
  const ctx = {
    endpoint: v1, base, apiKey, hostname, place: placeOf(v1), outPath, caps, timeoutMs, headers,
    url: (p) => base + p,
    // GET and probe-POST results are shared by every provider's detect() in one run.
    get(p, { auth = 'bearer' } = {}) { const k = `GET ${auth} ${p}`; if (!memo.has(k)) memo.set(k, remember(probe(base + p, { headers: headers({}, auth) }))); return memo.get(k); },
    post(p, json = {}, { auth = 'bearer' } = {}) { const k = `POST ${auth} ${p} ${JSON.stringify(json)}`; if (!memo.has(k)) memo.set(k, remember(probe(base + p, { method: 'POST', headers: headers({ 'content-type': 'application/json' }, auth), body: JSON.stringify(json) }))); return memo.get(k); },
    anyDenied: () => seen.some(denied),
    anyAnswer: () => seen.some((r) => r.status > 0),
    lastError: () => (seen.find((r) => r.error) || {}).error || null,
  };
  return ctx;
}

// A real request (not a probe): throws with a message a person can act on.
async function request(ctx, method, p, { json, form, query, timeoutMs, label = 'The voice server', auth = 'bearer' } = {}) {
  const qs = query ? `?${new URLSearchParams(query)}` : '';
  const headers = ctx.headers(json !== undefined ? { 'content-type': 'application/json' } : {}, auth);
  let r;
  try { r = await fetch(ctx.base + p + qs, { method, headers, body: json !== undefined ? JSON.stringify(json) : form, signal: AbortSignal.timeout(timeoutMs || ctx.timeoutMs) }); }
  catch (e) { throw new Error(`${label} is not reachable at ${ctx.endpoint} (${e.cause && e.cause.code ? e.cause.code : e.message})`, { cause: e }); }
  if (denied(r)) throw Object.assign(new Error(`${label} refused the request: ${ctx.apiKey ? 'the API key was not accepted' : 'it needs an API key'} (${r.status})`), { status: r.status });
  if (!r.ok) { let t = ''; try { t = await r.text(); } catch {} throw Object.assign(new Error(`${label} answered ${r.status}${t ? `: ${t.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`), { status: r.status }); }
  return r;
}
async function requestJson(ctx, method, p, opts) { const r = await request(ctx, method, p, opts); return r.json(); }

const EXT = [[/mpeg|mp3/, 'mp3'], [/wav|wave/, 'wav'], [/ogg|opus/, 'ogg'], [/flac/, 'flac'], [/aac|mp4|m4a/, 'm4a'], [/webm/, 'webm']];
const extOf = (ctype, fallback = 'wav') => (EXT.find(([re]) => re.test(ctype || '')) || [null, fallback])[1];

// Writes an audio response to a new file and returns its path. A JSON answer
// with a 200 is an error dressed as success, so it is reported as one.
async function saveAudio(ctx, r, fallbackExt = 'wav', label = 'The voice server') {
  const ctype = r.headers.get('content-type') || '';
  const buf = Buffer.from(await r.arrayBuffer());
  if (/json|text\/(plain|html)/.test(ctype)) throw new Error(`${label} sent text instead of audio: ${buf.toString('utf8').slice(0, 200)}`);
  if (buf.length < 44) throw new Error(`${label} sent an empty audio file`);
  const out = ctx.outPath(extOf(ctype, fallbackExt));
  fs.writeFileSync(out, buf);
  return out;
}
function saveBase64(ctx, b64, ext = 'mp3') { const out = ctx.outPath(ext); fs.writeFileSync(out, Buffer.from(b64, 'base64')); return out; }

// A file as a multipart part. Blob comes from node:buffer so this also runs in
// the plain Node test process.
function filePart(path, name = null) {
  const { Blob } = require('buffer');
  const data = fs.readFileSync(path);
  const ext = String(path).split('.').pop().toLowerCase();
  const type = { wav: 'audio/wav', mp3: 'audio/mpeg', webm: 'audio/webm', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac' }[ext] || 'application/octet-stream';
  return [new Blob([data], { type }), name || `audio.${ext}`];
}
function form(fields) {
  // eslint-disable-next-line no-undef -- FormData is global in Node 18+ and Electron's main process
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v) && v[0] && typeof v[0] === 'object' && typeof v[0].arrayBuffer === 'function') f.append(k, v[0], v[1]);
    else f.append(k, String(v));
  }
  return f;
}

// Every shape a voice list comes back in: strings, {id|voice_id|name}, wrapped
// in {voices}, {data}, or the KittenTTS server's {data:{openai_compatible,...}}.
function parseVoices(body) {
  if (!body) return [];
  let list = Array.isArray(body) ? body : body.voices || body.data || body.items || [];
  if (list && !Array.isArray(list) && typeof list === 'object') list = [...(list.kitten_native || []), ...(list.openai_compatible || []), ...(list.voices || [])];
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const x of list) {
    if (typeof x === 'string') out.push({ id: x, label: x });
    else if (x && typeof x === 'object') {
      const id = x.id || x.voice_id || x.name || x.voice; if (!id) continue;
      const labels = x.labels || {};
      out.push({ id: String(id), label: String(x.name || x.label || id), lang: x.language || x.lang || labels.accent || labels.language || undefined, gender: x.gender || labels.gender || undefined, type: x.type || x.category || undefined, description: x.description || undefined });
    }
  }
  const seenIds = new Set();
  return out.filter((v) => (seenIds.has(v.id) ? false : seenIds.add(v.id)));
}

const openapiPaths = (p) => (ok(p) && p.body.paths && typeof p.body.paths === 'object' ? Object.keys(p.body.paths) : []);
const openapiTitle = (p) => (ok(p) && p.body.info ? String(p.body.info.title || '') : '');

module.exports = { normalize, placeOf, ok, denied, routeExists, probe, makeCtx, request, requestJson, saveAudio, saveBase64, filePart, form, parseVoices, openapiPaths, openapiTitle, extOf, PROBE_MS };
