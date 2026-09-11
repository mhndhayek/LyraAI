// Extensions: folders under state/extensions/<id>/ with a manifest.json, an optional
// main.js exporting tools, and an optional panel.html. The kernel loads them, asks
// the user to approve declared capabilities, and quarantines the ones that fail.
const fs = require('fs');
const path = require('path');

const CAPABILITIES = { settings: 'read app settings', shell: 'run shell commands', network: 'make network requests', files: 'read and write files outside the workspace', browser: 'drive Lyra’s browser', ui: 'show a panel in the app' };
const MAX_FAILURES = 5;

class Extensions {
  constructor(k) { this.k = k; this.loaded = new Map(); this.state = this.readState(); }
  readState() { try { return JSON.parse(fs.readFileSync(this.k.paths.extensionsState, 'utf8')); } catch { return {}; } }
  saveState() { fs.writeFileSync(this.k.paths.extensionsState, JSON.stringify(this.state, null, 2)); }
  dir(id) { return path.join(this.k.paths.extensions, id); }
  manifest(id) {
    const f = path.join(this.dir(id), 'manifest.json'); if (!fs.existsSync(f)) throw new Error('manifest.json missing');
    let m; try { m = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { throw new Error(`manifest.json is not valid JSON: ${e.message}`); }
    if (m.id && m.id !== id) throw new Error(`manifest id "${m.id}" does not match folder "${id}"`);
    if (!m.name) throw new Error('manifest needs a name');
    m.id = id; m.capabilities = Array.isArray(m.capabilities) ? m.capabilities : [];
    const bad = m.capabilities.filter((c) => !CAPABILITIES[c]); if (bad.length) throw new Error(`unknown capabilities: ${bad.join(', ')} (known: ${Object.keys(CAPABILITIES).join(', ')})`);
    if (m.panel && !fs.existsSync(path.join(this.dir(id), m.panel))) throw new Error(`panel file ${m.panel} missing`);
    if (m.main && !fs.existsSync(path.join(this.dir(id), m.main))) throw new Error(`main file ${m.main} missing`);
    if (!m.main && fs.existsSync(path.join(this.dir(id), 'main.js'))) m.main = 'main.js';
    if (!m.panel && fs.existsSync(path.join(this.dir(id), 'panel.html'))) m.panel = 'panel.html';
    return m;
  }
  ids() { try { return fs.readdirSync(this.k.paths.extensions, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name); } catch { return []; } }
  needsApproval(m) { const st = this.state[m.id] || {}; return m.capabilities.filter((c) => !(st.approved || []).includes(c)); }
  list() {
    return this.ids().map((id) => {
      const st = this.state[id] || {}; let m = null, error = st.error || null;
      try { m = this.manifest(id); } catch (e) { error = e.message; }
      const live = this.loaded.get(id);
      const status = !m ? 'broken' : st.quarantined ? 'quarantined' : st.enabled === false ? 'disabled' : this.needsApproval(m).length ? 'pending-approval' : live ? 'active' : 'inactive';
      return { id, name: m ? m.name : id, version: m ? m.version || '' : '', description: m ? m.description || '' : '', capabilities: m ? m.capabilities : [], pending: m ? this.needsApproval(m) : [], status, error, panel: m && m.panel ? path.join(this.dir(id), m.panel) : null, tools: live ? live.tools.map((t) => t.name) : [], failures: st.failures || 0 };
    });
  }
  approve(id) { const m = this.manifest(id); this.state[id] = { ...(this.state[id] || {}), approved: m.capabilities, enabled: true, quarantined: false, error: null, failures: 0 }; this.saveState(); return this.load(id); }
  setEnabled(id, on) { this.state[id] = { ...(this.state[id] || {}), enabled: !!on, quarantined: false, error: on ? null : (this.state[id] || {}).error, failures: 0 }; this.saveState(); if (on) return this.load(id); this.unload(id); return { ok: true }; }
  quarantine(id, why) { this.unload(id); this.state[id] = { ...(this.state[id] || {}), quarantined: true, error: why }; this.saveState(); this.k.logError('extensions', `Extension ${id} quarantined: ${why}`); this.k.emit(null, 'kernel', { level: 'warn', text: `Extension ${id} was quarantined: ${why}` }); }
  recordFailure(id, why) { const st = this.state[id] || {}; st.failures = (st.failures || 0) + 1; st.error = why; this.state[id] = st; this.saveState(); if (st.failures >= MAX_FAILURES) this.quarantine(id, `${MAX_FAILURES} failures, last: ${why}`); }
  api(m) {
    const k = this.k; const caps = new Set(m.capabilities); const need = (c) => { if (!caps.has(c)) throw new Error(`extension ${m.id} did not declare the "${c}" capability`); };
    return { id: m.id, dir: this.dir(m.id), workspace: () => k.root(), settings: () => { need('settings'); return JSON.parse(JSON.stringify(k.settings.get())); }, log: (t) => k.log(`[${m.id}] ${t}`), notice: (t) => k.emit(null, 'notice', { text: `${m.name}: ${t}` }), runShell: (cmd, timeout) => { need('shell'); return k.organs.runShell(cmd, timeout); }, fetch: (...a) => { need('network'); return fetch(...a); }, browser: () => { need('browser'); return k.organs.browser; }, store: { get: (key, d) => k.store.kvGet(`ext:${m.id}:${key}`, d), set: (key, v) => k.store.kvSet(`ext:${m.id}:${key}`, v) } };
  }
  load(id) {
    let m; try { m = this.manifest(id); } catch (e) { this.state[id] = { ...(this.state[id] || {}), error: e.message }; this.saveState(); return { ok: false, error: e.message }; }
    const st = this.state[id] || {};
    if (st.enabled === false) return { ok: false, error: 'disabled' };
    if (st.quarantined) return { ok: false, error: 'quarantined: ' + st.error };
    if (this.needsApproval(m).length) return { ok: false, error: 'capabilities not approved yet', pending: this.needsApproval(m) };
    this.unload(id);
    const entry = { manifest: m, tools: [], mod: null, api: this.api(m) };
    if (m.main) {
      const file = path.join(this.dir(id), m.main);
      try {
        for (const key of Object.keys(require.cache)) if (key.startsWith(this.dir(id) + path.sep)) delete require.cache[key];
        const mod = require(file); entry.mod = mod;
        const tools = Array.isArray(mod.tools) ? mod.tools : [];
        for (const t of tools) {
          if (!t.name || !t.description || typeof t.run !== 'function') throw new Error(`tool ${t.name || '?'} needs name, description and run()`);
          const run = t.run; const self = this;
          entry.tools.push({ name: t.name, description: t.description, parameters: t.parameters || { type: 'object', properties: {} }, icon: 'tool', key: 'ext', extension: id, risk: () => (typeof t.risk === 'function' ? t.risk() : t.risk || (m.capabilities.some((c) => ['shell', 'files'].includes(c)) ? 'high' : 'low')), summary: (a) => (typeof t.summary === 'function' ? t.summary(a) : `${m.name}: ${t.name}`), run: async (args) => { try { const r = await run(args, entry.api); return typeof r === 'string' ? r : JSON.stringify(r); } catch (e) { self.recordFailure(id, e.message); throw e; } } });
        }
        if (typeof mod.activate === 'function') mod.activate(entry.api);
      } catch (e) { this.quarantine(id, `failed to load: ${e.message}`); return { ok: false, error: e.message }; }
    }
    this.loaded.set(id, entry); this.state[id] = { ...st, enabled: true, error: null }; this.saveState();
    this.k.log(`extension ${id} loaded (${entry.tools.length} tools${m.panel ? ', panel' : ''})`);
    return { ok: true, tools: entry.tools.map((t) => t.name), panel: !!m.panel };
  }
  unload(id) { const e = this.loaded.get(id); if (!e) return; try { e.mod && typeof e.mod.dispose === 'function' && e.mod.dispose(); } catch {} this.loaded.delete(id); }
  loadAll() { for (const id of this.ids()) this.load(id); }
  unloadAll() { for (const id of [...this.loaded.keys()]) this.unload(id); }
  tools() { return [...this.loaded.values()].flatMap((e) => e.tools); }
  panels() { return [...this.loaded.values()].filter((e) => e.manifest.panel).map((e) => ({ id: e.manifest.id, name: e.manifest.name, file: path.join(this.dir(e.manifest.id), e.manifest.panel) })); }
  async call(id, tool, args) { const e = this.loaded.get(id); if (!e) throw new Error(`extension ${id} is not active`); const t = e.tools.find((x) => x.name === tool); if (!t) throw new Error(`extension ${id} has no tool ${tool}`); return t.run(args || {}); }
}
module.exports = { Extensions, CAPABILITIES };
