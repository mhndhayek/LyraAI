const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpdir, cleanup } = require('../helpers/tmp');
const { Settings, DEFAULTS, DEFAULT_SOUL, merge } = require('../../main/kernel/settings');

test.after(cleanup);
const file = () => path.join(tmpdir(), 'state', 'settings.json');
// What the file holds for the profile in force, which is where the sections
// that belong to a profile are written.
const savedProfile = (f) => {
  const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  return raw.profiles.list.find((p) => p.id === raw.profiles.active);
};

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
  assert.equal(savedProfile(f).appearance.theme, 'pixel', 'the look is saved with the profile it belongs to');
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
  const onDisk = savedProfile(f);
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

/* ---- profiles ---- */

test('an install from before profiles becomes the first profile, in place', () => {
  const f = file();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ persona: { name: 'Ada', soul: 'be precise' }, appearance: { theme: 'pixel' } }));
  const s = new Settings(f);
  const { active, list } = s.profiles();
  assert.equal(list.length, 1);
  assert.equal(active, list[0].id);
  assert.equal(list[0].name, 'Ada', 'the profile is named after her');
  assert.equal(s.get().persona.soul, 'be precise', 'nothing about her is lost');
  assert.equal(s.get().appearance.theme, 'pixel');
  assert.equal(s.profileDataDir(), '', 'the first profile keeps the data folder it already uses');
});

test('a profile owns her persona, look, voice, goals and model', () => {
  const { PROFILE_SECTIONS } = require('../../main/kernel/settings');
  assert.deepEqual(PROFILE_SECTIONS, ['persona', 'appearance', 'voice', 'goals', 'model', 'providers']);
  const s = new Settings(file());
  const saved = s.activeProfile();
  for (const section of PROFILE_SECTIONS) assert.ok(saved[section], `${section} should be stored with the profile`);
});

test('a second profile starts fresh and does not disturb the first', () => {
  const s = new Settings(file());
  s.set({ persona: { soul: 'the first one' }, appearance: { theme: 'pixel' } });
  const made = s.createProfile({ name: 'Iris' });
  assert.equal(made.name, 'Iris');
  assert.equal(made.persona.name, 'Iris');
  assert.match(made.dataDir, /profiles[/\\]iris/, 'a new profile gets its own data folder');
  assert.equal(s.get().persona.soul, 'the first one', 'creating one does not switch to it');

  s.switchProfile(made.id);
  assert.equal(s.get().persona.name, 'Iris');
  assert.equal(s.get().persona.soul, DEFAULT_SOUL, 'she starts with her own soul');
  assert.equal(s.get().appearance.theme, 'lyra-dark', 'and her own look');

  s.switchProfile('default');
  assert.equal(s.get().persona.soul, 'the first one', 'the first one is exactly as it was');
  assert.equal(s.get().appearance.theme, 'pixel');
});

test('editing one profile never reaches another', () => {
  const s = new Settings(file());
  const b = s.createProfile({ name: 'Iris' });
  s.set({ voice: { voice: 'Rosie' }, model: { temperature: 0.1 } });
  s.switchProfile(b.id);
  s.set({ voice: { voice: 'Luna' }, model: { temperature: 0.9 } });
  assert.equal(s.get().voice.voice, 'Luna');
  assert.equal(s.get().model.temperature, 0.9);
  s.switchProfile('default');
  assert.equal(s.get().voice.voice, 'Rosie');
  assert.equal(s.get().model.temperature, 0.1);
});

test('the settings that belong to the machine are shared by every profile', () => {
  const s = new Settings(file());
  const b = s.createProfile({ name: 'Iris' });
  s.set({ safety: { approvalMode: 'auto' }, workspace: { folder: '/tmp/shared' }, mobile: { port: 9443 } });
  s.switchProfile(b.id);
  assert.equal(s.get().safety.approvalMode, 'auto', 'safety is the user’s, not the profile’s');
  assert.equal(s.get().workspace.folder, '/tmp/shared');
  assert.equal(s.get().mobile.port, 9443);
});

test('a profile can be copied, taking the settings but not the name', () => {
  const s = new Settings(file());
  s.set({ persona: { soul: 'worth keeping' }, appearance: { theme: 'pixel' }, voice: { voice: 'Rosie' } });
  const copy = s.createProfile({ name: 'Iris', copyFrom: 'default' });
  s.switchProfile(copy.id);
  assert.equal(s.get().persona.soul, 'worth keeping');
  assert.equal(s.get().appearance.theme, 'pixel');
  assert.equal(s.get().persona.name, 'Iris', 'but she is her own person');
});

test('profiles survive a restart, including which one was in use', () => {
  const f = file();
  const s = new Settings(f);
  const b = s.createProfile({ name: 'Iris' });
  s.switchProfile(b.id);
  s.set({ persona: { soul: 'second' } });

  const again = new Settings(f);
  assert.equal(again.profiles().active, b.id);
  assert.equal(again.get().persona.soul, 'second');
  assert.equal(again.profiles().list.length, 2);
});

test('renaming a profile renames her with it', () => {
  const s = new Settings(file());
  s.renameProfile('default', 'Ada');
  assert.equal(s.get().persona.name, 'Ada');
  assert.equal(s.profiles().list[0].name, 'Ada');
});

test('naming her renames the profile, so the two never disagree', () => {
  const s = new Settings(file());
  s.set({ persona: { name: 'Ada' } });
  assert.equal(s.profiles().list[0].name, 'Ada');
});

test('a profile can be deleted, but never the last one', () => {
  const s = new Settings(file());
  const b = s.createProfile({ name: 'Iris' });
  s.switchProfile(b.id);
  const out = s.deleteProfile(b.id);
  assert.equal(out.profiles.list.length, 1);
  assert.equal(s.profiles().active, 'default', 'deleting the one in use falls back to another');
  assert.throws(() => s.deleteProfile('default'), /has to be one profile/);
});

test('profiles are refused rather than allowed to collide or vanish', () => {
  const s = new Settings(file());
  assert.throws(() => s.createProfile({ name: '  ' }), /needs a name/);
  assert.throws(() => s.switchProfile('nope'), /no profile nope/);
  assert.throws(() => s.renameProfile('nope', 'x'), /no profile nope/);
  const a = s.createProfile({ name: 'Iris' });
  const b = s.createProfile({ name: 'Iris' });
  assert.notEqual(a.id, b.id, 'two profiles with the same name still get their own folders');
  assert.notEqual(a.dataDir, b.dataDir);
});

test('resetting everything keeps the other profiles', () => {
  const s = new Settings(file());
  s.createProfile({ name: 'Iris' });
  s.set({ persona: { soul: 'changed' } });
  s.reset();
  assert.equal(s.get().persona.soul, DEFAULT_SOUL);
  assert.equal(s.profiles().list.length, 2, 'a reset is not a way to lose the others');
});

test('switching profile reports a change with no patch, so nothing reads it as an edit', () => {
  const s = new Settings(file());
  const b = s.createProfile({ name: 'Iris' });
  const seen = [];
  s.on('change', (data, before, patch) => seen.push(patch));
  s.switchProfile(b.id);
  assert.deepEqual(seen, [{}]);
});
