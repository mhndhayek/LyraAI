// Dry-loads organ or extension modules in a throwaway process. Prints one JSON line.
const Module = require('module');
const path = require('path');
const orig = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) { if (request === 'electron') return path.join(__dirname, 'electron-stub.js'); return orig.call(this, request, ...rest); };
const errors = [];
for (const file of process.argv.slice(2)) {
  try { const m = require(file); if (file.endsWith(path.join('organs', 'main', 'index.js')) && typeof m.create !== 'function') errors.push({ file, message: 'organs/main/index.js must export create(kernel)' }); }
  catch (e) { errors.push({ file, message: String(e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n') : e) }); }
}
process.stdout.write(JSON.stringify({ ok: errors.length === 0, errors }) + '\n');
process.exit(0);
