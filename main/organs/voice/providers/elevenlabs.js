// ElevenLabs (api.elevenlabs.io). Hosted: text, and for cloning the voice
// sample, leave this computer, and the UI says so. The key goes in xi-api-key.
// Voices: GET /v1/voices. Speech: POST /v1/text-to-speech/{voice_id}. Design:
// POST /v1/text-to-voice/design returns previews; saving one is
// POST /v1/text-to-voice. Cloning (IVC): multipart POST /v1/voices/add.
const h = require('./http');

const isEleven = (ctx) => /(^|\.)elevenlabs\.io$/.test(ctx.hostname);
const DEFAULT_MODEL = 'eleven_multilingual_v2';

module.exports = {
  id: 'elevenlabs', label: 'ElevenLabs', logo: 'elevenlabs', hosted: true,
  async detect(ctx) {
    if (!isEleven(ctx)) return { ok: false };
    const v = await ctx.get('/v1/voices', { auth: 'xi' });
    if (h.denied(v)) return { ok: false, needsKey: true };
    return h.ok(v) ? { ok: true, confidence: 1, tts: true, stt: true } : { ok: false };
  },
  async capabilities(ctx) {
    const [v, m] = await Promise.all([ctx.get('/v1/voices', { auth: 'xi' }), ctx.get('/v1/models', { auth: 'xi' })]);
    const voices = h.ok(v) ? h.parseVoices(v.body).map((x) => ({ ...x, label: x.type && x.type !== 'premade' ? `${x.label} (${x.type})` : x.label })) : [];
    const models = h.ok(m) && Array.isArray(m.body) ? m.body.filter((x) => x.can_do_text_to_speech !== false).map((x) => x.model_id) : [DEFAULT_MODEL, 'eleven_flash_v2_5', 'eleven_turbo_v2_5'];
    return { voices, models: models.length ? models : [DEFAULT_MODEL], sttModels: ['scribe_v1'], formats: ['mp3'], stream: true, voiceDesign: true, cloning: true, speed: true, emotion: false, stt: true, tts: true, hosted: true, designMin: 20 };
  },
  async speak(ctx, o) {
    const voice = o.voice || (ctx.caps && ctx.caps.voices && ctx.caps.voices[0] && ctx.caps.voices[0].id);
    if (!voice) throw new Error('ElevenLabs: pick a voice first');
    const body = { text: o.text, model_id: o.model || DEFAULT_MODEL, ...(o.speed && o.speed !== 1 ? { voice_settings: { speed: Math.max(0.7, Math.min(1.2, o.speed)) } } : {}) };
    const r = await h.request(ctx, 'POST', `/v1/text-to-speech/${encodeURIComponent(voice)}`, { json: body, query: { output_format: 'mp3_44100_128' }, auth: 'xi', label: 'ElevenLabs' });
    return { path: await h.saveAudio(ctx, r, 'mp3', 'ElevenLabs') };
  },
  async transcribe(ctx, o) {
    const j = await h.requestJson(ctx, 'POST', '/v1/speech-to-text', { form: h.form({ file: h.filePart(o.path), model_id: 'scribe_v1', ...(o.language ? { language_code: o.language } : {}) }), auth: 'xi', label: 'ElevenLabs', timeoutMs: 300000 });
    return { text: String(j.text || '').trim(), language: j.language_code || null };
  },
  // A prompt → a short preview to listen to; saving it makes a real voice.
  async design(ctx, { prompt, text }) {
    const j = await h.requestJson(ctx, 'POST', '/v1/text-to-voice/design', { json: { voice_description: prompt, ...(text && text.length >= 100 ? { text } : { auto_generate_text: true }) }, auth: 'xi', label: 'ElevenLabs' });
    const p = (j.previews || [])[0]; if (!p) throw new Error('ElevenLabs returned no preview');
    return { path: h.saveBase64(ctx, p.audio_base_64, 'mp3'), generatedId: p.generated_voice_id };
  },
  async saveDesign(ctx, { name, prompt, generatedId }) {
    const j = await h.requestJson(ctx, 'POST', '/v1/text-to-voice', { json: { voice_name: name, voice_description: prompt, generated_voice_id: generatedId }, auth: 'xi', label: 'ElevenLabs' });
    return { voiceId: j.voice_id };
  },
  async clone(ctx, { name, path }) {
    const j = await h.requestJson(ctx, 'POST', '/v1/voices/add', { form: h.form({ name, files: h.filePart(path), description: 'Cloned in Lyra' }), auth: 'xi', label: 'ElevenLabs' });
    return { voiceId: j.voice_id };
  },
};
