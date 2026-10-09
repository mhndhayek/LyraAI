# 04 · Voice providers: detect + configure all the common TTS/STT APIs · L

*As a user, I point Lyra at any voice server (local or remote) or keep the on-device engine, and she figures out what it is, which voices it has, and what it can do. If the server can design a voice from a prompt or clone one from a sample, those controls show up.*

## What's wrong today (0.9.12)
- `main/organs/voice.js` knows three engines: `kitten` (the on-device sidecar), `custom` (`POST {endpoint}/audio/speech` with OpenAI-style JSON, no auth header, fixed model/voice strings) and `say` (the macOS fallback).
- There's no detection, no voice list for `custom`, no API key, and STT is on-device Whisper only.
- On lucix, OmniVoice (`/v1/audio/speech`, `/v1/voices`, `/health`) can only be used by typing the URL and guessing a voice name.

## Design: a provider registry with capabilities
`main/organs/voice/providers/<id>.js` (one small file each), all with the same shape:
```js
module.exports = {
  id: 'kokoro', label: 'Kokoro', logo: 'kokoro',
  async detect({ endpoint, apiKey }) { /* → { ok, version?, confidence } */ },
  async capabilities(ctx) { /* → { voices:[{id,label,lang,gender?}], models:[], formats:['wav','mp3'], stream:bool,
                                    voiceDesign:bool, cloning:bool, speed:bool, emotion:bool, stt:bool } */ },
  async speak(ctx, { text, voice, model, speed, format, design, cloneRef }) { /* → { path } */ },
  async transcribe?(ctx, { path, language }) { /* → { text, language } */ },
};
```
`voice.js` keeps `tts(text)` / `stt(path)` as the public API, so story 05 doesn't change. Underneath it picks the selected provider, and on failure falls back as today (provider → on-device → `say`).

**Providers for v1** (detection is plain HTTP probes, run in parallel with a 3 s timeout, auth on every probe):

| Provider | Typical endpoint | Detect by | Caps to expose |
|---|---|---|---|
| On-device (KittenTTS + Whisper) | sidecar | — | voices, STT |
| OpenAI-compatible (OpenAI, and anything that copies it) | `…/v1` | `POST /audio/speech` 200, `/models` | model, voice, speed, format; STT via `/audio/transcriptions` |
| Kokoro-FastAPI | `:8880/v1` | `GET /v1/audio/voices` | voices (incl. mixes `af_bella+af_sky`), speed, stream |
| OmniVoice (lucix) | `:8880/v1` | `GET /v1/voices` + `/health` + `openapi.json` title/paths | voices; **voice design / cloning if its OpenAPI lists them** |
| Fish Speech / OpenAudio | `:8080` | `GET /v1/health` + `POST /v1/tts` schema | reference-audio **cloning**, emotion tags |
| Kitten TTS server (remote) | — | OpenAPI paths | voices |
| ElevenLabs | `api.elevenlabs.io` | key + `GET /v1/voices` | voices, **cloning** (IVC), **voice design** (`/v1/text-to-voice`), stream |
| Whisper servers (faster-whisper-server / speaches, whisper.cpp server) | `…/v1` | `POST /audio/transcriptions` | STT only |

Generic fallback: when nothing matches but `openapi.json` exists, read its paths and map `*/audio/speech` → speak, `*/voices` → voice list, `*/clone*`/`reference` → cloning, `*design*`/`instruct*` → voice design. That's how new servers "just work" without a new file.

**UI (Settings › Voice + the setup Voice step):**
- The same pattern as story 02: **Endpoint**, **API key (optional)** and **Connect**, which shows `[logo] Connected · Kokoro · 54 voices · streaming`. A separate **Speech-to-text** card works the same way, with *On-device (Whisper)* as the default.
- A voice picker with a ▶ preview for each voice, plus speed (if supported).
- **Capability-driven panels.** Each panel appears only when the capability is true:
  - **Design a voice**: a text prompt ("warm, playful, slight British accent") → preview → save as a named voice
  - **Clone a voice**: record or upload 10–30 s → consent checkbox ("I have the right to use this voice") → preview → save
  - **Emotion/style**: a dropdown, if the provider exposes tags

**Owns:** `main/organs/voice.js`, the new `main/organs/voice/providers/*`, `renderer/settings.js` (Voice section only), `renderer/setup.js` (`voice()` only, coordinate with 01), `main/kernel/settings.js` (voice defaults + migration of `engine: 'custom'` → `provider: 'openai-compatible'`), `main/organs/organs.json`, `docs/AGENT.md`.

## QA
1. **Failing-first** `test/organs/voice-providers.test.js`: one fake HTTP server per provider. `detect()` picks the right id for each, and two servers sharing `:8880` shapes (Kokoro vs OmniVoice) are told apart.
2. Capability fixtures: a fake whose OpenAPI lists a clone path gets `cloning: true`, and the Voice settings render the Clone panel (DOM test via the existing smoke harness). Without it, the panel is absent.
3. 401 → "Needs an API key", not "unreachable".
4. Fallback: the provider throws, so `tts()` returns on-device audio and the log entry names the provider.
5. Settings migration test: an old `engine: 'custom', customEndpoint` profile maps to the OpenAI-compatible provider with the same URL.
6. **Mac demo** (tunnel to lucix, see the README): connect to OmniVoice on `localhost:8880/v1`, the voice list loads, ▶ preview plays, and you send a chat that gets read aloud. Repeat with Fish once its port is confirmed. Attach a screenshot of the capability panels that appeared.

## 4.5 · Needs approval
- **A.** Hosted providers (ElevenLabs, OpenAI) send text, and for cloning *your voice sample*, off the machine. Do we include them in v1, or local and self-hosted only?
- **B.** Cloning needs a consent checkbox and stores the sample under `<userData>/media/voices/`. OK?
- **C.** Priority if we have to cut: proposal is OpenAI-compatible → OmniVoice → Kokoro → Fish → Whisper servers → ElevenLabs.
