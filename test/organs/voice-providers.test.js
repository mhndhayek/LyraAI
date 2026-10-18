// Story 04: voice providers. Point Lyra at any voice server and she works out
// what it is, which voices it has and what it can do. One fake HTTP server per
// provider, each answering the routes the real one has, in the shapes the real
// one returns (omnivoice-server, Kokoro-FastAPI, fish-speech, KittenTTS-FastAPI,
// speaches, whisper.cpp, ElevenLabs).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { tmpdir, cleanup } = require('../helpers/tmp');
const providers = require('../../main/organs/voice/providers');
const { Voice } = require('../../main/organs/voice');
const { Settings } = require('../../main/kernel/settings');

const servers = [];
test.after(() => { for (const s of servers) s.close(); cleanup(); });

// A WAV header and a little silence: enough to count as audio.
const WAV = Buffer.concat([Buffer.from('RIFF\x24\x08\x00\x00WAVEfmt ', 'binary'), Buffer.alloc(2100)]);
const json = (res, obj, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const audio = (res, ctype = 'audio/wav') => { res.writeHead(200, { 'content-type': ctype }); res.end(WAV); };
const unprocessable = (res) => json(res, { detail: [{ loc: ['body', 'input'], msg: 'Field required', type: 'missing' }] }, 422);

// routes: { 'GET /path': handler, 'POST /path': handler }. Unknown routes 404,
// like FastAPI. With a key, everything but the routes in `open` answers 401.
async function serve(routes, { key, open = [], log } = {}) {
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks); const p = req.url.split('?')[0];
    if (log) log.push({ method: req.method, path: p, headers: req.headers, raw });
    const authOk = !key || req.headers.authorization === `Bearer ${key}` || req.headers['xi-api-key'] === key;
    if (!authOk && !open.includes(p)) return json(res, { detail: 'Invalid API key' }, 401);
    const route = routes[`${req.method} ${p}`];
    if (!route) return json(res, { detail: 'Not Found' }, 404);
    let body = null; if (/json/.test(req.headers['content-type'] || '') && raw.length) { try { body = JSON.parse(raw.toString()); } catch {} }
    return route(req, res, body, raw);
  });
  servers.push(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}/v1`;
}
// A POST route that rejects an empty body the way FastAPI does, and otherwise speaks.
const speech = (onBody) => (req, res, body, raw) => (!body || (!body.input && !body.text) ? (raw.length && !body ? audio(res) : unprocessable(res)) : (onBody && onBody(body), audio(res)));

// ---- fixtures: what each real server answers ----

const OMNI_OPENAPI = (withClone = true) => ({
  openapi: '3.1.0', info: { title: 'OmniVoice Server', version: '0.2.1' },
  paths: {
    '/health': { get: {} },
    '/v1/voices': { get: {} },
    '/v1/audio/speech': { post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/SpeechRequest' } } } } } },
    ...(withClone ? { '/v1/audio/speech/clone': { post: { requestBody: { content: { 'multipart/form-data': { schema: { $ref: '#/components/schemas/Body_clone' } } } } } } } : {}),
  },
  components: { schemas: {
    SpeechRequest: { type: 'object', required: ['input'], properties: { model: {}, input: {}, voice: {}, speaker: {}, instructions: {}, response_format: {}, speed: {}, stream: {}, num_step: {} } },
    Body_clone: { type: 'object', required: ['text', 'ref_audio'], properties: { text: {}, ref_audio: { format: 'binary' }, ref_text: {}, speed: {} } },
  } },
});
const omnivoice = ({ withClone = true, log } = {}) => serve({
  'GET /health': (q, r) => json(r, { status: 'ok', model_loaded: true }),
  'GET /openapi.json': (q, r) => json(r, OMNI_OPENAPI(withClone)),
  'GET /v1/voices': (q, r) => json(r, { voices: [
    { id: 'auto', type: 'auto', description: 'Ignored by /v1/audio/speech; server default design prompt is male, middle-aged, moderate pitch, british accent' },
    { id: 'design:<attributes>', type: 'design', description: 'Custom voice design using upstream OmniVoice attributes' },
    { id: 'alloy', type: 'preset', description: 'Server-only preset mapped to: female, young adult, moderate pitch, american accent' },
    { id: 'nova', type: 'preset', description: 'Server-only preset mapped to: female, young adult, high pitch, american accent' },
    { id: 'clone:hanood', type: 'clone', profile_id: 'hanood', description: 'Server-stored voice profile' },
  ], design_attributes: { gender: ['male', 'female'], age: ['child', 'young adult'], pitch: ['low pitch', 'high pitch'] }, total: 5 }),
  'POST /v1/audio/speech': speech(),
  ...(withClone ? { 'POST /v1/audio/speech/clone': (q, r, b, raw) => (raw.length ? audio(r) : unprocessable(r)) } : {}),
}, { log });

const KOKORO_VOICES = ['af_alloy', 'af_bella', 'af_heart', 'af_sky', 'am_adam', 'am_echo', 'bf_emma', 'bm_george', 'jf_alpha', 'zf_xiaobei'];
const kokoro = ({ log } = {}) => serve({
  'GET /openapi.json': (q, r) => json(r, { openapi: '3.1.0', info: { title: 'Kokoro TTS API', version: '0.3.0' }, paths: { '/v1/audio/speech': { post: {} }, '/v1/audio/voices': { get: {} } } }),
  'GET /v1/audio/voices': (q, r) => json(r, { voices: KOKORO_VOICES }),
  'GET /v1/models': (q, r) => json(r, { object: 'list', data: [{ id: 'tts-1', object: 'model' }, { id: 'kokoro', object: 'model' }] }),
  'POST /v1/audio/speech': speech(),
  'GET /health': (q, r) => json(r, { status: 'healthy' }),
}, { log });
// Kokoro without its OpenAPI title (behind a proxy): told apart by the voice ids alone.
const kokoroNoDocs = () => serve({ 'GET /v1/audio/voices': (q, r) => json(r, { voices: KOKORO_VOICES }), 'POST /v1/audio/speech': speech() });

// fish-speech's api_server: /v1/health, /v1/tts with msgpack or JSON, /v1/references/*.
const fish = ({ log } = {}) => serve({
  'GET /v1/health': (q, r) => json(r, { status: 'ok' }),
  'POST /v1/health': (q, r) => json(r, { status: 'ok' }),
  'POST /v1/tts': (q, r, b) => (!b || !b.text ? json(r, { detail: 'text is required' }, 422) : audio(r)),
  'GET /v1/references/list': (q, r) => json(r, { success: true, reference_ids: ['lyra-warm', 'narrator'], message: 'ok' }),
}, { log });

const kittenServer = () => serve({
  'GET /openapi.json': (q, r) => json(r, { openapi: '3.1.0', info: { title: 'KittenTTS FastAPI', version: '1.2.0' }, paths: { '/v1/audio/speech': { post: {} }, '/v1/audio/voices': { get: {} }, '/tts': { post: {} } } }),
  'GET /v1/audio/voices': (q, r) => json(r, { voices: [{ name: 'Bella', id: 'Bella' }, { name: 'Jasper', id: 'Jasper' }, { name: 'Luna', id: 'Luna' }, { name: 'Rosie', id: 'Rosie' }] }),
  'POST /v1/audio/speech': speech(),
});

// speaches (faster-whisper-server): transcription only.
const speaches = ({ log } = {}) => serve({
  'GET /openapi.json': (q, r) => json(r, { openapi: '3.1.0', info: { title: 'Speaches', version: '0.8.2' }, paths: { '/v1/audio/transcriptions': { post: {} }, '/v1/models': { get: {} } } }),
  'GET /v1/models': (q, r) => json(r, { data: [{ id: 'Systran/faster-whisper-small', object: 'model' }] }),
  'POST /v1/audio/transcriptions': (q, r, b, raw) => (raw.length > 50 && /multipart/.test(q.headers['content-type'] || '') ? json(r, { text: ' hello from the fake whisper ' }) : unprocessable(r)),
}, { log });
const whisperCpp = () => serve({
  'POST /inference': (q, r, b, raw) => (raw.length > 50 ? json(r, { text: 'whisper cpp heard you' }) : json(r, { error: 'no file' }, 400)),
  'POST /load': (q, r) => json(r, { status: 'ok' }),
});

// A plain OpenAI-compatible server with nothing else to say about itself.
const plainOpenAI = ({ log, key } = {}) => serve({
  'POST /v1/audio/speech': speech(),
  'POST /v1/audio/transcriptions': (q, r, b, raw) => (raw.length > 50 ? json(r, { text: 'plain transcript' }) : unprocessable(r)),
  'GET /v1/models': (q, r) => json(r, { data: [{ id: 'tts-1' }, { id: 'whisper-1' }] }),
}, { log, key });

// A server Lyra has no file for: only its OpenAPI describes it.
const unknownWithDocs = ({ withClone }) => serve({
  'GET /openapi.json': (q, r) => json(r, { openapi: '3.1.0', info: { title: 'Acme Voice Lab', version: '1' }, paths: {
    '/api/synthesize': { post: { requestBody: { content: { 'application/json': { schema: { properties: { text: {}, speaker: {}, style_prompt: {} } } } } } } },
    '/api/speakers': { get: {} },
    ...(withClone ? { '/api/clone_voice': { post: { requestBody: { content: { 'multipart/form-data': { schema: { properties: { text: {}, reference_audio: {}, transcript: {} } } } } } } } } : {}),
  } }),
  'POST /api/synthesize': (q, r, b) => (b && b.text ? audio(r) : unprocessable(r)),
  'GET /api/voices': (q, r) => json(r, []),
  ...(withClone ? { 'POST /api/clone_voice': (q, r) => audio(r) } : {}),
});

const elevenRoutes = {
  'GET /v1/voices': (q, r) => json(r, { voices: [
    { voice_id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel', category: 'premade', labels: { accent: 'american', gender: 'female' } },
    { voice_id: 'AZnzlk1XvdvUeBnXmlld', name: 'Domi', category: 'premade', labels: { accent: 'american', gender: 'female' } },
    { voice_id: 'myclone123', name: 'My voice', category: 'cloned', labels: {} },
  ] }),
  'GET /v1/models': (q, r) => json(r, [{ model_id: 'eleven_multilingual_v2', can_do_text_to_speech: true }, { model_id: 'eleven_flash_v2_5', can_do_text_to_speech: true }]),
};

// ---- detection ----

test('detect() picks the right provider for each kind of server', async () => {
  const cases = [
    ['omnivoice', await omnivoice()],
    ['kokoro', await kokoro()],
    ['kokoro', await kokoroNoDocs()],
    ['fish', await fish()],
    ['kitten-server', await kittenServer()],
    ['openai-compatible', await plainOpenAI()],
    ['openapi', await unknownWithDocs({ withClone: false })],
  ];
  for (const [want, endpoint] of cases) {
    const r = await providers.detect({ endpoint });
    assert.equal(r.ok, true, `${want} at ${endpoint}: ${r.error}`);
    assert.equal(r.id, want, `${endpoint} was taken for ${r.id}, not ${want}`);
    assert.equal(r.place, 'this-mac');
    assert.equal(r.privacy, null, 'a server on this computer sends nothing off it');
  }
});

test('Kokoro and OmniVoice, which both sit on :8880 with /v1/audio/speech, are told apart', async () => {
  const k = await providers.detect({ endpoint: await kokoro() });
  const o = await providers.detect({ endpoint: await omnivoice() });
  assert.equal(k.id, 'kokoro'); assert.equal(o.id, 'omnivoice');
  assert.equal(k.caps.voices.length, KOKORO_VOICES.length);
  assert.equal(providers.summary(k), 'Kokoro · 10 voices · streaming · 0.3.0');
  assert.equal(k.caps.voices.find((v) => v.id === 'af_bella').label, 'Bella · American English');
  assert.equal(k.caps.voices.find((v) => v.id === 'bm_george').gender, 'male');
  assert.equal(k.caps.mixes, true, 'Kokoro voices can be mixed (af_bella+af_sky)');
  // OmniVoice: the presets and clones are voices; "auto" and "design:<attributes>" are not.
  assert.deepEqual(o.caps.voices.map((v) => v.id), ['alloy', 'nova', 'clone:hanood']);
});

test('the speech-to-text card finds Whisper servers, and refuses a server that only speaks', async () => {
  const s = await providers.detect({ endpoint: await speaches() }, { role: 'stt' });
  assert.equal(s.ok, true, s.error); assert.equal(s.id, 'whisper-server');
  assert.deepEqual(s.caps.sttModels, ['Systran/faster-whisper-small']);
  const w = await providers.detect({ endpoint: await whisperCpp() }, { role: 'stt' });
  assert.equal(w.id, 'whisper-server'); assert.equal(w.caps.flavor, 'whisper.cpp');
  const plain = await providers.detect({ endpoint: await plainOpenAI() }, { role: 'stt' });
  assert.equal(plain.id, 'openai-compatible', 'a full OpenAI copy also transcribes');
  const k = await providers.detect({ endpoint: await kokoro() }, { role: 'stt' });
  assert.equal(k.ok, false); assert.match(k.error, /can speak but not transcribe/);
  const tts = await providers.detect({ endpoint: await speaches() });
  assert.equal(tts.ok, false, 'a Whisper server is not offered as a voice'); assert.match(tts.error, /only transcribes/);
});

test('every probe carries the key', async () => {
  const log = [];
  const endpoint = await kokoro({ log });
  const r = await providers.detect({ endpoint, apiKey: 'sekrit' });
  assert.equal(r.ok, true);
  assert.ok(log.length >= 3);
  for (const req of log) assert.equal(req.headers.authorization, 'Bearer sekrit', `${req.method} ${req.path} went without the key`);
});

// ---- capabilities ----

test('a server whose OpenAPI lists a clone path can clone; without it, it cannot', async () => {
  const withClone = await providers.detect({ endpoint: await omnivoice({ withClone: true }) });
  const without = await providers.detect({ endpoint: await omnivoice({ withClone: false }) });
  assert.equal(withClone.caps.cloning, true);
  assert.equal(without.caps.cloning, false);
  assert.equal(withClone.caps.voiceDesign, true, 'the speech request takes `instructions`');
  assert.match(providers.summary(withClone), /voice design · cloning/);
  // The generic fallback reads the same from a server Lyra has no file for.
  const g = await providers.detect({ endpoint: await unknownWithDocs({ withClone: true }) });
  assert.equal(g.id, 'openapi'); assert.equal(g.label, 'Acme Voice Lab');
  assert.equal(g.caps.cloning, true); assert.equal(g.caps.voiceDesign, true, 'style_prompt is a design field');
  const g2 = await providers.detect({ endpoint: await unknownWithDocs({ withClone: false }) });
  assert.equal(g2.caps.cloning, false);
});

test('Fish Speech clones from a reference recording and has emotion tags', async () => {
  const r = await providers.detect({ endpoint: await fish() });
  assert.equal(r.caps.cloning, true); assert.equal(r.caps.emotion, true);
  assert.ok(r.caps.emotions.includes('excited'));
  assert.deepEqual(r.caps.voices.map((v) => v.id), ['lyra-warm', 'narrator']);
});

// ---- keys ----

test('401 says the server needs an API key, not that it is unreachable', async () => {
  const endpoint = await plainOpenAI({ key: 'sekrit' });
  const without = await providers.detect({ endpoint });
  assert.equal(without.ok, false); assert.equal(without.needsKey, true);
  assert.equal(without.error, 'This server needs an API key.');
  const wrong = await providers.detect({ endpoint, apiKey: 'nope' });
  assert.equal(wrong.needsKey, true); assert.match(wrong.error, /refused this API key/);
  const right = await providers.detect({ endpoint, apiKey: 'sekrit' });
  assert.equal(right.ok, true); assert.equal(right.id, 'openai-compatible');
  const nothing = await providers.detect({ endpoint: 'http://127.0.0.1:9/v1' });
  assert.equal(nothing.needsKey, false); assert.match(nothing.error, /Not reachable/);
});

// ---- where the data goes ----

test('a hosted service says it sends data off this Mac', () => {
  assert.equal(providers.placeOf('http://localhost:8880/v1'), 'this-mac');
  assert.equal(providers.placeOf('http://100.101.102.103:8880/v1'), 'network', 'a tailnet address');
  assert.equal(providers.placeOf('http://192.168.1.20:8880/v1'), 'network');
  assert.equal(providers.placeOf('https://api.elevenlabs.io/v1'), 'internet');
  assert.equal(providers.normalize('api.elevenlabs.io'), 'https://api.elevenlabs.io/v1');
  assert.equal(providers.normalize('localhost:8880'), 'http://localhost:8880/v1');
  const eleven = providers.byId('elevenlabs');
  assert.match(providers.privacyNote('internet', eleven), /^Sends data off this Mac: .*voice sample you clone.*ElevenLabs/);
  assert.match(providers.privacyNote('network', null), /on your network/);
});

test('ElevenLabs: voices, design and cloning, with the key in xi-api-key', async () => {
  const log = [];
  const endpoint = await serve(elevenRoutes, { key: 'xi-sekrit', log });
  const p = providers.byId('elevenlabs');
  // detect() only answers for the real host; the provider itself is exercised directly.
  const ctx = providers.makeCtx({ endpoint, apiKey: 'xi-sekrit' }); ctx.hostname = 'api.elevenlabs.io';
  const d = await p.detect(ctx);
  assert.equal(d.ok, true);
  const caps = await p.capabilities(ctx, d);
  assert.deepEqual(caps.voices.map((v) => v.id), ['21m00Tcm4TlvDq8ikWAM', 'AZnzlk1XvdvUeBnXmlld', 'myclone123']);
  assert.equal(caps.voices[2].label, 'My voice (cloned)');
  assert.equal(caps.cloning, true); assert.equal(caps.voiceDesign, true); assert.equal(caps.hosted, true);
  for (const req of log) { assert.equal(req.headers['xi-api-key'], 'xi-sekrit'); assert.equal(req.headers.authorization, undefined, 'the key is not also sent as a bearer token'); }
  const noKey = providers.makeCtx({ endpoint }); noKey.hostname = 'api.elevenlabs.io';
  assert.deepEqual(await p.detect(noKey), { ok: false, needsKey: true });
});

// ---- the Voice organ: speaking, fallback, listening ----

function makeVoice(voice = {}) {
  const dir = tmpdir();
  const settings = new Settings(path.join(dir, 'state', 'settings.json'));
  settings.set({ voice });
  const logs = []; const events = [];
  const log = (level) => (source, message, detail) => logs.push({ level, source, message, detail });
  const v = new Voice({ settings, appPath: path.join(__dirname, '..', '..'), userData: dir, emit: (c, t, p) => events.push({ t, ...p }), logs: { info: log('info'), warn: log('warn'), error: log('error') } });
  return { v, settings, logs, events, dir };
}

test('tts() speaks with the selected provider and sends what it was set to', async () => {
  const log = [];
  const endpoint = await omnivoice({ log });
  const { v, settings } = makeVoice();
  const c = await v.connect({ endpoint, apiKey: '' });
  assert.equal(c.ok, true); assert.equal(c.id, 'omnivoice');
  assert.equal(settings.get().voice.provider, 'omnivoice', 'Connect remembers what it found');
  assert.equal(settings.get().voice.detected.label, 'OmniVoice');
  await settings.set({ voice: { remoteVoice: 'nova', speed: 1.2 } });
  const r = await v.tts('Hello **there**, Hanood!');
  assert.equal(r.engine, 'omnivoice');
  assert.ok(fs.existsSync(r.path) && fs.statSync(r.path).size > 44);
  const sent = log.filter((x) => x.method === 'POST' && x.path === '/v1/audio/speech').map((x) => JSON.parse(x.raw.toString())).pop();
  assert.deepEqual({ input: sent.input, voice: sent.voice, speed: sent.speed }, { input: 'Hello there, Hanood!', voice: 'nova', speed: 1.2 });
});

test('a failing provider falls back to the on-device voice, and the log names the provider', async () => {
  const endpoint = await serve({ 'GET /openapi.json': (q, r) => json(r, OMNI_OPENAPI()), 'GET /v1/voices': (q, r) => json(r, { voices: [{ id: 'alloy', type: 'preset' }] }), 'POST /v1/audio/speech': (q, r, b) => (b && b.input === 'boom' ? json(r, { detail: 'CUDA out of memory' }, 500) : unprocessable(r)) });
  const { v, logs, events } = makeVoice();
  assert.equal((await v.connect({ endpoint })).id, 'omnivoice');
  // The sidecar is not installed in the test process: stand in for it.
  let onDevice = 0;
  v.kittenTts = async () => { onDevice++; return { path: '/tmp/kitten.wav', voice: 'expr-voice-2-f', chunks: 1, seconds: 1 }; };
  const r = await v.tts('boom');
  assert.equal(onDevice, 1, 'the on-device voice spoke instead');
  assert.equal(r.engine, 'kitten'); assert.equal(r.path, '/tmp/kitten.wav');
  const err = logs.find((l) => l.level === 'error' && l.source === 'voice');
  assert.match(err.message, /^OmniVoice failed, fell back to the voice on this computer: .*500.*CUDA out of memory/);
  assert.match(err.detail, /provider=omnivoice/);
  assert.ok(events.some((e) => e.t === 'notice' && /OmniVoice failed/.test(e.text)), 'the user is told too');
  assert.equal(v.status().last.fellBackFrom, 'OmniVoice');
});

test('with no engine on this computer, the fallback does not claim to be loading one', async () => {
  const endpoint = await serve({ 'GET /openapi.json': (q, r) => json(r, OMNI_OPENAPI()), 'GET /v1/voices': (q, r) => json(r, { voices: [{ id: 'alloy', type: 'preset' }] }) });
  const { v, events } = makeVoice();
  assert.equal((await v.connect({ endpoint })).id, 'omnivoice');
  v.available = () => false; // no sidecar installed
  v.sayFallback = async () => ({ path: '/tmp/say.wav', engine: 'say' });
  const r = await v.tts('hello there');
  assert.equal(r.engine, 'say', 'the macOS voice spoke');
  assert.ok(events.some((e) => e.t === 'notice' && /OmniVoice failed/.test(e.text)), 'the user is told the server failed');
  assert.ok(!events.some((e) => e.t === 'notice' && /Loading the voice model/.test(e.text)), 'no "loading the voice model" notice when there is nothing to load');
});

test('a leftover detection from another server does not rename the provider', async () => {
  const endpoint = await serve({ 'GET /openapi.json': (q, r) => json(r, OMNI_OPENAPI()), 'GET /v1/voices': (q, r) => json(r, { voices: [{ id: 'alloy', type: 'preset' }] }) });
  const { v, logs, settings } = makeVoice();
  await v.connect({ endpoint });
  // The provider changes without a new Connect (e.g. hand-edited settings).
  await settings.set({ voice: { provider: 'kokoro', endpoint: 'http://127.0.0.1:9/v1' } });
  v.available = () => false; v.sayFallback = async () => ({ path: '/tmp/say.wav', engine: 'say' });
  await v.tts('hello');
  const err = logs.find((l) => l.level === 'error' && /fell back to the voice on this computer/.test(l.message));
  assert.match(err.message, /^Kokoro failed/, 'named after the provider in use, not the old OmniVoice detection');
  assert.equal((await v.info()).label, 'Kokoro');
});

test('stt() uses the connected Whisper server, and falls back to the on-device one', async () => {
  const log = [];
  const endpoint = await speaches({ log });
  const { v, settings } = makeVoice();
  const c = await v.connect({ role: 'stt', endpoint });
  assert.equal(c.id, 'whisper-server'); assert.equal(settings.get().voice.sttProvider, 'whisper-server');
  assert.equal(settings.get().voice.provider, 'on-device', 'connecting speech to text leaves speaking alone');
  const clip = path.join(tmpdir(), 'clip.wav'); fs.writeFileSync(clip, WAV);
  const r = await v.stt(clip);
  assert.equal(r.text, 'hello from the fake whisper');
  const sent = log.filter((x) => x.method === 'POST' && x.path === '/v1/audio/transcriptions').pop();
  assert.match(sent.raw.toString('latin1'), /name="model"\r\n\r\nSystran\/faster-whisper-small/);
  // The server goes away: the on-device Whisper takes over.
  await settings.set({ voice: { sttEndpoint: 'http://127.0.0.1:9/v1' } });
  v.capsCache.clear();
  v.python = () => '/fake/python';
  v.whisperStt = async () => ({ text: 'on-device transcript', language: 'en' });
  assert.equal((await v.stt(clip)).text, 'on-device transcript');
});

test('cloning needs consent, stores the sample under media/voices, and sends it as the reference', async () => {
  const log = [];
  const endpoint = await omnivoice({ log });
  const { v, settings, dir } = makeVoice();
  await v.connect({ endpoint });
  const sample = v.saveSample({ dataUrl: `data:audio/wav;base64,${WAV.toString('base64')}` });
  assert.equal(path.dirname(sample.path), path.join(dir, 'media', 'voices'));
  await assert.rejects(v.clonePreview({ samplePath: sample.path, consent: false }), /I have the right to use this voice/);
  await assert.rejects(v.clonePreview({ samplePath: '/etc/hosts', consent: true }), /Record or choose the voice sample again/, 'only samples Lyra stored');
  const p = await v.clonePreview({ samplePath: sample.path, refText: 'Hello it is me', consent: true });
  assert.ok(fs.existsSync(p.path));
  const sent = log.filter((x) => x.path === '/v1/audio/speech/clone').pop();
  const body = sent.raw.toString('latin1');
  assert.match(body, /name="ref_audio"; filename="audio\.wav"/); assert.match(body, /name="ref_text"\r\n\r\nHello it is me/);
  const saved = (await v.saveClone({ name: 'Me', samplePath: sample.path, refText: 'Hello it is me', consent: true }));
  assert.equal(settings.get().voice.remoteVoice, `lyra:${saved.id}`, 'the new voice is the one in use');
  assert.equal(saved.consent, true); assert.ok(saved.consentAt);
  await v.tts('Speaking as me now');
  assert.equal(log.filter((x) => x.path === '/v1/audio/speech/clone').length, 2, 'a cloned voice speaks through the clone route');
  await v.deleteSaved(saved.id);
  assert.equal(fs.existsSync(sample.path), false, 'deleting the voice deletes its sample');
  assert.equal(settings.get().voice.remoteVoice, '');
});

test('a designed voice is a prompt that goes out as `instructions`', async () => {
  const log = [];
  const endpoint = await omnivoice({ log });
  const { v, settings } = makeVoice();
  await v.connect({ endpoint });
  const prev = await v.designPreview({ prompt: 'female, young adult, high pitch, british accent' });
  assert.ok(fs.existsSync(prev.path));
  const saved = await v.saveDesign({ name: 'Bright', prompt: 'female, young adult, high pitch, british accent' });
  assert.equal(settings.get().voice.remoteVoice, `lyra:${saved.id}`);
  await v.tts('Hi');
  const sent = log.filter((x) => x.path === '/v1/audio/speech').map((x) => JSON.parse(x.raw.toString())).pop();
  assert.equal(sent.instructions, 'female, young adult, high pitch, british accent');
  assert.equal(sent.voice, undefined, 'a design replaces the preset');
});

// ---- settings migration ----

test('an old engine: custom profile becomes the OpenAI-compatible provider at the same URL', () => {
  const file = path.join(tmpdir(), 'state', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 0.9.12, from before profiles: the voice section at the top level.
  fs.writeFileSync(file, JSON.stringify({ voice: { engine: 'custom', customEndpoint: 'http://localhost:8880/v1', customModel: 'tts-1-hd', customVoice: 'nova', readAloud: false } }));
  const s = new Settings(file);
  const v = s.get().voice;
  assert.equal(v.provider, 'openai-compatible');
  assert.equal(v.endpoint, 'http://localhost:8880/v1');
  assert.equal(v.model, 'tts-1-hd'); assert.equal(v.remoteVoice, 'nova');
  assert.equal(v.readAloud, false, 'everything else is kept');
  for (const k of ['engine', 'customEndpoint', 'customModel', 'customVoice']) assert.ok(!(k in v), `${k} is gone`);
  const again = new Settings(file).get().voice;
  assert.equal(again.provider, 'openai-compatible', 'the migration is saved');
  // And inside profiles, a KittenTTS user stays on the on-device voice.
  const file2 = path.join(tmpdir(), 'state', 'settings.json'); fs.mkdirSync(path.dirname(file2), { recursive: true });
  fs.writeFileSync(file2, JSON.stringify({ ui: { setupDone: true }, profiles: { active: 'a', list: [{ id: 'a', name: 'Lyra', voice: { engine: 'kitten', voice: 'Luna' } }, { id: 'b', name: 'Nova', voice: { engine: 'custom', customEndpoint: 'http://lucix:8880/v1' } }] } }));
  const s2 = new Settings(file2);
  assert.equal(s2.get().voice.provider, 'on-device'); assert.equal(s2.get().voice.voice, 'Luna');
  s2.switchProfile('b');
  assert.equal(s2.get().voice.provider, 'openai-compatible'); assert.equal(s2.get().voice.endpoint, 'http://lucix:8880/v1');
});
