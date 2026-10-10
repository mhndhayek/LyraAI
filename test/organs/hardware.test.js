// Story 03: what Lyra reads about this computer for "Help me choose". The
// Electron and shell calls are stood in for, so the same answers come back on
// every machine, including CI runners with no GPU and no nvidia-smi.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const hw = require('../../main/organs/hardware');

const GB = 1024 ** 3;
const SP_M2 = JSON.stringify({ SPDisplaysDataType: [{ _name: 'Apple M2 Pro', sppci_model: 'Apple M2 Pro', sppci_cores: '19', sppci_vendor: 'sppci_vendor_Apple', sppci_device_type: 'spdisplays_gpu' }] });
const base = { cpus: () => [{ model: 'Apple M2 Pro' }, { model: 'Apple M2 Pro' }], totalmem: () => 16 * GB, statfs: async () => ({ bavail: 50 * GB / 4096, bsize: 4096 }), getGPUInfo: async () => ({ gpuDevice: [{ active: true, vendorId: 0x106b, deviceString: 'Apple M2 Pro' }] }) };

test('a Mac reports OS, arch, CPU, memory, free disk and the Apple GPU with its cores', async () => {
  const calls = [];
  const r = await hw.detect({ ...base, platform: 'darwin', arch: 'arm64', exec: async (cmd, args) => { calls.push(cmd); return cmd.endsWith('system_profiler') ? SP_M2 : null; } });
  assert.deepEqual({ os: r.os, arch: r.arch, memGB: r.memGB, freeDiskGB: r.freeDiskGB }, { os: 'darwin', arch: 'arm64', memGB: 16, freeDiskGB: 50 });
  assert.equal(r.cpu, 'Apple M2 Pro'); assert.equal(r.cores, 2);
  assert.equal(r.gpu.name, 'Apple M2 Pro'); assert.equal(r.gpu.cores, 19); assert.equal(r.gpu.unified, true);
  assert.ok(!calls.includes('nvidia-smi'), 'a Mac has no nvidia-smi to ask');
});

test('a PC with an NVIDIA card reports its name and VRAM', async () => {
  const r = await hw.detect({ ...base, platform: 'win32', arch: 'x64', exec: async (cmd) => (cmd === 'nvidia-smi' ? 'NVIDIA GeForce RTX 4070, 12282 MiB\n' : null) });
  assert.equal(r.gpu.name, 'NVIDIA GeForce RTX 4070'); assert.equal(r.gpu.vramGB, 12); assert.equal(r.gpu.nvidia, true);
});

test('a missing nvidia-smi, a failing GPU query and an unreadable disk do not throw', async () => {
  const r = await hw.detect({ platform: 'linux', arch: 'x64', cpus: () => [], totalmem: () => 8 * GB, statfs: async () => { throw new Error('EACCES'); }, getGPUInfo: async () => { throw new Error('no gpu'); }, exec: async () => null });
  assert.equal(r.memGB, 8); assert.equal(r.gpu, null); assert.equal(r.freeDiskGB, null); assert.equal(r.cpu, null);
});

test('the real nvidia-smi lookup resolves to nothing rather than throwing when the tool is absent', async () => {
  const r = await hw.detect({ ...base, platform: 'linux', arch: 'x64' });
  assert.equal(typeof r.memGB, 'number');
});

test('parsers ignore junk', () => {
  assert.equal(hw.parseSystemProfiler('not json'), null);
  assert.equal(hw.parseSystemProfiler('{}'), null);
  assert.equal(hw.parseNvidiaSmi(''), null);
});

test('a server already running on a known local port is found, and closed ports are skipped', async () => {
  const s = http.createServer((req, res) => { res.writeHead(401).end(); });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const open = s.address().port;
  const closed = await new Promise((r) => { const t = http.createServer(); t.listen(0, '127.0.0.1', () => { const p = t.address().port; t.close(() => r(p)); }); });
  const found = await hw.probeRunning([{ port: open, kind: 'llama.cpp' }, { port: closed, kind: 'ollama' }]);
  s.close();
  assert.deepEqual(found.map((f) => [f.kind, f.status]), [['llama.cpp', 401]]);
  assert.equal(found[0].endpoint, `http://localhost:${open}/v1`);
});
