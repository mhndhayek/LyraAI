// Story 07: Lyra on the desktop. When the main window is hidden, minimised or
// closed (and Settings › Appearance › Desktop companion is on), she stays on the
// desktop as a full-body 3D character in a small transparent, always-on-top
// window, with a mini chat in the app's theme. She can walk along the bottom of
// the screen when "Let Lyra walk around" is on.
//
// This lives in the kernel, not in the organs, because it owns a window and the
// tray, like the main window does. The pure helpers at the top (layout, routing,
// visibility) are exported for the tests; everything that needs Electron is in
// the Companion class and only runs inside the app.
const path = require('path');
const walk = require('./companion-walk');

const SIZE = { width: 260, height: 420 }; // her stage
const BUBBLE_W = 330;                     // the mini chat card plus its gap

// Where the window goes for a character standing at pos (top-left of her stage).
// With the chat open the window grows sideways, towards whichever side of the
// screen has room, so she herself never moves.
function layout(pos, open, work) {
  if (!open) return { x: Math.round(pos.x), y: Math.round(pos.y), width: SIZE.width, height: SIZE.height, side: null };
  const roomRight = work.x + work.width - (pos.x + SIZE.width);
  const side = roomRight >= BUBBLE_W ? 'right' : 'left';
  return { x: Math.round(side === 'left' ? pos.x - BUBBLE_W : pos.x), y: Math.round(pos.y), width: SIZE.width + BUBBLE_W, height: SIZE.height, side };
}

// Should she be on the desktop right now?
function shouldShow({ enabled, mainVisible, dismissed, safeMode, quitting }) {
  return !!enabled && !mainVisible && !dismissed && !safeMode && !quitting;
}

// Audio goes to exactly one window, or a reply would play twice: the one that
// was in front when the reply started. The other window still gets the final
// 'tts' event so its message gets the play pill, marked streamed so it does not
// play it as well.
const SPEECH = new Set(['tts:chunk', 'tts']);
function routeEvent(e, target, owner) {
  if (!SPEECH.has(e.type)) return e;
  if (owner === target) return e;
  if (e.type === 'tts') return { ...e, streamed: true };
  return null;
}

class Companion {
  constructor(k, electron) {
    this.k = k; this.e = electron;
    this.win = null; this.tray = null;
    this.dismissed = false; this.chatOpen = false; this.side = null;
    this.hover = false; this.dragging = null; this.agentState = 'idle';
    this.walker = null; this.walkTimer = null; this.lastTick = 0;
    this.speechOwner = new Map(); // reply id -> 'main' | 'companion'
    this.unhook = k.onEvent((e) => this.onEvent(e));
    this.registerIpc();
    k.settings.on('change', (data, before, patch) => this.onSettings(data, before, patch));
  }

  settings() { return this.k.settings.get().appearance; }
  enabled() { const a = this.settings(); return a.desktopCompanion !== false && a.liveCharacter !== false; }
  mainVisible() { const w = this.k.win(); return !!(w && w.isVisible() && !w.isMinimized()); }
  visible() { return !!(this.win && !this.win.isDestroyed() && this.win.isVisible()); }
  work() {
    const { screen } = this.e; const p = this.pos || { x: 0, y: 0 };
    return screen.getDisplayNearestPoint({ x: Math.round(p.x + SIZE.width / 2), y: Math.round(p.y + SIZE.height / 2) }).workArea;
  }

  /* ---------- the main window's lifecycle ---------- */
  attachMain(win) {
    const sync = () => setTimeout(() => this.sync(), 0);
    for (const ev of ['hide', 'show', 'minimize', 'restore']) win.on(ev, sync);
    // Closing the window with the companion on keeps Lyra running on the desktop
    // and in the tray; Quit (or turning the companion off) really closes it.
    win.on('close', (ev) => {
      if (this.k.quitting || !this.enabled() || this.k.safeMode) return;
      ev.preventDefault(); win.hide();
    });
    // The UI organ was reloaded (an agent change, a rollback): reload her too.
    // On the first load, build her window hidden a little later, so her model and
    // clips are loaded before she is needed and she never appears mid-load in a
    // T-pose. A hidden window draws no frames, so waiting costs nothing.
    win.webContents.on('did-finish-load', () => {
      if (this.win && !this.win.isDestroyed()) this.win.webContents.reload();
      else if (!this.preload) this.preload = setTimeout(() => { if (this.enabled() && !this.k.quitting && !this.k.safeMode && (!this.win || this.win.isDestroyed())) this.create(); }, 3000);
    });
    this.syncTray();
  }
  showMain() {
    const w = this.k.win(); if (!w) return;
    if (w.isMinimized()) w.restore();
    w.show(); w.focus();
  }

  sync() {
    const want = shouldShow({ enabled: this.enabled(), mainVisible: this.mainVisible(), dismissed: this.dismissed, safeMode: this.k.safeMode, quitting: this.k.quitting });
    if (this.mainVisible()) this.dismissed = false; // she comes back next time the window goes away
    if (want) this.show(); else this.hide();
  }

  /* ---------- her window ---------- */
  create() {
    const { BrowserWindow } = this.e;
    const a = this.settings();
    this.pos = this.pos || null;
    const w0 = this.e.screen.getPrimaryDisplay().workArea;
    const st = walk.start(this.pos || a.companionPos, w0, SIZE);
    this.pos = { x: st.x, y: st.y };
    const b = layout(this.pos, false, this.work());
    const win = new BrowserWindow({
      ...b, show: false, transparent: true, frame: false, hasShadow: false, backgroundColor: '#00000000',
      alwaysOnTop: true, skipTaskbar: true, resizable: false, focusable: true, fullscreenable: false, maximizable: false, minimizable: false,
      title: 'Lyra on the desktop', roundedCorners: false,
      webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, spellcheck: false },
    });
    win.setAlwaysOnTop(true, 'floating');
    try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true }); } catch {}
    // Click-through except over her body or the chat: the page flips this off
    // while the cursor is on something of hers (alpha hit test on the canvas).
    win.setIgnoreMouseEvents(true, { forward: true });
    win.webContents.setWindowOpenHandler(({ url }) => { this.e.shell.openExternal(url); return { action: 'deny' }; });
    win.webContents.on('will-navigate', (ev) => ev.preventDefault());
    win.webContents.on('console-message', (ev, level, msg, line, src) => {
      const where = `companion ${(src || '').split('/').pop()}:${line}`;
      if (level >= 3) this.k.logs.error('ui', msg, where); else if (level === 2) this.k.logs.warn('ui', msg, where);
      if (this.k.verbose) console.log(`[companion${level >= 3 ? ' ERROR' : ''}] ${msg} (${where})`);
    });
    win.webContents.on('render-process-gone', (_, d) => { this.k.log(`companion window process gone (${d.reason})`); this.destroy(); setTimeout(() => this.sync(), 1000); });
    win.on('closed', () => { if (this.win === win) this.win = null; this.stopWalk(); });
    win.loadFile(path.join(this.k.paths.organsRenderer, 'companion.html'));
    this.win = win;
    return win;
  }
  show() {
    if (!this.win || this.win.isDestroyed()) this.create();
    if (this.win.isVisible()) return;
    this.chatOpen = false; this.applyBounds();
    const w = this.win;
    const go = () => { if (w.isDestroyed()) return; w.showInactive(); this.send({ type: 'companion', visible: true, chatOpen: false }); this.syncWalk(); this.k.log('desktop companion shown'); };
    if (w.webContents.isLoading()) w.webContents.once('did-finish-load', go); else go();
  }
  hide() {
    this.stopWalk();
    if (!this.visible()) return;
    this.chatOpen = false; this.savePos();
    this.send({ type: 'companion', visible: false, chatOpen: false });
    this.win.hide(); this.k.log('desktop companion hidden');
  }
  destroy() { clearTimeout(this.preload); this.stopWalk(); if (this.win && !this.win.isDestroyed()) this.win.destroy(); this.win = null; }
  send(e) { if (this.win && !this.win.isDestroyed()) this.win.webContents.send('lyra:event', e); }
  applyBounds() {
    if (!this.win || this.win.isDestroyed()) return;
    const b = layout(this.pos, this.chatOpen, this.work()); this.side = b.side;
    this.win.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
  }
  savePos() {
    if (!this.pos) return; const p = { x: Math.round(this.pos.x), y: Math.round(this.pos.y) };
    const old = this.settings().companionPos;
    if (!old || old.x !== p.x || old.y !== p.y) this.k.settings.set({ appearance: { companionPos: p } });
  }
  openChat(open) {
    if (open && !this.visible()) { this.dismissed = false; const w = this.k.win(); if (w && this.mainVisible()) w.hide(); this.show(); }
    if (!this.win || this.win.isDestroyed()) return;
    this.chatOpen = !!open; this.applyBounds();
    if (open) this.win.focus();
    this.send({ type: 'companion', visible: this.visible(), chatOpen: this.chatOpen, side: this.side });
    this.syncWalk();
  }

  /* ---------- walking ---------- */
  blocked() { return this.chatOpen || !!this.dragging || this.hover || ['speaking', 'thinking', 'writing'].includes(this.agentState); }
  syncWalk() {
    const on = this.settings().walk && this.visible();
    if (!on) { this.stopWalk(); return; }
    if (!this.walker) { this.walker = { ...walk.start(this.pos, this.work(), SIZE), mode: 'idle' }; this.walker.x = this.pos.x; this.walker.y = this.pos.y; this.lastTick = Date.now(); this.tick(); }
  }
  stopWalk() {
    if (this.walkTimer) clearTimeout(this.walkTimer); this.walkTimer = null;
    if (this.walker && this.walker.mode === 'walking') this.send({ type: 'companion:walk', walking: false });
    this.walker = null;
  }
  tick() {
    if (!this.walker || !this.visible()) return;
    const now = Date.now(); const dt = Math.min(0.25, (now - this.lastTick) / 1000); this.lastTick = now;
    const was = this.walker.mode;
    const r = walk.step(this.walker, dt, { work: this.work(), size: SIZE, blocked: this.blocked() });
    this.walker = r.state;
    for (const ev of r.events) {
      if (ev.type === 'started') this.send({ type: 'companion:walk', walking: true, dir: this.walker.dir });
      else if (ev.type === 'turned') this.send({ type: 'companion:walk', walking: true, dir: ev.dir });
      else if (ev.type === 'stopped') { this.send({ type: 'companion:walk', walking: false }); this.savePos(); }
      else if (ev.type === 'gesture') this.send({ type: 'companion:gesture', name: ev.name });
    }
    if (this.walker.mode === 'walking' || was === 'walking') {
      this.pos = { x: this.walker.x, y: this.walker.y };
      if (!this.chatOpen) this.win.setPosition(Math.round(this.pos.x), Math.round(this.pos.y));
    }
    // 30 fps while she walks, a few checks a second while she stands about.
    this.walkTimer = setTimeout(() => this.tick(), this.walker.mode === 'walking' ? 33 : 250);
  }

  /* ---------- events and settings ---------- */
  onEvent(e) {
    if (e.type === 'state') { this.agentState = e.state; }
    if (e.type === 'assistant:start' && e.message) this.speechOwner.set(e.message.id, this.visible() ? 'companion' : 'main');
    if (e.type === 'assistant:done' && this.speechOwner.size > 50) this.speechOwner.delete(this.speechOwner.keys().next().value);
    if (!this.win || this.win.isDestroyed()) return;
    const routed = routeEvent(e, 'companion', this.ownerOf(e));
    if (routed) this.send(routed);
  }
  ownerOf(e) { return this.speechOwner.get(e.id) || (this.visible() ? 'companion' : 'main'); }
  // What the main window gets (called from k.emit).
  forMain(e) { return routeEvent(e, 'main', this.ownerOf(e)); }
  onSettings(data, before, patch) {
    const a = patch && patch.appearance; if (!a) return;
    if ('desktopCompanion' in a || 'liveCharacter' in a) { if (!this.enabled()) this.destroy(); this.sync(); this.syncTray(); }
    if ('walk' in a) { this.syncWalk(); this.syncTray(); }
  }

  /* ---------- the tray / menu-bar item and her right-click menu ---------- */
  trayIcon() {
    const { nativeImage } = this.e;
    const mac = process.platform === 'darwin';
    const img = nativeImage.createFromPath(path.join(__dirname, 'tray', mac ? 'trayTemplate.png' : 'tray.png'));
    if (mac) img.setTemplateImage(true);
    return img;
  }
  menuItems(where) {
    const a = this.settings(); const name = this.k.settings.get().persona.name || 'Lyra';
    const items = [];
    if (where === 'tray') items.push({ label: `Show ${name}`, click: () => this.showMain() });
    items.push({ label: 'Open chat', click: () => this.openChat(true) });
    if (where === 'her') items.push({ label: 'Open full chat', click: () => this.showMain() });
    items.push({ type: 'separator' });
    items.push({ label: `Let ${name} walk around`, type: 'checkbox', checked: !!a.walk, click: (it) => this.k.settings.set({ appearance: { walk: it.checked } }) });
    if (where === 'tray') items.push({ label: 'Desktop companion', type: 'checkbox', checked: a.desktopCompanion !== false, click: (it) => this.k.settings.set({ appearance: { desktopCompanion: it.checked } }) });
    if (where === 'her') items.push({ label: `Hide ${name} for now`, click: () => { this.dismissed = true; this.hide(); } });
    items.push({ type: 'separator' }, { label: `Quit ${name}`, click: () => this.e.app.quit() });
    return items;
  }
  syncTray() {
    const { Tray, Menu } = this.e;
    if (!this.enabled()) { if (this.tray) { this.tray.destroy(); this.tray = null; } return; }
    try {
      if (!this.tray) { this.tray = new Tray(this.trayIcon()); this.tray.setToolTip(this.k.settings.get().persona.name || 'Lyra'); if (process.platform !== 'darwin') this.tray.on('click', () => this.showMain()); }
      this.tray.setContextMenu(Menu.buildFromTemplate(this.menuItems('tray')));
    } catch (e) { this.k.logs.warn('kernel', `No tray icon: ${e.message}`); }
  }

  /* ---------- IPC from her page ---------- */
  registerIpc() {
    const { ipcMain, Menu } = this.e;
    const mine = (ev) => this.win && !this.win.isDestroyed() && ev.sender === this.win.webContents;
    ipcMain.on('companion:ignore', (ev, over) => {
      if (!mine(ev)) return; this.hover = !!over;
      this.win.setIgnoreMouseEvents(!over, { forward: true });
    });
    ipcMain.on('companion:drag', (ev, p) => {
      if (!mine(ev) || !p) return;
      if (p.phase === 'start') { this.dragging = { sx: p.screenX, sy: p.screenY, px: this.pos.x, py: this.pos.y }; if (this.walker) this.walker.mode = 'idle'; return; }
      if (!this.dragging) return;
      const work = this.work();
      let x = this.dragging.px + (p.screenX - this.dragging.sx), y = this.dragging.py + (p.screenY - this.dragging.sy);
      x = Math.min(work.x + work.width - SIZE.width, Math.max(work.x, x)); y = Math.min(work.y + work.height - SIZE.height, Math.max(work.y, y));
      this.pos = { x, y }; if (this.walker) { this.walker.x = x; this.walker.y = y; }
      const b = layout(this.pos, this.chatOpen, work);
      this.win.setPosition(b.x, b.y);
      if (p.phase === 'end') { this.dragging = null; this.savePos(); if (this.chatOpen) this.applyBounds(); }
    });
    const h = (ch, fn) => ipcMain.handle(ch, (ev, p) => (mine(ev) ? fn(p || {}) : null));
    h('companion:chat', () => this.currentChat());
    h('companion:open', (p) => { this.openChat(!!p.open); return { chatOpen: this.chatOpen, side: this.side }; });
    h('companion:openMain', () => { this.showMain(); return true; });
    h('companion:menu', () => { Menu.buildFromTemplate(this.menuItems('her')).popup({ window: this.win }); return true; });
    h('companion:state', () => ({ visible: this.visible(), chatOpen: this.chatOpen, side: this.side, walk: !!this.settings().walk, walking: !!(this.walker && this.walker.mode === 'walking') }));
  }
  // The chat the main window has open, so both windows talk in the same chat.
  async currentChat() {
    const w = this.k.win(); let id = null;
    try { if (w) id = await w.webContents.executeJavaScript('window.LyraApp && window.LyraApp.chatId ? window.LyraApp.chatId() : null', true); } catch {}
    const store = this.k.store;
    if (id && store.getChat(id)) return id;
    const first = store.listChats().find((c) => c.kind !== 'goal');
    if (first) return first.id;
    const c = store.createChat(); this.k.emit(null, 'chats', {}); return c.id;
  }
}

module.exports = { Companion, layout, shouldShow, routeEvent, SIZE, BUBBLE_W };
