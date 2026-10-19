// The generic fallback: nothing above matched, but the server publishes an
// OpenAPI description. Its paths say what it can do (see openapi.js), so a new
// server "just works" without a file of its own.
const h = require('./http');
const oa = require('./openapi');

module.exports = {
  id: 'openapi', label: 'Voice server (from its API description)', logo: 'openai',
  async detect(ctx) {
    const api = await ctx.get('/openapi.json');
    const a = h.ok(api) ? oa.analyze(api.body) : null;
    if (!a || (!a.speech && !a.stt)) return { ok: false };
    return { ok: true, confidence: 0.3, tts: !!a.speech, stt: a.stt, label: a.title || undefined };
  },
  async capabilities(ctx) {
    const api = await ctx.get('/openapi.json');
    const a = oa.analyze(api.body);
    let voices = [];
    if (a.voicesPath) { const r = await ctx.get(a.voicesPath); if (h.ok(r)) voices = h.parseVoices(r.body); }
    return { voices, models: [], formats: ['wav'], stream: a.stream, voiceDesign: a.voiceDesign, cloning: a.cloning, speed: a.speed, emotion: false, stt: a.stt, tts: !!a.speech, analysis: a, clonePath: a.clone ? a.clone.path : null, title: a.title };
  },
  async speak(ctx, o) {
    const a = (ctx.caps && ctx.caps.analysis) || null;
    if (o.cloneRef && a && a.clone) {
      const f = oa.cloneFields(a, o);
      const fields = { [f.text]: o.text, [f.audio]: h.filePart(o.cloneRef.path) };
      if (f.refText && o.cloneRef.text) fields[f.refText] = o.cloneRef.text;
      const r = await h.request(ctx, 'POST', a.clone.path, { form: h.form(fields), label: 'The voice server' });
      return { path: await h.saveAudio(ctx, r) };
    }
    if (!a || !a.speech) throw new Error('This server does not list a speech route');
    const r = await h.request(ctx, 'POST', a.speech.path, { json: oa.speechBody(a, o), label: 'The voice server' });
    return { path: await h.saveAudio(ctx, r) };
  },
};
