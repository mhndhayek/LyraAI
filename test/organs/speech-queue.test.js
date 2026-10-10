// Story 05: speak while writing. The chunker turns streamed text into
// sentences, the queue synthesises them (at most two at a time) and hands the
// audio back in reading order, and the agent only says "speaking" once the
// window reports that sound is playing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { SentenceChunker, SpeechQueue, joinWavs, MAX_CHUNK } = require('../../main/organs/speech-queue');
const { tmpdir, cleanup } = require('../helpers/tmp');

test.after(cleanup);

const chunks = (deltas, opts) => { const c = new SentenceChunker(opts); const out = []; for (const d of deltas) out.push(...c.push(d)); out.push(...c.flush()); return out; };
const tick = () => new Promise((r) => setImmediate(r));
const deferred = () => { let resolve, reject; const p = new Promise((a, b) => { resolve = a; reject = b; }); return { p, resolve, reject }; };

/* ---------- 1. the chunker ---------- */

test('deltas become whole sentences, in order', () => {
  assert.deepEqual(chunks(['Hi there. How are', ' you? Fine.']), ['Hi there.', 'How are you?', 'Fine.']);
});

test('a sentence is emitted as soon as it ends, before the reply does', () => {
  const c = new SentenceChunker();
  assert.deepEqual(c.push('Hi there. How'), ['Hi there.'], 'the first sentence must not wait for the rest');
  assert.deepEqual(c.push(' are you'), []);
  assert.deepEqual(c.push('? Fine'), ['How are you?']);
  assert.deepEqual(c.flush(), ['Fine']);
});

test('code fences are never spoken, even when split across deltas', () => {
  assert.deepEqual(chunks(['Run this:\n``', '`js\nconst a = 1. b = 2.\nconsole.log(a);\n`', '``\nThat prints one.']), ['Run this:', 'That prints one.']);
  assert.deepEqual(chunks(['Before. ```py\nprint("never ends")']), ['Before.'], 'an unclosed fence swallows the rest');
});

test('a 600-character run-on sentence is split into pieces of at most 220', () => {
  const words = Array.from({ length: 120 }, (_, i) => `word${i % 10}`).join(' '); // ~600 chars, no punctuation
  assert.ok(words.length >= 590);
  const out = chunks([words.slice(0, 250), words.slice(250)]);
  assert.ok(out.length >= 3, `expected at least 3 pieces, got ${out.length}`);
  for (const c of out) assert.ok(c.length <= MAX_CHUNK, `chunk of ${c.length} chars is over the limit`);
  assert.equal(out.join(' '), words, 'nothing is lost or reordered, and words are not cut in half');
});

test('the first chunk may stop at a comma so speech starts quickly; later ones wait for the sentence', () => {
  const out = chunks(['Well, that is a really interesting question to think about, and honestly I have a few thoughts, so here goes nothing.']);
  assert.equal(out[0], 'Well, that is a really interesting question to think about,');
  assert.equal(out[1], 'and honestly I have a few thoughts, so here goes nothing.');
});

test('decimals, domains, abbreviations and numbered lists are not sentence ends', () => {
  assert.deepEqual(chunks(['Pi is 3.14 roughly. See example.com today. Dr. Smith agrees.']), ['Pi is 3.14 roughly.', 'See example.com today.', 'Dr. Smith agrees.']);
  assert.deepEqual(chunks(['Steps:\n1. Open it.\n2. Close it.']), ['Steps:', '1. Open it.', '2. Close it.']);
});

test('markdown, links, bare URLs and emoji are cleaned like the whole-reply path', () => {
  assert.deepEqual(chunks(['**Bold** and _soft_ 🎉. Read [the docs](https://x.dev/a.b) or https://x.dev/a.b now.\n- a bullet\n']), ['Bold and soft .', 'Read the docs or now.', 'a bullet']);
  assert.deepEqual(chunks(['🎉🎉\n', '---\n', 'Real words.']), ['Real words.'], 'chunks with nothing to say are dropped');
});

/* ---------- 2–4. the queue ---------- */

test('chunks come out in seq order even when synthesis finishes out of order', async () => {
  const pending = [];
  const tts = (text) => { const d = deferred(); pending.push({ text, d }); return d.p; };
  const got = [];
  const q = new SpeechQueue({ tts, onChunk: (c) => got.push(c) });
  q.push('One here. Two here. ');
  await tick();
  assert.equal(pending.length, 2);
  pending[1].d.resolve({ path: '/two.wav' }); // chunk 2 finishes first
  await tick(); await tick();
  assert.deepEqual(got, [], 'chunk 2 must wait for chunk 1');
  pending[0].d.resolve({ path: '/one.wav' });
  await tick(); await tick();
  assert.deepEqual(got.map((c) => [c.seq, c.path]), [[1, '/one.wav'], [2, '/two.wav']]);
  q.finish();
  const r = await q.done;
  assert.deepEqual(got.map((c) => c.seq), [1, 2, 3], 'a terminator closes the stream');
  assert.equal(got[2].final, true); assert.equal(got[2].path, null);
  assert.deepEqual(r.chunks.map((c) => c.path), ['/one.wav', '/two.wav']);
});

test('at most two synthesis calls are in flight at once', async () => {
  let inFlight = 0, peak = 0, calls = 0;
  const tts = async () => { calls++; inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 5 + Math.random() * 10)); inFlight--; return { path: `/c${calls}.wav` }; };
  const got = [];
  const q = new SpeechQueue({ tts, onChunk: (c) => got.push(c) });
  for (let i = 1; i <= 8; i++) q.push(`Sentence number ${i}. `);
  q.finish();
  await q.done;
  assert.equal(calls, 8);
  assert.equal(peak, 2, `peak concurrency was ${peak}`);
  assert.deepEqual(got.map((c) => c.seq), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(got[7].final, true, 'the last real chunk carries final when the reply already ended');
});

test('stopping mid-reply makes no further tts calls and resolves the queue', async () => {
  const pending = []; let calls = 0;
  const tts = () => { calls++; const d = deferred(); pending.push(d); return d.p; };
  const got = [];
  const q = new SpeechQueue({ tts, onChunk: (c) => got.push(c) });
  q.push('A one. B two. C three. D four. ');
  await tick();
  assert.equal(calls, 2);
  const r = await q.cancel();
  assert.equal(r.cancelled, true);
  q.push('E five. F six. '); q.finish();
  for (const d of pending) d.resolve({ path: '/late.wav' });
  await tick(); await tick();
  assert.equal(calls, 2, 'nothing new is synthesised after stop');
  assert.deepEqual(got, [], 'and nothing that finishes late is emitted');
});

test('a failed sentence is skipped, not fatal, and the rest still plays in order', async () => {
  const errors = [];
  const tts = async (text) => { if (text.startsWith('Bad')) throw new Error('engine hiccup'); return { path: `/${text.split(' ')[0]}.wav` }; };
  const got = [];
  const q = new SpeechQueue({ tts, onChunk: (c) => got.push(c), onError: (e) => errors.push(e.message) });
  q.push('Good one. Bad two. Good three.'); q.finish();
  const r = await q.done;
  assert.deepEqual(got.map((c) => [c.seq, c.path]), [[1, '/Good.wav'], [2, null], [3, '/Good.wav']]);
  assert.deepEqual(errors, ['engine hiccup']);
  assert.equal(r.chunks.length, 2);
});

test('a runaway reply stops being spoken at the character limit', async () => {
  let limited = null; const spoken = [];
  const q = new SpeechQueue({ tts: async (t) => { spoken.push(t); return { path: '/x.wav' }; }, onLimit: (n) => { limited = n; }, limit: 50 });
  q.push('This sentence is thirty chars. And this one pushes past the limit. And more.'); q.finish();
  const r = await q.done;
  assert.equal(r.truncated, true); assert.equal(limited, 30);
  assert.deepEqual(spoken, ['This sentence is thirty chars.']);
});

/* ---------- 5. state honesty, through the real agent ---------- */

const { Agent } = require('../../main/organs/agent');
const llm = require('../../main/organs/llm');

function agentHarness({ readAloud = true, streamSpeech = true, text = ['Hello there. ', 'This is Lyra. ', 'Goodbye.'], tts } = {}) {
  const events = []; const messages = new Map(); let n = 0; const logs = [];
  const settings = {
    voice: { readAloud, streamSpeech }, chat: { followUp: 'cancel' }, persona: { name: 'Lyra', soul: '', memoryEnabled: false },
    model: { chat: {}, contextMode: 'auto', reasoning: 'off', compression: false, maxSteps: 5, runMinutes: 5, temperature: 0.7 },
    memory: { profileBudget: 100 }, workspace: { repoDiscovery: false }, tools: {}, browser: { mode: 'headless' }, providers: { list: [{ id: 'p', name: 'Test', endpoint: 'http://x/v1' }] },
  };
  const store = {
    getChat: () => ({ id: 'c1', title: 'chat', summarized_count: 0 }), listMessages: () => [], updateChat() {}, countMessages: () => 99,
    addMessage: (chatId, role, content) => { const m = { id: `m${++n}`, role, content: { ...content }, created_at: Date.now() }; messages.set(m.id, m); return m; },
    updateMessage: (id, content) => { messages.get(id).content = JSON.parse(JSON.stringify(content)); },
  };
  const ttsCalls = [];
  const voice = { tts: tts || (async (t) => { ttsCalls.push(t); return { path: `/tmp/fake-${ttsCalls.length}.wav`, engine: 'fake' }; }), outPath: () => '/tmp/joined.wav' };
  const ctx = {
    settings: { get: () => settings, set() {} }, store, voice, emit: (chatId, type, p) => events.push({ chatId, type, ...p }),
    approvals: { cancelAll() {}, request: async () => ({ decision: 'approved' }) }, browser: { beginTurn() {}, stop() {} }, notify() {}, root: () => '/tmp', runShell() {},
    kernel: { logs: { info: (s, m) => logs.push(m), warn: (s, m) => logs.push(m), error: (s, m) => logs.push(m) }, extensions: { tools: () => [] }, afterRun: async () => {}, appState: () => ({}) },
  };
  const agent = new Agent(ctx);
  agent.pickModel = async () => ({ id: 'test-model', context: 8192, endpoint: 'http://x/v1', tools: false });
  agent.title = async () => {};
  const restore = llm.chatStream;
  llm.chatStream = async ({ onDelta }) => { for (const d of text) { onDelta(d); await tick(); } return { text: text.join(''), toolCalls: [] }; };
  return { agent, events, messages, ttsCalls, logs, done: () => { llm.chatStream = restore; } };
}
const states = (events) => events.filter((e) => e.type === 'state').map((e) => e.state);
const until = async (fn, ms = 2000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 5)); } };

test('the agent never says "speaking" before the window reports sound', async () => {
  const h = agentHarness();
  try {
    await h.agent.run({ chatId: 'c1', text: 'hi' });
    await until(() => h.events.some((e) => e.type === 'tts:chunk' && e.final));
    assert.ok(!states(h.events).includes('speaking'), `states so far: ${states(h.events).join(' → ')}`);
    const chunkEvents = h.events.filter((e) => e.type === 'tts:chunk');
    assert.deepEqual(chunkEvents.map((e) => e.seq), [1, 2, 3]);
    assert.deepEqual(h.ttsCalls, ['Hello there.', 'This is Lyra.', 'Goodbye.'], 'each sentence is synthesised on its own');
    h.agent.voicePlaying({ chatId: 'c1', id: chunkEvents[0].id, playing: true });
    assert.equal(states(h.events).at(-1), 'speaking', 'speaking comes from the window, not the agent');
    h.agent.voicePlaying({ chatId: 'c1', id: chunkEvents[0].id, playing: false });
    assert.equal(states(h.events).at(-1), 'idle', 'when the sound ends and the turn is over, she is idle');
    assert.ok(h.logs.some((l) => /^First audio \d+ ms after the reply started/.test(l)), 'the time to first audio is logged');
  } finally { h.done(); }
});

test('sentences are synthesised while the reply is still streaming', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const h = agentHarness({ text: ['First sentence here. ', 'Second one. '] });
  const original = llm.chatStream;
  llm.chatStream = async ({ onDelta }) => { onDelta('First sentence here. '); await tick(); await gate; onDelta('Second one.'); return { text: 'First sentence here. Second one.', toolCalls: [] }; };
  try {
    const run = h.agent.run({ chatId: 'c1', text: 'hi' });
    await until(() => h.ttsCalls.length === 1);
    assert.deepEqual(h.ttsCalls, ['First sentence here.'], 'the first sentence goes to TTS before the reply is done');
    assert.ok(!h.events.some((e) => e.type === 'assistant:done'));
    release(); await run;
  } finally { llm.chatStream = original; h.done(); }
});

test('voice back on while the turn is still working returns to the turn state, not idle', async () => {
  const h = agentHarness();
  try {
    h.agent.runs.set('c1', {}); h.agent.turnState('writing');
    h.agent.voicePlaying({ chatId: 'c1', id: 'm2', playing: true });
    h.agent.turnState('thinking', { step: 'Reading a file' });
    assert.equal(states(h.events).at(-1), 'speaking', 'a tool step does not interrupt the speaking state');
    h.agent.voicePlaying({ chatId: 'c1', id: 'm2', playing: false });
    assert.deepEqual(h.events.filter((e) => e.type === 'state').at(-1), { chatId: null, type: 'state', state: 'thinking', step: 'Reading a file' });
  } finally { h.agent.runs.clear(); h.done(); }
});

test('stop cancels pending speech and tells the window to drop its queue', async () => {
  const pending = [];
  const h = agentHarness({ tts: () => { const d = deferred(); pending.push(d); return d.p; } });
  try {
    await h.agent.run({ chatId: 'c1', text: 'hi' });
    assert.equal(pending.length, 2, 'two sentences in flight, the third waiting');
    h.agent.stop('c1');
    for (const d of pending) d.resolve({ path: '/late.wav' });
    await tick(); await tick();
    assert.equal(pending.length, 2, 'the waiting sentence is never synthesised');
    assert.ok(h.events.some((e) => e.type === 'tts:stop'));
    assert.ok(!h.events.some((e) => e.type === 'tts:chunk'), 'nothing is emitted after stop');
  } finally { h.done(); }
});

test('with the setting off, the reply is spoken whole after it is written (old behaviour)', async () => {
  const h = agentHarness({ streamSpeech: false });
  try {
    await h.agent.run({ chatId: 'c1', text: 'hi' });
    assert.deepEqual(h.ttsCalls, ['Hello there. This is Lyra. Goodbye.']);
    assert.ok(!h.events.some((e) => e.type === 'tts:chunk'));
    const tts = h.events.find((e) => e.type === 'tts');
    assert.ok(tts && !tts.streamed, 'the window plays it as one file');
    assert.ok(!states(h.events).includes('speaking'), 'still no speaking until the window reports sound');
  } finally { h.done(); }
});

test('with read aloud off, nothing is synthesised', async () => {
  const h = agentHarness({ readAloud: false });
  try {
    await h.agent.run({ chatId: 'c1', text: 'hi' });
    assert.deepEqual(h.ttsCalls, []);
    assert.equal(states(h.events).at(-1), 'idle');
  } finally { h.done(); }
});

/* ---------- saving one file per reply ---------- */

function wav(samples, rate = 24000) {
  const data = Buffer.alloc(samples.length * 2); samples.forEach((s, i) => data.writeInt16LE(s, i * 2));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

test('the spoken pieces are joined into one playable WAV', () => {
  const d = tmpdir(); const a = path.join(d, 'a.wav'), b = path.join(d, 'b.wav'), out = path.join(d, 'out.wav');
  fs.writeFileSync(a, wav([1, 2, 3])); fs.writeFileSync(b, wav([4, 5]));
  assert.equal(joinWavs([a, b], out), true);
  const j = fs.readFileSync(out);
  assert.equal(j.toString('ascii', 0, 4), 'RIFF'); assert.equal(j.readUInt32LE(4), j.length - 8);
  assert.equal(j.readUInt32LE(40), 10, 'data size covers both pieces');
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => j.readInt16LE(44 + i * 2)), [1, 2, 3, 4, 5]);
});

test('pieces in different formats are not joined (the caller keeps them)', () => {
  const d = tmpdir(); const a = path.join(d, 'a.wav'), b = path.join(d, 'b.wav'), mp3 = path.join(d, 'c.mp3');
  fs.writeFileSync(a, wav([1], 24000)); fs.writeFileSync(b, wav([1], 22050)); fs.writeFileSync(mp3, Buffer.from('ID3 not a wav'));
  assert.equal(joinWavs([a, b], path.join(d, 'x.wav')), false);
  assert.equal(joinWavs([a, mp3], path.join(d, 'y.wav')), false);
});
