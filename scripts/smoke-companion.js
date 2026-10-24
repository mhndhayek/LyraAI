#!/usr/bin/env node
// Story 07 smoke: boot the real app on a throwaway data folder with
// --companion-test. The kernel hides the main window, checks that Lyra appears on
// the desktop (transparent, always on top, her canvas drawn), sends a message from
// the mini chat and finds it in the main window's chat, switches to the light
// theme and compares the colours, then shows the main window and checks that she
// is gone. Fails on any check or any renderer error.
const fs = require('fs');
const path = require('path');
const { run } = require('./electron-run');

const EXPECTED = [
  /ECONNREFUSED/i, /fetch failed/i, /voice/i, /sidecar/i, /tailscale/i, /tailnet/i,
  /model/i, /lmstudio/i, /ollama/i, /notification/i, /MESA|GL|GPU|dbus|gbm|libva|vaapi/i,
  /Autofill/i, /DevTools/i, /sandbox/i, /XDG_RUNTIME_DIR/i, /WebGL/i, /texture/i,
  /VRMAnimationLoaderPlugin: specVersion/i, /Nothing to send/i, /StatusNotifier|tray/i,
];

function seed(dir) {
  // Past the setup guide, so the main window opens on a chat.
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'state', 'settings.json'), JSON.stringify({ ui: { setupDone: true } }));
}

const problems = []; let result = null;
const onLine = (line) => {
  const m = line.match(/\[companion-check\] (\{.*\})\s*$/); if (m) { try { result = JSON.parse(m[1]); } catch {} return; }
  const isRendererError = /^\[(renderer|companion) ERROR\]/.test(line);
  const isKernelError = /\[(ui|kernel|organs|main)\]\s+.*(Uncaught|Unhandled|cannot|failed to load|is not a function|is not defined)/i.test(line);
  if (!isRendererError && !isKernelError) return;
  if (EXPECTED.some((re) => re.test(line))) return;
  problems.push(line.trim());
};

const dataDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'lyra-companion-'));
seed(dataDir);
run(['--companion-test'], { timeoutMs: 180000, onLine, userDataDir: dataDir })
  .then(({ code }) => {
    const fail = (msg) => { console.error(`✗ ${msg}`); process.exitCode = 1; };
    if (!result) fail('the companion check never reported (did --companion-test run?)');
    else {
      for (const c of result.checks) { if (c.pass) console.log(`✓ ${c.name}`); else fail(`${c.name}${c.detail !== undefined ? ` — ${JSON.stringify(c.detail)}` : ''}`); }
      for (const s of result.skipped || []) console.log(`– skipped ${s}`);
      // Skipping is only acceptable where there is no GPU path at all.
      if ((result.skipped || []).length && process.platform !== 'linux') fail('the canvas checks were skipped on a machine that should have WebGL');
    }
    if (code !== 0 && result && result.pass) fail(`the app exited with code ${code}`);
    if (problems.length) { fail(`${problems.length} error(s) were reported:`); for (const p of problems.slice(0, 20)) console.error(`    ${p}`); }
    else console.log('✓ no errors reported by the kernel, the main window or the companion');
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
    if (!process.exitCode) console.log('\n✓ desktop companion smoke passed'); else console.error('\n✗ desktop companion smoke failed');
  })
  .catch((e) => { console.error('✗', e.message); process.exit(1); });
