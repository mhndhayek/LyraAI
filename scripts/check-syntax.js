#!/usr/bin/env node
// Parses every JavaScript file the app ships. Cheap, dependency-free, and it
// catches the one mistake that would leave the app unable to start at all.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ROOTS = ['main', 'renderer', 'scripts', 'test'];
const SKIP = new Set(['node_modules', 'vendor', 'dist', '.git']);

function listJs(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listJs(p, out);
    else if (p.endsWith('.js') || p.endsWith('.mjs')) out.push(p);
  }
  return out;
}

const files = [path.join(ROOT, 'preload.js'), ...ROOTS.flatMap((d) => listJs(path.join(ROOT, d)))];
const failures = [];
for (const f of files) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: ['ignore', 'ignore', 'pipe'] }); }
  catch (e) { failures.push(`${path.relative(ROOT, f)}\n${String(e.stderr || e.message).trim()}`); }
}

if (failures.length) {
  console.error(`✗ ${failures.length} file(s) do not parse:\n\n${failures.join('\n\n')}`);
  process.exit(1);
}
console.log(`✓ ${files.length} JavaScript files parse cleanly`);
