const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpdir, cleanup, ROOT } = require('../helpers/tmp');
const { layout, migrate, adoptOldUserData, copyDir } = require('../../main/kernel/paths');

test.after(cleanup);

test('the layout keeps editable state apart from the read-only bundle', () => {
  const data = path.join(path.sep, 'data'), app = path.join(path.sep, 'app');
  const p = layout(data, app);
  assert.equal(p.state, path.join(data, 'state'));
  for (const key of ['organsMain', 'organsRenderer', 'extensions', 'themes', 'settingsFile']) {
    assert.ok(p[key].startsWith(p.state), `${key} must live under the state folder`);
  }
  for (const key of ['docs', 'shippedOrgans', 'shippedRenderer', 'kernelDir', 'voiceDir']) {
    assert.ok(p[key].startsWith(app), `${key} must live in the app bundle`);
  }
});

test('migrate creates the folders the kernel assumes exist', () => {
  const p = layout(tmpdir(), ROOT);
  migrate(p);
  for (const d of [p.state, p.extensions, p.themes, p.media]) assert.ok(fs.existsSync(d), `${d} missing`);
});

test('migrate lifts a pre-state-folder install into place', () => {
  const ud = tmpdir();
  fs.writeFileSync(path.join(ud, 'settings.json'), '{"persona":{"soul":"old"}}');
  fs.mkdirSync(path.join(ud, 'themes', 'mine'), { recursive: true });
  const p = layout(ud, ROOT);
  migrate(p);
  assert.equal(JSON.parse(fs.readFileSync(p.settingsFile, 'utf8')).persona.soul, 'old');
  assert.ok(fs.existsSync(path.join(p.themes, 'mine')));
  assert.equal(fs.existsSync(path.join(ud, 'settings.json')), false);
});

test('migrate is safe to run twice and never clobbers newer settings', () => {
  const ud = tmpdir();
  const p = layout(ud, ROOT);
  migrate(p);
  fs.writeFileSync(p.settingsFile, '{"new":true}');
  fs.writeFileSync(path.join(ud, 'settings.json'), '{"old":true}');
  migrate(p);
  assert.deepEqual(JSON.parse(fs.readFileSync(p.settingsFile, 'utf8')), { new: true });
});

test('an old Nova data folder is adopted on first start', () => {
  const parent = tmpdir();
  const oldDir = path.join(parent, 'Nova'), newDir = path.join(parent, 'Lyra');
  fs.mkdirSync(path.join(oldDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(oldDir, 'nova.sqlite'), '');
  fs.writeFileSync(path.join(oldDir, 'state', 'settings.json'), '{}');
  const r = adoptOldUserData(newDir);
  assert.ok(r);
  assert.deepEqual(r.moved.sort(), ['nova.sqlite', 'state']);
  assert.ok(fs.existsSync(path.join(newDir, 'state', 'settings.json')));
  assert.equal(fs.existsSync(oldDir), false, 'the emptied old folder is removed');
});

test('adoption is skipped when there is nothing to adopt', () => {
  const parent = tmpdir();
  assert.equal(adoptOldUserData(path.join(parent, 'Lyra')), null, 'no old folder');
  fs.mkdirSync(path.join(parent, 'Nova'), { recursive: true });
  assert.equal(adoptOldUserData(path.join(parent, 'Lyra')), null, 'old folder holds no data');
});

test('adoption never overwrites data the new install already has', () => {
  const parent = tmpdir();
  const oldDir = path.join(parent, 'Nova'), newDir = path.join(parent, 'Lyra');
  fs.mkdirSync(path.join(oldDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(oldDir, 'state', 'settings.json'), '{"from":"old"}');
  fs.mkdirSync(path.join(newDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(newDir, 'state', 'settings.json'), '{"from":"new"}');
  assert.equal(adoptOldUserData(newDir), null, 'a populated new folder is left alone');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(newDir, 'state', 'settings.json'), 'utf8')), { from: 'new' });
});

test('copyDir copies recursively and honours skips', () => {
  const src = tmpdir(), dst = path.join(tmpdir(), 'out');
  fs.mkdirSync(path.join(src, 'sub', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(src, 'vendor'), { recursive: true });
  fs.writeFileSync(path.join(src, 'a.txt'), 'a');
  fs.writeFileSync(path.join(src, 'sub', 'deep', 'b.txt'), 'b');
  fs.writeFileSync(path.join(src, 'vendor', 'big.js'), 'x');
  copyDir(src, dst, { skip: ['vendor'] });
  assert.equal(fs.readFileSync(path.join(dst, 'a.txt'), 'utf8'), 'a');
  assert.equal(fs.readFileSync(path.join(dst, 'sub', 'deep', 'b.txt'), 'utf8'), 'b');
  assert.equal(fs.existsSync(path.join(dst, 'vendor')), false);
});
