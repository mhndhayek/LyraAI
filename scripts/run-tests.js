#!/usr/bin/env node
// Runs the test suite. Node's own glob support for --test differs between
// releases, so the files are collected here and passed explicitly: the same
// command then works on every Node version the project supports.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const passthrough = args.filter((a) => a.startsWith('-'));
const dirs = args.filter((a) => !a.startsWith('-'));
const roots = (dirs.length ? dirs : ['test']).map((d) => path.join(ROOT, d));

function collect(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collect(p, out);
    else if (e.name.endsWith('.test.js')) out.push(p);
  }
  return out;
}

const files = roots.flatMap((r) => collect(r)).sort();
if (!files.length) {
  console.error(`No test files found under ${roots.join(', ')}`);
  process.exit(1);
}

const r = spawnSync(process.execPath, ['--test', ...passthrough, ...files], { stdio: 'inherit', cwd: ROOT });
process.exit(r.status === null ? 1 : r.status);
