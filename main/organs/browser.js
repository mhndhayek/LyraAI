// The agent's own browser: a WebContentsView docked inside the app window
// (visible mode) or a hidden window (headless mode). The agent drives it through
// a handful of primitives; the user can take over at any time.
const { BrowserWindow, WebContentsView, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { hostOf } = require('./util');

const PARTITION = 'persist:agent-browser';
const COLLECT = `(() => {
  const sel = 'a[href], button, input, textarea, select, [role="button"], [role="link"], [role="tab"], [onclick], summary';
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const els = [...document.querySelectorAll(sel)].filter(vis).slice(0, 90);
  window.__lyra = els;
  return els.map((e, i) => ({ i, tag: e.tagName.toLowerCase(), type: e.type || '', text: (e.innerText || e.value || e.getAttribute('aria-label') || e.placeholder || e.alt || e.title || '').replace(/\\s+/g, ' ').trim().slice(0, 80), href: e.href || '' }));
})()`;

class AgentBrowser {
  constructor({ getWindow, settings, emit, approvals, downloadsDir }) {
    Object.assign(this, { getWindow, settings, emit, approvals, downloadsDir });
    this.view = null; this.headlessWin = null; this.bounds = null; this.shown = false; this.takenOver = false; this.stopped = false;
    this.status = { url: '', title: '', busy: false, step: '', mode: settings.get().browser.mode };
    this.chatId = null; this.sessionWired = false;
  }
  cfg() { return this.settings.get().browser; }
  wireSession() {
    if (this.sessionWired) return; this.sessionWired = true;
    const s = session.fromPartition(PARTITION);
    s.on('will-download', async (e, item) => {
      const name = item.getFilename();
      const dest = path.join(this.downloadsDir, name);
      if (this.cfg().askBeforeDownloads) {
        item.pause();
        const r = await this.approvals.request({ chatId: this.chatId, tool: 'browser_download', summary: `Download ${name}`, detail: `${item.getURL()}\n→ ${dest}`, risk: 'high', reason: 'A file download was started in the browser.' });
        if (r.decision !== 'approved') { item.cancel(); this.push({ step: `Download of ${name} denied` }); return; }
        item.setSavePath(dest); item.resume();
      } else item.setSavePath(dest);
      item.once('done', (_, state) => { this.push({ step: state === 'completed' ? `Downloaded ${name}` : `Download ${state}` }); this.emit(this.chatId, 'activity', { icon: 'download', text: `Downloaded ${name}`, detail: dest }); });
    });
  }
  wire(wc) {
    wc.setWindowOpenHandler(({ url }) => { wc.loadURL(url); return { action: 'deny' }; });
    wc.on('did-navigate', (_, url) => this.push({ url }));
    wc.on('did-navigate-in-page', (_, url) => this.push({ url }));
    wc.on('page-title-updated', (_, title) => this.push({ title }));
    wc.on('did-start-loading', () => this.push({ busy: true }));
    wc.on('did-stop-loading', () => this.push({ busy: false, url: wc.getURL(), title: wc.getTitle() }));
  }
  visibleView() {
    if (this.view) return this.view;
    this.wireSession();
    this.view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, partition: PARTITION } });
    this.view.setBackgroundColor('#ffffff');
    const win = this.getWindow(); win.contentView.addChildView(this.view);
    this.view.setVisible(false);
    this.wire(this.view.webContents);
    this.view.webContents.loadURL(this.cfg().startPage || 'about:blank').catch(() => {});
    return this.view;
  }
  headless() {
    if (this.headlessWin) return this.headlessWin;
    this.wireSession();
    this.headlessWin = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { sandbox: true, contextIsolation: true, partition: PARTITION } });
    this.wire(this.headlessWin.webContents);
    this.headlessWin.on('closed', () => { this.headlessWin = null; });
    return this.headlessWin;
  }
  mode() { return this.cfg().mode === 'headless' ? 'headless' : 'visible'; }
  contents(forceHeadless = false) { return (forceHeadless || this.mode() === 'headless') ? this.headless().webContents : this.visibleView().webContents; }
  push(patch) { this.status = { ...this.status, ...patch, mode: this.mode(), shown: this.shown, takenOver: this.takenOver }; this.emit(null, 'browser', this.status); }

  setBounds(b) { this.bounds = b; if (this.view && this.shown) this.view.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) }); }
  show(on) {
    this.shown = !!on; const v = this.visibleView();
    v.setVisible(this.shown); if (this.shown && this.bounds) this.setBounds(this.bounds);
    this.push({});
  }
  takeOver(on) { this.takenOver = !!on; this.push({ step: on ? 'You have the browser' : 'Lyra has the browser' }); }
  stop() { this.stopped = true; try { this.contents().stop(); } catch {} this.push({ busy: false, step: 'Stopped by you' }); }
  beginTurn(chatId) { this.chatId = chatId; this.stopped = false; }
  guard() {
    if (!this.cfg().enabled) throw new Error('The browser is turned off in Settings › Browser.');
    if (this.stopped) throw new Error('The browser was stopped by the user for this turn.');
    if (this.takenOver) throw new Error('The user has taken over the browser. Ask them to hand it back.');
  }
  settle(wc, ms = 10000) {
    return new Promise((resolve) => {
      if (!wc.isLoading()) return setTimeout(resolve, 250);
      const done = () => { clearTimeout(t); setTimeout(resolve, 350); };
      const t = setTimeout(() => { wc.removeListener('did-stop-loading', done); resolve(); }, ms);
      wc.once('did-stop-loading', done);
    });
  }
  async open(url) {
    this.guard();
    if (!/^https?:\/\//i.test(url) && !/^about:/.test(url)) url = 'https://' + url;
    const wc = this.contents();
    if (this.mode() === 'visible' && this.cfg().autoOpen && !this.shown) { this.show(true); this.emit(null, 'browser:show', {}); }
    this.push({ step: `Opening ${hostOf(url)}`, busy: true });
    try { await wc.loadURL(url); } catch (e) { if (!/ERR_ABORTED/.test(String(e))) throw new Error(`Could not open ${url}: ${e.message}`); }
    await this.settle(wc);
    return this.read(3000);
  }
  async read(maxChars = 12000) {
    this.guard();
    const wc = this.contents();
    const info = await wc.executeJavaScript(`({ title: document.title, url: location.href, text: (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n') })`, true);
    const els = await wc.executeJavaScript(COLLECT, true);
    this.push({ step: `Reading ${info.title || hostOf(info.url)}`, url: info.url, title: info.title });
    const text = info.text.length > maxChars ? info.text.slice(0, maxChars) + `\n…[${info.text.length - maxChars} more chars; scroll or ask for a section]` : info.text;
    const list = els.map((e) => `[${e.i}] ${e.tag}${e.type ? ':' + e.type : ''} "${e.text}"${e.href && e.tag === 'a' ? ' → ' + e.href.slice(0, 100) : ''}`).join('\n');
    return `Page: ${info.title}\nURL: ${info.url}\n\n${text}\n\nInteractive elements (use the [index] with browser_click / browser_type):\n${list}`;
  }
  async resolveTarget(wc, target) {
    if (typeof target === 'number' || /^\d+$/.test(String(target))) return Number(target);
    const els = await wc.executeJavaScript(COLLECT, true);
    const q = String(target).toLowerCase();
    const hit = els.find((e) => e.text.toLowerCase() === q) || els.find((e) => e.text.toLowerCase().includes(q));
    if (!hit) throw new Error(`No element matching "${target}"`);
    return hit.i;
  }
  async click(target) {
    this.guard(); const wc = this.contents();
    const i = await this.resolveTarget(wc, target);
    const r = await wc.executeJavaScript(`(() => { const e = window.__lyra && window.__lyra[${i}]; if (!e) return 'stale element list, call browser_read first'; e.scrollIntoView({ block: 'center' }); e.click(); return 'clicked ' + (e.innerText || e.value || e.getAttribute('aria-label') || '').trim().slice(0, 60); })()`, true);
    this.push({ step: r }); await this.settle(wc, 6000);
    return `${r}\n\n${await this.read(2500)}`;
  }
  async type(target, text, submit = false) {
    this.guard(); const wc = this.contents();
    const i = await this.resolveTarget(wc, target);
    const r = await wc.executeJavaScript(`(() => { const e = window.__lyra && window.__lyra[${i}]; if (!e) return 'stale'; e.scrollIntoView({ block: 'center' }); e.focus(); if ('value' in e) { e.value = ${JSON.stringify(String(text))}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); } else e.textContent = ${JSON.stringify(String(text))}; return e.form ? 'form' : 'nofor'; })()`, true);
    if (r === 'stale') return 'Stale element list, call browser_read first';
    this.push({ step: `Typed into [${i}]` });
    if (submit) {
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' }); wc.sendInputEvent({ type: 'char', keyCode: '\r' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
      await this.settle(wc, 8000);
    }
    return `Typed "${String(text).slice(0, 60)}"${submit ? ' and pressed Enter' : ''}.\n\n${await this.read(2500)}`;
  }
  async scroll(direction = 'down') {
    this.guard(); const wc = this.contents();
    await wc.executeJavaScript(`window.scrollBy(0, ${direction === 'up' ? -1 : 1} * window.innerHeight * 0.85)`, true);
    await new Promise((r) => setTimeout(r, 300));
    return this.read(6000);
  }
  async screenshot(dir) {
    this.guard(); const wc = this.contents();
    const img = await wc.capturePage();
    const file = path.join(dir, `browser-${Date.now()}.png`);
    fs.writeFileSync(file, img.toPNG());
    return file;
  }
  async search(query) {
    // Always headless: search results are read, never shown.
    if (!this.cfg().enabled) throw new Error('The browser is turned off in Settings › Browser.');
    const wc = this.contents(true);
    this.push({ step: `Searching “${query}”` });
    try { await wc.loadURL(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`); } catch (e) { if (!/ERR_ABORTED/.test(String(e))) throw e; }
    await this.settle(wc);
    const results = await wc.executeJavaScript(`[...document.querySelectorAll('.result')].slice(0, 8).map(r => { const a = r.querySelector('.result__a'); let href = a ? a.href : ''; try { const u = new URL(href); const dd = u.searchParams.get('uddg'); if (dd) href = dd; } catch {} return { title: a ? a.innerText.trim() : '', url: href, snippet: (r.querySelector('.result__snippet') || {}).innerText || '' }; })`, true);
    if (!results.length) return 'No results (the search page may have blocked the request).';
    return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet.trim()}`).join('\n');
  }
  userNavigate(url) { if (!/^https?:\/\//i.test(url) && !/^about:/.test(url)) url = 'https://' + url; this.visibleView().webContents.loadURL(url).catch(() => {}); }
  back() { const wc = this.visibleView().webContents; if (wc.navigationHistory?.canGoBack?.() ?? wc.canGoBack()) (wc.navigationHistory?.goBack ? wc.navigationHistory.goBack() : wc.goBack()); }
  reload() { this.visibleView().webContents.reload(); }
  clearData() { return session.fromPartition(PARTITION).clearStorageData(); }
  destroy() {
    try { this.headlessWin && this.headlessWin.destroy(); } catch {}
    try { if (this.view) { const w = this.getWindow(); if (w && !w.isDestroyed()) w.contentView.removeChildView(this.view); this.view.webContents.close(); } } catch {}
    this.view = null; this.shown = false;
  }
}
module.exports = { AgentBrowser };
