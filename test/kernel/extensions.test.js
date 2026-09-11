// Extensions are third-party code running inside the app: the tests cover the
// manifest contract, the capability gate, and what happens when one misbehaves.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { fakeKernel, cleanup } = require('../helpers/tmp');
const { Extensions, CAPABILITIES } = require('../../main/kernel/extensions');

test.after(cleanup);

function withExt(id, files) {
  const k = fakeKernel();
  k.organs = { runShell: async () => 'ran', browser: { fake: true } };
  k.root = () => k.paths.userData;
  const dir = path.join(k.paths.extensions, id);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return { k, ext: new Extensions(k), dir };
}

const manifest = (over = {}) => ({ id: 'demo', name: 'Demo', capabilities: [], ...over });
const TOOL_MAIN = `module.exports = { tools: [{ name: 'demo_echo', description: 'Echo back', run: async (a) => 'echo ' + a.text }] };`;

test('a well-formed manifest is accepted and defaults are filled in', () => {
  const { ext } = withExt('demo', { 'manifest.json': manifest(), 'main.js': TOOL_MAIN, 'panel.html': '<p>hi</p>' });
  const m = ext.manifest('demo');
  assert.equal(m.id, 'demo');
  assert.equal(m.main, 'main.js', 'main.js is picked up without being declared');
  assert.equal(m.panel, 'panel.html');
  assert.deepEqual(m.capabilities, []);
});

test('broken manifests are rejected with an explanation', () => {
  const cases = [
    [{ 'other.json': '{}' }, /manifest.json missing/],
    [{ 'manifest.json': '{ not json' }, /not valid JSON/],
    [{ 'manifest.json': JSON.stringify({ id: 'demo' }) }, /needs a name/],
    [{ 'manifest.json': JSON.stringify({ id: 'elsewhere', name: 'X' }) }, /does not match folder/],
    [{ 'manifest.json': JSON.stringify({ name: 'X', capabilities: ['telepathy'] }) }, /unknown capabilities/],
    [{ 'manifest.json': JSON.stringify({ name: 'X', panel: 'nope.html' }) }, /panel file nope.html missing/],
    [{ 'manifest.json': JSON.stringify({ name: 'X', main: 'nope.js' }) }, /main file nope.js missing/],
  ];
  for (const [files, re] of cases) {
    const { ext } = withExt('demo', files);
    assert.throws(() => ext.manifest('demo'), re);
  }
});

test('every capability the manifest may declare is described for the user', () => {
  for (const [cap, why] of Object.entries(CAPABILITIES)) assert.ok(why && why.length > 3, `${cap} needs a description`);
});

test('an extension does not load until its capabilities are approved', () => {
  const { ext } = withExt('demo', { 'manifest.json': manifest({ capabilities: ['shell'] }), 'main.js': TOOL_MAIN });
  const r = ext.load('demo');
  assert.equal(r.ok, false);
  assert.match(r.error, /not approved/);
  assert.deepEqual(r.pending, ['shell']);
  assert.deepEqual(ext.tools(), []);

  const approved = ext.approve('demo');
  assert.equal(approved.ok, true);
  assert.deepEqual(approved.tools, ['demo_echo']);
  assert.equal(ext.tools().length, 1);
});

test('an approved extension exposes its tools and its panel', async () => {
  const { ext } = withExt('demo', { 'manifest.json': manifest(), 'main.js': TOOL_MAIN, 'panel.html': '<p>hi</p>' });
  ext.approve('demo');
  const [tool] = ext.tools();
  assert.equal(tool.name, 'demo_echo');
  assert.equal(tool.key, 'ext', 'extension tools ride the ext master switch');
  assert.equal(tool.extension, 'demo');
  assert.equal(tool.risk(), 'low', 'a capability-free extension is low risk');
  assert.equal(await ext.call('demo', 'demo_echo', { text: 'hi' }), 'echo hi');
  assert.deepEqual(ext.panels().map((p) => p.id), ['demo']);
});

test('tools from an extension with shell or file access are high risk', () => {
  const { ext } = withExt('demo', { 'manifest.json': manifest({ capabilities: ['shell'] }), 'main.js': TOOL_MAIN });
  ext.approve('demo');
  assert.equal(ext.tools()[0].risk(), 'high');
});

test('the api refuses anything the manifest did not declare', () => {
  const { ext } = withExt('demo', { 'manifest.json': manifest({ capabilities: ['settings'] }) });
  const api = ext.api(ext.manifest('demo'));
  assert.ok(api.settings().persona, 'declared capabilities work');
  assert.throws(() => api.runShell('ls'), /did not declare the "shell" capability/);
  assert.throws(() => api.browser(), /did not declare the "browser" capability/);
  assert.throws(() => api.fetch('http://x'), /did not declare the "network" capability/);
});

test('extension storage is namespaced so one cannot read another', () => {
  const { k, ext } = withExt('demo', { 'manifest.json': manifest() });
  const api = ext.api(ext.manifest('demo'));
  api.store.set('token', 'mine');
  assert.equal(api.store.get('token'), 'mine');
  assert.equal(k.store.kvGet('ext:demo:token'), 'mine');
  assert.equal(k.store.kvGet('token'), null, 'nothing leaks into the kernel namespace');
});

test('an extension that throws on load is quarantined, not retried forever', () => {
  const { k, ext } = withExt('bad', { 'manifest.json': manifest({ id: 'bad', name: 'Bad' }), 'main.js': `throw new Error('bad extension');` });
  const r = ext.approve('bad');
  assert.equal(r.ok, false);
  const entry = ext.list().find((x) => x.id === 'bad');
  assert.equal(entry.status, 'quarantined');
  assert.match(entry.error, /bad extension/);
  assert.equal(ext.load('bad').error, 'quarantined: ' + entry.error, 'it stays quarantined on the next attempt');
  assert.ok(k.events.some((e) => e.type === 'kernel' && /quarantined/.test(e.text)), 'the user is told');
});

test('a malformed tool is refused rather than half-registered', () => {
  const { ext } = withExt('demo', { 'manifest.json': manifest(), 'main.js': `module.exports = { tools: [{ name: 'x' }] };` });
  const r = ext.approve('demo');
  assert.equal(r.ok, false);
  assert.match(r.error, /needs name, description and run/);
});

test('repeated tool failures quarantine the extension', async () => {
  const { ext } = withExt('flaky', {
    'manifest.json': manifest({ id: 'flaky', name: 'Flaky' }),
    'main.js': `module.exports = { tools: [{ name: 'boom', description: 'always fails', run: async () => { throw new Error('nope'); } }] };`,
  });
  ext.approve('flaky');
  for (let i = 0; i < 5; i++) await assert.rejects(() => ext.call('flaky', 'boom', {}), /nope/);
  assert.equal(ext.list().find((x) => x.id === 'flaky').status, 'quarantined');
});

test('disabling an extension unloads it and enabling loads it again', () => {
  const { ext } = withExt('demo', { 'manifest.json': manifest(), 'main.js': TOOL_MAIN });
  ext.approve('demo');
  assert.equal(ext.tools().length, 1);
  ext.setEnabled('demo', false);
  assert.equal(ext.tools().length, 0);
  assert.equal(ext.load('demo').error, 'disabled');
  assert.equal(ext.setEnabled('demo', true).ok, true);
  assert.equal(ext.tools().length, 1);
});

test('dispose is called when an extension is unloaded', () => {
  const { k, ext } = withExt('demo', {
    'manifest.json': manifest(),
    'main.js': `module.exports = { activate: (api) => api.log('activated'), dispose: () => { require('fs').writeFileSync(process.env.LYRA_TEST_DISPOSE, 'yes'); } };`,
  });
  const marker = path.join(k.paths.userData, 'disposed.txt');
  process.env.LYRA_TEST_DISPOSE = marker;
  ext.approve('demo');
  assert.ok(k.logged.some((l) => /activated/.test(l.msg || '')), 'activate runs with the api');
  ext.unloadAll();
  assert.equal(fs.readFileSync(marker, 'utf8'), 'yes');
  delete process.env.LYRA_TEST_DISPOSE;
});

test('calling a tool on an inactive extension is an error, not a crash', async () => {
  const { ext } = withExt('demo', { 'manifest.json': manifest(), 'main.js': TOOL_MAIN });
  await assert.rejects(() => ext.call('demo', 'demo_echo', {}), /is not active/);
  ext.approve('demo');
  await assert.rejects(() => ext.call('demo', 'missing_tool', {}), /has no tool/);
});

test('approval state survives a restart', () => {
  const { k, ext } = withExt('demo', { 'manifest.json': manifest({ capabilities: ['settings'] }), 'main.js': TOOL_MAIN });
  ext.approve('demo');
  const fresh = new Extensions(k);
  fresh.loadAll();
  assert.equal(fresh.tools().length, 1, 'an approved extension loads without asking again');
});
