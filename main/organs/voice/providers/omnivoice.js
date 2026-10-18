// OmniVoice (k2-fsa/OmniVoice behind omnivoice-server), the server on lucix,
// usually on :8880 like Kokoro. Told apart by GET /v1/voices (OmniVoice) vs
// GET /v1/audio/voices (Kokoro), /health, and the OpenAPI title and paths.
// Voice design is the `instructions` field on /v1/audio/speech; cloning is a
// multipart POST to /v1/audio/speech/clone. Both show only when the server's
// OpenAPI lists them.
const h = require('./http');
const oa = require('./openapi');

const PRESET_LABEL = (v) => (v.description ? `${v.id} · ${String(v.description).replace(/^.*?mapped to:\s*/i, '').slice(0, 60)}` : v.id);

module.exports = {
  id: 'omnivoice', label: 'OmniVoice', logo: 'omnivoice',
  async detect(ctx) {
    const [voices, health, api] = await Promise.all([ctx.get('/v1/voices'), ctx.get('/health'), ctx.get('/openapi.json')]);
    const title = h.openapiTitle(api); const paths = h.openapiPaths(api);
    if (/omnivoice/i.test(title)) return { ok: true, confidence: 0.95, tts: true, version: api.body.info.version };
    const typed = h.ok(voices) && Array.isArray(voices.body.voices) && voices.body.voices.some((v) => v && ['design', 'preset', 'clone', 'auto'].includes(v.type));
    if (typed || (h.ok(voices) && voices.body.design_attributes)) return { ok: true, confidence: 0.9, tts: true };
    if (paths.includes('/v1/voices') && paths.includes('/v1/audio/speech/clone')) return { ok: true, confidence: 0.8, tts: true };
    if (h.ok(voices) && h.ok(health) && !paths.includes('/v1/audio/voices')) return { ok: true, confidence: 0.5, tts: true };
    return { ok: false };
  },
  async capabilities(ctx) {
    const [voices, api] = await Promise.all([ctx.get('/v1/voices'), ctx.get('/openapi.json')]);
    const a = h.ok(api) ? oa.analyze(api.body) : null;
    const list = h.ok(voices) && Array.isArray(voices.body.voices) ? voices.body.voices : [];
    // "design:<attributes>" and "auto" are instructions to the server, not voices to pick.
    const out = list.filter((v) => v && v.id && v.type !== 'design' && v.type !== 'auto' && !String(v.id).includes('<'))
      .map((v) => ({ id: v.id, label: v.type === 'clone' ? `${v.profile_id || v.id} (cloned on the server)` : PRESET_LABEL(v), type: v.type }));
    const attrs = h.ok(voices) && voices.body.design_attributes ? voices.body.design_attributes : null;
    return {
      voices: out, models: ['omnivoice'], formats: ['wav', 'pcm'], stream: !!(a && a.stream), speed: a ? a.speed : true, emotion: false, stt: false, tts: true,
      // Only what the server says it has: no OpenAPI, no panels.
      voiceDesign: !!(a && a.voiceDesign), cloning: !!(a && a.cloning), designAttributes: attrs,
      designHint: attrs ? 'Comma-separated attributes, e.g. female, young adult, high pitch, british accent' : null,
      clonePath: a && a.clone ? a.clone.path : null, analysis: a,
    };
  },
  async speak(ctx, o) {
    const caps = ctx.caps || {};
    if (o.cloneRef) {
      const a = caps.analysis || null; const f = oa.cloneFields(a, o);
      const fields = { [f.text]: o.text, [f.audio]: h.filePart(o.cloneRef.path) };
      if (f.refText && o.cloneRef.text) fields[f.refText] = o.cloneRef.text;
      if (f.speed && o.speed && o.speed !== 1) fields[f.speed] = o.speed;
      const r = await h.request(ctx, 'POST', caps.clonePath || '/v1/audio/speech/clone', { form: h.form(fields), label: 'OmniVoice' });
      return { path: await h.saveAudio(ctx, r, 'wav', 'OmniVoice') };
    }
    const body = { model: 'omnivoice', input: o.text, response_format: 'wav', ...(o.voice && !o.design ? { voice: o.voice } : {}), ...(o.speed && o.speed !== 1 ? { speed: o.speed } : {}), ...(o.design ? { instructions: o.design } : {}) };
    const r = await h.request(ctx, 'POST', '/v1/audio/speech', { json: body, label: 'OmniVoice' });
    return { path: await h.saveAudio(ctx, r, 'wav', 'OmniVoice') };
  },
};
