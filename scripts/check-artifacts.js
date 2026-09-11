#!/usr/bin/env node
// Confirms that a build actually produced the installers for this platform, and
// that they are real files rather than empty stubs. Run after electron-builder.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const dist = path.join(ROOT, 'dist');
const MIN_BYTES = 10 * 1024 * 1024; // an Electron app is never smaller than this

const EXPECTED = {
  darwin: [['.dmg', 'a macOS installer'], ['.zip', 'a zipped app for updates']],
  win32: [['.exe', 'a Windows installer']],
  linux: [['.AppImage', 'a portable Linux build'], ['.deb', 'a Debian package'], ['.tar.gz', 'a Linux tarball']],
};

const wanted = EXPECTED[process.platform];
if (!wanted) {
  console.log(`No installer expectations for ${process.platform}; nothing to check.`);
  process.exit(0);
}
if (!fs.existsSync(dist)) {
  console.error('✗ dist/ does not exist: the build produced nothing');
  process.exit(1);
}

const files = fs.readdirSync(dist).filter((f) => fs.statSync(path.join(dist, f)).isFile());
let failed = false;

for (const [ext, what] of wanted) {
  const matches = files.filter((f) => f.endsWith(ext));
  if (!matches.length) {
    console.error(`✗ no ${ext} was produced (${what})`);
    failed = true;
    continue;
  }
  for (const m of matches) {
    const size = fs.statSync(path.join(dist, m)).size;
    if (size < MIN_BYTES) {
      console.error(`✗ ${m} is only ${Math.round(size / 1024)} KB; the build is incomplete`);
      failed = true;
    } else {
      console.log(`✓ ${m} (${(size / 1024 / 1024).toFixed(1)} MB) — ${what}`);
    }
  }
}

if (failed) process.exit(1);
console.log(`\n✓ all installers for ${process.platform} were produced`);

// The installers exist: now prove the app inside them actually starts. A build
// that packages cleanly but cannot boot is worse than a build that fails.
if (process.argv.includes('--launch')) {
  const { spawnSync } = require('child_process');
  const os = require('os');
  // macOS builds one folder per architecture and which one is named plain "mac"
  // depends on the builder host, so prefer whichever matches this machine.
  const macApps = fs.readdirSync(dist)
    .filter((d) => /^mac(-|$)/.test(d) && fs.statSync(path.join(dist, d)).isDirectory())
    .sort((a, b) => Number(b.includes(process.arch)) - Number(a.includes(process.arch)))
    .map((d) => path.join(dist, d, 'Lyra AI Agent.app', 'Contents', 'MacOS', 'Lyra AI Agent'));

  const candidates = {
    linux: [path.join(dist, 'linux-unpacked', 'lyra-ai-agent')],
    darwin: macApps,
    win32: [path.join(dist, 'win-unpacked', 'Lyra AI Agent.exe')],
  }[process.platform] || [];

  const bin = candidates.find((c) => fs.existsSync(c));
  if (!bin) {
    console.error(`✗ no unpacked app found to launch (looked in ${candidates.join(', ')})`);
    process.exit(1);
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-packaged-'));
  const shot = path.join(dataDir, 'packaged.png');
  const args = [`--user-data-dir=${dataDir}`, '--no-sandbox', `--screenshot=${shot}`, '--delay=6000'];
  const useXvfb = process.platform === 'linux' && !process.env.DISPLAY;
  const r = spawnSync(useXvfb ? 'xvfb-run' : bin, useXvfb ? ['-a', bin, ...args] : args, { encoding: 'utf8', timeout: 180000 });

  if (r.error) {
    console.error(`✗ the packaged app could not be started: ${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`✗ the packaged app exited with ${r.status}`);
    console.error((r.stderr || '').split('\n').slice(-15).join('\n'));
    process.exit(1);
  }
  if (!fs.existsSync(shot) || fs.statSync(shot).size < 5000) {
    console.error('✗ the packaged app started but never rendered a window');
    process.exit(1);
  }
  if (!fs.existsSync(path.join(dataDir, 'state', 'organs', 'main', 'index.js'))) {
    console.error('✗ the packaged app did not lay out its state folder: files are missing from the bundle');
    process.exit(1);
  }
  console.log(`✓ the packaged app starts and renders (${path.basename(bin)})`);
}
