// "Help me choose": the newcomer's way onto a local model. Four short screens
// inside the setup guide's Model step: look at this computer, two questions,
// one recommendation, and a plain table of exactly what would be downloaded,
// from where, how big and where it goes. Nothing downloads before "Download
// and start", and the engine only ever runs while Lyra is open.
(() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  const ui = () => window.Settings.ui;
  const toast = (t, k) => window.LyraApp.toast(t, k);
  const fmtBytes = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
  const LOCAL_ID = 'local-llamacpp';

  let st = null; let rerender = () => {}; let onExit = () => {};

  const GOALS = [['chat', 'Chat and companion', 'Talking, ideas, keeping me company.'], ['coding', 'Coding and tools', 'Files, commands, scripts and the browser.'], ['both', 'Both', 'A bit of everything.']];
  const SPEEDS = [['snappy', 'Snappy', 'Fast replies from a smaller model.'], ['balanced', 'Balanced', 'Good answers at a comfortable speed.'], ['smartest', 'Smartest that fits', 'The biggest model this computer runs well.']];

  // The folder every row goes under (Lyra's data folder), shown once.
  function commonRoot(paths) {
    const parts = paths.map((p) => p.split(/([\\/])/)); const first = parts[0]; let n = 0;
    while (n < first.length && parts.every((p) => p[n] === first[n])) n++;
    return first.slice(0, n).join('').replace(/[\\/]$/, '');
  }
  function exit(why) { st = null; onExit(why); }
  async function look() {
    try { const r = await lyra.engine.hardware(); if (!st) return; st.hw = r.hw; st.running = r.running; }
    catch (e) { if (st) st.error = e.message; }
    rerender();
  }
  async function recommend() { st.rec = await lyra.engine.recommend({ hw: st.hw, answers: st.answers }); st.chosen = st.rec.pick; }

  function hwCard() {
    const h = st.hw; const g = h.gpu || {};
    const gpu = g.name ? `${g.name}${g.cores ? ` · ${g.cores} GPU cores` : ''}${g.unified ? ' · shares memory with the CPU' : ''}${g.vramGB ? ` · ${g.vramGB} GB VRAM` : ''}` : 'none found';
    const rows = [['System', `${{ darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[h.os] || h.os} · ${h.arch}`], ['Processor', `${h.cpu || 'unknown'}${h.cores ? ` · ${h.cores} cores` : ''}`], ['Memory', `${h.memGB} GB`], ['Graphics', gpu], ['Free disk', h.freeDiskGB == null ? 'unknown' : `${h.freeDiskGB} GB`]];
    return el(`<div class="card"><div class="kv">${rows.map(([k, v]) => `<b>${k}</b><span>${esc(v)}</span>`).join('')}</div></div>`);
  }
  const radios = (list, cur, cb) => { const box = el('<div style="display:flex;flex-direction:column;gap:8px"></div>'); list.forEach(([v, t, d]) => { const c = el(`<div class="radio-card ${cur === v ? 'on' : ''}" data-v="${v}"><div class="r"></div><div><div class="t">${esc(t)}</div><div class="d">${esc(d)}</div></div></div>`); c.addEventListener('click', () => cb(v)); box.appendChild(c); }); return box; };
  const footer = (...btns) => { const f = el('<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"></div>'); btns.filter(Boolean).forEach((b) => f.appendChild(b)); return f; };
  const skipLink = () => { const a = el('<button class="btn small" type="button" style="background:none;border:none;color:var(--muted);text-decoration:underline">Skip, I’ll choose myself</button>'); a.addEventListener('click', () => exit('skip')); return a; };

  const screens = {
    // 1 · Let me look at this computer
    look() {
      const { title, btn } = ui();
      const parts = [title('Let me look at this computer', 'To recommend a model, I read this computer’s chip, memory, graphics and free disk. This stays on your computer: nothing is sent anywhere.')];
      if (st.error) { parts.push(el(`<div class="md error">Could not read this computer: ${esc(st.error)}</div>`)); parts.push(footer(btn('Try again', () => { st.error = null; rerender(); look(); }, { ic: 'refresh' }), skipLink())); return parts; }
      if (!st.hw) { parts.push(el('<div class="status-line"><span class="dot busy"></span>Looking…</div>')); parts.push(footer(skipLink())); return parts; }
      parts.push(hwCard());
      for (const r of st.running || []) {
        const name = window.brandName(r.kind);
        const card = el(`<div class="card"><div class="status-line"><span class="dot"></span>${window.brandLogo(r.kind, 16)}<span>${esc(name)} is already running at ${esc(r.endpoint)}${r.status === 401 ? ' (it wants an API key)' : ''}.</span></div></div>`);
        card.appendChild(footer(btn('Use the one you already have', () => exit({ endpoint: r.endpoint }), { primary: true, ic: 'check' })));
        parts.push(card);
      }
      parts.push(footer(btn('Next', () => { st.screen = 'ask'; rerender(); }, { primary: !(st.running || []).length, small: false }), skipLink()));
      return parts;
    },
    // 2 · two questions
    ask() {
      const { title, btn } = ui();
      return [
        title('Two quick questions', 'So I pick the right size of model.'),
        el('<div class="group-label">What for?</div>'), radios(GOALS, st.answers.goal, (v) => { st.answers.goal = v; rerender(); }),
        el('<div class="group-label">Speed or smarts?</div>'), radios(SPEEDS, st.answers.speed, (v) => { st.answers.speed = v; rerender(); }),
        footer(btn('Back', () => { st.screen = 'look'; rerender(); }, { small: false }), btn('Show me', async (e) => { e.currentTarget.disabled = true; try { await recommend(); st.screen = 'pick'; } catch (err) { toast(err.message, 'error'); } rerender(); }, { primary: true, small: false }), skipLink()),
      ];
    },
    // 3 · Here's what I'd do
    pick() {
      const { title, btn } = ui(); const r = st.rec;
      if (r.fallback) {
        return [
          title('Here’s what I’d do', ''),
          el(`<div class="card choose-pick"><div class="t">Connect to a server or API</div><div class="d">${esc(r.why)}</div></div>`),
          footer(btn('Back', () => { st.screen = 'ask'; rerender(); }, { small: false }), btn('Connect to a server or API', () => exit('fallback'), { primary: true, small: false })),
        ];
      }
      const m = st.chosen; const g = (st.hw.gpu && st.hw.gpu.name) || 'this computer';
      const dl = m.sizeGB + (m.mmproj ? m.mmproj.sizeGB : 0);
      const card = el(`<div class="card choose-pick"><div class="t">${esc(m.label)}<span class="tag-rec">Recommended</span></div><div class="specs">${esc(m.quant)} · ${dl.toFixed(1)} GB download · ${Math.round(m.context / 1024)}k context · runs on your ${esc(g)} GPU</div><div class="d">${esc(m.id === r.pick.id ? r.why : `You picked this one instead. Tested at about ${m.tokPerSec} tokens a second${m.vision ? '; it can see pictures' : ''}.`)}</div></div>`);
      const alts = [r.pick, ...r.alternatives].filter((x) => x.id !== m.id);
      const others = el('<div style="display:flex;flex-direction:column;gap:6px"></div>');
      if (alts.length) {
        const link = el(`<button class="btn small" type="button" style="align-self:flex-start;background:none;border:none;color:var(--accent);padding:0">${st.showAlts ? 'Hide the other options' : `Other options (${alts.length})`}</button>`);
        link.addEventListener('click', () => { st.showAlts = !st.showAlts; rerender(); }); others.appendChild(link);
        if (st.showAlts) alts.forEach((a) => { const c = el(`<div class="radio-card"><div class="r"></div><div><div class="t">${esc(a.label)} · ${esc(a.quant)} · ${(a.sizeGB + (a.mmproj ? a.mmproj.sizeGB : 0)).toFixed(1)} GB</div><div class="d">About ${a.tokPerSec} tokens a second when tested${a.vision ? ' · sees pictures' : ''}</div></div></div>`); c.addEventListener('click', () => { st.chosen = a; st.showAlts = false; rerender(); }); others.appendChild(c); });
      }
      return [
        title('Here’s what I’d do', 'One model we have tested on a computer like this one.'),
        card, others,
        footer(btn('Back', () => { st.screen = 'ask'; rerender(); }, { small: false }), btn('Set it up for me', async (e) => { e.currentTarget.disabled = true; try { st.plan = await lyra.engine.plan({ id: m.id }); st.screen = 'plan'; } catch (err) { toast(err.message, 'error'); } rerender(); }, { primary: true, small: false })),
      ];
    },
    // 4 · the transparency screen
    plan() {
      const { title, btn } = ui();
      // Long URLs and paths may only break after a slash, never inside a name.
      const slashes = (s) => String(s).split('/').map((seg) => `<span class="nb">${esc(seg)}</span>`).join('/<wbr>');
      const root = st.plan.length ? commonRoot(st.plan.map((r) => r.to)) : '';
      const home = (s) => s.replace(/^\/Users\/[^/]+|^\/home\/[^/]+|^[A-Z]:\\Users\\[^\\]+/, '~');
      const rel = (to) => (root && to.startsWith(root) ? to.slice(root.length).replace(/^[\\/]/, '') + '/' : home(to));
      const total = st.plan.reduce((n, r) => n + (r.installed ? 0 : r.bytes), 0);
      const rows = st.plan.map((r) => `<tr><td>${esc(r.what).replace(/\(([^)]+)\)/, '(<span class="nb">$1</span>)')}</td><td class="mono">${slashes(r.from.replace(/^https?:\/\//, ''))}</td><td class="size">${r.installed ? 'already here' : `~${fmtBytes(r.bytes)}`}</td><td class="mono">${slashes(rel(r.to))}</td></tr>`).join('');
      return [
        title('Set it up for me', 'Before anything downloads, here is exactly what I would fetch and where it goes.'),
        el(`<div class="card"><table class="choose-table"><thead><tr><th>What</th><th>From</th><th class="size">Size</th><th>Goes to</th></tr></thead><tbody>${rows}</tbody><tfoot><tr><td>Total</td><td></td><td class="size">~${fmtBytes(total)}</td><td class="mono">${root ? `under ${slashes(home(root))}/` : ''}</td></tr></tfoot></table></div>`),
        el('<div class="d choose-promise">Each file is checked against a SHA-256 fingerprint pinned in Lyra; anything that does not match is deleted, never run. It runs only while Lyra is open, uses only <span class="mono">127.0.0.1</span> (nothing on your network can reach it), and you can remove it all from Settings › Model › Local engine.</div>'),
        footer(btn('Back', () => { st.screen = 'pick'; rerender(); }, { small: false }), btn('Download and start', () => install(), { primary: true, ic: 'download', small: false })),
      ];
    },
    install() {
      const { title, btn } = ui();
      const bars = el('<div class="card" id="choose-progress" style="gap:12px"></div>');
      st.plan.filter((r) => !r.installed).forEach((r) => bars.appendChild(el(`<div class="choose-bar" data-item="${esc(r.item)}"><div class="status-line"><span>${esc(r.what)}</span><span class="spacer"></span><span class="n">waiting · ~${fmtBytes(r.bytes)}</span></div><div class="track"><i style="width:0%"></i></div></div>`)));
      const line = el(`<div class="status-line" id="choose-phase"><span class="dot busy"></span><span>${esc(st.phaseText || 'Starting the download…')}</span></div>`);
      const pauseBtn = btn(st.paused ? 'Resume' : 'Pause', () => { if (st.paused) install(); else { lyra.engine.pause(); } }, { small: false, ic: st.paused ? 'play' : 'pause' });
      const cancelBtn = btn('Cancel', async () => { if (!confirm('Cancel and delete what has been downloaded so far?')) return; st.cancelling = true; await lyra.engine.cancel(); st.screen = 'plan'; st.paused = false; rerender(); }, { small: false });
      if (st.failed) line.innerHTML = `<span class="dot off"></span><span>${esc(st.failed)}</span>`;
      return [title('Setting it up', 'You can keep this window open or carry on; it continues in the background.'), bars, line, footer(st.failed ? btn('Try again', () => install(), { primary: true, small: false, ic: 'refresh' }) : pauseBtn, cancelBtn)];
    },
  };

  // Progress arrives as engine events from the main process; the bars are
  // updated in place so the page does not flicker.
  lyra.onEvent((e) => {
    if (e.type !== 'engine' || !st || st.screen !== 'install') return;
    if (e.phase === 'download') {
      const pct = e.total ? Math.min(100, (e.received / e.total) * 100) : 0;
      const box = [...document.querySelectorAll('#choose-progress .choose-bar')].find((b) => b.dataset.item === e.item);
      if (box) { box.querySelector('i').style.width = `${pct.toFixed(1)}%`; box.querySelector('.n').textContent = e.received >= e.total ? `${fmtBytes(e.total)} · checking…` : `${fmtBytes(e.received)} of ${fmtBytes(e.total)} · ${fmtBytes(e.speed)}/s`; }
      setPhase(`Downloading ${e.item}…`);
    } else if (e.phase === 'verify') { setPhase(`Checking the SHA-256 of ${e.item}…`); markDone(e.item, 'checking SHA-256…'); }
    else if (e.phase === 'verified') markDone(e.item, '✓ verified');
    else if (e.phase === 'extract') setPhase('Unpacking the engine…');
    else if (e.phase === 'loading') setPhase('Starting the engine and loading the model into memory…');
  });
  function markDone(item, text) { const box = [...document.querySelectorAll('#choose-progress .choose-bar')].find((b) => b.dataset.item === item); if (box) { box.querySelector('i').style.width = '100%'; box.querySelector('.n').textContent = text; box.classList.toggle('done', text.startsWith('✓')); } }
  function setPhase(t) { st.phaseText = t; const p = document.getElementById('choose-phase'); if (p && !st.failed) p.lastElementChild.textContent = t; }

  async function install() {
    st.screen = 'install'; st.paused = false; st.failed = null; st.cancelling = false; rerender();
    const r = await lyra.engine.install({ id: st.chosen.id });
    if (!st || st.cancelling) return;
    if (!r.ok) { if (r.paused) { st.paused = true; st.phaseText = 'Paused. Resume picks up where it stopped.'; } else st.failed = r.error; rerender(); return; }
    setPhase('Starting the engine and loading the model into memory…');
    const s = await lyra.engine.start();
    if (!st) return;
    if (!s.ok) { st.failed = `The engine did not start: ${s.error}`; rerender(); return; }
    // Lyra now thinks with the local model; vision too when it can see.
    const patch = { model: { chat: { provider: LOCAL_ID, model: '' } } };
    if (st.chosen.vision) patch.model.vision = { provider: LOCAL_ID, model: '' };
    await window.LyraApp.set(patch);
    toast(`${st.chosen.label} is running on this computer.`);
    exit('installed');
  }

  window.Choose = {
    active: () => !!st,
    // r: re-render the host page; done(result): leave the flow. result is
    // 'skip' | 'fallback' | 'installed' | { endpoint } for an existing server.
    start(r, done) { st = { screen: 'look', answers: { goal: 'chat', speed: 'balanced' }, hw: null, running: [] }; rerender = r; onExit = done || (() => {}); look(); },
    stop() { st = null; },
    parts() { return st ? screens[st.screen]() : []; },
  };
})();
