#!/usr/bin/env node
// End-to-end smoke test: starts the real app the way a user would, waits for the
// window to render, captures a screenshot and fails on any error the renderer or
// the kernel reported on the way up. This is the check that catches a UI that
// boots into a blank page or a white screen of death.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run } = require('./electron-run');

const outDir = process.env.SMOKE_OUT || path.join(os.tmpdir(), 'lyra-smoke');
fs.mkdirSync(outDir, { recursive: true });
const shot = path.join(outDir, 'app.png');

// Lines that mean something is wrong, rather than a local service simply not
// running on a CI machine (no model server, no microphone, no Tailscale).
const EXPECTED = [
  /ECONNREFUSED/i, /fetch failed/i, /voice/i, /sidecar/i, /tailscale/i, /tailnet/i,
  /model/i, /lmstudio/i, /ollama/i, /notification/i, /MESA|GL|GPU|dbus|gbm|libva|vaapi/i,
  /Autofill/i, /DevTools/i, /sandbox/i, /XDG_RUNTIME_DIR/i,
  // three-vrm's VRMA loader logs this once per clip when the VRMA omits its spec
  // version; it then assumes 1.0 (which is correct for our clips), so it is noise.
  /VRMAnimationLoaderPlugin: specVersion/i,
];
const problems = [];
const onLine = (line) => {
  const isRendererError = /^\[renderer ERROR\]/.test(line);
  const isKernelError = /\[(ui|kernel|organs|main)\]\s+.*(Uncaught|Unhandled|cannot|failed to load|is not a function|is not defined)/i.test(line);
  if (!isRendererError && !isKernelError) return;
  if (EXPECTED.some((re) => re.test(line))) return;
  problems.push(line.trim());
};

// The in-app llama.cpp engine (story 03), seeded with a stand-in llama-server
// so no download or GPU is needed: while the app runs it must listen on
// 127.0.0.1 only, and once the app quits no server may be left behind.
function seedEngine(dataDir) {
  const { LocalEngine } = require('../main/organs/localEngine');
  const matrix = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'recommendations.json'), 'utf8'));
  const row = matrix.models[0]; const eng = new LocalEngine({ userData: dataDir, settings: { get: () => ({}) }, matrix });
  fs.mkdirSync(eng.tagDir(), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'test', 'helpers', 'fake-llama-server.js'), eng.binary()); fs.chmodSync(eng.binary(), 0o755);
  fs.mkdirSync(eng.modelsDir, { recursive: true }); fs.writeFileSync(eng.modelFile(row), 'GGUF');
  if (row.mmproj) fs.writeFileSync(eng.mmprojFile(row), 'GGUF');
  eng.writeState({ tag: matrix.engine.tag, model: row.id, autoStart: true });
  return eng;
}
const engineCheck = { seeded: null, listening: null, pid: null };
const engineData = process.platform === 'win32' ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-ci-'));
if (engineData) {
  engineCheck.seeded = seedEngine(engineData);
  // Look while the app is up: the screenshot is taken 8 s in.
  setTimeout(function look(n = 0) {
    let pid = null; try { pid = Number(fs.readFileSync(engineCheck.seeded.pidFile(), 'utf8')); } catch {}
    if (!pid) { if (n < 40) setTimeout(() => look(n + 1), 250); return; }
    engineCheck.pid = pid;
    // The pid file is written at spawn, before the server has bound its port; on a
    // slow runner lsof can look in between. Ask again until it is listening (~20 s).
    let l = '';
    try { l = require('child_process').execFileSync('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' }); } catch (e) { if (e.code === 'ENOENT') l = 'no lsof'; }
    engineCheck.listening = l;
    if (!l && n < 80) setTimeout(() => look(n + 1), 250);
  }, 3000);
}

run([`--screenshot=${shot}`, '--delay=8000'], { timeoutMs: 180000, onLine, userDataDir: engineData || undefined })
  .then(({ code, dataDir }) => {
    const fail = (msg) => { console.error(`✗ ${msg}`); process.exitCode = 1; };

    if (code !== 0) fail(`the app exited with code ${code}`);

    if (!fs.existsSync(shot) || fs.statSync(shot).size < 5000) {
      fail('no screenshot was captured: the window never rendered');
    } else {
      console.log(`✓ the window rendered (${Math.round(fs.statSync(shot).size / 1024)} KB screenshot at ${shot})`);
    }

    // A healthy first boot lays out the state folder, copies the organs in and
    // starts the checkpoint repository that every later change is undone with.
    for (const rel of [path.join('state', 'organs', 'main', 'index.js'), path.join('state', 'organs', 'renderer', 'index.html'),
      path.join('state', '.git'), path.join('state', 'extensions'), path.join('state', 'themes'), 'logs']) {
      if (fs.existsSync(path.join(dataDir, rel))) console.log(`✓ ${rel} created on first boot`);
      else fail(`${rel} was not created: the app did not finish setting itself up`);
    }

    const health = path.join(dataDir, 'health.log');
    if (fs.existsSync(health) && /safe mode/i.test(fs.readFileSync(health, 'utf8'))) {
      fail('the app fell back to safe mode on a clean install');
    }

    if (engineCheck.seeded) {
      const l = engineCheck.listening;
      if (!engineCheck.pid) fail('the local engine did not start with the app');
      else if (l === 'no lsof') console.log('– lsof is not installed: skipped the listening-address check');
      else if (!l) fail(`the local engine (pid ${engineCheck.pid}) never opened a listening port`);
      else if (!/127\.0\.0\.1:\d+ \(LISTEN\)/.test(l) || /(\*|0\.0\.0\.0|\[::\]):\d+ \(LISTEN\)/.test(l)) fail(`the local engine is not listening on 127.0.0.1 only:\n${l}`);
      else console.log('✓ the local engine started with the app and listens on 127.0.0.1 only');
      let left = '';
      try { left = require('child_process').execFileSync('pgrep', ['-f', engineCheck.seeded.root], { encoding: 'utf8' }).trim(); } catch {}
      if (left) fail(`a llama-server outlived the app (pid ${left})`); else if (engineCheck.pid) console.log('✓ no llama-server left running after the app quit (pgrep is empty)');
    }

    if (problems.length) {
      fail(`${problems.length} error(s) were reported while starting:`);
      for (const p of problems.slice(0, 20)) console.error(`    ${p}`);
    } else {
      console.log('✓ no errors reported by the kernel or the UI');
    }

    if (!process.exitCode) console.log('\n✓ smoke test passed');
    else console.error('\n✗ smoke test failed');
  })
  .catch((e) => { console.error('✗', e.message); process.exit(1); });
