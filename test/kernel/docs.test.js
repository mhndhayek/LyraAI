const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeKernel, cleanup } = require('../helpers/tmp');
const { Docs } = require('../../main/kernel/docs');
const { LOCKED } = require('../../main/kernel/guard');

test.after(cleanup);

function docsKernel() {
  const k = fakeKernel();
  k.extensions = { tools: () => [] };
  k.organs = { tools: require('../../main/organs/tools') };
  return { k, docs: new Docs(k) };
}

test('every advertised topic returns real content', () => {
  const { docs } = docsKernel();
  for (const topic of docs.topics()) {
    const text = docs.read(topic);
    assert.ok(typeof text === 'string' && text.length > 40, `${topic} is empty`);
    assert.ok(!/^Missing doc/.test(text), `${topic} points at a file that is not shipped`);
  }
});

test('the shipped markdown guides are all present', () => {
  const { docs } = docsKernel();
  for (const topic of ['agent', 'extensions', 'organs', 'recovery', 'avatars']) {
    assert.ok(docs.read(topic).length > 200, `${topic} doc is missing or too short to help`);
  }
});

test('an unknown topic lists the ones that exist', () => {
  const { docs } = docsKernel();
  const out = docs.read('nonsense');
  assert.match(out, /^Unknown topic/);
  for (const t of docs.topics()) assert.ok(out.includes(t), `${t} not offered`);
});

test('the settings doc shows live values and flags what is locked', () => {
  const { k, docs } = docsKernel();
  k.settings.set({ appearance: { theme: 'pixel' } });
  const out = docs.read('settings');
  assert.match(out, /appearance\.theme = "pixel" \(default "lyra-dark"\)/);
  for (const l of LOCKED) assert.ok(new RegExp(`${l.replace('.', '\\.')}[^\\n]*LOCKED`).test(out), `${l} is not marked locked`);
  assert.match(out, /model\.chat\.model[^\n]*queued until idle/);
});

test('the tools doc describes the tools that are actually switched on', () => {
  const { k, docs } = docsKernel();
  const out = docs.read('tools');
  assert.match(out, /## read_file/);
  assert.match(out, /## shell/);
  assert.ok(!out.includes('## web_search'), 'web search is off by default and is not advertised');
  k.settings.set({ tools: { shell: false } });
  assert.ok(!docs.read('tools').includes('## shell'), 'a disabled tool disappears from the doc');
});

test('the tools doc says so plainly when the organs are not loaded', () => {
  const { k, docs } = docsKernel();
  k.organs = null;
  assert.equal(docs.read('tools'), 'Organs not loaded.');
});

test('the UI doc maps the renderer files the agent may edit', () => {
  const { k, docs } = docsKernel();
  const fs = require('fs'), path = require('path');
  fs.writeFileSync(path.join(k.paths.organsRenderer, 'app.js'), '// ui');
  fs.mkdirSync(path.join(k.paths.organsRenderer, 'vendor'), { recursive: true });
  fs.writeFileSync(path.join(k.paths.organsRenderer, 'vendor', 'pixi.js'), '// huge');
  const out = docs.read('ui');
  assert.match(out, /- app\.js/);
  assert.ok(!out.includes('pixi.js'), 'vendored libraries are not listed as editable');
  assert.match(out, /apply_changes/, 'the doc tells the agent how to apply a UI change');
});

test('the examples doc inlines the shipped example extension', () => {
  const { docs } = docsKernel();
  const out = docs.read('examples');
  assert.match(out, /hello-panel/);
  assert.match(out, /manifest\.json/);
});

test('topic lookup is forgiving about case and blanks', () => {
  const { docs } = docsKernel();
  assert.equal(docs.read('SETTINGS').slice(0, 10), docs.read('settings').slice(0, 10));
  assert.equal(docs.read().slice(0, 10), docs.read('agent').slice(0, 10), 'the agent guide is the default');
});

test('the settings doc tells her which profile she is, without showing the others', () => {
  const { k, docs } = docsKernel();
  k.settings.createProfile({ name: 'Iris' });
  k.settings.set({ providers: { list: [{ id: 'x', name: 'Remote', runtime: 'openai', endpoint: 'https://api.example.com/v1', apiKey: 'sk-the-first-ones-key' }] } });
  const iris = k.settings.profiles().list.find((p) => p.name === 'Iris');
  k.settings.switchProfile(iris.id);

  const out = docs.read('settings');
  assert.match(out, /You are the profile "Iris", one of 2/);
  assert.match(out, /profiles LOCKED: only the user/, 'she must be told she cannot switch profiles herself');
  assert.ok(!out.includes('sk-the-first-ones-key'), 'another profile’s key must not be readable from here');
});
