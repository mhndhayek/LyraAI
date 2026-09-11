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
];
const problems = [];
const onLine = (line) => {
  const isRendererError = /^\[renderer ERROR\]/.test(line);
  const isKernelError = /\[(ui|kernel|organs|main)\]\s+.*(Uncaught|Unhandled|cannot|failed to load|is not a function|is not defined)/i.test(line);
  if (!isRendererError && !isKernelError) return;
  if (EXPECTED.some((re) => re.test(line))) return;
  problems.push(line.trim());
};

run([`--screenshot=${shot}`, '--delay=8000'], { timeoutMs: 180000, onLine })
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
