// OpenAI's own API and anything that copies it: POST /v1/audio/speech to speak,
// POST /v1/audio/transcriptions to listen. The speak/transcribe helpers here are
// shared by the other providers that speak the same dialect.
const h = require('./http');

const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];
const isHosted = (ctx) => ctx.hostname === 'api.openai.com';

async function speakOpenAI(ctx, o, { model = 'tts-1', label = 'The voice server', extra = {} } = {}) {
  const body = { model: o.model || model, input: o.text, response_format: o.format || 'wav', ...(o.voice ? { voice: o.voice } : {}), ...(o.speed && o.speed !== 1 ? { speed: o.speed } : {}), ...extra };
  const r = await h.request(ctx, 'POST', '/v1/audio/speech', { json: body, label });
  return { path: await h.saveAudio(ctx, r, o.format || 'wav', label) };
}

async function transcribeOpenAI(ctx, o, { model = 'whisper-1', label = 'The speech-to-text server' } = {}) {
  const fields = { file: h.filePart(o.path), model: o.model || model, response_format: 'json' };
  if (o.language) fields.language = o.language;
  const j = await h.requestJson(ctx, 'POST', '/v1/audio/transcriptions', { form: h.form(fields), label, timeoutMs: 300000 });
  return { text: String(j.text || '').trim(), language: j.language || o.language || null };
}

// Speech or transcription models out of /v1/models, when the server lists any.
async function listModels(ctx, re) {
  const m = await ctx.get('/v1/models');
  if (!h.ok(m)) return [];
  return (m.body.data || m.body.models || []).map((x) => (typeof x === 'string' ? x : x.id || x.name)).filter((id) => id && re.test(id));
}

module.exports = {
  id: 'openai-compatible', label: 'OpenAI-compatible', logo: 'openai',
  async detect(ctx) {
    const hosted = isHosted(ctx);
    // An empty request: a server with the route rejects the body (400/422), one
    // without it answers 404. Nothing is synthesised, so a hosted API costs nothing.
    const [speech, trans] = await Promise.all([ctx.post('/v1/audio/speech', {}), ctx.post('/v1/audio/transcriptions', {})]);
    const tts = h.routeExists(speech), stt = h.routeExists(trans);
    if (!tts && !stt && !hosted) return { ok: false };
    if (hosted && (h.denied(speech) || h.denied(trans))) return { ok: false };
    return { ok: true, confidence: hosted ? 0.9 : 0.4, tts: tts || hosted, stt: stt || hosted, label: hosted ? 'OpenAI' : undefined };
  },
  async capabilities(ctx, d = {}) {
    const hosted = isHosted(ctx);
    let voices = [];
    for (const p of ['/v1/audio/voices', '/v1/voices']) { const r = await ctx.get(p); if (h.ok(r)) { voices = h.parseVoices(r.body); if (voices.length) break; } }
    if (!voices.length) voices = OPENAI_VOICES.map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1) }));
    let models = await listModels(ctx, /tts|speech|voice|kokoro|piper/i);
    if (!models.length) models = hosted ? ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'] : ['tts-1'];
    let sttModels = await listModels(ctx, /whisper|transcri|scribe|parakeet/i);
    if (!sttModels.length && hosted) sttModels = ['gpt-4o-mini-transcribe', 'whisper-1'];
    return { voices, models, sttModels, formats: ['wav', 'mp3', 'opus', 'flac'], stream: false, voiceDesign: false, cloning: false, speed: true, emotion: false, stt: !!d.stt, tts: d.tts !== false };
  },
  speak: (ctx, o) => speakOpenAI(ctx, o, { model: (ctx.caps && ctx.caps.models && ctx.caps.models[0]) || 'tts-1' }),
  transcribe: (ctx, o) => transcribeOpenAI(ctx, o, { model: (ctx.caps && ctx.caps.sttModels && ctx.caps.sttModels[0]) || 'whisper-1' }),
  speakOpenAI, transcribeOpenAI, listModels, OPENAI_VOICES,
};
