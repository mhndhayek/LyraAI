// Story 07 smoke (QA 2-4), run inside the real app with --companion-test:
//   2. hiding the main window puts Lyra on the desktop: her window exists, is
//      transparent and always on top, and her canvas has drawn her (pixels with
//      alpha); showing the main window again takes her off the desktop.
//   3. a message typed into the mini chat lands in the chat the main window has open.
//   4. switching the theme to light gives the mini chat the main window's --bg.
// Prints one JSON line; scripts/smoke-companion.js reads it.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, step = 250) { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch {} await wait(step); } return v; }

async function run(k) {
  const checks = []; const ok = (name, pass, detail) => { checks.push({ name, pass: !!pass, detail }); };
  const main = k.win(); const c = k.companion;
  if (!main || !c) return { pass: false, checks: [{ name: 'app up', pass: false, detail: 'no main window or companion' }] };
  await until(() => main.webContents.executeJavaScript('!!(window.LyraApp && window.LyraApp.chatId())'), 15000);
  const chatId = await main.webContents.executeJavaScript('window.LyraApp.chatId()');

  // 2. Hide the main window: she appears.
  main.hide();
  const shown = await until(() => c.visible(), 10000);
  ok('hiding the main window shows the companion', shown);
  const w = c.win;
  ok('the companion window is always on top', w && w.isAlwaysOnTop());
  // Transparent for real: the window's own pixels at a corner (no body there) have alpha 0.
  let cornerAlpha;
  try { const img = await w.webContents.capturePage({ x: 0, y: 0, width: 8, height: 8 }); const bmp = img.toBitmap(); cornerAlpha = bmp.length ? bmp[3] : null; } catch (e) { cornerAlpha = e.message; }
  ok('the companion window is transparent', cornerAlpha === 0, { cornerAlpha });
  const b = w ? w.getBounds() : null;
  ok('the companion window is her size (260×420)', b && b.width === 260 && b.height === 420, b);
  // Her canvas has drawn her: count pixels with alpha in a downscaled copy. A
  // machine with no WebGL at all (Linux CI under xvfb) cannot draw her; that is
  // reported as a skip, the way the main smoke tolerates it, not as a pass.
  const noGl = await until(() => w.webContents.executeJavaScript("document.querySelector('#c-stage canvas') ? 'gl' : (document.querySelector('#c-stage').dataset.vrmError || '')"), 45000, 500);
  const skipped = [];
  if (noGl && noGl !== 'gl') skipped.push(`her canvas checks: no WebGL on this machine (${noGl})`);
  const px = skipped.length ? null : await until(() => w.webContents.executeJavaScript(`(() => {
    const cv = document.querySelector('#c-stage canvas'); if (!cv) return 0;
    const t = document.createElement('canvas'); t.width = 65; t.height = 105; const x = t.getContext('2d');
    x.drawImage(cv, 0, 0, t.width, t.height); const d = x.getImageData(0, 0, t.width, t.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++; return n; })()`), 45000, 500);
  if (!skipped.length) {
  ok('her canvas renders a frame (non-empty pixels)', px > 150, { opaquePixels: px, of: 65 * 105 });
  const corner = await w.webContents.executeJavaScript(`(() => { const cv = document.querySelector('#c-stage canvas'); if (!cv) return null; const t = document.createElement('canvas'); t.width = t.height = 4; const x = t.getContext('2d'); x.drawImage(cv, 0, 0, 4, 4, 0, 0, 4, 4); return x.getImageData(0, 0, 1, 1).data[3]; })()`).catch(() => null);
  ok('her canvas is see-through around her', corner === 0, { cornerAlpha: corner });
  }

  // 3. The mini chat talks in the main window's chat.
  const open = await w.webContents.executeJavaScript(`(async () => { document.querySelector('#c-stage'); await lyra.companion.open({ open: true }); return lyra.companion.state(); })()`);
  ok('clicking her opens the mini chat (window widens for the card)', open && open.chatOpen && c.win.getBounds().width > 260, { state: open, bounds: c.win.getBounds() });
  const text = `companion smoke ${Date.now()}`;
  await w.webContents.executeJavaScript(`(async () => { const id = await lyra.companion.chat(); document.querySelector('#c-input').value = ${JSON.stringify(text)}; document.querySelector('#c-send').click(); return id; })()`);
  const landed = await until(() => k.store.listMessages(chatId).some((m) => m.role === 'user' && m.content && m.content.text === text), 8000);
  ok('a mini chat message lands in the main window\'s current chat', landed, { chatId });

  // 4. Theme: switch to light, compare --bg in both windows.
  const before = k.settings.get().appearance.theme;
  k.settings.set({ appearance: { theme: 'lyra-light' } });
  const cssVar = "getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()";
  const same = await until(async () => { const a = await main.webContents.executeJavaScript(cssVar); const m = await w.webContents.executeJavaScript(cssVar); return a && a === m && a === '#ffffff' ? { main: a, companion: m } : null; }, 8000);
  ok('light theme: the mini chat --bg matches the main window', !!same, same || { main: await main.webContents.executeJavaScript(cssVar), companion: await w.webContents.executeJavaScript(cssVar) });
  const cardBg = await w.webContents.executeJavaScript("getComputedStyle(document.querySelector('#c-card')).backgroundColor");
  ok('the chat card is painted in the theme panel colour', /241, 241, 238/.test(cardBg), cardBg);
  k.settings.set({ appearance: { theme: before } });

  // Walk: turning it on starts the walker, and an open chat keeps her still.
  k.settings.set({ appearance: { walk: true } });
  await wait(400);
  ok('walking on: the walker runs and the open chat holds her still', !!c.walker && c.blocked(), { mode: c.walker && c.walker.mode });
  k.settings.set({ appearance: { walk: false } });
  await wait(100);
  ok('walking off stops the walker', !c.walker);

  // 2b. Show the main window: she goes off the desktop.
  main.show();
  const shownAt = Date.now();
  const gone = await until(() => !c.visible(), 5000, 100);
  ok('showing the main window hides the companion (within 1.5 s)', gone && Date.now() - shownAt < 1500, { ms: Date.now() - shownAt });

  return { pass: checks.every((x) => x.pass), checks, skipped };
}

module.exports = { run };
