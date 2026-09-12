// Lyra kernel. Boots the app, owns settings, data, checkpoints, the organ loader,
// extensions and the watchdog. Everything the user experiences lives in organs
// under the state folder, which the agent may edit and the kernel can put back.
const { app, BrowserWindow, ipcMain, shell: eshell, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { layout, migrate, adoptOldUserData } = require('./kernel/paths');
const pkg = require('../package.json');
const { Settings } = require('./kernel/settings');
const { openStore } = require('./kernel/store');
const { Checkpoints } = require('./kernel/checkpoints');
const { Loader } = require('./kernel/loader');
const { Extensions } = require('./kernel/extensions');
const { Guard } = require('./kernel/guard');
const { Docs } = require('./kernel/docs');
const { Logs } = require('./kernel/logs');
const watchdog = require('./kernel/watchdog');

app.setName('Lyra');
process.on('unhandledRejection', (e) => console.error('unhandled', e));
const argOf = (k) => (process.argv.find((x) => x.startsWith(`--${k}=`)) || '').split('=').slice(1).join('=');
const flag = (k) => process.argv.includes(`--${k}`);
if (argOf('user-data-dir')) app.setPath('userData', argOf('user-data-dir'));

let win = null;
const k = { version: app.getVersion(), organs: null, safeMode: null, dirty: { main: false, renderer: false, extensions: false }, deferReload: null, queued: null, win: () => (win && !win.isDestroyed() ? win : null) };

function log(msg, detail) { try { fs.appendFileSync(k.paths.healthLog, `${new Date().toISOString()} ${msg}\n`); } catch {} if (k.logs) k.logs.info('kernel', msg, detail); else console.log('[kernel]', msg); }
k.log = log;
k.logError = (source, message, detail) => (k.logs ? k.logs.error(source, message, detail) : console.error(source, message, detail));
k.eventHooks = new Set();
k.onEvent = (fn) => { k.eventHooks.add(fn); return () => k.eventHooks.delete(fn); };
k.emit = (chatId, type, payload) => {
  const e = { chatId, type, ...payload };
  const w = k.win(); if (w) w.webContents.send('lyra:event', e);
  for (const fn of k.eventHooks) { try { fn(e); } catch (err) { console.error('event hook failed', err); } }
};

function listThemes() {
  const out = [];
  const scan = (dir, builtin) => { if (!fs.existsSync(dir)) return; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (!e.isDirectory()) continue; const jp = path.join(dir, e.name, 'theme.json'); if (!fs.existsSync(jp)) continue; try { const j = JSON.parse(fs.readFileSync(jp, 'utf8')); out.push({ id: e.name, name: j.name || e.name, scheme: j.scheme || 'dark', character: j.character || 'default', css: pathToFileURL(path.join(dir, e.name, 'theme.css')).href, builtin, vars: j.vars || {} }); } catch {} } };
  scan(path.join(k.paths.organsRenderer, 'themes'), true); scan(k.paths.themes, false);
  return out;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 980, minHeight: 640, show: false, backgroundColor: '#141517', title: 'Lyra',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default', trafficLightPosition: { x: 14, y: 18 },
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, spellcheck: true },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { eshell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('console-message', (e, level, msg, line, src) => {
    const where = `${(src || '').split('/').pop()}:${line}`;
    if (level >= 3) k.logs.error('ui', msg, where);
    else if (level === 2) k.logs.warn('ui', msg, where);
    if (argOf('screenshot')) console.log(`[renderer${level >= 3 ? ' ERROR' : ''}] ${msg} (${where})`);
  });
  win.on('closed', () => { win = null; });
  watchdog.attach(k, win);
  // Debug flags: --open=settings:<section>, --send="text", --send2=..., --screenshot=<file> --delay=ms
  win.webContents.on('did-finish-load', () => {
    const open = argOf('open'); if (open) setTimeout(() => k.emit(null, 'debug', { open, scroll: argOf('scroll') || null }), 1500);
    const sendText = argOf('send'); if (sendText) setTimeout(() => k.emit(null, 'debug', { send: sendText, browser: !!argOf('browser') }), 2000);
    const send2 = argOf('send2'); if (send2) setTimeout(() => k.emit(null, 'debug', { send: send2 }), Number(argOf('send2delay')) || 10000);
    const shot = argOf('screenshot'); if (shot && !k.shotTimer) k.shotTimer = setTimeout(async () => { try { const img = await win.webContents.capturePage(); fs.writeFileSync(shot, img.toPNG()); } catch (e) { console.error(e); } app.quit(); }, Number(argOf('delay')) || 4000);
  });
}

function bootCounter() {
  let b = { attempts: 0 }; try { b = JSON.parse(fs.readFileSync(k.paths.bootFile, 'utf8')); } catch {}
  b.attempts = (b.attempts || 0) + 1; b.last = Date.now(); fs.writeFileSync(k.paths.bootFile, JSON.stringify(b)); return b.attempts;
}
function markHealthy() { fs.writeFileSync(k.paths.bootFile, JSON.stringify({ attempts: 0, last: Date.now(), healthy: true })); if (k.settings.get().kernel.checkpoints) k.checkpoints.markGood(); log('healthy: boot marked good'); }

app.whenReady().then(async () => {
  const ud = app.getPath('userData'); let adopted = null;
  if (!argOf('user-data-dir')) { try { adopted = adoptOldUserData(ud); } catch (e) { console.error('could not adopt the old data folder', e); } }
  fs.mkdirSync(ud, { recursive: true });
  k.paths = layout(fs.realpathSync(ud), fs.realpathSync(path.join(__dirname, '..')));
  k.logs = new Logs(k.paths.logs, { emit: (c, t, p) => k.emit(c, t, p) });
  process.on('uncaughtException', (e) => k.logs.error('main', `Uncaught exception: ${e.message}`, e));
  process.on('unhandledRejection', (e) => k.logs.error('main', `Unhandled rejection: ${e && e.message ? e.message : String(e)}`, e instanceof Error ? e : String(e)));
  k.logs.info('kernel', `Lyra ${k.version} starting`);
  if (adopted) k.logs.info('kernel', `Adopted the app data from ${adopted.from}`, adopted);
  migrate(k.paths);
  k.settings = new Settings(k.paths.settingsFile);
  k.store = openStore(k.paths.userData, k.settings.get().persona.store);
  k.checkpoints = new Checkpoints(k.paths.state, log); if (k.settings.get().kernel.checkpoints) k.checkpoints.init();
  k.guard = new Guard(k); k.docs = new Docs(k); k.extensions = new Extensions(k); k.loader = new Loader(k);
  k.root = () => require(path.join(k.paths.organsMain, 'workspace.js')).ensure(k.settings.get().workspace.folder);
  k.ipc = (ch, fn) => k.loader.ipc(ch, fn);
  k.beforeStateWrite = (label, chatId) => { if (!k.checkpoints.isDirty()) return; k.checkpoints.commit(`Before: ${label}`); };
  k.markDirty = (abs) => { const rel = path.relative(k.paths.state, abs); if (rel.startsWith(path.join('organs', 'main'))) k.dirty.main = true; else if (rel.startsWith(path.join('organs', 'renderer'))) k.dirty.renderer = true; else if (rel.startsWith('extensions')) k.dirty.extensions = true; };
  k.queueSettings = (patch) => { k.queued = k.queued ? require('./kernel/settings').merge(k.queued, patch) : patch; };
  k.flushQueued = () => { if (k.queued) { const p = k.queued; k.queued = null; k.settings.set(p); k.emit(null, 'notice', { text: 'Applied the model change now that Lyra is idle.' }); } };
  k.afterRun = async (chatId) => {
    const busy = k.organs && k.organs.agent.isBusy(); if (busy) return;
    k.flushQueued();
    if (k.deferReload) { const d = k.deferReload; k.deferReload = null; await k.loader.reload(d.what, { chatId, label: d.label }); }
    else if (k.settings.get().kernel.autoApply) {
      if (k.dirty.extensions) { k.dirty.extensions = false; k.extensions.unloadAll(); k.extensions.loadAll(); k.emit(null, 'extensions', {}); }
      const what = k.dirty.main && k.dirty.renderer ? 'all' : k.dirty.main ? 'main' : k.dirty.renderer ? 'renderer' : null;
      if (what) await k.loader.reload(what, { chatId, label: 'agent changes (auto-applied)' });
    }
    if (k.checkpoints.isDirty()) k.checkpoints.commit('After agent turn');
  };
  k.appState = () => ({ version: k.version, links: { repo: pkg.homepage, issues: pkg.bugs && pkg.bugs.url, donate: pkg.funding && pkg.funding.url, license: `${pkg.homepage}/blob/main/LICENSE` }, safeMode: k.safeMode, organsGeneration: k.loader.generation, organsVersion: fs.existsSync(k.paths.organsVersion) ? fs.readFileSync(k.paths.organsVersion, 'utf8').trim() : null, statePath: k.paths.state, workspace: k.settings.get().workspace.folder, extensions: k.extensions.list(), checkpoints: k.checkpoints.list(5), lastKnownGood: k.checkpoints.lastKnownGood(), changedSinceGood: k.checkpoints.changedSince('lkg').slice(0, 20), budget: k.guard.budget(), pendingChanges: !!(k.dirty.main || k.dirty.renderer || k.dirty.extensions) || !!k.deferReload, queuedSettings: k.queued, locked: require('./kernel/guard').LOCKED, autoApply: k.settings.get().kernel.autoApply });

  const attempts = bootCounter(); const safe = flag('safe') || attempts >= 3;
  nativeTheme.themeSource = 'dark';
  createWindow();

  // Kernel IPC (always available, also in safe mode)
  const h = (ch, fn) => ipcMain.handle(ch, async (_, p) => fn(p || {}));
  h('renderer:ready', () => { k.loader.rendererReady(); if (flag('kernel-test') && !k.selftestStarted) { k.selftestStarted = true; setTimeout(() => require('./kernel/selftest').run(k, markHealthy).then((r) => app.exit(r.pass ? 0 : 1)).catch((e) => { console.error('[selftest] crashed', e); app.exit(2); }), 1500); } if (!k.safeMode) { fs.writeFileSync(k.paths.bootFile, JSON.stringify({ attempts: 0, last: Date.now() })); if (!k.healthyTimer) k.healthyTimer = setTimeout(() => { if (!k.safeMode) markHealthy(); }, 20000); } return true; });
  h('kernel:state', () => k.appState());
  h('kernel:checkpoints', () => k.checkpoints.list(40));
  h('kernel:checkpoint', (p) => k.checkpoints.commit(p.label || 'Manual checkpoint'));
  h('kernel:rollback', async (p) => { k.checkpoints.rollback(p.ref || 'lkg', { subdir: p.subdir || null }); k.settings.load(); k.settings.emit('change', k.settings.get(), null, {}); if (!k.safeMode) { k.extensions.unloadAll(); k.extensions.loadAll(); await k.loader.reload('all', { label: 'rollback' }); } return true; });
  h('kernel:resetShipped', async () => { k.loader.syncOrgans({ force: true }); if (!k.safeMode) await k.loader.reload('all', { label: 'reset to shipped' }); return true; });
  h('kernel:reload', (p) => k.loader.reload(p.what || 'all', { label: p.label || 'manual reload' }));
  h('kernel:verify', (p) => k.loader.verify(p.what || 'all'));
  h('logs:list', (p) => k.logs.list(p));
  h('logs:text', (p) => k.logs.text(p));
  h('logs:counts', (p) => k.logs.counts(p.sinceMinutes));
  h('logs:clear', () => { k.logs.clear(); k.logs.info('kernel', 'Log cleared by the user'); return true; });
  h('logs:write', (p) => k.logs.write(p.level || 'error', p.source || 'ui', p.message || '', p.detail));
  h('logs:open', () => eshell.openPath(k.paths.logs));
  h('kernel:health', () => { try { return fs.readFileSync(k.paths.healthLog, 'utf8').split('\n').slice(-80).join('\n'); } catch { return ''; } });
  h('kernel:docs', (p) => k.docs.read(p.topic));
  h('kernel:relaunch', () => { fs.writeFileSync(k.paths.bootFile, JSON.stringify({ attempts: 0 })); app.relaunch(); app.exit(0); });
  h('kernel:disableAllExtensions', () => { for (const e of k.extensions.list()) k.extensions.setEnabled(e.id, false); return true; });
  h('kernel:openState', () => eshell.openPath(k.paths.state));
  h('ext:list', () => k.extensions.list());
  h('ext:set', (p) => { const r = k.extensions.setEnabled(p.id, p.enabled); k.emit(null, 'extensions', {}); return r; });
  h('ext:approve', (p) => { const r = k.extensions.approve(p.id); k.emit(null, 'extensions', {}); return r; });
  h('ext:call', async (p) => { try { return { ok: true, result: await k.extensions.call(p.id, p.tool, p.args) }; } catch (e) { return { ok: false, error: e.message }; } });
  h('ext:panels', () => k.extensions.panels().map((x) => ({ ...x, url: pathToFileURL(x.file).href })));
  h('ext:openFolder', () => eshell.openPath(k.paths.extensions));
  h('packs:list', () => { const dir = path.join(k.paths.organsRenderer, 'character'); if (!fs.existsSync(dir)) return []; return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'idle.gif'))).map((e) => { let meta = {}; try { meta = JSON.parse(fs.readFileSync(path.join(dir, e.name, 'pack.json'), 'utf8')); } catch {} return { id: e.name, name: meta.name || e.name, description: meta.description || '', avatar: fs.existsSync(path.join(dir, e.name, 'avatar.png')) }; }); });
  // Drawn in the kernel: organs live outside the bundle and cannot load npm packages.
  h('mobile:qr', async (p) => {
    const QR = require('qrcode');
    const text = p.text || (k.organs && k.organs.companion ? k.organs.companion.state().pairUrl : '') || '';
    if (!text) return '';
    return QR.toString(text, { type: 'svg', margin: 1, width: p.width || 220, color: { dark: p.dark || '#101114', light: p.light || '#ffffff' } });
  });
  h('themes:list', () => listThemes());
  h('themes:openFolder', () => { const d = k.paths.themes; fs.mkdirSync(d, { recursive: true }); const readme = path.join(d, 'README.txt'); if (!fs.existsSync(readme)) fs.writeFileSync(readme, 'Drop a folder here with theme.json ({"name":"My theme","scheme":"dark","character":"default"}) and theme.css. Copy a built-in theme from organs/renderer/themes to start.\n'); return eshell.openPath(d); });
  h('app:paths', () => ({ userData: k.paths.userData, workspace: k.root(), themes: k.paths.themes, state: k.paths.state, voiceReady: !!(k.organs && k.organs.voice.available()), version: k.version, safeMode: k.safeMode }));

  k.settings.on('change', (data, before, patch) => {
    if (patch.persona && patch.persona.store && before && patch.persona.store !== before.persona.store) { const dump = k.store.dump(); k.store.close(); k.store = openStore(k.paths.userData, data.persona.store); k.store.loadDump(dump); }
    if (patch.appearance && patch.appearance.theme) { const t = listThemes().find((x) => x.id === data.appearance.theme); nativeTheme.themeSource = t && t.scheme === 'light' ? 'light' : 'dark'; }
    k.emit(null, 'settings', { settings: data });
  });

  if (safe) { log(`safe mode requested (attempts=${attempts}, flag=${flag('safe')})`); await k.loader.safeMode(flag('safe') ? 'Started with --safe.' : `The app failed to start ${attempts - 1} times in a row.`); return; }

  k.loader.syncOrgans({ force: flag('sync-organs') });
  try { k.loader.load(); }
  catch (e) {
    log(`organs failed to load: ${e.message}; rolling back to last known good`);
    try { k.checkpoints.rollback('lkg', { subdir: 'organs' }); k.loader.load(); }
    catch (e2) { log(`still failing: ${e2.message}; resetting to shipped`); try { k.loader.syncOrgans({ force: true }); k.loader.load(); } catch (e3) { await k.loader.safeMode(`Organs cannot load: ${e3.message}`); return; } }
  }
  k.extensions.loadAll();
  win.loadFile(path.join(k.paths.organsRenderer, 'index.html'));
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) { createWindow(); win.loadFile(path.join(k.paths.organsRenderer, 'index.html')); } });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { try { if (k.paths && !k.safeMode) fs.writeFileSync(k.paths.bootFile, JSON.stringify({ attempts: 0, last: Date.now() })); } catch {} try { k.loader && k.loader.dispose(); k.extensions && k.extensions.unloadAll(); k.store && k.store.close(); } catch {} });
