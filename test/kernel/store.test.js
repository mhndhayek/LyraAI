// The same contract is run against both backends, because the "Store" switch in
// Persona settings moves real data between them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpdir, cleanup } = require('../helpers/tmp');
const { openStore } = require('../../main/kernel/store');

test.after(cleanup);

const open = (kind, dir = tmpdir()) => ({ store: openStore(dir, kind), dir });

// node:sqlite only exists from Node 22 on; older runtimes are expected to fall
// back to the JSON store rather than fail to start.
const SQLITE_AVAILABLE = (() => { try { require('node:sqlite'); return true; } catch { return false; } })();

test('the SQLite backend is used where the runtime has it, and falls back where it does not', () => {
  const { store } = open('sqlite');
  assert.equal(store.kind, SQLITE_AVAILABLE ? 'sqlite' : 'json');
  store.close();
});

test('asking for JSON always gets JSON', () => {
  const { store } = open('json');
  assert.equal(store.kind, 'json');
  store.close();
});

test('an unknown backend name still returns a working store', () => {
  const { store } = open('something-else');
  assert.equal(store.kind, 'json');
  assert.ok(store.createChat({ title: 'works' }).id);
  store.close();
});

for (const kind of ['sqlite', 'json']) {

  test(`${kind}: chats are created, listed, updated and deleted`, () => {
    const { store } = open(kind);
    const a = store.createChat({ title: 'First' });
    const b = store.createChat({ title: 'Second', kind: 'goal' });
    assert.equal(store.listChats().length, 2);
    assert.equal(store.getChat(a.id).title, 'First');
    assert.equal(store.getChat(b.id).kind, 'goal');
    store.updateChat(a.id, { title: 'Renamed', updated_at: Date.now() + 1000 });
    assert.equal(store.getChat(a.id).title, 'Renamed');
    assert.equal(store.listChats()[0].id, a.id, 'the most recently updated chat sorts first');
    store.deleteChat(a.id);
    assert.equal(store.getChat(a.id), null);
    assert.equal(store.listChats().length, 1);
    store.close();
  });

  test(`${kind}: messages round-trip structured content and bump the chat`, () => {
    const { store } = open(kind);
    const c = store.createChat({});
    store.addMessage(c.id, 'user', 'hello');
    const parts = [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:,' } }];
    const m = store.addMessage(c.id, 'assistant', parts);
    const rows = store.listMessages(c.id);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].content, 'hello');
    assert.deepEqual(rows[1].content, parts, 'array content survives the round trip');
    assert.equal(store.countMessages(c.id), 2);
    store.updateMessage(m.id, 'edited');
    assert.equal(store.listMessages(c.id)[1].content, 'edited');
    assert.ok(store.getChat(c.id).updated_at >= c.created_at);
    store.close();
  });

  test(`${kind}: deleting a chat takes its messages and short-term memories with it`, () => {
    const { store } = open(kind);
    const c = store.createChat({});
    store.addMessage(c.id, 'user', 'x');
    store.addMemory('short', c.id, 'ephemeral');
    store.addMemory('long', null, 'permanent');
    store.deleteChat(c.id);
    assert.equal(store.listMessages(c.id).length, 0);
    assert.equal(store.listMemories('short', c.id).length, 0);
    assert.equal(store.listMemories('long').length, 1, 'long-term memory outlives the chat');
    store.close();
  });

  test(`${kind}: short-term memory is scoped to its chat, long-term is global`, () => {
    const { store } = open(kind);
    const a = store.createChat({}), b = store.createChat({});
    store.addMemory('short', a.id, 'for a');
    store.addMemory('short', b.id, 'for b');
    const long = store.addMemory('long', a.id, 'for everyone');
    assert.equal(long.chat_id, null, 'long-term memories are not pinned to a chat');
    assert.deepEqual(store.listMemories('short', a.id).map((m) => m.text), ['for a']);
    assert.deepEqual(store.listMemories('long').map((m) => m.text), ['for everyone']);
    store.deleteMemory(long.id);
    assert.equal(store.listMemories('long').length, 0);
    store.clearMemories('short', a.id);
    assert.equal(store.listMemories('short', a.id).length, 0);
    assert.equal(store.listMemories('short', b.id).length, 1, 'clearing one chat leaves the others');
    store.close();
  });

  test(`${kind}: goals default sensibly, update and archive`, () => {
    const { store } = open(kind);
    const g = store.addGoal({ title: 'Learn the codebase' });
    assert.equal(g.type, 'improve');
    assert.equal(g.status, 'proposed');
    assert.equal(store.listGoals().length, 1);
    store.updateGoal(g.id, { status: 'done', archived: 1 });
    assert.equal(store.listGoals().length, 0, 'archived goals drop out of the default list');
    assert.equal(store.listGoals(true).length, 1);
    assert.equal(store.updateGoal('nope', { status: 'x' }), null);
    store.close();
  });

  test(`${kind}: kv stores JSON values and defaults for missing keys`, () => {
    const { store } = open(kind);
    assert.equal(store.kvGet('missing'), null);
    assert.deepEqual(store.kvGet('missing', { a: 1 }), { a: 1 });
    store.kvSet('k', { nested: [1, 2] });
    assert.deepEqual(store.kvGet('k'), { nested: [1, 2] });
    store.kvSet('k', 'overwritten');
    assert.equal(store.kvGet('k'), 'overwritten');
    store.close();
  });

  test(`${kind}: data survives closing and reopening`, () => {
    const dir = tmpdir();
    const first = openStore(dir, kind);
    const c = first.createChat({ title: 'Persisted' });
    first.addMessage(c.id, 'user', 'still here');
    first.kvSet('flag', true);
    first.close();
    const second = openStore(dir, kind);
    assert.equal(second.getChat(c.id).title, 'Persisted');
    assert.equal(second.listMessages(c.id)[0].content, 'still here');
    assert.equal(second.kvGet('flag'), true);
    second.close();
  });
}

test('a dump moves every table from one backend to the other', () => {
  const from = openStore(tmpdir(), 'sqlite');
  const c = from.createChat({ title: 'Move me' });
  from.addMessage(c.id, 'assistant', [{ type: 'text', text: 'rich' }]);
  from.addMemory('long', null, 'remember');
  from.addGoal({ title: 'carry over' });
  from.kvSet('kernel:writes', { date: '2026-01-01', used: 4 });
  const dump = from.dump();
  from.close();

  const to = openStore(tmpdir(), 'json');
  to.loadDump(dump);
  assert.equal(to.getChat(c.id).title, 'Move me');
  assert.deepEqual(to.listMessages(c.id)[0].content, [{ type: 'text', text: 'rich' }]);
  assert.equal(to.listMemories('long')[0].text, 'remember');
  assert.equal(to.listGoals()[0].title, 'carry over');
  assert.deepEqual(to.kvGet('kernel:writes'), { date: '2026-01-01', used: 4 });
  to.close();
});

test('loading a dump twice does not duplicate rows', () => {
  const from = openStore(tmpdir(), 'json');
  from.createChat({ title: 'once' });
  const dump = from.dump();
  from.close();
  const to = openStore(tmpdir(), 'json');
  to.loadDump(dump);
  to.loadDump(dump);
  assert.equal(to.listChats().length, 1);
  to.close();
});

test('a Nova database file is adopted under the new name', () => {
  const dir = tmpdir();
  const seed = openStore(dir, 'json');
  seed.createChat({ title: 'from Nova' });
  seed.close();
  fs.renameSync(path.join(dir, 'lyra.json'), path.join(dir, 'nova.json'));
  const store = openStore(dir, 'json');
  assert.equal(store.listChats()[0].title, 'from Nova');
  assert.ok(fs.existsSync(path.join(dir, 'lyra.json')));
  assert.equal(fs.existsSync(path.join(dir, 'nova.json')), false);
  store.close();
});

test('a corrupt JSON store starts empty instead of crashing', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'lyra.json'), 'not json at all');
  const store = openStore(dir, 'json');
  assert.deepEqual(store.listChats(), []);
  store.close();
});
