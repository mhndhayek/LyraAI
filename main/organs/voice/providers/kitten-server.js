// A remote KittenTTS server (KittenTTS-FastAPI, kittentts-server, ...): an
// OpenAI-style /v1/audio/speech plus a voice list whose names are Kitten's
// (Bella, Jasper, ... or expr-voice-N-f), or an OpenAPI title that says so.
const h = require('./http');
const { speakOpenAI } = require('./openai-compatible');

const KITTEN_NAMES = ['bella', 'jasper', 'luna', 'bruno', 'rosie', 'hugo', 'kiki', 'leo'];
const isKittenVoice = (id) => KITTEN_NAMES.includes(String(id).toLowerCase()) || /^expr-voice-\d-[fm]$/.test(id);

module.exports = {
  id: 'kitten-server', label: 'KittenTTS server', logo: 'kitten',
  async detect(ctx) {
    const [api, voices, root] = await Promise.all([ctx.get('/openapi.json'), ctx.get('/v1/audio/voices'), ctx.get('/')]);
    if (/kitten/i.test(h.openapiTitle(api)) || (h.ok(root) && /kitten/i.test(String(root.body.message || root.body.name || '')))) return { ok: true, confidence: 0.95, tts: true };
    const ids = h.ok(voices) ? h.parseVoices(voices.body).map((v) => v.id) : [];
    if (ids.length && ids.filter(isKittenVoice).length >= Math.ceil(ids.length / 2)) return { ok: true, confidence: 0.85, tts: true };
    return { ok: false };
  },
  async capabilities(ctx) {
    const r = await ctx.get('/v1/audio/voices');
    return { voices: h.ok(r) ? h.parseVoices(r.body) : KITTEN_NAMES.map((n) => ({ id: n[0].toUpperCase() + n.slice(1), label: n[0].toUpperCase() + n.slice(1) })), models: ['tts-1'], formats: ['wav', 'mp3'], stream: false, voiceDesign: false, cloning: false, speed: true, emotion: false, stt: false, tts: true };
  },
  speak: (ctx, o) => speakOpenAI(ctx, o, { model: 'tts-1', label: 'The KittenTTS server' }),
};
