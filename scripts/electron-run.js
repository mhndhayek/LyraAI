// Shared launcher for the headless checks. Runs the real app under the real
// Electron binary, on a throwaway data folder, with a virtual display where the
// machine has no screen (Linux CI). Returns the exit code and everything printed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function electronBinary() {
  try {
    const bin = require(path.join(ROOT, 'node_modules', 'electron'));
    return typeof bin === 'string' && fs.existsSync(bin) ? bin : null;
  } catch (e) {
    // The electron package downloads its binary on first use, so this is a
    // failed download as often as it is a missing install. Say which.
    console.error(`could not resolve the Electron binary: ${e.message}`);
    return null;
  }
}

// Linux CI has no display; xvfb-run gives Electron one. macOS and Windows
// runners can open a real window, so they run the binary directly.
function wrap(cmd, args) {
  if (process.platform !== 'linux' || process.env.DISPLAY) return { cmd, args };
  try { execFileSync('which', ['xvfb-run'], { stdio: 'ignore' }); }
  catch { return { cmd, args }; }
  return { cmd: 'xvfb-run', args: ['-a', '--server-args=-screen 0 1280x900x24', cmd, ...args] };
}

// A CI machine has no real GPU. Chromium still tries to use the hardware
// compositor under a virtual display, and when it cannot get a frame out of it
// capturePage() fails with UnknownVizError and the screenshot never lands.
// Software rendering makes the headless checks produce the same frame every time.
function headlessGpuArgs() {
  if (process.platform !== 'linux' || process.env.DISPLAY) return [];
  return ['--disable-gpu', '--disable-gpu-compositing', '--disable-dev-shm-usage', '--use-gl=swiftshader'];
}

function run(extraArgs, { timeoutMs = 180000, userDataDir, onLine } = {}) {
  const bin = electronBinary();
  if (!bin) return Promise.reject(new Error('the Electron binary is not available; run npm ci, then node scripts/ensure-electron.js'));
  const dataDir = userDataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-ci-'));
  const args = [ROOT, `--user-data-dir=${dataDir}`, '--no-sandbox', ...headlessGpuArgs(), ...extraArgs];
  const { cmd, args: finalArgs } = wrap(bin, args);

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, finalArgs, {
      cwd: ROOT,
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ELECTRON_ENABLE_LOGGING: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '', settled = false;
    const collect = (chunk, isErr) => {
      const s = String(chunk);
      if (isErr) err += s; else out += s;
      process.stdout.write(s);
      if (onLine) for (const line of s.split('\n')) if (line) onLine(line);
    };
    child.stdout.on('data', (c) => collect(c, false));
    child.stderr.on('data', (c) => collect(c, true));

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`the app did not finish within ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.on('error', (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code === null ? 1 : code, signal, stdout: out, stderr: err, dataDir });
    });
  });
}

module.exports = { run, ROOT, headlessGpuArgs };
