const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpdir, cleanup } = require('../helpers/tmp');
const { Logs, LEVELS } = require('../../main/kernel/logs');

test.after(cleanup);
const logs = (opts = {}) => new Logs(tmpdir(), { mirror: false, ...opts });

test('entries carry a level, a source and a monotonic id', () => {
  const l = logs();
  const a = l.info('kernel', 'started');
  const b = l.error('voice', 'sidecar died');
  assert.equal(a.level, 'info');
  assert.equal(b.level, 'error');
  assert.equal(b.source, 'voice');
  assert.equal(b.id, a.id + 1);
  assert.ok(b.at >= a.at);
});

test('an unknown level falls back to info rather than being dropped', () => {
  const l = logs();
  assert.equal(l.write('shout', 'x', 'msg').level, 'info');
});

test('api keys and bearer tokens never reach the log', () => {
  const l = logs();
  const e = l.error('llm', 'call failed with sk-abcdef1234567890 in the url', 'Authorization: Bearer abcd.efgh-1234567');
  assert.ok(!e.message.includes('sk-abcdef1234567890'), e.message);
  assert.ok(e.message.includes('sk-[redacted]'));
  assert.ok(!e.detail.includes('abcd.efgh-1234567'), e.detail);
  assert.ok(e.detail.includes('[redacted]'));
});

test('api keys in structured detail are redacted too', () => {
  const l = logs();
  const e = l.warn('cfg', 'provider saved', { apiKey: 'supersecretvalue', endpoint: 'http://localhost:1234' });
  assert.ok(!e.detail.includes('supersecretvalue'), e.detail);
  assert.ok(e.detail.includes('localhost:1234'), 'non-secret fields are kept');
});

test('errors are stored with their stack and long values are clipped', () => {
  const l = logs();
  const e = l.error('main', 'boom', new Error('detailed failure'));
  assert.ok(e.detail.includes('detailed failure'));
  const big = l.info('x', 'a'.repeat(5000), 'b'.repeat(9000));
  assert.ok(big.message.length < 2100, 'messages are clipped');
  assert.ok(big.detail.length < 4100, 'details are clipped');
  assert.ok(big.message.includes('[+'), 'clipping is visible');
});

test('entries are appended to a dated file as JSON lines', () => {
  const l = logs();
  l.info('kernel', 'one');
  l.info('kernel', 'two');
  const lines = fs.readFileSync(l.file(), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]).message, 'two');
  assert.match(path.basename(l.file()), /^lyra-\d{4}-\d{2}-\d{2}\.jsonl$/);
});

test('errors and warnings are pushed to the UI, quiet levels are not', () => {
  const seen = [];
  const l = logs({ emit: (chatId, type, payload) => seen.push(payload.entry.level) });
  l.info('x', 'quiet');
  l.warn('x', 'loud');
  l.error('x', 'louder');
  assert.deepEqual(seen, ['warn', 'error']);
});

test('listing filters by level, source, text and age', () => {
  const l = logs();
  l.info('voice', 'engine warmed');
  l.warn('llm', 'model missing');
  l.error('llm', 'connection refused');
  assert.equal(l.list({ level: 'warn' }).length, 2);
  assert.equal(l.list({ level: 'error' }).length, 1);
  assert.equal(l.list({ source: 'llm' }).length, 2);
  assert.equal(l.list({ search: 'refused' }).length, 1);
  assert.equal(l.list({ search: 'REFUSED' }).length, 1, 'search is case-insensitive');
  assert.equal(l.list({ sinceMinutes: 60 }).length, 3);
});

test('entries older than the window are filtered out of the day files', () => {
  const l = logs();
  l.info('x', 'recent');
  fs.appendFileSync(l.file(), JSON.stringify({ id: 99, at: Date.now() - 7200000, level: 'info', source: 'x', message: 'ancient' }) + '\n');
  const out = l.list({ sinceMinutes: 60, limit: 500 });
  assert.deepEqual(out.map((e) => e.message), ['recent']);
  assert.equal(l.list({ limit: 500 }).length, 2, 'without a window both are returned');
});

test('the limit is clamped and returns the newest entries', () => {
  const l = logs();
  for (let i = 0; i < 20; i++) l.info('x', `msg ${i}`);
  const out = l.list({ limit: 5 });
  assert.equal(out.length, 5);
  assert.equal(out[4].message, 'msg 19');
  assert.ok(l.list({ limit: 100000 }).length <= 1000);
});

test('counts summarise the recent levels', () => {
  const l = logs();
  l.info('x', 'a'); l.warn('x', 'b'); l.error('x', 'c'); l.error('x', 'd');
  assert.deepEqual(l.counts(), { info: 1, warn: 1, error: 2 });
});

test('text rendering is readable and includes the detail', () => {
  const l = logs();
  l.error('voice', 'sidecar died', 'exit code 1');
  const text = l.text({ level: 'error' });
  assert.match(text, /ERROR voice: sidecar died/);
  assert.match(text, /exit code 1/);
});

test('clear empties the ring and removes the day files', () => {
  const l = logs();
  l.info('x', 'gone');
  assert.ok(fs.existsSync(l.file()));
  l.clear();
  assert.equal(l.list({ limit: 10 }).length, 0);
  assert.equal(fs.existsSync(l.file()), false);
});

test('the sweep deletes log files older than the retention window', () => {
  const dir = tmpdir();
  const stale = path.join(dir, 'lyra-2000-01-01.jsonl');
  const legacy = path.join(dir, 'nova-2000-01-02.jsonl');
  const keep = path.join(dir, 'notes.txt');
  for (const f of [stale, legacy, keep]) fs.writeFileSync(f, '{}\n');
  const old = Date.now() - 30 * 86400000;
  for (const f of [stale, legacy]) fs.utimesSync(f, old / 1000, old / 1000);
  new Logs(dir, { mirror: false });
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(legacy), false, 'pre-rename logs are swept too');
  assert.ok(fs.existsSync(keep), 'unrelated files are left alone');
});

test('levels are ordered so filtering by one includes everything above it', () => {
  assert.ok(LEVELS.error > LEVELS.warn && LEVELS.warn > LEVELS.info && LEVELS.info > LEVELS.debug);
});
