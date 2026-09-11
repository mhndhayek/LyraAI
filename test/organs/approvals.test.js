// The approval gate decides what the agent may do without asking. Getting this
// wrong is the difference between an assistant and an accident.
const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULTS, merge } = require('../../main/kernel/settings');
const { Approvals } = require('../../main/organs/approvals');

function gate(patch = {}) {
  const data = merge(DEFAULTS, patch);
  const emitted = [], notified = [];
  const a = new Approvals({ settings: { get: () => data }, emit: (c, t, p) => emitted.push({ type: t, ...p }), notify: (n) => notified.push(n) });
  return { a, emitted, notified, data };
}

test('ask mode stops to ask about anything that is not plainly safe', () => {
  const { a } = gate();
  assert.equal(a.decide('high'), null, 'high risk always asks');
  assert.equal(a.decide('medium'), null);
  assert.deepEqual(a.decide('low').decision, 'approved', 'smart approvals let low-risk work through');
});

test('smart approvals can be switched off so every action is asked about', () => {
  const { a } = gate({ model: { smartApprovals: false } });
  assert.equal(a.decide('low'), null);
});

test('auto mode approves without asking, none mode removes the gate', () => {
  for (const mode of ['auto', 'none']) {
    const { a } = gate({ safety: { approvalMode: mode } });
    for (const risk of ['low', 'medium', 'high']) {
      const d = a.decide(risk);
      assert.equal(d.decision, 'approved', `${mode} should approve ${risk}`);
      assert.equal(d.auto, true);
      assert.ok(d.why, 'the UI shows why it was not asked');
    }
  }
});

test('a phone session cannot run high-risk actions unless the user allowed it', () => {
  const { a } = gate({ safety: { approvalMode: 'none' } });
  const d = a.decide('high', 'mobile');
  assert.equal(d.decision, 'denied', 'the phone limit outranks even "no restrictions"');
  assert.match(d.why, /phone/);
  assert.equal(a.decide('high', 'desktop').decision, 'approved');
  assert.equal(a.decide('low', 'mobile').decision, 'approved', 'low risk is still fine from the phone');

  const opened = gate({ safety: { approvalMode: 'none' }, mobile: { allowHighRiskTools: true } });
  assert.equal(opened.a.decide('high', 'mobile').decision, 'approved');
});

test('a request that needs a person reaches the UI and waits', async () => {
  const { a, emitted, notified } = gate();
  const p = a.request({ chatId: 'c1', tool: 'shell', summary: 'Run rm -rf', risk: 'high', detail: 'rm -rf /tmp/x' });
  assert.equal(emitted.length, 1);
  const req = emitted[0];
  assert.equal(req.type, 'approval');
  assert.equal(req.tool, 'shell');
  assert.ok(req.id && req.expiresAt > Date.now());
  assert.equal(a.pending.size, 1);
  assert.equal(notified.length, 1, 'the user is notified even if the window is hidden');

  a.respond(req.id, 'approved');
  assert.deepEqual(await p, { decision: 'approved' });
  assert.equal(a.pending.size, 0, 'the request is cleared once answered');
});

test('a denial comes back as a denial', async () => {
  const { a, emitted } = gate();
  const p = a.request({ chatId: 'c1', tool: 'write_file', summary: 'Overwrite', risk: 'high' });
  a.respond(emitted[0].id, 'denied');
  assert.deepEqual(await p, { decision: 'denied' });
});

test('an unanswered request times out the way the user configured', async () => {
  for (const [onTimeout, expected] of [['deny', 'denied'], ['approve', 'approved']]) {
    const { a } = gate({ safety: { timeoutSec: 0.01, onTimeout } });
    const r = await a.request({ chatId: 'c1', tool: 'shell', summary: 'slow', risk: 'high' });
    assert.equal(r.decision, expected);
    assert.equal(r.timedOut, true);
  }
});

test('a timeout is never shorter than five seconds of real thinking time', async () => {
  const { a, emitted } = gate({ safety: { timeoutSec: 0 } });
  a.request({ chatId: 'c1', tool: 'shell', summary: 'x', risk: 'high' });
  assert.ok(emitted[0].expiresAt - Date.now() >= 4000, 'a zero timeout would deny before anyone could read it');
  a.respond(emitted[0].id, 'denied');
});

test('responding twice, or to nothing, is harmless', () => {
  const { a, emitted } = gate();
  a.request({ chatId: 'c1', tool: 'shell', summary: 'x', risk: 'high' });
  a.respond(emitted[0].id, 'approved');
  assert.doesNotThrow(() => a.respond(emitted[0].id, 'denied'));
  assert.doesNotThrow(() => a.respond('never-existed', 'approved'));
});

test('cancelling a chat releases everything it was waiting on', async () => {
  const { a } = gate();
  const p1 = a.request({ chatId: 'c1', tool: 'shell', summary: 'a', risk: 'high' });
  const p2 = a.request({ chatId: 'c1', tool: 'shell', summary: 'b', risk: 'high' });
  const other = a.request({ chatId: 'c2', tool: 'shell', summary: 'c', risk: 'high' });
  a.cancelAll('c1');
  assert.equal((await p1).decision, 'denied');
  assert.equal((await p2).decision, 'denied');
  assert.equal(a.pending.size, 1, 'other chats keep waiting');
  a.cancelAll('c2');
  await other;
});
