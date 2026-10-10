// What this computer can run, and which tested model to recommend for it.
// Nothing here leaves the machine: it reads the OS, memory, disk and GPU, and
// probes only 127.0.0.1 for a local AI server that is already running.
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');

const GB = 1024 ** 3;
const round1 = (n) => Math.round(n * 10) / 10;
const run = (cmd, args, timeout = 5000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout)));
});

// Apple silicon: system_profiler names the chip and its GPU cores. The GPU
// shares the main memory, so memGB is also what the model can use.
function parseSystemProfiler(json) {
  try {
    const d = (JSON.parse(json).SPDisplaysDataType || [])[0]; if (!d) return null;
    const cores = Number(d.sppci_cores) || null;
    return { name: d.sppci_model || d._name || null, cores, unified: (d.sppci_vendor || d.spdisplays_vendor || '').includes('Apple') || /^Apple /.test(d.sppci_model || '') };
  } catch { return null; }
}
// "NVIDIA GeForce RTX 4090, 24564 MiB" → the first card.
function parseNvidiaSmi(csv) {
  const line = String(csv || '').split('\n').map((l) => l.trim()).find(Boolean); if (!line) return null;
  const [name, mem] = line.split(',').map((x) => x.trim()); const mib = parseFloat(mem);
  return { name, vramGB: Number.isFinite(mib) ? round1(mib / 1024) : null };
}

// deps lets the tests stand in for Electron, the shell and the disk.
async function detect(deps = {}) {
  const platform = deps.platform || process.platform; const arch = deps.arch || process.arch;
  const exec = deps.exec || run;
  const cpus = (deps.cpus || os.cpus)(); const totalmem = (deps.totalmem || os.totalmem)();
  let freeDiskGB = null;
  try { const st = await (deps.statfs || fs.promises.statfs)(deps.dir || os.homedir()); freeDiskGB = round1((Number(st.bavail) * Number(st.bsize)) / GB); } catch {}
  let gpu = null;
  try {
    const info = deps.getGPUInfo ? await deps.getGPUInfo('complete') : null;
    const dev = info && info.gpuDevice && (info.gpuDevice.find((g) => g.active) || info.gpuDevice[0]);
    if (dev) gpu = { name: dev.deviceString || dev.driverVendor || null, vendorId: dev.vendorId || null };
  } catch {}
  if (platform === 'darwin') {
    const sp = parseSystemProfiler(await exec('/usr/sbin/system_profiler', ['SPDisplaysDataType', '-json'], 10000));
    if (sp) gpu = { ...(gpu || {}), ...sp };
  } else {
    // Missing nvidia-smi just means no NVIDIA card (or no driver): never an error.
    const nv = parseNvidiaSmi(await exec('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader']));
    if (nv) gpu = { ...(gpu || {}), ...nv, nvidia: true };
  }
  return { os: platform, arch, cpu: (cpus[0] && cpus[0].model || '').trim() || null, cores: cpus.length, memGB: Math.round(totalmem / GB), gpu, freeDiskGB };
}

// The ports local runtimes use. Anything answering (even 401) is a server.
const KNOWN_PORTS = [{ port: 8080, kind: 'llama.cpp' }, { port: 1234, kind: 'lmstudio' }, { port: 11434, kind: 'ollama' }];
async function probeRunning(ports = KNOWN_PORTS, timeoutMs = 1200) {
  const hits = await Promise.all(ports.map(async (p) => {
    try { const r = await fetch(`http://127.0.0.1:${p.port}/v1/models`, { signal: AbortSignal.timeout(timeoutMs) }); return { ...p, endpoint: `http://localhost:${p.port}/v1`, status: r.status }; } catch { return null; }
  }));
  return hits.filter(Boolean);
}

function loadMatrix(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

const SPEEDS = ['snappy', 'balanced', 'smartest'];
const SPEED_WORDS = { snappy: 'the quickest replies', balanced: 'a good balance of speed and smarts', smartest: 'the smartest model that fits' };
// Room for the engine, the partial download and the OS: never fill the disk.
const DISK_MARGIN_GB = 3;

function rowsFor(hw, matrix) {
  return (matrix.models || []).filter((m) => {
    const w = m.when || {};
    return (!w.os || w.os === hw.os) && (!w.arch || w.arch === hw.arch) && hw.memGB >= (w.minMemGB || 0) && hw.memGB <= (w.maxMemGB || Infinity);
  });
}

// One pick (or the fallback card), one line of why, and the other rows that
// also fit this computer as alternatives.
function recommend(hw, answers, matrix) {
  const goal = (answers && answers.goal) || 'chat'; const speed = SPEEDS.includes(answers && answers.speed) ? answers.speed : 'balanced';
  const platformKey = `${hw.os}-${hw.arch}`; const engineReady = !!(matrix.engine && matrix.engine.assets && matrix.engine.assets[platformKey]);
  const fallback = (why, extra = {}) => ({ fallback: true, pick: null, alternatives: [], why, comingSoon: false, ...extra });
  if (hw.os !== 'darwin') return fallback('Setting up a local model for you inside Lyra is coming soon on this system. For now, connect to a server or API you already run.', { comingSoon: true });
  if (!engineReady) return fallback('This Mac is a bit small for a local model (Intel Macs have no GPU llama.cpp can use well). Connect to a server or API instead.');
  const fits = rowsFor(hw, matrix).filter((m) => !m.goal || m.goal.includes(goal));
  if (!fits.length) return fallback(`This computer is a bit small for a local model (${hw.memGB} GB of memory). Connect to a server or API instead.`);
  const roomy = fits.filter((m) => hw.freeDiskGB == null || hw.freeDiskGB >= m.sizeGB + DISK_MARGIN_GB);
  if (!roomy.length) return fallback(`There is not enough free disk space for a local model (${hw.freeDiskGB} GB free, ${round1(Math.min(...fits.map((m) => m.sizeGB)) + DISK_MARGIN_GB)} GB needed). Free some up, or connect to a server or API instead.`);
  const bySpeed = (s) => roomy.find((m) => (m.speed || []).includes(s));
  const pick = bySpeed(speed) || roomy[0];
  const chip = hw.gpu && hw.gpu.name ? hw.gpu.name : 'this computer';
  const why = `${pick.label} gives ${SPEED_WORDS[speed]} on ${chip} with ${hw.memGB} GB: about ${pick.tokPerSec} tokens a second on the Mac we tested it on${pick.vision ? ', and it can see pictures' : ''}.`;
  return { fallback: false, pick, why, alternatives: roomy.filter((m) => m.id !== pick.id), comingSoon: false };
}

module.exports = { detect, probeRunning, recommend, loadMatrix, parseSystemProfiler, parseNvidiaSmi, KNOWN_PORTS, DISK_MARGIN_GB };
