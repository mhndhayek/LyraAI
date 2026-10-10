// Story 03: "Help me choose". The computer and two answers go in; one tested
// row from docs/recommendations.json comes out, or the fallback card when
// nothing local fits. The matrix used here is the shipped one, so a row that is
// dropped or mis-banded fails these tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { ROOT } = require('../helpers/tmp');
const { recommend, loadMatrix } = require('../../main/organs/hardware');

const matrix = loadMatrix(path.join(ROOT, 'docs', 'recommendations.json'));
const mac = (memGB, extra = {}) => ({ os: 'darwin', arch: 'arm64', memGB, freeDiskGB: 200, gpu: { name: 'Apple M2', unified: true }, ...extra });
const chat = { goal: 'chat', speed: 'balanced' };

test('the shipped matrix pins an engine build with a SHA-256 for the Mac', () => {
  const a = matrix.engine.assets['darwin-arm64'];
  assert.match(matrix.engine.tag, /^b\d+$/);
  assert.match(a.file, new RegExp(`^llama-${matrix.engine.tag}-bin-macos-arm64\\.tar\\.gz$`));
  assert.match(a.sha256, /^[0-9a-f]{64}$/, 'an unpinned engine would run whatever the download served');
});

test('every shipped model row is pinned and was fitness-tested', () => {
  assert.ok(matrix.models.length >= 3);
  for (const m of matrix.models) {
    assert.match(m.sha256, /^[0-9a-f]{64}$/, `${m.id} has no pinned SHA-256`);
    assert.match(m.hf, /^[\w.-]+\/[\w.-]+$/, `${m.id} names no Hugging Face repo`);
    assert.match(m.file, /\.gguf$/);
    assert.match(m.fitness, /^5\/5$|^4\/4$/, `${m.id} did not pass the fitness test`);
    assert.ok(m.tokPerSec > 0, `${m.id} has no measured speed`);
    if (m.mmproj) assert.match(m.mmproj.sha256, /^[0-9a-f]{64}$/);
  }
});

test('an 8 GB Apple silicon Mac gets a small model that fits', () => {
  const r = recommend(mac(8), chat, matrix);
  assert.equal(r.fallback, false);
  assert.equal(r.pick.when.minMemGB, 8);
  assert.ok(r.pick.sizeGB < 4, `${r.pick.sizeGB} GB is too much for 8 GB of shared memory`);
});

test('a 16 GB Mac gets a bigger model than an 8 GB one', () => {
  const small = recommend(mac(8), chat, matrix).pick; const mid = recommend(mac(16), chat, matrix).pick;
  assert.ok(mid.sizeGB > small.sizeGB, `${mid.id} should be larger than ${small.id}`);
  assert.ok(mid.sizeGB < 10.7, 'stays inside the GPU share of 16 GB');
});

test('a 36 GB Mac gets the 32+ GB row', () => {
  const r = recommend(mac(36), { goal: 'both', speed: 'smartest' }, matrix);
  assert.equal(r.fallback, false);
  assert.ok(r.pick.when.minMemGB >= 32, `${r.pick.id} is not a 32+ GB row`);
});

test('the speed answer changes the pick, and the other choices are offered as alternatives', () => {
  const snappy = recommend(mac(16), { goal: 'chat', speed: 'snappy' }, matrix);
  const smart = recommend(mac(16), { goal: 'chat', speed: 'smartest' }, matrix);
  assert.ok(snappy.pick.sizeGB < smart.pick.sizeGB);
  assert.ok(snappy.alternatives.length >= 1);
  assert.ok(!snappy.alternatives.some((a) => a.id === snappy.pick.id));
  assert.ok(snappy.why.length > 10, 'the card carries one line of why');
});

test('an Intel Mac with 8 GB gets the fallback card', () => {
  const r = recommend({ os: 'darwin', arch: 'x64', memGB: 8, freeDiskGB: 200, gpu: { name: 'Intel Iris' } }, chat, matrix);
  assert.equal(r.fallback, true);
  assert.equal(r.pick, null);
  assert.match(r.why, /server or API/);
});

test('Windows and Linux get the fallback card with "coming soon" for the in-app engine', () => {
  for (const os of ['win32', 'linux']) {
    const r = recommend({ os, arch: 'x64', memGB: 64, freeDiskGB: 500, gpu: { name: 'NVIDIA GeForce RTX 4090', vramGB: 24 } }, chat, matrix);
    assert.equal(r.fallback, true, os);
    assert.equal(r.comingSoon, true, os);
  }
});

test('too little free disk falls back instead of recommending a download that cannot land', () => {
  const r = recommend(mac(16, { freeDiskGB: 2 }), chat, matrix);
  assert.equal(r.fallback, true);
  assert.match(r.why, /disk/i);
});

test('less than 8 GB falls back', () => {
  assert.equal(recommend(mac(4), chat, matrix).fallback, true);
});
