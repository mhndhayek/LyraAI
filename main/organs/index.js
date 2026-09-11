// The main organ set. The kernel calls create(k) at boot and after a hot swap; the
// returned object holds every service and a dispose() that tears them down again.
const path = require('path');
const fs = require('fs');
const { dialog, shell: eshell, nativeTheme } = require('electron');
const ws = require('./workspace');
const { PersistentShell, runOnce } = require('./shell');
const { Approvals } = require('./approvals');
const { AgentBrowser } = require('./browser');
const { Voice } = require('./voice');
const { Agent } = require('./agent');
const { Goals } = require('./goals');
const { Companion } = require('./companion');
const { makeNotifier } = require('./notify');
const llm = require('./llm');
const imagegen = require('./imagegen');
const tools = require('./tools');
const { id } = require('./util');

function saveDataUrl(dir, name, dataUrl) {
  fs.mkdirSync(dir, { recursive: true });
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl || ''); if (!m) throw new Error('bad data url');
  const ext = path.extname(name || '') || ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'audio/webm': '.webm', 'audio/ogg': '.ogg', 'audio/wav': '.wav', 'audio/mp4': '.m4a' }[m[1]] || '.bin');
  const file = path.join(dir, `${Date.now()}-${id()}${ext}`);
  fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
  return file;
}

function create(k) {
  const { settings } = k; const root = () => k.root(); const emit = k.emit;
  let shellInst = new PersistentShell(root());
  const runShell = (cmd, timeout) => (settings.get().workspace.persistentShell ? shellInst.run(cmd, timeout) : runOnce(cmd, root(), timeout));
  const notifier = makeNotifier(settings, () => k.win());
  const approvals = new Approvals({ settings, emit, notify: notifier.notify });
  const browser = new AgentBrowser({ getWindow: () => k.win(), settings, emit, approvals, downloadsDir: path.join(root(), 'downloads') });
  const voice = new Voice({ settings, appPath: k.paths.appPath, userData: k.paths.userData, emit, logs: k.logs });
  // Warm the voice model shortly after start so the first spoken reply is not slow.
  const warmTimer = setTimeout(() => { if (settings.get().voice.readAloud && voice.available()) voice.warm(); }, 6000);
  const ctx = { settings, get store() { return k.store; }, approvals, browser, voice, notify: notifier.notify, emit, root, runShell, mediaDir: k.paths.media, kernel: k };
  const agent = new Agent(ctx);
  const goals = new Goals({ settings, get store() { return k.store; }, agent, emit, notify: notifier.notify });
  goals.start();
  const companion = new Companion({ settings, get store() { return k.store; }, kernel: k, emit, agent, approvals, send: (p) => sendMessage(p) });
  const mobileTimer = setTimeout(() => { const m = settings.get().mobile; if (m.enabled && m.autoStart) companion.start().catch(() => {}); }, 3000);

  const onSettings = (data, before, patch) => {
    if (patch.workspace && patch.workspace.folder && before && patch.workspace.folder !== before.workspace.folder) { shellInst.kill(); shellInst = new PersistentShell(root()); agent.repoCache.at = 0; }
  };
  settings.on('change', onSettings);

  // ---- IPC (tracked by the kernel, removed on dispose) ----
  const h = k.ipc;
  h('settings:get', () => settings.get());
  h('settings:set', (p) => settings.set(p));
  h('settings:reset', (p) => settings.reset(p.section));
  h('models:detect', () => agent.detectModels(true));
  h('app:testConnection', (p) => llm.testConnection({ endpoint: p.endpoint, apiKey: p.apiKey || '' }));
  h('chats:list', () => k.store.listChats());
  h('chats:create', async () => { const c = k.store.createChat(); emit(null, 'chats', {}); goals.reflectPending().catch(() => {}); return c; });
  h('chats:get', (p) => ({ chat: k.store.getChat(p.id), messages: k.store.listMessages(p.id) }));
  h('chats:delete', (p) => { agent.stop(p.id); k.store.deleteChat(p.id); emit(null, 'chats', {}); return true; });
  h('chats:rename', (p) => { k.store.updateChat(p.id, { title: p.title }); emit(null, 'chats', {}); return true; });
  const sendMessage = async (p) => {
    const dir = path.join(k.paths.media, p.chatId);
    const images = (p.images || []).map((im) => ({ name: im.name, path: saveDataUrl(dir, im.name, im.dataUrl) }));
    const audio = p.audio ? { path: saveDataUrl(dir, 'voice.webm', p.audio.dataUrl), mime: p.audio.mime, duration: p.audio.duration } : null;
    agent.run({ chatId: p.chatId, text: p.text || '', images, audio, origin: p.origin || 'desktop' }).catch((e) => emit(p.chatId, 'error', { message: e.message }));
    return { ok: true };
  };
  h('chat:send', sendMessage);
  h('chat:stop', (p) => { agent.stop(p.chatId); return true; });
  h('chat:context', (p) => agent.contextInfo(p.chatId));
  h('approval:respond', (p) => approvals.respond(p.id, p.decision));
  h('browser:bounds', (p) => { browser.setBounds(p); return true; });
  h('browser:show', (p) => { browser.show(p.on); return browser.status; });
  h('browser:takeover', (p) => { browser.takeOver(p.on); return browser.status; });
  h('browser:stop', () => { browser.stop(); return browser.status; });
  h('browser:navigate', (p) => { browser.userNavigate(p.url); return true; });
  h('browser:back', () => { browser.back(); return true; });
  h('browser:reload', () => { browser.reload(); return true; });
  h('browser:status', () => browser.status);
  h('browser:clear', () => browser.clearData());
  h('voice:available', () => voice.available());
  h('voice:status', () => voice.status());
  h('voice:setup', () => voice.setup());
  h('voice:warm', () => voice.warm());
  h('voice:voices', () => voice.voices());
  h('voice:speak', async (p) => voice.tts(p.text));
  h('voice:transcribe', async (p) => { const f = saveDataUrl(path.join(k.paths.media, 'stt'), 'voice.webm', p.dataUrl); return voice.stt(f); });
  h('state:set', (p) => { agent.setState(p.state); return true; });
  h('memory:list', (p) => k.store.listMemories(p.scope, p.chatId));
  h('memory:delete', (p) => { k.store.deleteMemory(p.id); return true; });
  h('memory:clear', (p) => { k.store.clearMemories(p.scope, p.chatId); return true; });
  h('goals:list', () => k.store.listGoals(true));
  h('goals:archive', (p) => { k.store.updateGoal(p.id, { archived: p.archived === false ? 0 : 1 }); emit(null, 'goals', {}); return true; });
  h('goals:reflect', async (p) => { const cid = p.chatId || k.store.listChats().find((c) => c.kind !== 'goal')?.id; if (!cid) return []; k.store.updateChat(cid, { reflected: 0 }); return goals.reflect(cid); });
  h('goals:run', (p) => goals.workOnce(p.id, true));
  h('goals:usage', () => goals.usage());
  h('workspace:tree', () => ws.tree(root()));
  h('workspace:repos', () => ws.discoverRepos(root()));
  h('workspace:choose', async () => { const r = await dialog.showOpenDialog(k.win(), { properties: ['openDirectory', 'createDirectory'] }); if (r.canceled || !r.filePaths[0]) return null; settings.set({ workspace: { folder: r.filePaths[0] } }); return r.filePaths[0]; });
  h('workspace:open', () => eshell.openPath(root()));
  h('files:pickImages', async () => { const r = await dialog.showOpenDialog(k.win(), { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] }); if (r.canceled) return []; return r.filePaths.map((f) => { const ext = path.extname(f).slice(1).toLowerCase(); const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`; return { name: path.basename(f), dataUrl: `data:${mime};base64,${fs.readFileSync(f).toString('base64')}` }; }); });
  h('files:pickFolder', async () => { const r = await dialog.showOpenDialog(k.win(), { properties: ['openDirectory'] }); return r.canceled ? null : r.filePaths[0]; });
  h('files:pickFile', async (p) => { const r = await dialog.showOpenDialog(k.win(), { properties: ['openFile'], filters: p.filters || [] }); return r.canceled ? null : r.filePaths[0]; });
  h('pets:list', () => {
    const os = require('os'); const out = []; const seen = new Set();
    const scan = (dir, profile) => { if (!fs.existsSync(dir)) return; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (!e.isDirectory()) continue; const p = path.join(dir, e.name); const jp = path.join(p, 'pet.json'); if (!fs.existsSync(jp) || seen.has(p)) continue; seen.add(p); let j = {}; try { j = JSON.parse(fs.readFileSync(jp, 'utf8')); } catch {} out.push({ path: p, slug: e.name, name: j.displayName || e.name, description: j.description || '', profile }); } };
    const home = path.join(os.homedir(), '.hermes'); scan(path.join(home, 'pets'), 'default');
    const prof = path.join(home, 'profiles'); if (fs.existsSync(prof)) for (const d of fs.readdirSync(prof)) scan(path.join(prof, d, 'pets'), d);
    return out;
  });
  h('imagegen:test', (p) => imagegen.test({ ...settings.get().imagegen, ...p }));
  h('mobile:state', () => companion.state());
  h('mobile:start', async () => { await settings.set({ mobile: { enabled: true } }); try { return { ok: true, state: await companion.start() }; } catch (e) { return { ok: false, error: e.message, state: companion.state() }; } });
  h('mobile:stop', async () => { await settings.set({ mobile: { enabled: false } }); return { ok: true, state: companion.stop() }; });
  h('mobile:tailnet', async () => { try { return { ok: true, ...(await companion.tailnet()) }; } catch (e) { return { ok: false, error: e.message }; } });
  h('mobile:newCode', () => { companion.newPairingCode(); return companion.state(); });
  h('mobile:revoke', (p) => { companion.revoke(p.id); return companion.state(); });
  h('mobile:renewCert', async () => { try { const st = await companion.tailnet(); const c = await companion.ensureCert(st.host, { force: true }); if (companion.server) { companion.stop(); await companion.start(); } return { ok: true, cert: c }; } catch (e) { return { ok: false, error: e.message }; } });
  h('app:notifyTest', () => notifier.notify('test', 'Lyra', 'Notifications are working.'));
  h('app:notifyStatus', () => { const { Notification } = require('electron'); return { supported: Notification.isSupported(), blocked: notifier.state.blocked, lastError: notifier.state.lastError }; });
  h('app:openNotificationSettings', () => eshell.openExternal('x-apple.systempreferences:com.apple.Notifications-Settings.extension'));
  h('app:openExternal', (p) => eshell.openExternal(p.url));
  h('tools:list', () => { const s = settings.get(); const all = tools.enabledTools(s, k.extensions.tools()); return tools.TOOLS.map((t) => ({ name: t.name, key: t.key, description: t.description, enabled: all.includes(t) })).concat(k.extensions.tools().map((t) => ({ name: t.name, key: 'ext', extension: t.extension, description: t.description, enabled: all.includes(t) }))); });

  return {
    agent, browser, voice, goals, approvals, notifier, tools, llm, runShell, companion,
    dispose() {
      clearTimeout(warmTimer); clearTimeout(mobileTimer);
      try { companion.stop(); } catch {}
      settings.off('change', onSettings);
      try { goals.stop(); } catch {}
      try { agent.stopAll(); } catch {}
      try { approvals.cancelAll(); } catch {}
      try { shellInst.kill(); } catch {}
      try { voice.stop(); } catch {}
      try { browser.destroy(); } catch {}
    },
  };
}
module.exports = { create };
