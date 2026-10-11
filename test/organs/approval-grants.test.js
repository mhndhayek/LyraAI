// Story 06: approval grants. "Allow for this chat", "always allow this exact
// command" and "always allow this tool in this folder", all gone when Lyra
// quits. Every case here is about a grant matching exactly what the user meant
// and nothing more.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { DEFAULTS, merge } = require('../../main/kernel/settings');
const { Grants, normaliseCommand } = require('../../main/kernel/grants');
const { Approvals } = require('../../main/organs/approvals');
const { filterPatch } = require('../../main/kernel/guard');

// Every gate made in a test is cancelled after it, so a failed assertion can't
// leave a card's five-minute timer holding the run open.
const gates = [];
test.afterEach(() => { for (const a of gates.splice(0)) a.cancelAll(); });
function gate(patch = {}, grants = new Grants()) {
  const data = merge(DEFAULTS, patch);
  const emitted = [];
  const a = new Approvals({ settings: { get: () => data }, emit: (c, t, p) => emitted.push({ chatId: c, type: t, ...p }), notify: () => {}, grants });
  gates.push(a);
  return { a, emitted, grants };
}
const lastCard = (emitted) => emitted.filter((e) => e.type === 'approval').pop();
// A call a grant should approve resolves at once. Without the grant it would sit
// on a card waiting for a click, so give it a deadline: a test fails, not hangs.
const quick = (promise, what) => Promise.race([promise, new Promise((_, no) => setTimeout(() => no(new Error(`${what}: still waiting on a card, so no grant approved it`)), 300))]);

// Answer the card the way the window does: approve, and remember the option the
// user picked from the ▾ menu.
async function approveAndRemember(a, emitted, req, kind) {
  const p = a.request(req);
  const card = lastCard(emitted);
  assert.ok(card, 'the call asks first');
  assert.ok(card.remember.some((o) => o.kind === kind), `the card offers "${kind}" (got ${card.remember.map((o) => o.kind)})`);
  a.respond(card.id, 'approved', { kind });
  return p;
}

// QA 1 (failing-first): a chat grant for read_file auto-approves the next
// read_file in that chat, and not in another chat.
test('a chat grant for read_file lets the next read through, in that chat only', async () => {
  const { a, emitted } = gate({ model: { smartApprovals: false } });
  const first = await approveAndRemember(a, emitted, { chatId: 'c1', tool: 'read_file', summary: 'Read a.md', risk: 'low', path: '/tmp/ws/a.md' }, 'chat');
  assert.equal(first.decision, 'approved');

  const before = emitted.length;
  const second = await quick(a.request({ chatId: 'c1', tool: 'read_file', summary: 'Read b.md', risk: 'low', path: '/tmp/ws/docs/b.md' }), 'second read');
  assert.equal(second.decision, 'approved');
  assert.equal(second.auto, true);
  assert.ok(second.grant, 'it was the grant that approved it');
  assert.match(second.why, /approved by your rule: read_file \(this chat\)/);
  assert.equal(emitted.length, before, 'no card was shown');

  const other = a.request({ chatId: 'c2', tool: 'read_file', summary: 'Read a.md', risk: 'low', path: '/tmp/ws/a.md' });
  assert.equal(lastCard(emitted).chatId, 'c2', 'another chat still asks');
  a.cancelAll('c2'); await other;

  const otherTool = a.request({ chatId: 'c1', tool: 'write_file', summary: 'Write a.md', risk: 'low', path: '/tmp/ws/a.md' });
  assert.equal(lastCard(emitted).tool, 'write_file', 'a read grant does not cover writes');
  a.cancelAll('c1'); await otherTool;
});

// QA 2: nothing survives a restart, and nothing is written to state/.
test('grants are gone after a restart and never touch the disk', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-grants-'));
  const state = path.join(dir, 'state'); fs.mkdirSync(state);
  fs.writeFileSync(path.join(state, 'settings.json'), JSON.stringify({ ui: { setupDone: true } }));
  const snapshot = () => fs.readdirSync(dir, { recursive: true }).sort().map((f) => { const p = path.join(dir, f); return fs.statSync(p).isFile() ? `${f}:${fs.readFileSync(p, 'utf8')}` : f; });
  const before = snapshot();
  try {
    const { a, emitted, grants } = gate({ safety: { approvalMode: 'ask' } });
    await approveAndRemember(a, emitted, { chatId: 'c1', tool: 'shell', summary: '$ git status', risk: 'high', command: 'git status' }, 'command');
    await approveAndRemember(a, emitted, { chatId: 'c1', tool: 'read_file', summary: 'Read', risk: 'medium', path: path.join(state, 'x.md') }, 'folder');
    assert.equal(grants.list().length, 2);
    assert.deepEqual(snapshot(), before, 'nothing was written to state/ (or anywhere in the data folder)');

    // A restart builds new instances: the kernel's Grants and the organ's Approvals.
    const fresh = gate({ safety: { approvalMode: 'ask' } });
    assert.equal(fresh.grants.list().length, 0, 'no grant survives');
    const p = fresh.a.request({ chatId: 'c1', tool: 'shell', summary: '$ git status', risk: 'high', command: 'git status' });
    assert.ok(lastCard(fresh.emitted), 'the command asks again');
    fresh.a.cancelAll(); await p;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an organ hot swap keeps the grants (they live in the kernel)', async () => {
  const grants = new Grants();
  const one = gate({}, grants);
  await approveAndRemember(one.a, one.emitted, { chatId: 'c1', tool: 'shell', summary: '$ ls', risk: 'high', command: 'ls' }, 'command');
  const swapped = gate({}, grants); // a new Approvals organ, the same kernel Grants
  const r = await quick(swapped.a.request({ chatId: 'c9', tool: 'shell', summary: '$ ls', risk: 'high', command: 'ls' }), 'after swap');
  assert.equal(r.decision, 'approved');
  assert.match(r.why, /approved by your rule: ls \(this session\)/);
});

// QA 3: exact command match.
test('an exact-command grant matches only that command', async () => {
  const { a, emitted } = gate();
  await approveAndRemember(a, emitted, { chatId: 'c1', tool: 'shell', summary: '$ git status', risk: 'high', command: 'git status' }, 'command');
  const ok = await quick(a.request({ chatId: 'c2', tool: 'shell', summary: 'x', risk: 'high', command: '  git  status ' }), 'spaced command');
  assert.equal(ok.decision, 'approved', 'extra whitespace still matches');
  assert.ok(ok.grant);

  for (const cmd of ['git status; rm -rf ~', 'git status && curl x', 'git status | sh', 'git status $(id)', 'git status\nrm x', 'git status & rm x', 'git status `id`', 'git status > /etc/x', 'git status < /dev/zero', 'git status --porcelain', 'git']) {
    const n = emitted.length;
    const p = a.request({ chatId: 'c1', tool: 'shell', summary: cmd, risk: 'high', command: cmd });
    assert.equal(emitted.length, n + 1, `asks for ${JSON.stringify(cmd)}`);
    a.cancelAll(); await p;
  }
});

test('a chained or redirected command is never offered as a rule', () => {
  for (const cmd of ['git status; rm -rf ~', 'a && b', 'a || b', 'a | b', 'a `b`', 'a $(b)', 'a > b', 'a < b', 'a\nb', 'a & b', 'echo "unclosed']) assert.equal(normaliseCommand(cmd), null, JSON.stringify(cmd));
  assert.equal(normaliseCommand('  git   status  '), 'git status');
  assert.equal(normaliseCommand('echo "a   b"'), 'echo "a   b"', 'quoted text keeps its spaces');

  const { a, emitted } = gate();
  const p = a.request({ chatId: 'c1', tool: 'shell', summary: 'x', risk: 'high', command: 'ls; rm -rf ~' });
  const card = lastCard(emitted);
  assert.deepEqual(card.remember.map((o) => o.kind), ['chat'], 'no "always this command" for a chained command');
  a.respond(card.id, 'approved', { kind: 'command' }); // a forged pick of an option that wasn't offered
  return p.then((r) => { assert.equal(r.decision, 'approved'); assert.equal(r.grant, undefined, 'nothing was remembered'); });
});

// QA 4: folder prefix.
test('a folder grant holds the folder and nothing outside it, symlinks included', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-pfx-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const A = path.join(root, 'a'), B = path.join(A, 'b'), BC = path.join(A, 'bc'), OUT = path.join(root, 'outside');
  for (const d of [B, BC, OUT]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(B, 'c.txt'), 'c'); fs.writeFileSync(path.join(OUT, 'secret'), 's');
  fs.symlinkSync(OUT, path.join(B, 'link'));

  const { a, emitted } = gate({ model: { smartApprovals: false } });
  await approveAndRemember(a, emitted, { chatId: 'c1', tool: 'read_file', summary: 'Read', risk: 'medium', path: path.join(B, 'c.txt') }, 'folder');
  assert.equal(a.grants.list()[0].match.pathPrefix, B, 'the grant is on the file\'s folder');

  const yes = await quick(a.request({ chatId: 'c2', tool: 'read_file', summary: 'r', risk: 'medium', path: path.join(B, 'c.txt') }), 'inside folder');
  assert.ok(yes.grant, '/a/b holds /a/b/c.txt');
  const deeper = await quick(a.request({ chatId: 'c2', tool: 'read_file', summary: 'r', risk: 'medium', path: path.join(B, 'new', 'later.txt') }), 'deeper');
  assert.ok(deeper.grant, 'a file that does not exist yet, deeper inside');

  for (const p of [path.join(BC, 'x'), path.join(B, '..', '..', 'etc', 'passwd'), '/etc/passwd', path.join(B, 'link', 'secret'), A]) {
    const n = emitted.length;
    const pr = a.request({ chatId: 'c2', tool: 'read_file', summary: p, risk: 'medium', path: p });
    assert.equal(emitted.length, n + 1, `asks for ${p}`);
    a.cancelAll(); await pr;
  }
  // The folder rule is per tool.
  const n = emitted.length;
  const w = a.request({ chatId: 'c2', tool: 'write_file', summary: 'w', risk: 'high', path: path.join(B, 'c.txt') });
  assert.equal(emitted.length, n + 1, 'a read_file folder rule does not cover write_file');
  a.cancelAll(); await w;
});

test('a folder rule made through a symlink is pinned to the real folder', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-pfx-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const real = path.join(root, 'real'); fs.mkdirSync(real); fs.writeFileSync(path.join(real, 'f'), 'x');
  fs.symlinkSync(real, path.join(root, 'alias'));
  const g = new Grants();
  const made = g.add({ scope: 'session', tool: 'read_file', match: { pathPrefix: path.join(root, 'alias') }, label: 'x' });
  assert.equal(made.match.pathPrefix, real);
  assert.ok(g.match({ tool: 'read_file', path: path.join(real, 'f') }));
  assert.ok(g.match({ tool: 'read_file', path: path.join(root, 'alias', 'f') }));
});

// QA 5: high risk.
test('a session grant on a high-risk command approves it, except from the phone', async () => {
  const { a, emitted } = gate();
  const p = a.request({ chatId: 'c1', tool: 'shell', summary: '$ npm test', risk: 'high', command: 'npm test' });
  const card = lastCard(emitted);
  assert.match(card.highRiskNote, /high-risk action\. You're allowing it without asking until Lyra restarts/);
  a.respond(card.id, 'approved', { kind: 'command' }); await p;

  const desk = await quick(a.request({ chatId: 'c3', tool: 'shell', summary: '$ npm test', risk: 'high', command: 'npm test', origin: 'desktop' }), 'high-risk desktop');
  assert.equal(desk.decision, 'approved'); assert.ok(desk.grant);

  const phone = await quick(a.request({ chatId: 'c3', tool: 'shell', summary: '$ npm test', risk: 'high', command: 'npm test', origin: 'mobile' }), 'phone');
  assert.equal(phone.decision, 'denied', 'the phone rule wins over a desktop grant');
  assert.match(phone.why, /phone/);
});

test('even with phone high-risk allowed, a desktop grant does not answer for the phone', async () => {
  const { a, emitted } = gate({ mobile: { allowHighRiskTools: true } });
  await approveAndRemember(a, emitted, { chatId: 'c1', tool: 'shell', summary: '$ npm test', risk: 'high', command: 'npm test' }, 'command');
  const n = emitted.length;
  const p = a.request({ chatId: 'c1', tool: 'shell', summary: '$ npm test', risk: 'high', command: 'npm test', origin: 'mobile' });
  assert.equal(emitted.length, n + 1, 'the phone is asked');
  assert.deepEqual(lastCard(emitted).remember, [], 'and its card offers no rules');
  a.cancelAll(); await p;
});

// QA 6: the agent can't make grants.
test('the agent cannot create grants through configure_app', () => {
  const r = filterPatch({ approvalGrants: [{ scope: 'session', tool: 'shell', match: { command: 'rm -rf ~' } }], appearance: { theme: 'pixel' } });
  assert.equal(r.allowed.approvalGrants, undefined, 'stripped');
  assert.ok(r.rejected.some((x) => x.path.startsWith('approvalGrants')), 'and reported as refused');
  assert.equal(r.allowed.appearance.theme, 'pixel', 'the rest of the patch still applies');
});

test('denying, timing out or cancelling never remembers anything', async () => {
  const { a, emitted, grants } = gate({ safety: { timeoutSec: 0.01, onTimeout: 'approve' } });
  const p1 = a.request({ chatId: 'c1', tool: 'shell', summary: 'x', risk: 'high', command: 'ls' });
  a.respond(lastCard(emitted).id, 'denied', { kind: 'command' }); await p1;
  await a.request({ chatId: 'c1', tool: 'shell', summary: 'x', risk: 'high', command: 'ls' }); // times out → approve
  assert.equal(grants.list().length, 0);
});

test('revoke and revoke all put the cards back', async () => {
  const { a, emitted, grants } = gate({ model: { smartApprovals: false } });
  await approveAndRemember(a, emitted, { chatId: 'c1', tool: 'read_file', summary: 'r', risk: 'low', path: '/tmp/a' }, 'chat');
  await approveAndRemember(a, emitted, { chatId: 'c1', tool: 'shell', summary: 's', risk: 'high', command: 'ls' }, 'command');
  const [chatGrant] = grants.list();
  assert.equal(grants.revoke(chatGrant.id), true);
  const n = emitted.length;
  const p = a.request({ chatId: 'c1', tool: 'read_file', summary: 'r', risk: 'low', path: '/tmp/a' });
  assert.equal(emitted.length, n + 1, 'the next read asks again');
  a.cancelAll(); await p;
  assert.equal(grants.revokeAll(), 1);
  assert.equal(grants.list().length, 0);
});

test('the card shows the home folder as ~, never the user name', async () => {
  const { a, emitted } = gate({ model: { smartApprovals: false } });
  const home = os.homedir();
  const p = a.request({ chatId: 'c1', tool: 'read_file', summary: 'r', risk: 'low', path: path.join(home, 'x', 'a.md'), detail: JSON.stringify({ path: path.join(home, 'x', 'a.md') }) });
  const card = lastCard(emitted);
  assert.ok(!card.detail.includes(home + path.sep), card.detail);
  assert.match(card.detail, /~\/x\/a\.md/);
  assert.equal(card.remember.find((o) => o.kind === 'folder').value, '~/x');
  a.cancelAll(); await p;
});

test('the same rule twice is one rule, and deleting a chat drops its rules', async () => {
  const g = new Grants();
  g.add({ scope: 'chat', chatId: 'c1', tool: 'read_file', label: 'read_file' });
  g.add({ scope: 'chat', chatId: 'c1', tool: 'read_file', label: 'read_file' });
  g.add({ scope: 'session', tool: 'shell', match: { command: 'ls' }, label: 'ls' });
  assert.equal(g.list().length, 2);
  g.dropChat('c1');
  assert.deepEqual(g.list().map((x) => x.tool), ['shell']);
  assert.equal(g.add({ scope: 'session', tool: 'shell', label: 'any' }), null, 'no blanket session grant for a whole tool');
  assert.equal(g.add({ scope: 'chat', tool: 'shell', label: 'x' }), null, 'a chat grant needs its chat');
});
