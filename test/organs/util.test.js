const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const u = require('../../main/organs/util');
const kernelUtil = require('../../main/kernel/util');

test('ids are unique and stable in shape', () => {
  const ids = new Set(Array.from({ length: 500 }, () => u.id()));
  assert.equal(ids.size, 500, 'collisions would merge chats or messages');
  for (const id of ids) assert.match(id, /^[0-9a-f]{16}$/);
  assert.match(kernelUtil.id(), /^[0-9a-f]{16}$/);
});

test('now is a millisecond timestamp', () => {
  const t = u.now();
  assert.ok(Number.isInteger(t) && Math.abs(Date.now() - t) < 1000);
});

test('a leading tilde expands to the home folder', () => {
  assert.equal(u.expandHome('~/notes'), path.join(os.homedir(), 'notes'));
  assert.equal(u.expandHome('~'), os.homedir());
  assert.equal(u.expandHome('/absolute/path'), '/absolute/path');
  assert.equal(u.expandHome('relative'), 'relative');
  assert.equal(u.expandHome(''), '');
  assert.equal(u.expandHome(undefined), undefined);
  assert.equal(u.expandHome('/tmp/~/odd'), '/tmp/~/odd', 'a tilde in the middle is a real folder name');
});

test('token estimates are cheap and never negative', () => {
  assert.equal(u.estimateTokens('abcd'), 1);
  assert.equal(u.estimateTokens('abcde'), 2);
  assert.equal(u.estimateTokens(''), 0);
  assert.equal(u.estimateTokens(null), 0);
});

test('clamped text says how much was cut', () => {
  assert.equal(u.clampText('short', 100), 'short');
  const out = u.clampText('x'.repeat(50), 10);
  assert.ok(out.startsWith('x'.repeat(10)));
  assert.match(out, /truncated 40 chars/);
  assert.equal(u.clampText(null, 10), '');
});

test('sleep resolves after the delay', async () => {
  const start = Date.now();
  await u.sleep(20);
  assert.ok(Date.now() - start >= 15);
});

test('hostOf shows the site, and falls back to the raw string', () => {
  assert.equal(u.hostOf('https://example.com/a/b?c=d'), 'example.com');
  assert.equal(u.hostOf('http://localhost:1234/v1'), 'localhost:1234');
  assert.equal(u.hostOf('not a url'), 'not a url');
});
