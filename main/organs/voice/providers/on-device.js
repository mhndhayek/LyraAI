// The on-device engine: KittenTTS to speak and Whisper to listen, in the Python
// sidecar under voice/. No endpoint, nothing leaves the computer. The sidecar
// itself is driven by the Voice organ, which passes itself in as ctx.sidecar.
const FALLBACK_VOICES = ['Rosie', 'Bella', 'Jasmine', 'Luna', 'Jasper', 'Leo', 'Ben', 'Axel'];

module.exports = {
  id: 'on-device', label: 'On-device (KittenTTS + Whisper)', logo: 'on-device', local: true,
  async detect() { return { ok: true, confidence: 1, tts: true, stt: true }; },
  async capabilities(ctx) {
    let voices = FALLBACK_VOICES;
    if (ctx.sidecar && ctx.sidecar.available()) { try { voices = await ctx.sidecar.kittenVoices(); } catch {} }
    return { voices: voices.map((v) => ({ id: v, label: v })), models: ['KittenML/kitten-tts-nano-0.1'], sttModels: ['tiny', 'base', 'small', 'medium', 'large-v3'], formats: ['wav'], stream: false, voiceDesign: false, cloning: false, speed: false, emotion: false, stt: true, tts: true };
  },
  speak(ctx, o) { return ctx.sidecar.kittenTts(o.text, o.voice); },
  transcribe(ctx, o) { return ctx.sidecar.whisperStt(o.path, o.language); },
  FALLBACK_VOICES,
};
