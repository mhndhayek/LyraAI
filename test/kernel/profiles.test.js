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
  app.settings.set({ persona: { soul: 'a different soul' }, appearance: { theme: 'lyra-light', gifFolder: 'builtin:cowboy' }, voice: { voice: 'Luna' }, goals: { autonomous: false }, model: { temperature: 0.9 } });

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
