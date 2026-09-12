// The guardrails are the safety boundary between the agent and the user's machine:
// every one of them gets a test that fails loudly if the boundary moves.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { fakeKernel, cleanup } = require('../helpers/tmp');
const { filterPatch, LOCKED, QUEUED, flatten } = require('../../main/kernel/guard');

test.after(cleanup);

test('locked settings are rejected with a reason', () => {
  const r = filterPatch({ persona: { name: 'Evil' }, safety: { approvalMode: 'none' } });
  assert.equal(r.rejected.length, 2);
  assert.deepEqual(r.rejected.map((x) => x.path).sort(), ['persona.name', 'safety.approvalMode']);
  for (const x of r.rejected) assert.ok(x.why && x.why.length > 0, `${x.path} needs a reason`);
  assert.deepEqual(r.allowed, {});
});

test('every locked path has a user-facing reason', () => {
  const { REASONS } = require('../../main/kernel/guard');
  for (const l of LOCKED) assert.ok(REASONS[l], `no reason given for locked path ${l}`);
});

test('locking a prefix locks everything under it', () => {
  const r = filterPatch({ kernel: { dailyWrites: 9999, checkpoints: false }, tools: { enabled: false, shell: false } });
  const rejected = r.rejected.map((x) => x.path).sort();
  assert.deepEqual(rejected, ['kernel.checkpoints', 'kernel.dailyWrites', 'tools.enabled']);
  assert.deepEqual(r.allowed, { tools: { shell: false } }, 'individual tool switches stay open to the agent');
});

test('model changes are queued and other changes pass through', () => {
  const r = filterPatch({ model: { chat: { model: 'x' } }, appearance: { theme: 'pixel' } });
  assert.deepEqual(r.queuedPaths, ['model.chat.model']);
  assert.equal(r.allowed.appearance.theme, 'pixel');
  assert.equal(r.rejected.length, 0);
  assert.deepEqual(QUEUED, ['model']);
});

test('an empty patch is a no-op rather than an error', () => {
  const r = filterPatch({});
  assert.deepEqual(r, { allowed: {}, queued: {}, rejected: [], queuedPaths: [] });
});

test('flatten walks nested objects and leaves arrays alone', () => {
  assert.deepEqual(flatten({ a: { b: 1 }, c: [1, 2] }), [['a.b', 1], ['c', [1, 2]]]);
});

test('shell commands that would kill or lobotomise the app are blocked', () => {
  const k = fakeKernel();
  const blocked = ['killall Electron', 'pkill -9 Lyra', 'rm -rf ~/x/state/.git', 'rm -rf "/Applications/Lyra.app"', 'rm -rf "/Applications/Lyra AI Agent.app"',
    'git --git-dir=/x/state/.git reset --hard', 'osascript -e \'quit app "Lyra"\'', 'sudo shutdown -h now', 'launchctl unload x'];
  for (const cmd of blocked) assert.ok(k.guard.shellBlocked(cmd), `${cmd} should be blocked`);
  const allowed = ['ls -la', 'npm test', 'git status', 'python3 script.py', 'rm -rf node_modules'];
  for (const cmd of allowed) assert.equal(k.guard.shellBlocked(cmd), null, `${cmd} should be allowed`);
});

test('the app bundle, the checkpoint repo and kernel data files are off-limits', () => {
  const k = fakeKernel();
  const p = k.paths;
  assert.ok(k.guard.forbiddenPath(path.join(p.appPath, 'main', 'main.js')), 'kernel source is read-only');
  assert.ok(k.guard.forbiddenPath(path.join(p.appPath, 'package.json')));
  assert.ok(k.guard.forbiddenPath(path.join(p.state, '.git', 'HEAD')), 'checkpoint repo is kernel-owned');
  assert.ok(k.guard.forbiddenPath(p.bootFile));
  assert.ok(k.guard.forbiddenPath(p.extensionsState));
  assert.ok(k.guard.forbiddenPath(path.join(p.userData, 'lyra.sqlite')));
  assert.equal(k.guard.forbiddenPath(path.join(p.organsMain, 'tools.js')), null, 'live organs are editable');
  assert.equal(k.guard.forbiddenPath(path.join(p.state, 'themes', 'mine', 'theme.css')), null);
});

test('paths are classified by where they sit in the state folder', () => {
  const k = fakeKernel();
  assert.ok(k.guard.inState(path.join(k.paths.state, 'themes', 'x')));
  assert.equal(k.guard.inState(path.join(k.paths.userData, 'media', 'x.png')), false);
  assert.equal(k.guard.stateRisk(path.join(k.paths.organsMain, 'tools.js')), 'high');
  assert.equal(k.guard.stateRisk(path.join(k.paths.themes, 'x', 'theme.css')), 'low');
});

test('the daily write budget counts down and then refuses', () => {
  const k = fakeKernel();
  k.settings.set({ kernel: { dailyWrites: 3 } });
  assert.deepEqual(k.guard.budget(), { date: new Date().toISOString().slice(0, 10), used: 0, limit: 3 });
  assert.equal(k.guard.consume(1).ok, true);
  assert.equal(k.guard.consume(2).ok, true);
  const denied = k.guard.consume(1);
  assert.equal(denied.ok, false);
  assert.equal(denied.used, 3);
});

test('the budget resets on a new day', () => {
  const k = fakeKernel();
  k.store.kvSet('kernel:writes', { date: '2000-01-01', used: 999 });
  assert.equal(k.guard.budget().used, 0);
  assert.equal(k.guard.consume(1).ok, true);
});
