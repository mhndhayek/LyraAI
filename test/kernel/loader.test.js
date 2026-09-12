// The loader is the gate every self-modification passes through: it must catch a
// broken organ in a throwaway process before the change can reach the running app.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { fakeKernel, cleanup } = require('../helpers/tmp');
const { Loader } = require('../../main/kernel/loader');

test.after(cleanup);

function loaderKernel() {
  const k = fakeKernel();
  const committed = [];
  k.checkpoints = { commit: (label) => { committed.push(label); return { hash: 'abc', label }; }, isDirty: () => false, markGood: () => {} };
  k.committed = committed;
  const loader = new Loader(k);
  loader.syncOrgans({ force: true });
  return { k, loader };
}

test('shipped organs are copied into the state folder and stamped with the version', () => {
  const { k, loader } = loaderKernel();
  assert.ok(fs.existsSync(path.join(k.paths.organsMain, 'index.js')));
  assert.ok(fs.existsSync(path.join(k.paths.organsMain, 'tools.js')));
  assert.ok(fs.existsSync(path.join(k.paths.organsRenderer, 'index.html')));
  assert.equal(fs.readFileSync(k.paths.organsVersion, 'utf8').trim(), k.version);
  assert.ok(k.committed.some((l) => /Organs synced/.test(l)), 'the sync is checkpointed');
  const again = loader.syncOrgans();
  assert.equal(again.synced, false, 'an up-to-date state folder is left alone');
});

test('a sync for a new version keeps a checkpoint of what came before', () => {
  const { k, loader } = loaderKernel();
  fs.writeFileSync(path.join(k.paths.organsMain, 'mine.js'), '// the user edited this');
  k.version = '9.9.9';
  const r = loader.syncOrgans();
  assert.equal(r.synced, true);
  assert.equal(r.version, '9.9.9');
  assert.ok(k.committed.some((l) => /Before organ sync to 9\.9\.9/.test(l)));
});

test('clean shipped organs verify', async () => {
  const { loader } = loaderKernel();
  const v = await loader.verify('all');
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.deepEqual(v.errors, []);
});

test('a syntax error is caught with the file that caused it', async () => {
  const { k, loader } = loaderKernel();
  const file = path.join(k.paths.organsMain, 'tools.js');
  fs.writeFileSync(file, 'this is not javascript (\n' + fs.readFileSync(file, 'utf8'));
  const v = await loader.verify('main');
  assert.equal(v.ok, false);
  assert.equal(v.errors.length, 1);
  assert.match(v.errors[0].file, /tools\.js$/);
  assert.ok(v.errors[0].message.length > 0, 'the agent is told what is wrong');
  assert.ok(!path.isAbsolute(v.errors[0].file), 'paths are reported relative to the state folder');
});

test('code that throws while being loaded is caught before it goes live', async () => {
  const { k, loader } = loaderKernel();
  const file = path.join(k.paths.organsMain, 'index.js');
  fs.writeFileSync(file, `throw new Error('organ exploded on load');\n`);
  const v = await loader.verify('main');
  assert.equal(v.ok, false);
  assert.match(JSON.stringify(v.errors), /organ exploded on load/);
});

test('a main organ set that forgets to export create is rejected', async () => {
  const { k, loader } = loaderKernel();
  fs.writeFileSync(path.join(k.paths.organsMain, 'index.js'), 'module.exports = {};\n');
  const v = await loader.verify('main');
  assert.equal(v.ok, false);
  assert.match(JSON.stringify(v.errors), /must export create\(kernel\)/);
});

test('organs may require electron: verification substitutes a stub', async () => {
  const { k, loader } = loaderKernel();
  const file = path.join(k.paths.organsMain, 'index.js');
  fs.writeFileSync(file, `const { app, BrowserWindow } = require('electron');\nnew BrowserWindow({});\nmodule.exports = { create: () => ({ dispose() {} }) };\n`);
  const v = await loader.verify('main');
  assert.equal(v.ok, true, JSON.stringify(v.errors));
});

test('a missing UI entry point fails verification', async () => {
  const { k, loader } = loaderKernel();
  fs.rmSync(path.join(k.paths.organsRenderer, 'index.html'));
  const v = await loader.verify('renderer');
  assert.equal(v.ok, false);
  assert.match(v.errors[0].file, /index\.html$/);
});

test('verifying one half ignores breakage in the other', async () => {
  const { k, loader } = loaderKernel();
  fs.writeFileSync(path.join(k.paths.organsRenderer, 'app.js'), 'broken (');
  assert.equal((await loader.verify('main')).ok, true, 'a broken UI does not block a main-organ change');
  assert.equal((await loader.verify('renderer')).ok, false);
  assert.equal((await loader.verify('all')).ok, false);
});

test('vendored libraries and dotfiles are left out of verification', async () => {
  const { k, loader } = loaderKernel();
  fs.mkdirSync(path.join(k.paths.organsRenderer, 'vendor'), { recursive: true });
  fs.writeFileSync(path.join(k.paths.organsRenderer, 'vendor', 'huge.js'), 'not ( valid');
  fs.writeFileSync(path.join(k.paths.organsRenderer, '.hidden.js'), 'also ( broken');
  assert.equal((await loader.verify('renderer')).ok, true);
});

test('a forced reset puts the shipped organs back over the agent edits', () => {
  const { k, loader } = loaderKernel();
  const file = path.join(k.paths.organsMain, 'tools.js');
  const shipped = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, '// wiped out');
  loader.syncOrgans({ force: true });
  assert.equal(fs.readFileSync(file, 'utf8'), shipped);
});
