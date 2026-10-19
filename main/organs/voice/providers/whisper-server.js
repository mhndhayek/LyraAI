// Whisper servers: faster-whisper-server / speaches (OpenAI-style
// /v1/audio/transcriptions), and the whisper.cpp server (POST /inference).
// Speech to text only.
const h = require('./http');
const { transcribeOpenAI, listModels } = require('./openai-compatible');

module.exports = {
  id: 'whisper-server', label: 'Whisper server', logo: 'whisper', sttOnly: true,
  async detect(ctx) {
    const [trans, speech, inference, api] = await Promise.all([ctx.post('/v1/audio/transcriptions', {}), ctx.post('/v1/audio/speech', {}), ctx.post('/inference', {}), ctx.get('/openapi.json')]);
    const title = h.openapiTitle(api);
    // whisper.cpp's server: /inference, no /v1 routes at all.
    if (h.routeExists(inference) && !h.routeExists(trans)) return { ok: true, confidence: 0.85, stt: true, tts: false, flavor: 'whisper.cpp' };
    if (/speaches|faster.?whisper|whisper/i.test(title) && h.routeExists(trans)) return { ok: true, confidence: 0.9, stt: true, tts: h.routeExists(speech), version: api.body.info.version };
    // Transcribes but cannot speak: a Whisper server, not a full OpenAI copy.
    if (h.routeExists(trans) && !h.routeExists(speech)) return { ok: true, confidence: 0.7, stt: true, tts: false };
    return { ok: false };
  },
  async capabilities(ctx, d = {}) {
    let sttModels = d.flavor === 'whisper.cpp' ? ['(loaded model)'] : await listModels(ctx, /whisper|distil|parakeet|.+/i);
    if (!sttModels.length) sttModels = ['Systran/faster-whisper-small'];
    return { voices: [], models: [], sttModels, formats: [], stream: false, voiceDesign: false, cloning: false, speed: false, emotion: false, stt: true, tts: false, flavor: d.flavor || 'openai' };
  },
  async transcribe(ctx, o) {
    if (ctx.caps && ctx.caps.flavor === 'whisper.cpp') {
      const j = await h.requestJson(ctx, 'POST', '/inference', { form: h.form({ file: h.filePart(o.path), response_format: 'json', ...(o.language ? { language: o.language } : {}) }), label: 'The Whisper server', timeoutMs: 300000 });
      return { text: String(j.text || '').trim(), language: j.language || null };
    }
    return transcribeOpenAI(ctx, o, { model: (ctx.caps && ctx.caps.sttModels && ctx.caps.sttModels[0]) || 'whisper-1', label: 'The Whisper server' });
  },
};
