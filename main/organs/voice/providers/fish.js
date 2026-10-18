// Fish Speech / OpenAudio (fishaudio/fish-speech), usually on :8080. GET
// /v1/health answers {"status":"ok"}; speech is POST /v1/tts with {text,
// format, reference_id | references:[{audio, text}]}. A reference recording is
// all cloning needs, so cloning is always on. Emotion is inline tags in the
// text, e.g. "(excited) Hi!".
const h = require('./http');
const fs = require('fs');

const EMOTIONS = ['angry', 'sad', 'excited', 'surprised', 'satisfied', 'delighted', 'scared', 'worried', 'nervous', 'frustrated', 'embarrassed', 'empathetic', 'curious', 'sarcastic', 'joyful', 'confident', 'whispering', 'laughing'];

module.exports = {
  id: 'fish', label: 'Fish Speech', logo: 'fish',
  async detect(ctx) {
    const [health, api, tts] = await Promise.all([ctx.get('/v1/health'), ctx.get('/openapi.json'), ctx.post('/v1/tts', {})]);
    const paths = h.openapiPaths(api); const title = h.openapiTitle(api);
    if (/fish|openaudio/i.test(title) || paths.includes('/v1/tts')) return { ok: true, confidence: 0.9, tts: true };
    // The real server serves its docs elsewhere, so: the health shape plus a
    // /v1/tts route that rejects an empty body.
    if (h.ok(health) && health.body.status === 'ok' && h.routeExists(tts)) return { ok: true, confidence: 0.8, tts: true };
    return { ok: false };
  },
  async capabilities(ctx) {
    const refs = await ctx.get('/v1/references/list');
    const ids = h.ok(refs) && Array.isArray(refs.body.reference_ids) ? refs.body.reference_ids : [];
    return {
      voices: ids.map((id) => ({ id, label: `${id} (saved on the server)` })), models: ['fish-speech'], formats: ['wav', 'mp3', 'opus'],
      stream: true, speed: false, voiceDesign: false, cloning: true, emotion: true, emotions: EMOTIONS, stt: false, tts: true, defaultVoice: '',
    };
  },
  async speak(ctx, o) {
    const text = o.emotion ? `(${o.emotion}) ${o.text}` : o.text;
    const body = { text, format: 'wav', normalize: true };
    if (o.cloneRef) body.references = [{ audio: fs.readFileSync(o.cloneRef.path).toString('base64'), text: o.cloneRef.text || '' }];
    else if (o.voice) body.reference_id = o.voice;
    const r = await h.request(ctx, 'POST', '/v1/tts', { json: body, label: 'Fish Speech' });
    return { path: await h.saveAudio(ctx, r, 'wav', 'Fish Speech') };
  },
  EMOTIONS,
};
