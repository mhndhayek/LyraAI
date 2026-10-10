#!/usr/bin/env node
// Visual QA: boot the app straight into 3D (setup already done) and screenshot the
// stage so a human can check Lyra's pose. Writes to $QA_OUT or a temp dir.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run } = require('./electron-run');

const outDir = process.env.QA_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-3d-qa-'));
fs.mkdirSync(outDir, { recursive: true });
const shot = path.join(outDir, 'lyra-3d.png');

// Pre-seed the profile: setup finished, appearance already 3D, so the stage shows
// the VRM immediately and the Welcome overlay never blocks it.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-3d-qa-data-'));
const settingsFile = path.join(dataDir, 'settings.json');
fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
fs.writeFileSync(settingsFile, JSON.stringify({
  appearance: { theme: 'lyra-dark', liveCharacter: true, source: 'vrm', vrmModel: 'builtin:lyra', gifFolder: 'builtin:catgirl', placement: 'panel' },
  ui: { setupDone: true },
  kernel: { checkpoints: true },
  persona: { store: 'default' },
}, null, 2));

run([`--screenshot=${shot}`, '--3d', '--delay=6000'], { timeoutMs: 120000, userDataDir: dataDir, onLine: () => {} })
  .then(({ code }) => {
    if (code !== 0 || !fs.existsSync(shot)) { console.error('✗ no shot, code', code); process.exit(1); }
    console.log(`✓ 3D QA screenshot: ${shot}`);
  })
  .catch((e) => { console.error('✗', e.message); process.exit(1); });
