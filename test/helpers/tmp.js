// Throwaway directories and a minimal kernel stand-in, so kernel modules can be
// exercised in a plain Node process without Electron.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const dirs = [];

function tmpdir(prefix = 'lyra-test-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return fs.realpathSync(d);
}

function cleanup() {
  while (dirs.length) { try { fs.rmSync(dirs.pop(), { recursive: true, force: true }); } catch {} }
}

// A kernel with the pieces the modules under test actually reach for: paths,
// settings, a store and the collectors that main.js would otherwise provide.
function fakeKernel({ userData = tmpdir(), appPath = ROOT, storeKind = 'json' } = {}) {
  const { layout, migrate } = require('../../main/kernel/paths');
  const { Settings } = require('../../main/kernel/settings');
  const { openStore } = require('../../main/kernel/store');
  const paths = layout(userData, appPath);
  migrate(paths);
  fs.mkdirSync(paths.organsMain, { recursive: true });
  fs.mkdirSync(paths.organsRenderer, { recursive: true });
  const events = [], logged = [];
  const k = {
    version: '0.0.0-test', paths, organs: null, safeMode: null,
    settings: new Settings(paths.settingsFile),
    store: openStore(userData, storeKind),
    events, logged,
    log: (msg, detail) => logged.push({ level: 'info', msg, detail }),
    logError: (source, message, detail) => logged.push({ level: 'error', source, message, detail }),
    emit: (chatId, type, payload) => events.push({ chatId, type, ...payload }),
    win: () => null,
  };
  k.guard = new (require('../../main/kernel/guard').Guard)(k);
  return k;
}

module.exports = { tmpdir, cleanup, fakeKernel, ROOT };
