// Found in the LYR-06 demo: a new chat on a 4B model ran 4 tool steps, then
// said "I used all 80 tool steps" because the reply text was empty (the answer
// was inside its thinking). Nothing was logged.
const test = require('node:test');
const assert = require('node:assert/strict');
const { finishTurn } = require('../../main/organs/turn-end');

const base = { text: '', ranOut: false, stopped: false, maxSteps: 80, steps: 4, lastReasoning: '', finish: 'stop', model: 'qwen3.5-4b' };

test('an empty reply after 4 steps never claims the step limit', () => {
  const r = finishTurn(base);
  assert.doesNotMatch(r.text, /tool steps/);
  assert.match(r.text, /without writing a reply/);
  assert.equal(r.log.level, 'warn');
  assert.match(r.log.message, /qwen3\.5-4b, 4 steps, finish stop/);
});

test('an answer that only came as thinking is shown, with a notice and a log line', () => {
  const r = finishTurn({ ...base, lastReasoning: '  You asked two things: role-play and MCP.  ' });
  assert.equal(r.text, 'You asked two things: role-play and MCP.');
  assert.equal(r.fromReasoning, true);
  assert.match(r.notice, /inside its thinking/);
  assert.match(r.log.message, /only in the model's thinking/);
});

test('the step-limit message is kept for a turn that really ran out', () => {
  const r = finishTurn({ ...base, ranOut: true, steps: 81, lastReasoning: 'thinking…' });
  assert.match(r.text, /I used all 80 tool steps/);
  assert.equal(r.log, null);
});

test('a stopped turn and a normal reply are unchanged', () => {
  assert.equal(finishTurn({ ...base, stopped: true }).text, '(stopped)');
  const ok = finishTurn({ ...base, text: ' Hi! ' });
  assert.deepEqual(ok, { text: 'Hi!', notice: null, log: null });
});
