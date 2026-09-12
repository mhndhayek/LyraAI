#!/usr/bin/env node
// Makes sure the Electron binary is actually on disk before any check tries to
// start the app. The electron package downloads it lazily on first require, so
// without this a network blip surfaces much later as a failing smoke test
// rather than as what it is: a download that did not happen.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ATTEMPTS = 3;

function resolve() {
  // Requiring the package downloads the binary if it is missing, so clear it
  // from the cache between attempts to let a retry try the download again.
  delete require.cache[require.resolve(path.join(ROOT, 'node_modules', 'electron'))];
  const bin = require(path.join(ROOT, 'node_modules', 'electron'));
  if (typeof bin !== 'string' || !fs.existsSync(bin)) throw new Error(`electron resolved to "${bin}", which does not exist`);
  return bin;
}

let lastError = null;
for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  try {
    const bin = resolve();
    // Ask the binary for its version as plain Node: starting the browser side
    // here would need a display and a sandbox, neither of which this check needs.
    const version = execFileSync(bin, ['-p', 'process.versions.electron'], {
      encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    }).trim();
    console.log(`✓ Electron ${version} ready at ${path.relative(ROOT, bin)}`);
    process.exit(0);
  } catch (e) {
    lastError = e;
    console.error(`Attempt ${attempt} of ${ATTEMPTS} failed: ${e.message}`);
    if (attempt < ATTEMPTS) {
      const wait = attempt * 5;
      console.error(`Retrying in ${wait}s…`);
      execFileSync(process.execPath, ['-e', `setTimeout(() => {}, ${wait * 1000})`]);
    }
  }
}

console.error(`✗ the Electron binary could not be downloaded after ${ATTEMPTS} attempts: ${lastError && lastError.message}`);
process.exit(1);
