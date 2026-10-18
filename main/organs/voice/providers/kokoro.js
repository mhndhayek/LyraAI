// Kokoro-FastAPI (remsky/Kokoro-FastAPI), usually on :8880. Lists its voices at
// GET /v1/audio/voices as ids like af_bella; any two can be mixed: af_bella+af_sky.
const h = require('./http');
const { speakOpenAI } = require('./openai-compatible');

const KOKORO_ID = /^[a-z][a-z]_[a-z0-9]+$/;
// The first letter of a Kokoro voice is its language, the second its gender.
const LANG = { a: 'American English', b: 'British English', e: 'Spanish', f: 'French', h: 'Hindi', i: 'Italian', j: 'Japanese', p: 'Portuguese', z: 'Mandarin' };

function voicesOf(body) {
  return h.parseVoices(body).map((v) => {
    const m = /^([a-z])([fm])_(.+)$/.exec(v.id);
    if (!m) return v;
    const name = m[3].replace(/(^|_)([a-z])/g, (_, s, c) => `${s ? ' ' : ''}${c.toUpperCase()}`);
    return { ...v, label: `${name} · ${LANG[m[1]] || m[1]}`, lang: LANG[m[1]] || m[1], gender: m[2] === 'f' ? 'female' : 'male' };
  });
}

module.exports = {
  id: 'kokoro', label: 'Kokoro', logo: 'kokoro',
  async detect(ctx) {
    const [voices, api] = await Promise.all([ctx.get('/v1/audio/voices'), ctx.get('/openapi.json')]);
    const title = h.openapiTitle(api);
    const ids = h.ok(voices) ? h.parseVoices(voices.body).map((v) => v.id) : [];
    const looksKokoro = ids.length > 0 && ids.filter((id) => KOKORO_ID.test(id)).length >= Math.ceil(ids.length / 2);
    if (/kokoro/i.test(title)) return { ok: true, confidence: 0.95, tts: true, version: api.body.info.version };
    if (looksKokoro) return { ok: true, confidence: 0.85, tts: true };
    return { ok: false };
  },
  async capabilities(ctx) {
    const r = await ctx.get('/v1/audio/voices');
    return { voices: h.ok(r) ? voicesOf(r.body) : [], models: ['kokoro'], formats: ['wav', 'mp3', 'opus', 'flac', 'pcm'], stream: true, mixes: true, voiceDesign: false, cloning: false, speed: true, emotion: false, stt: false, tts: true };
  },
  speak: (ctx, o) => speakOpenAI(ctx, o, { model: 'kokoro', label: 'Kokoro' }),
  voicesOf,
};
