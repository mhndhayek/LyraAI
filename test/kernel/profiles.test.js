// Profiles, end to end at the kernel level: settings, the data folder each one
// gets, and the switch that swaps one assistant for another.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpdir, cleanup } = require('../helpers/tmp');
const { Settings } = require('../../main/kernel/settings');
const { openStore } = require('../../main/kernel/store');
const { layout, migrate } = require('../../main/kernel/paths');

test.after(cleanup);

// The kernel's half of a profile switch: close the store, move the settings
// over, open the store the new profile uses.
function install({ storeKind = 'json' } = {}) {
  const userData = tmpdir();
  const paths = layout(userData, path.join(__dirname, '..', '..'));
  migrate(paths);
  const settings = new Settings(paths.settingsFile);
  if (storeKind !== 'sqlite') settings.set({ persona: { store: storeKind } });
  const dir = (id) => path.join(userData, settings.profileDataDir(id));
  let store = openStore(dir(), settings.get().persona.store);
  return {
    settings, userData,
    get store() { return store; },
    use(id) { store.close(); settings.switchProfile(id); store = openStore(dir(id), settings.get().persona.store); },
    close() { store.close(); },
  };
}

test('the first profile keeps using the data that was already there', () => {
  const userData = tmpdir();
  const paths = layout(userData, path.join(__dirname, '..', '..'));
  migrate(paths);
  const before = openStore(userData, 'json');
  before.createChat({ title: 'from before profiles existed' });
  before.close();

  const settings = new Settings(paths.settingsFile);
  const store = openStore(path.join(userData, settings.profileDataDir()), 'json');
  assert.equal(store.listChats()[0].title, 'from before profiles existed', 'nothing was moved out from under her');
  store.close();
});

test('each profile has her own chats', () => {
  const app = install();
  app.store.createChat({ title: 'talking to the first' });
  const iris = app.settings.createProfile({ name: 'Iris' });

  app.use(iris.id);
  assert.deepEqual(app.store.listChats(), [], 'she starts with a blank slate');
  app.store.createChat({ title: 'talking to Iris' });

  app.use('default');
  assert.deepEqual(app.store.listChats().map((c) => c.title), ['talking to the first'], 'and cannot see the other one');
  app.close();
});

test('each profile has her own memory and goals', () => {
  const app = install();
  app.store.addMemory('long', null, 'the first one remembers this');
  app.store.addGoal({ title: 'a goal of the first one' });
  const iris = app.settings.createProfile({ name: 'Iris' });

  app.use(iris.id);
  assert.deepEqual(app.store.listMemories('long'), []);
  assert.deepEqual(app.store.listGoals(), []);
  app.store.addMemory('long', null, 'Iris remembers something else');

  app.use('default');
  assert.deepEqual(app.store.listMemories('long').map((m) => m.text), ['the first one remembers this']);
  assert.deepEqual(app.store.listGoals().map((g) => g.title), ['a goal of the first one']);
  app.close();
});

test('a profile keeps her data in her own folder', () => {
  const app = install();
  const iris = app.settings.createProfile({ name: 'Iris' });
  app.use(iris.id);
  app.store.createChat({ title: 'hers' });
  app.close();
  const dir = path.join(app.userData, 'profiles', 'iris');
  assert.ok(fs.existsSync(dir), `${dir} should hold her data`);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('lyra.')), 'her store lives there');
});

test('two profiles can use different stores', () => {
  const app = install({ storeKind: 'json' });
  const iris = app.settings.createProfile({ name: 'Iris' });
  app.use(iris.id);
  app.settings.set({ persona: { store: 'json' } });
  app.store.createChat({ title: 'hers' });
  app.use('default');
  assert.equal(app.settings.get().persona.store, 'json');
  app.close();
});

test('everything that makes her herself changes together on a switch', () => {
  const app = install();
  app.settings.set({ persona: { soul: 'the first soul' }, appearance: { theme: 'pixel', gifFolder: 'builtin:fox' }, voice: { voice: 'Rosie' }, goals: { autonomous: true }, model: { temperature: 0.2 } });
  const iris = app.settings.createProfile({ name: 'Iris' });
  app.use(iris.id);
  app.settings.set({ persona: { soul: 'a different soul' }, appearance: { theme: 'lyra-light', gifFolder: 'builtin:succubus' }, voice: { voice: 'Luna' }, goals: { autonomous: false }, model: { temperature: 0.9 } });

  const hers = app.settings.get();
  assert.equal(hers.persona.name, 'Iris');
  assert.equal(hers.appearance.theme, 'lyra-light');
  assert.equal(hers.voice.voice, 'Luna');

  app.use('default');
  const first = app.settings.get();
  assert.equal(first.persona.soul, 'the first soul');
  assert.equal(first.appearance.theme, 'pixel');
  assert.equal(first.appearance.gifFolder, 'builtin:fox', 'her animation comes back with her');
  assert.equal(first.voice.voice, 'Rosie');
  assert.equal(first.goals.autonomous, true);
  assert.equal(first.model.temperature, 0.2);
  app.close();
});

test('deleting a profile leaves the others alone', () => {
  const app = install();
  app.store.createChat({ title: 'kept' });
  const iris = app.settings.createProfile({ name: 'Iris' });
  app.use(iris.id);
  app.store.createChat({ title: 'going away' });
  app.use('default');

  const dir = path.join(app.userData, 'profiles', 'iris');
  app.settings.deleteProfile(iris.id);
  fs.rmSync(dir, { recursive: true, force: true });

  assert.equal(app.settings.profiles().list.length, 1);
  assert.deepEqual(app.store.listChats().map((c) => c.title), ['kept']);
  assert.equal(fs.existsSync(dir), false);
  app.close();
});

test('a profile on a retired built-in pack falls back to the cat girl', () => {
  const userData = tmpdir();
  const paths = layout(userData, path.join(__dirname, '..', '..'));
  migrate(paths);
  fs.mkdirSync(path.dirname(paths.settingsFile), { recursive: true });
  fs.writeFileSync(paths.settingsFile, JSON.stringify({
    ui: { setupDone: true },
    profiles: { active: 'cow', list: [
      { id: 'cow', name: 'Cow', dataDir: '', persona: { name: 'Cow', avatar: 'builtin:cowboy' }, appearance: { source: 'gif', gifFolder: 'builtin:cowboy' } },
      { id: 'sue', name: 'Sue', dataDir: 'profiles/sue', persona: { name: 'Sue', avatar: 'builtin:succubus' }, appearance: { source: 'gif', gifFolder: 'builtin:succubus' } },
      { id: 'own', name: 'Own', dataDir: 'profiles/own', persona: { name: 'Own', avatar: '/Users/me/fox.png' }, appearance: { source: 'gif', gifFolder: '/Users/me/packs/foxgirl' } },
    ] },
  }));
  const settings = new Settings(paths.settingsFile);
  assert.equal(settings.get().appearance.gifFolder, 'builtin:catgirl', 'a retired pack is swapped for the original');
  assert.equal(settings.get().persona.avatar, 'builtin:catgirl');
  settings.switchProfile('sue');
  assert.equal(settings.get().appearance.gifFolder, 'builtin:succubus', 'a pack that still ships is left alone');
  settings.switchProfile('own');
  assert.equal(settings.get().appearance.gifFolder, '/Users/me/packs/foxgirl', 'a pack outside the app is left alone');
  assert.equal(settings.get().persona.avatar, '/Users/me/fox.png');
  const saved = JSON.parse(fs.readFileSync(paths.settingsFile, 'utf8'));
  assert.equal(saved.profiles.list[0].appearance.gifFolder, 'builtin:catgirl', 'the fix is written back to disk');
});

test('the retired live-character sources fall back to the GIF pack, 3D is kept', () => {
  const userData = tmpdir();
  const paths = layout(userData, path.join(__dirname, '..', '..'));
  migrate(paths);
  fs.mkdirSync(path.dirname(paths.settingsFile), { recursive: true });
  fs.writeFileSync(paths.settingsFile, JSON.stringify({
    ui: { setupDone: true },
    profiles: { active: 'svg', list: [
      { id: 'svg', name: 'Svg', dataDir: '', appearance: { source: 'svg', gifFolder: 'builtin:succubus' } },
      { id: 'pet', name: 'Pet', dataDir: 'profiles/pet', appearance: { source: 'pet', petFolder: '/Users/me/.hermes/pets/boba' } },
      { id: 'l2d', name: 'L2d', dataDir: 'profiles/l2d', appearance: { source: 'live2d', live2dModel: '/Users/me/hiyori.model3.json', last2d: 'live2d' } },
      { id: 'vrm', name: 'Vrm', dataDir: 'profiles/vrm', appearance: { source: 'vrm', vrmModel: '/Users/me/me.vrm' } },
    ] },
  }));
  const settings = new Settings(paths.settingsFile);
  assert.equal(settings.get().appearance.source, 'gif', 'built-in SVG becomes the GIF pack');
  assert.equal(settings.get().appearance.gifFolder, 'builtin:succubus', 'and keeps the pack it had');
  settings.switchProfile('pet');
  assert.equal(settings.get().appearance.source, 'gif');
  assert.equal(settings.get().appearance.gifFolder, 'builtin:catgirl', 'a pet with no pack gets the cat girl');
  settings.switchProfile('l2d');
  assert.equal(settings.get().appearance.source, 'gif');
  settings.switchProfile('vrm');
  assert.equal(settings.get().appearance.source, 'vrm', '3D stays 3D');
  assert.equal(settings.get().appearance.vrmModel, '/Users/me/me.vrm');
  const saved = JSON.parse(fs.readFileSync(paths.settingsFile, 'utf8'));
  for (const p of saved.profiles.list) {
    for (const k of ['petFolder', 'live2dModel', 'last2d']) assert.ok(!(k in (p.appearance || {})), `${p.id}: ${k} is gone`);
  }
});
