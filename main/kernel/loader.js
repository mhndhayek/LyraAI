// Organ loader: copies shipped organs into the state folder, verifies edits in a
// throwaway process before they go live, hot-swaps the main organ set, reloads the
// UI organ, and falls back to the last known good checkpoint or safe mode.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { copyDir } = require('./paths');

const listJs = (dir) => { const out = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === 'vendor' || e.name.startsWith('.')) continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) out.push(p); } }; if (fs.existsSync(dir)) walk(dir); return out; };
const runNode = (args, timeout = 20000) => new Promise((resolve) => execFile(process.execPath, args, { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') })));

class Loader {
  constructor(k) { this.k = k; this.ipcHandlers = new Map(); this.generation = 0; this.readyResolver = null; }

  syncOrgans({ force = false } = {}) {
    const p = this.k.paths; const shipped = this.k.version;
    const current = fs.existsSync(p.organsVersion) ? fs.readFileSync(p.organsVersion, 'utf8').trim() : null;
    if (!force && current === shipped && fs.existsSync(path.join(p.organsMain, 'index.js')) && fs.existsSync(path.join(p.organsRenderer, 'index.html'))) return { synced: false, version: current };
    if (current) this.k.checkpoints.commit(`Before organ sync to ${shipped}${force ? ' (forced)' : ''}`);
    fs.rmSync(p.organsMain, { recursive: true, force: true }); fs.rmSync(p.organsRenderer, { recursive: true, force: true });
    copyDir(p.shippedOrgans, p.organsMain); copyDir(p.shippedRenderer, p.organsRenderer);
    fs.writeFileSync(p.organsVersion, shipped);
    this.k.checkpoints.commit(`Organs synced to shipped version ${shipped}`);
    this.k.log(`organs synced (${current || 'none'} → ${shipped})`);
    return { synced: true, version: shipped };
  }

  async verify(what = 'all') {
    const p = this.k.paths; const errors = [];
    const files = [...(what !== 'renderer' ? listJs(p.organsMain) : []), ...(what !== 'main' ? listJs(p.organsRenderer) : [])];
    for (const f of files) { const r = await runNode(['--check', f], 10000); if (r.code !== 0) errors.push({ file: path.relative(p.state, f), message: r.stderr.split('\n').slice(0, 6).join('\n') }); }
    if (what !== 'renderer' && !errors.length) {
      const entry = path.join(p.organsMain, 'index.js');
      const r = await runNode([path.join(p.kernelDir, 'verify-child.js'), entry]);
      try { const j = JSON.parse(r.stdout.trim().split('\n').pop()); for (const e of j.errors) errors.push({ file: path.relative(p.state, e.file), message: e.message }); }
      catch { errors.push({ file: 'organs/main/index.js', message: `dry load failed: ${(r.stderr || r.stdout).slice(0, 600)}` }); }
    }
    if (what !== 'main' && !fs.existsSync(path.join(p.organsRenderer, 'index.html'))) errors.push({ file: 'organs/renderer/index.html', message: 'missing' });
    return { ok: errors.length === 0, errors };
  }

  ipc(channel, fn) {
    const { ipcMain } = require('electron');
    if (this.ipcHandlers.has(channel)) ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (_, payload) => fn(payload || {}));
    this.ipcHandlers.set(channel, fn);
  }
  clearIpc() { const { ipcMain } = require('electron'); for (const ch of this.ipcHandlers.keys()) ipcMain.removeHandler(ch); this.ipcHandlers.clear(); }

  load() {
    const entry = path.join(this.k.paths.organsMain, 'index.js');
    for (const key of Object.keys(require.cache)) if (key.startsWith(this.k.paths.organsMain + path.sep)) delete require.cache[key];
    const mod = require(entry);
    if (typeof mod.create !== 'function') throw new Error('organs/main/index.js must export create(kernel)');
    this.generation += 1;
    this.k.organs = mod.create(this.k);
    this.k.log(`main organs loaded (generation ${this.generation})`);
    return this.k.organs;
  }
  dispose() {
    const o = this.k.organs; if (!o) return;
    try { o.dispose && o.dispose(); } catch (e) { this.k.log(`dispose error: ${e.message}`); }
    this.clearIpc(); this.k.organs = null;
  }

  waitReady(timeoutMs) { return new Promise((resolve) => { const t = setTimeout(() => { this.readyResolver = null; resolve(false); }, timeoutMs); this.readyResolver = () => { clearTimeout(t); this.readyResolver = null; resolve(true); }; }); }
  rendererReady() { if (this.readyResolver) this.readyResolver(); }
  async reloadRenderer() {
    const win = this.k.win(); if (!win) return { ok: false, error: 'no window' };
    const p = this.waitReady(this.k.settings.get().kernel.uiReadyTimeoutMs || 10000);
    win.loadFile(path.join(this.k.paths.organsRenderer, 'index.html')).catch(() => {});
    return { ok: await p };
  }

  // Two-phase apply: verify in a child process, then swap; on failure roll the organs
  // back to the last checkpoint and swap again; if even that fails, safe mode.
  async reload(what = 'all', { chatId = null, label = 'agent changes' } = {}) {
    const k = this.k; const result = { ok: true, applied: [], errors: [] };
    const v = await this.verify(what);
    if (!v.ok) return { ok: false, applied: [], errors: v.errors, note: 'Nothing was applied; fix the errors and call apply_changes again.' };
    const wasRunning = k.organs && k.organs.agent && k.organs.agent.isBusy();
    if (what !== 'renderer') {
      if (wasRunning && chatId) k.deferReload = { what, label }; // the agent's own turn is running: swap after it ends
      else {
        try { this.dispose(); this.load(); result.applied.push('main organs (hot swap)'); k.checkpoints.commit(`Applied ${label} (main)`); }
        catch (e) {
          result.ok = false; result.errors.push({ file: 'organs/main', message: e.message });
          k.logError('organs', `Main organ swap failed, rolling back: ${e.message}`, e);
          try { k.checkpoints.rollback('lkg', { subdir: 'organs/main' }); this.load(); result.note = 'The change broke the main organs; rolled them back to the last known good checkpoint.'; }
          catch (e2) { await this.safeMode(`main organs failed to load even after rollback: ${e2.message}`); }
          return result;
        }
      }
    }
    if (what !== 'main') {
      const r = await this.reloadRenderer();
      if (r.ok) { result.applied.push('UI (reloaded)'); k.checkpoints.commit(`Applied ${label} (renderer)`); }
      else {
        result.ok = false; result.errors.push({ file: 'organs/renderer', message: 'the UI did not report ready in time' });
        k.logError('organs', 'The UI did not become ready after a change; rolling back'); 
        try { k.checkpoints.rollback('lkg', { subdir: 'organs/renderer' }); const r2 = await this.reloadRenderer(); result.note = r2.ok ? 'The UI change broke the window; rolled the UI back to the last known good checkpoint.' : 'UI still failing after rollback'; if (!r2.ok) await this.safeMode('UI failed even after rollback'); }
        catch (e2) { await this.safeMode(`UI rollback failed: ${e2.message}`); }
      }
    }
    if (what !== 'renderer') k.dirty.main = false; if (what !== 'main') k.dirty.renderer = false;
    k.emit(chatId, 'kernel', { level: result.ok ? 'info' : 'warn', text: result.ok ? `Applied: ${result.applied.join(', ')}` : `Apply failed: ${result.errors.map((e) => e.file + ': ' + e.message.split('\n')[0]).join('; ')}` });
    return result;
  }

  async safeMode(reason) {
    const k = this.k; k.safeMode = reason; k.logError('kernel', `Safe mode: ${reason}`);
    try { this.dispose(); } catch {}
    const win = k.win(); if (win) { win.loadFile(path.join(k.paths.kernelDir, 'recovery.html'), { query: { reason } }).catch(() => {}); }
  }
}
module.exports = { Loader };
