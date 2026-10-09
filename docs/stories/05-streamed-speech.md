# 05 · Speak while writing: streamed sentence-by-sentence voice · M

*As a user, Lyra starts talking within a second or two of starting to write. Her mouth only moves when sound is actually playing.*

## What's wrong today (0.9.12)
`main/organs/agent.js:276-281`: voice runs **after** the whole turn is done (`assistant:done`):
```js
this.setState('speaking');                       // ← mouth starts moving now…
const a = await voice.tts(content.text);         // ← …while the *entire* reply is synthesised in one call
emit(chatId, 'tts', { id: asst.id, path: a.path });  // ← one file, played only at the end
```
So there are two bugs you noticed:
1. The full text goes to TTS at once, and one long audio file comes back. The wait grows with reply length.
2. `speaking` is set before any audio exists, so the 3D mouth animates in silence (`character.js:113` fakes `aa` when there's no audio attached).

## Change
1. **Sentence chunker** (new `main/organs/speech-queue.js`): it's fed from `onDelta` (`agent.js:231`) and emits a chunk when it sees a sentence end (`. ! ? …` or a newline), or once 220 chars pass without one. It skips code blocks, URLs and tool output. The first chunk is allowed to be short (≥ 40 chars) so speech starts fast. It strips markdown and emoji the same way `Voice.speakable()` does.
2. **Synthesis pipeline**: at most **2 TTS requests in flight**, kept in order. Each chunk calls the existing `voice.tts(chunkText)`, so there's no change to `voice.js` and the story is independent of 04. It emits `tts:chunk { id, seq, path, final? }`.
3. **Playback queue** (`renderer/app.js`): play `tts:chunk`s strictly in `seq` order without gaps, and attach each `Audio` to the character's lip-sync analyser. After the turn ends, the message's single audio pill plays the chunks back-to-back. An optional concat into one file happens in the background for saving.
4. **State honesty**: while writing, the state stays `writing`. It switches to `speaking` on the first `audio.play()` resolve in the renderer, which reports back over IPC. It returns to `idle` on the last chunk's `ended`. With no audio attached, the mouth stays closed: remove the fake `aa` oscillation in `character.js:113`. Stop/new message cancels pending synth and clears the queue.
5. **Settings**: Voice › "Start speaking before the reply is finished" (on by default). Off gives today's behaviour.

**Owns:** new `main/organs/speech-queue.js`, `main/organs/agent.js` (stream hook + the voice block at 276-281), `renderer/app.js` (`case 'tts'`, `playAudio`, new queue), `renderer/character.js:113` (that one line only), `preload.js` (`tts:chunk`, `voice:playing`), `main/organs/index.js` (handler), the setting default.

## QA
1. **Failing-first** `test/organs/speech-queue.test.js`: feed deltas `"Hi there. How are"`, `" you? Fine."` and expect chunks exactly `["Hi there.", "How are you?", "Fine."]` in order. Code fences aren't spoken, and a 600-char run-on sentence is split at ≤ 220.
2. Ordering under jitter: a fake `tts` resolves chunk 2 before chunk 1, and the emitted `seq` order is still 1, 2.
3. At most 2 synth calls are in flight at once (counter assertion).
4. Cancel: stopping mid-reply makes no further `tts` calls and resolves the queue.
5. State: a test asserts `speaking` isn't emitted before the renderer's `voice:playing`.
6. **Mac demo** (screen recording with sound): ask *"tell me a 6-sentence story"* with OmniVoice or on-device voice. **Time to first audio** should be under 3 s after the first sentence appears, versus about the full reply time today. The mouth is still until sound starts. Put both timings in the PR.
