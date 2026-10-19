// The voice provider registry. Every provider is one small file with the same
// shape: { id, label, logo, detect(ctx), capabilities(ctx, detected),
// speak(ctx, opts), transcribe?(ctx, opts) }.
//
// detect() runs every provider's probes in parallel against one shared context
// (each GET is made once, with the key), then keeps the most specific match:
// a server that says it is OmniVoice beats one that merely answers
// /v1/audio/speech. The OpenAPI fallback only wins when nothing else matched.
const h = require('./http');

const PROVIDERS = [
  require('./on-device'),
  require('./openai-compatible'),
  require('./kokoro'),
  require('./omnivoice'),
  require('./fish'),
  require('./kitten-server'),
  require('./elevenlabs'),
  require('./whisper-server'),
  require('./openapi-generic'),
];
const byId = (id) => PROVIDERS.find((p) => p.id === id) || null;
const remote = () => PROVIDERS.filter((p) => !p.local);

// What leaves the computer, said plainly, for the UI and the log.
function privacyNote(place, provider) {
  if (place === 'this-mac') return null;
  if (place === 'network') return 'Text you hear (and any voice sample you clone) is sent to this server on your network.';
  return `Sends data off this Mac: the text of every spoken reply${provider && provider.hosted ? ', and any voice sample you clone,' : ''} goes to ${provider && provider.hosted ? provider.label : 'this server'} over the internet.`;
}

// { ok, id, label, logo, endpoint, place, privacy, version, caps, needsKey, error }.
// role is 'tts' or 'stt': which kind of server the card is looking for.
async function detect({ endpoint, apiKey = '' } = {}, { role = 'tts' } = {}) {
  const ctx = h.makeCtx({ endpoint, apiKey });
  if (!ctx.endpoint) return { ok: false, error: 'Enter the server address first.' };
  const out = { ok: false, endpoint: ctx.endpoint, place: ctx.place, needsKey: false, error: null };
  const results = await Promise.all(remote().map(async (p) => {
    try { return { p, d: await p.detect(ctx) }; } catch (e) { return { p, d: { ok: false, error: e.message } }; }
  }));
  const fits = (d) => d.ok && (role === 'stt' ? d.stt === true : d.tts !== false);
  const hits = results.filter((r) => fits(r.d)).sort((a, b) => (b.d.confidence || 0) - (a.d.confidence || 0));
  if (!hits.length) {
    const askedForKey = results.some((r) => r.d.needsKey) || ctx.anyDenied();
    if (askedForKey) { out.needsKey = true; out.error = apiKey ? 'The server refused this API key (401/403).' : 'This server needs an API key.'; return out; }
    if (results.some((r) => r.d.ok)) { out.error = role === 'stt' ? 'This server can speak but not transcribe. Pick it under Text to speech.' : 'This server only transcribes. Pick it under Speech to text.'; return out; }
    out.error = ctx.anyAnswer() ? 'A server answered, but not as any voice API Lyra knows.' : `Not reachable${ctx.lastError() ? ` (${ctx.lastError()})` : ''}.`;
    return out;
  }
  const { p, d } = hits[0];
  const caps = await p.capabilities(ctx, d);
  return { ...out, ok: true, id: p.id, label: d.label || p.label, logo: p.logo, version: d.version || null, caps: strip(caps), fullCaps: caps, privacy: privacyNote(ctx.place, p), confidence: d.confidence };
}

// What goes to the renderer and the settings file: no parsed OpenAPI documents.
function strip(caps) { const { analysis, ...rest } = caps || {}; return { ...rest, ...(analysis ? { routes: { speech: analysis.speech && analysis.speech.path, clone: analysis.clone && analysis.clone.path, design: analysis.design && analysis.design.path } } : {}) }; }

// The one-line status: "Kokoro · 54 voices · streaming".
function summary(r) {
  if (!r || !r.ok) return '';
  const c = r.caps || {}; const bits = [r.label];
  if (c.tts && c.voices) bits.push(`${c.voices.length} voice${c.voices.length === 1 ? '' : 's'}`);
  if (c.stream) bits.push('streaming');
  if (c.voiceDesign) bits.push('voice design');
  if (c.cloning) bits.push('cloning');
  if (c.emotion) bits.push('emotions');
  if (c.stt && !c.tts) bits.push('speech to text');
  if (r.version) bits.push(String(r.version));
  return bits.join(' · ');
}

module.exports = { PROVIDERS, byId, detect, summary, strip, privacyNote, makeCtx: h.makeCtx, normalize: h.normalize, placeOf: h.placeOf };
