const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpdir, cleanup } = require('../helpers/tmp');
const { Settings, DEFAULTS, merge } = require('../../main/kernel/settings');

test.after(cleanup);
const file = () => path.join(tmpdir(), 'state', 'settings.json');

test('merge is deep and leaves the base untouched', () => {
  const base = { a: { b: 1, c: 2 }, d: 3 };
  const out = merge(base, { a: { c: 9 } });
  assert.deepEqual(out, { a: { b: 1, c: 9 }, d: 3 });
  assert.equal(base.a.c, 2, 'merge must not mutate its input');
});

test('arrays are replaced, not merged', () => {
  assert.deepEqual(merge({ list: [1, 2, 3] }, { list: [9] }).list, [9]);
});

test('a fresh install gets the documented defaults', () => {
  const s = new Settings(file());
  const d = s.get();
  assert.equal(d.persona.name, 'Lyra');
  assert.equal(d.appearance.theme, 'lyra-dark');
  assert.equal(d.safety.approvalMode, 'ask');
  assert.equal(d.kernel.checkpoints, true);
  assert.equal(d.mobile.enabled, false, 'phone access is off until the user opens it');
  assert.equal(d.goals.autonomous, false, 'autonomous work is opt-in');
  assert.equal(d.tools.web_search, false);
});

test('every default section survives a save and reload untouched', () => {
  const f = file();
  const a = new Settings(f);
  a.save();
  const b = new Settings(f);
  assert.deepEqual(b.get(), a.get());
  for (const section of Object.keys(DEFAULTS)) assert.ok(b.get()[section] !== undefined, `${section} lost on reload`);
});

test('set applies a deep patch, persists it and emits a change', () => {
  const f = file();
  const s = new Settings(f);
  const seen = [];
  s.on('change', (data, before, patch) => seen.push({ patch, before: before && before.appearance.theme }));
  s.set({ appearance: { theme: 'pixel' } });
  assert.equal(s.get().appearance.theme, 'pixel');
  assert.equal(s.get().appearance.liveCharacter, true, 'siblings are preserved');
  assert.equal(seen.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')).appearance.theme, 'pixel');
  assert.equal(new Settings(f).get().appearance.theme, 'pixel');
});

test('reset restores one section or everything', () => {
  const s = new Settings(file());
  s.set({ appearance: { theme: 'pixel' }, voice: { readAloud: false } });
  s.reset('appearance');
  assert.equal(s.get().appearance.theme, 'lyra-dark');
  assert.equal(s.get().voice.readAloud, false, 'other sections are left alone');
  s.reset();
  assert.equal(s.get().voice.readAloud, true);
});

test('unknown keys in a settings file do not wipe the defaults', () => {
  const f = file();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ somethingOld: true, appearance: { theme: 'pixel' } }));
  const s = new Settings(f);
  assert.equal(s.get().appearance.theme, 'pixel');
  assert.equal(s.get().persona.name, 'Lyra');
  assert.equal(s.get().somethingOld, true);
});

test('a corrupt settings file falls back to defaults instead of crashing', () => {
  const f = file();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '{not json');
  const s = new Settings(f);
  assert.equal(s.get().persona.name, 'Lyra');
});

test('0.9 migration renames the Nova persona and themes, and writes it back', () => {
  const f = file();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ persona: { name: 'Nova' }, appearance: { theme: 'nova-dark' } }));
  const s = new Settings(f);
  assert.equal(s.get().persona.name, 'Lyra');
  assert.equal(s.get().appearance.theme, 'lyra-dark');
  const onDisk = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(onDisk.persona.name, 'Lyra', 'the rename must be persisted, not re-run every boot');
  assert.equal(onDisk.appearance.theme, 'lyra-dark');
});

test('nova-light migrates too', () => {
  const f = file();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ appearance: { theme: 'nova-light' } }));
  assert.equal(new Settings(f).get().appearance.theme, 'lyra-light');
});

test('a single legacy provider is lifted into the provider list', () => {
  const f = file();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ provider: { runtime: 'ollama', endpoint: 'http://localhost:11434/v1', apiKey: 'k' } }));
  const d = new Settings(f).get();
  assert.equal(d.provider, undefined, 'the old shape is removed');
  assert.equal(d.providers.list[0].runtime, 'ollama');
  assert.equal(d.providers.list[0].endpoint, 'http://localhost:11434/v1');
  assert.equal(d.providers.list[0].apiKey, 'k');
});

test('plain string model ids become provider/model presets', () => {
  const f = file();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ model: { chat: 'qwen3', vision: 'llava' } }));
  const d = new Settings(f).get();
  assert.deepEqual(d.model.chat, { provider: 'lmstudio', model: 'qwen3' });
  assert.deepEqual(d.model.vision, { provider: 'lmstudio', model: 'llava' });
});

test('an empty provider list is refilled from the defaults', () => {
  const f = file();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ providers: { list: [] } }));
  assert.equal(new Settings(f).get().providers.list.length, 1);
});
