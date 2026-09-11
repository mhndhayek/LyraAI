// Checkpoints are the undo button behind every change the agent makes, so the
// tests drive a real git repository rather than a stub.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpdir, cleanup } = require('../helpers/tmp');
const { Checkpoints } = require('../../main/kernel/checkpoints');

test.after(cleanup);

function repo() {
  const dir = path.join(tmpdir(), 'state');
  fs.mkdirSync(dir, { recursive: true });
  const c = new Checkpoints(dir);
  assert.equal(c.init(), true, 'git must be available for these tests');
  return { c, dir, write: (f, s) => fs.writeFileSync(path.join(dir, f), s), read: (f) => fs.readFileSync(path.join(dir, f), 'utf8') };
}

test('init creates a repository with a first commit and an ignore file', () => {
  const { c, dir } = repo();
  assert.ok(fs.existsSync(path.join(dir, '.git')));
  assert.ok(fs.existsSync(path.join(dir, '.gitignore')));
  assert.ok(c.head(), 'there is an initial commit to roll back to');
  assert.equal(c.available, true);
});

test('init on an existing repository is a no-op', () => {
  const { c, dir } = repo();
  const head = c.head();
  const again = new Checkpoints(dir);
  again.init();
  assert.equal(again.head(), head);
});

test('commits are recorded and an unchanged tree is skipped', () => {
  const { c, write } = repo();
  write('a.txt', 'one');
  const first = c.commit('Added a');
  assert.ok(first && first.hash);
  assert.equal(c.commit('Nothing changed'), null, 'a clean tree makes no new checkpoint');
  write('a.txt', 'two');
  assert.ok(c.commit('Changed a'));
  assert.deepEqual(c.list(3).map((x) => x.label), ['Changed a', 'Added a', 'Initial state']);
});

test('long labels are trimmed to stay readable', () => {
  const { c, write } = repo();
  write('a.txt', 'x');
  c.commit('L'.repeat(300));
  assert.ok(c.list(1)[0].label.length <= 120);
});

test('isDirty tracks uncommitted work', () => {
  const { c, write } = repo();
  assert.equal(c.isDirty(), false);
  write('new.txt', 'pending');
  assert.equal(c.isDirty(), true);
  c.commit('Saved');
  assert.equal(c.isDirty(), false);
});

test('a healthy boot moves the last-known-good tag', () => {
  const { c, write } = repo();
  write('a.txt', 'good');
  c.markGood();
  const lkg = c.lastKnownGood();
  assert.ok(lkg);
  assert.equal(c.list(1)[0].lkg, true, 'the listing marks which checkpoint is good');
  write('a.txt', 'newer');
  c.commit('Later work');
  assert.equal(c.lastKnownGood(), lkg, 'later commits do not move the tag on their own');
  c.markGood();
  assert.notEqual(c.lastKnownGood(), lkg, 'the next healthy boot does');
});

test('rollback restores the files and records both sides of the move', () => {
  const { c, write, read } = repo();
  write('organs.js', 'working');
  c.markGood();
  write('organs.js', 'broken');
  write('extra.js', 'left over');
  c.rollback('lkg');
  assert.equal(read('organs.js'), 'working');
  assert.equal(fs.existsSync(path.join(c.dir, 'extra.js')), false, 'untracked leftovers are cleaned up');
  const labels = c.list(5).map((x) => x.label);
  assert.ok(labels.some((l) => /Rolled back everything to lkg/.test(l)));
  assert.ok(labels.some((l) => /Before rollback to lkg/.test(l)), 'the broken state is kept so it can be inspected');
});

test('a rollback can be scoped to one subfolder', () => {
  const { c, dir, write, read } = repo();
  fs.mkdirSync(path.join(dir, 'organs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'organs', 'x.js'), 'working');
  write('settings.json', '{"keep":true}');
  c.markGood();
  fs.writeFileSync(path.join(dir, 'organs', 'x.js'), 'broken');
  write('settings.json', '{"keep":"changed"}');
  fs.writeFileSync(path.join(dir, 'organs', 'added.js'), 'new organ');
  write('outside.json', '{}');
  c.rollback('lkg', { subdir: 'organs' });
  assert.equal(fs.readFileSync(path.join(dir, 'organs', 'x.js'), 'utf8'), 'working');
  assert.equal(fs.existsSync(path.join(dir, 'organs', 'added.js')), false, 'files added since the checkpoint go too');
  assert.equal(read('settings.json'), '{"keep":"changed"}', 'files outside the subfolder are untouched');
  assert.ok(fs.existsSync(path.join(dir, 'outside.json')), 'and so are new files outside it');
});

test('changedSince and changedFiles report work since a reference', () => {
  const { c, write } = repo();
  write('a.txt', 'one');
  c.markGood();
  write('a.txt', 'two');
  write('untracked.txt', 'new');
  assert.ok(c.changedSince('lkg').some((l) => /a\.txt/.test(l)));
  const files = c.changedFiles('HEAD');
  assert.ok(files.includes('a.txt'));
  assert.ok(files.includes('untracked.txt'), 'new files count as changes');
});

test('an unknown reference is reported rather than thrown', () => {
  const { c } = repo();
  assert.deepEqual(c.changedSince('does-not-exist'), []);
  assert.equal(c.lastKnownGood(), null);
});

test('with checkpoints unavailable every call degrades quietly', () => {
  const c = new Checkpoints(tmpdir());
  assert.equal(c.available, false);
  assert.equal(c.commit('x'), null);
  assert.deepEqual(c.list(), []);
  assert.equal(c.isDirty(), false);
  assert.equal(c.markGood(), undefined);
  assert.throws(() => c.rollback('lkg'), /Checkpoints unavailable/);
});
