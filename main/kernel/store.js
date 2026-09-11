// Persistence: SQLite (node:sqlite) or a JSON file. Same API either way, so the
// "Store" switch in Persona settings is real; switching migrates the data.
// node:sqlite only exists from Node 22 on: on anything older, asking for SQLite
// quietly gets the JSON store instead.
const fs = require('fs');
const path = require('path');
const { id, now } = require('./util');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chats(id TEXT PRIMARY KEY, title TEXT, kind TEXT DEFAULT 'chat', created_at INTEGER, updated_at INTEGER, summary TEXT, summarized_count INTEGER DEFAULT 0, reflected INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, chat_id TEXT, role TEXT, content TEXT, created_at INTEGER);
CREATE INDEX IF NOT EXISTS messages_chat ON messages(chat_id, created_at);
CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY, scope TEXT, chat_id TEXT, text TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS goals(id TEXT PRIMARY KEY, type TEXT, title TEXT, why TEXT, status TEXT, archived INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER, log TEXT);
CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT);
`;

class SqliteStore {
  constructor(file) {
    const { DatabaseSync } = require('node:sqlite');
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    this.kind = 'sqlite';
  }
  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  one(sql, ...args) { return this.db.prepare(sql).get(...args); }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }

  listChats() { return this.all(`SELECT id, title, kind, created_at, updated_at FROM chats ORDER BY updated_at DESC`); }
  getChat(cid) { return this.one(`SELECT * FROM chats WHERE id = ?`, cid) || null; }
  createChat({ title = 'New chat', kind = 'chat' } = {}) {
    const c = { id: id(), title, kind, created_at: now(), updated_at: now(), summary: null, summarized_count: 0, reflected: 0 };
    this.run(`INSERT INTO chats(id,title,kind,created_at,updated_at,summary,summarized_count,reflected) VALUES(?,?,?,?,?,?,?,?)`, c.id, c.title, c.kind, c.created_at, c.updated_at, c.summary, c.summarized_count, c.reflected);
    return c;
  }
  updateChat(cid, patch) {
    const cur = this.getChat(cid); if (!cur) return null;
    const n = { ...cur, ...patch, updated_at: patch.updated_at ?? now() };
    this.run(`UPDATE chats SET title=?, kind=?, updated_at=?, summary=?, summarized_count=?, reflected=? WHERE id=?`, n.title, n.kind, n.updated_at, n.summary, n.summarized_count, n.reflected, cid);
    return n;
  }
  deleteChat(cid) { this.run(`DELETE FROM messages WHERE chat_id=?`, cid); this.run(`DELETE FROM memories WHERE chat_id=?`, cid); this.run(`DELETE FROM chats WHERE id=?`, cid); }

  listMessages(cid) { return this.all(`SELECT * FROM messages WHERE chat_id=? ORDER BY created_at ASC`, cid).map((m) => ({ ...m, content: JSON.parse(m.content) })); }
  addMessage(cid, role, content) {
    const m = { id: id(), chat_id: cid, role, content, created_at: now() };
    this.run(`INSERT INTO messages(id,chat_id,role,content,created_at) VALUES(?,?,?,?,?)`, m.id, cid, role, JSON.stringify(content), m.created_at);
    this.run(`UPDATE chats SET updated_at=? WHERE id=?`, m.created_at, cid);
    return m;
  }
  updateMessage(mid, content) { this.run(`UPDATE messages SET content=? WHERE id=?`, JSON.stringify(content), mid); }
  countMessages(cid) { return this.one(`SELECT COUNT(*) AS n FROM messages WHERE chat_id=?`, cid).n; }

  listMemories(scope, cid) {
    return scope === 'short'
      ? this.all(`SELECT * FROM memories WHERE scope='short' AND chat_id=? ORDER BY created_at DESC`, cid)
      : this.all(`SELECT * FROM memories WHERE scope='long' ORDER BY created_at DESC`);
  }
  addMemory(scope, cid, text) {
    const m = { id: id(), scope, chat_id: scope === 'short' ? cid : null, text, created_at: now() };
    this.run(`INSERT INTO memories(id,scope,chat_id,text,created_at) VALUES(?,?,?,?,?)`, m.id, m.scope, m.chat_id, m.text, m.created_at);
    return m;
  }
  deleteMemory(mid) { this.run(`DELETE FROM memories WHERE id=?`, mid); }
  clearMemories(scope, cid) { scope === 'short' ? this.run(`DELETE FROM memories WHERE scope='short' AND chat_id=?`, cid) : this.run(`DELETE FROM memories WHERE scope='long'`); }

  listGoals(all = false) { return this.all(all ? `SELECT * FROM goals ORDER BY created_at DESC` : `SELECT * FROM goals WHERE archived=0 ORDER BY created_at DESC`); }
  addGoal(g) {
    const n = { id: id(), type: g.type || 'improve', title: g.title, why: g.why || '', status: g.status || 'proposed', archived: 0, created_at: now(), updated_at: now(), log: g.log || '' };
    this.run(`INSERT INTO goals(id,type,title,why,status,archived,created_at,updated_at,log) VALUES(?,?,?,?,?,?,?,?,?)`, n.id, n.type, n.title, n.why, n.status, n.archived, n.created_at, n.updated_at, n.log);
    return n;
  }
  updateGoal(gid, patch) {
    const cur = this.one(`SELECT * FROM goals WHERE id=?`, gid); if (!cur) return null;
    const n = { ...cur, ...patch, updated_at: now() };
    this.run(`UPDATE goals SET type=?, title=?, why=?, status=?, archived=?, updated_at=?, log=? WHERE id=?`, n.type, n.title, n.why, n.status, n.archived ? 1 : 0, n.updated_at, n.log, gid);
    return n;
  }

  kvGet(k, d = null) { const r = this.one(`SELECT value FROM kv WHERE key=?`, k); return r ? JSON.parse(r.value) : d; }
  kvSet(k, v) { this.run(`INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, k, JSON.stringify(v)); }

  dump() { return { chats: this.all(`SELECT * FROM chats`), messages: this.all(`SELECT * FROM messages`).map((m) => ({ ...m, content: JSON.parse(m.content) })), memories: this.all(`SELECT * FROM memories`), goals: this.all(`SELECT * FROM goals`), kv: this.all(`SELECT * FROM kv`).map((r) => ({ key: r.key, value: JSON.parse(r.value) })) }; }
  loadDump(d) {
    for (const c of d.chats || []) this.run(`INSERT OR REPLACE INTO chats(id,title,kind,created_at,updated_at,summary,summarized_count,reflected) VALUES(?,?,?,?,?,?,?,?)`, c.id, c.title, c.kind || 'chat', c.created_at, c.updated_at, c.summary ?? null, c.summarized_count || 0, c.reflected || 0);
    for (const m of d.messages || []) this.run(`INSERT OR REPLACE INTO messages(id,chat_id,role,content,created_at) VALUES(?,?,?,?,?)`, m.id, m.chat_id, m.role, JSON.stringify(m.content), m.created_at);
    for (const m of d.memories || []) this.run(`INSERT OR REPLACE INTO memories(id,scope,chat_id,text,created_at) VALUES(?,?,?,?,?)`, m.id, m.scope, m.chat_id ?? null, m.text, m.created_at);
    for (const g of d.goals || []) this.run(`INSERT OR REPLACE INTO goals(id,type,title,why,status,archived,created_at,updated_at,log) VALUES(?,?,?,?,?,?,?,?,?)`, g.id, g.type, g.title, g.why, g.status, g.archived ? 1 : 0, g.created_at, g.updated_at, g.log || '');
    for (const r of d.kv || []) this.kvSet(r.key, r.value);
  }
  close() { try { this.db.close(); } catch {} }
}

class JsonStore {
  constructor(file) {
    this.file = file; this.kind = 'json';
    this.d = { chats: [], messages: [], memories: [], goals: [], kv: [] };
    try { if (fs.existsSync(file)) this.d = { ...this.d, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (e) { console.error('json store load failed', e); }
    this.timer = null;
  }
  flush() { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.d)); }
  save() { clearTimeout(this.timer); this.timer = setTimeout(() => this.flush(), 150); }

  listChats() { return [...this.d.chats].sort((a, b) => b.updated_at - a.updated_at).map(({ id, title, kind, created_at, updated_at }) => ({ id, title, kind, created_at, updated_at })); }
  getChat(cid) { return this.d.chats.find((c) => c.id === cid) || null; }
  createChat({ title = 'New chat', kind = 'chat' } = {}) { const c = { id: id(), title, kind, created_at: now(), updated_at: now(), summary: null, summarized_count: 0, reflected: 0 }; this.d.chats.push(c); this.save(); return c; }
  updateChat(cid, patch) { const c = this.getChat(cid); if (!c) return null; Object.assign(c, patch, { updated_at: patch.updated_at ?? now() }); this.save(); return c; }
  deleteChat(cid) { this.d.chats = this.d.chats.filter((c) => c.id !== cid); this.d.messages = this.d.messages.filter((m) => m.chat_id !== cid); this.d.memories = this.d.memories.filter((m) => m.chat_id !== cid); this.save(); }

  listMessages(cid) { return this.d.messages.filter((m) => m.chat_id === cid).sort((a, b) => a.created_at - b.created_at); }
  addMessage(cid, role, content) { const m = { id: id(), chat_id: cid, role, content, created_at: now() }; this.d.messages.push(m); const c = this.getChat(cid); if (c) c.updated_at = m.created_at; this.save(); return m; }
  updateMessage(mid, content) { const m = this.d.messages.find((x) => x.id === mid); if (m) { m.content = content; this.save(); } }
  countMessages(cid) { return this.d.messages.filter((m) => m.chat_id === cid).length; }

  listMemories(scope, cid) { return this.d.memories.filter((m) => m.scope === scope && (scope === 'long' || m.chat_id === cid)).sort((a, b) => b.created_at - a.created_at); }
  addMemory(scope, cid, text) { const m = { id: id(), scope, chat_id: scope === 'short' ? cid : null, text, created_at: now() }; this.d.memories.push(m); this.save(); return m; }
  deleteMemory(mid) { this.d.memories = this.d.memories.filter((m) => m.id !== mid); this.save(); }
  clearMemories(scope, cid) { this.d.memories = this.d.memories.filter((m) => !(m.scope === scope && (scope === 'long' || m.chat_id === cid))); this.save(); }

  listGoals(all = false) { return this.d.goals.filter((g) => all || !g.archived).sort((a, b) => b.created_at - a.created_at); }
  addGoal(g) { const n = { id: id(), type: g.type || 'improve', title: g.title, why: g.why || '', status: g.status || 'proposed', archived: 0, created_at: now(), updated_at: now(), log: g.log || '' }; this.d.goals.push(n); this.save(); return n; }
  updateGoal(gid, patch) { const g = this.d.goals.find((x) => x.id === gid); if (!g) return null; Object.assign(g, patch, { updated_at: now() }); this.save(); return g; }

  kvGet(k, d = null) { const r = this.d.kv.find((x) => x.key === k); return r ? r.value : d; }
  kvSet(k, v) { const r = this.d.kv.find((x) => x.key === k); if (r) r.value = v; else this.d.kv.push({ key: k, value: v }); this.save(); }

  dump() { return JSON.parse(JSON.stringify(this.d)); }
  loadDump(d) { for (const k of ['chats', 'messages', 'memories', 'goals', 'kv']) this.d[k] = [...(this.d[k] || []), ...(d[k] || []).filter((x) => !(this.d[k] || []).some((y) => (y.id ?? y.key) === (x.id ?? x.key)))]; this.flush(); }
  close() { clearTimeout(this.timer); this.flush(); }
}

function adopt(dir, oldName, newName) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const from = path.join(dir, oldName + suffix), to = path.join(dir, newName + suffix);
    if (fs.existsSync(from) && !fs.existsSync(to)) { try { fs.renameSync(from, to); } catch {} }
  }
}

function openStore(dir, kind) {
  fs.mkdirSync(dir, { recursive: true });
  adopt(dir, 'nova.sqlite', 'lyra.sqlite'); adopt(dir, 'nova.json', 'lyra.json');
  if (kind === 'sqlite') {
    try { return new SqliteStore(path.join(dir, 'lyra.sqlite')); }
    catch (e) { console.error('SQLite unavailable, falling back to JSON:', e.message); }
  }
  return new JsonStore(path.join(dir, 'lyra.json'));
}

module.exports = { openStore };
