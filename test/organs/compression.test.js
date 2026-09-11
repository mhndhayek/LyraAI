// Context compression decides what the agent still remembers when a conversation
// outgrows the model's window.
const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULTS, merge } = require('../../main/kernel/settings');
const { messagesTokens, partTokens, maybeCompress } = require('../../main/organs/compression');

const msg = (role, chars) => ({ role, content: 'x'.repeat(chars) });
const settings = (patch = {}) => merge(DEFAULTS, patch);

test('token estimates cover strings, multi-part content and images', () => {
  assert.equal(partTokens('abcd'), 1);
  assert.equal(partTokens(''), 0);
  assert.equal(partTokens([{ type: 'text', text: 'abcd' }]), 1);
  assert.equal(partTokens([{ type: 'image_url', image_url: { url: 'data:...' } }]), 800, 'an image is budgeted, not ignored');
  assert.equal(partTokens(null), 0, 'a tool call with no content does not break the estimate');
});

test('message totals include per-message overhead', () => {
  assert.equal(messagesTokens([msg('user', 4), msg('assistant', 4)]), (1 + 4) * 2);
  assert.equal(messagesTokens([]), 0);
});

function fakeLlm(reply = 'a summary') {
  const calls = [];
  return { calls, chatOnce: async (opts) => { calls.push(opts); return reply; } };
}

const run = (over = {}) => maybeCompress({
  history: [], previousSummary: null, fixedTokens: 0, contextLength: 1000,
  settings: settings(), llm: fakeLlm(), model: 'm', endpoint: 'http://localhost:1234/v1', apiKey: '', ...over,
});

test('a conversation under the threshold is left alone', async () => {
  const llm = fakeLlm();
  const r = await run({ history: [msg('user', 100), msg('assistant', 100)], llm });
  assert.equal(r, null);
  assert.equal(llm.calls.length, 0, 'no model call is made when nothing needs folding');
});

test('crossing the threshold folds the older turns into a summary', async () => {
  const llm = fakeLlm('folded');
  const history = Array.from({ length: 30 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', 400));
  const r = await run({ history, llm, contextLength: 1000 });
  assert.ok(r, 'compression should have run');
  assert.equal(r.summary, 'folded');
  assert.ok(r.cut > 0 && r.cut <= history.length);
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].temperature, 0.2, 'summaries are generated conservatively');
});

test('the summary prompt carries the folded transcript and the previous summary', async () => {
  const llm = fakeLlm();
  const history = [{ role: 'user', content: 'THE FIRST THING' }, ...Array.from({ length: 20 }, () => msg('assistant', 400))];
  await run({ history, llm, previousSummary: 'EARLIER SUMMARY', contextLength: 800 });
  const prompt = llm.calls[0].messages.map((m) => m.content).join('\n');
  assert.match(prompt, /EARLIER SUMMARY/);
  assert.match(prompt, /THE FIRST THING/);
  assert.match(prompt, /USER:/, 'roles are preserved in the transcript');
});

test('images are described rather than pasted into the summary prompt', async () => {
  const llm = fakeLlm();
  const history = [{ role: 'user', content: [{ type: 'text', text: 'look at this' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
    ...Array.from({ length: 20 }, () => msg('assistant', 400))];
  await run({ history, llm, contextLength: 800 });
  const prompt = JSON.stringify(llm.calls[0].messages);
  assert.match(prompt, /\[image\]/);
  assert.ok(!prompt.includes('base64,AAAA'), 'image data never reaches the summariser');
});

test('the most recent turns are always kept', async () => {
  const llm = fakeLlm();
  const history = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `message ${i} ` + 'x'.repeat(300) }));
  const r = await run({ history, llm, contextLength: 2000 });
  assert.ok(r.cut < history.length, 'compression never folds away the whole conversation');
  assert.ok(!llm.calls[0].messages.some((m) => m.content.includes(`message ${history.length - 1}`)), 'the newest turn stays in context');
});

test('a bigger fixed prompt makes compression kick in sooner', async () => {
  const history = Array.from({ length: 12 }, () => msg('user', 200));
  assert.equal(await run({ history, contextLength: 1000 }), null);
  assert.ok(await run({ history, contextLength: 1000, fixedTokens: 500 }), 'the system prompt counts against the window');
});

test('the threshold and target are honoured', async () => {
  const history = Array.from({ length: 12 }, () => msg('user', 200));
  assert.equal(await run({ history, contextLength: 1000 }), null);
  assert.ok(await run({ history, contextLength: 1000, settings: settings({ memory: { threshold: 0.1 } }) }), 'a lower threshold compresses earlier');
});

test('the progress log explains why compression happened', async () => {
  const lines = [];
  const history = Array.from({ length: 30 }, () => msg('user', 400));
  await run({ history, contextLength: 1000, log: (l) => lines.push(l) });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Compressing \d+ older messages/);
});
