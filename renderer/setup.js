// The setup guide: opens once on a fresh install, and again from Settings › About.
// A few short pages for what a new install needs most: the model, her name and
// look, her voice, image generation, safety and tools. Every control writes
// straight to settings, the way the settings page does, so skipping at any point
// keeps whatever was already chosen.
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  const S = () => window.LyraApp.settings();
  const set = (patch) => window.LyraApp.set(patch);
  const toast = (t, k) => window.LyraApp.toast(t, k);
  // The controls are the settings page's own, so the two look and behave alike.
  const ui = () => window.Settings.ui;
  // Shortcuts that only fill in the URL: the runtime itself is detected.
  const QUICK = [
    { kind: 'lmstudio', l: 'LM Studio', ep: 'http://localhost:1234/v1', get: 'https://lmstudio.ai' },
    { kind: 'ollama', l: 'Ollama', ep: 'http://localhost:11434/v1', get: 'https://ollama.com/download' },
    { kind: 'llama.cpp', l: 'llama.cpp', ep: 'http://localhost:8080/v1', get: 'https://github.com/ggml-org/llama.cpp' },
  ];
  const normalize = (v) => { let s = String(v || '').trim(); if (!s) return ''; if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`; s = s.replace(/\/+$/, ''); return /\/v\d+$/.test(s) ? s : `${s}/v1`; };
  const packOf = (s) => (s.appearance.source === 'gif' && s.appearance.gifFolder.startsWith('builtin:') ? s.appearance.gifFolder.slice(8) : null);
  let open = false, step = 0, seq = 0, models = null, modelChecked = false, imageTest = null;

  const STEPS = [
    { id: 'welcome', name: 'Welcome', render: welcome },
    { id: 'model', name: 'Model', render: model },
    { id: 'look', name: 'Name and look', render: look },
    { id: 'voice', name: 'Voice', render: voice },
    { id: 'images', name: 'Images', render: images },
    { id: 'safety', name: 'Safety', render: safety },
    { id: 'tools', name: 'Tools and scripts', render: tools },
    { id: 'done', name: 'Done', render: done },
  ];

  async function welcome() {
    const s = S();
    const hero = el(`<div class="setup-hero setup-hero-3d"><div class="setup-hero-3d-stage" id="setup-3d-stage"></div><div><div class="s-title">Hi, I’m ${esc(s.persona.name)}.</div><div class="s-sub">Chat, build and grow.</div></div></div>`);
    return [hero];
  }

  async function model() {
    const s = S(); const { title, row, field, btn, select } = ui();
    const provs = s.providers.list; const prov = provs.find((p) => p.id === s.model.chat.provider) || provs[0];
    const known = models || window.LyraApp.models(); const info = known && known.byProvider ? known.byProvider[prov.id] : null;
    const save = (patch) => set({ providers: { list: provs.map((p) => (p.id === prov.id ? { ...p, ...patch } : p)) } });
    const check = async (e) => {
      const b = e ? e.currentTarget : null; if (b) { b.disabled = true; b.textContent = 'Connecting…'; }
      const line = document.querySelector('#setup-content .status-line'); if (line) line.innerHTML = '<span class="dot busy"></span>Connecting…';
      try { models = await lyra.models.detect(); } catch (err) { toast(err.message || String(err), 'error'); } finally { render(); }
    };
    const card = el('<div class="card" style="gap:10px"><div class="conn-row"></div><div class="conn-row"></div><div class="conn-row"></div><div class="status-line"></div></div>');
    const [l1, l2, chips, st] = card.children;
    const url = field(prov.endpoint, (v) => { const ep = normalize(v); save({ endpoint: ep }).then(() => check()); }, { w: 300, mono: true, ph: 'http://localhost:1234/v1' });
    l1.appendChild(el('<span class="conn-label">Base URL</span>')); l1.appendChild(url);
    // Always offered: a local server can sit behind a key too (llama-server --api-key).
    const key = field(prov.apiKey, (v) => { save({ apiKey: v.trim() }).then(() => check()); }, { w: 300, type: 'password', ph: 'API key (optional)' });
    l2.appendChild(el('<span class="conn-label">API key</span>')); l2.appendChild(key);
    l2.appendChild(btn('Connect', check, { primary: true, ic: 'refresh', small: false }));
    chips.appendChild(el('<span class="conn-label d">Quick fill</span>'));
    QUICK.forEach((q) => { const c = el(`<button class="chip ${prov.endpoint === q.ep ? 'on' : ''}" type="button">${window.brandLogo(q.kind, 14)}<span>${esc(q.l)}</span></button>`); c.addEventListener('click', () => save({ endpoint: q.ep }).then(() => check())); chips.appendChild(c); });
    const kind = info && info.ok ? info.source : null;
    if (!info) st.innerHTML = '<span class="dot off"></span>Not checked yet.';
    else if (info.ok) st.innerHTML = `<span class="dot"></span>${window.brandLogo(kind, 16)}<span>Connected · ${esc(info.summary || window.brandName(kind))}</span>`;
    else if (info.needsKey) { st.innerHTML = `<span class="dot off"></span>${esc(info.error || 'This server needs an API key.')} Paste it above, then Connect.`; setTimeout(() => key.focus(), 0); }
    else {
      const local = QUICK.find((q) => prov.endpoint && prov.endpoint.startsWith(q.ep.replace(/\/v1$/, '')));
      st.innerHTML = `<span class="dot off"></span>Nothing answered at ${esc(info.endpoint)}: ${esc(info.error || 'unknown error')}. Check the address ends in /v1 and the server is running.`;
      if (local) st.appendChild(btn(`Get ${local.l}`, () => lyra.app.openExternal({ url: local.get }), { ic: 'globe' }));
    }
    const parts = [title('Which model do I think with?', 'Paste the address of any OpenAI-compatible server, ending in /v1. LM Studio, Ollama, llama.cpp, vLLM and hosted APIs all work. I work out which one it is. Add a key if the server needs one.'), card];
    if (info && info.ok) {
      const usable = info.list.filter((x) => !x.id.includes('embed'));
      parts.push(row('Model', 'The one I use for conversation and tools. Auto takes one the server already has loaded.', select(window.Settings.modelOptions(usable, s.model.chat.model, 'Auto (a loaded model)'), s.model.chat.model, (v) => set({ model: { chat: { provider: prov.id, model: v } } }), 360)));
    }
    parts.push(el('<div class="d" style="font-size:12px;color:var(--muted)">A separate vision model, more servers and the context length are under Settings › Model and Provider.</div>'));
    // The first visit checks on its own, so a server that is already running
    // shows up without a click.
    if (!info && !modelChecked) { modelChecked = true; check(); }
    return parts;
  }

  async function look() {
    const s = S(); const { title, row, field } = ui(); const p = s.persona;
    const themes = await lyra.themes.list();
    // 3D-first: Lyra (3D) is always selected; the "More characters" card is greyed.
    const lyraCard = el(`<div class="theme-card setup-pack on"><img src="character/vrm/avatar.png" alt=""><div class="n">Lyra (3D)</div><div class="k">Selected</div></div>`);
    const comingSoon = el(`<div class="theme-card setup-pack coming-soon"><div class="n">More characters</div><div class="k">Coming soon</div></div>`);
    const grid = el('<div class="theme-grid" style="grid-template-columns:repeat(2,minmax(0,1fr))"></div>');
    grid.appendChild(lyraCard);
    grid.appendChild(comingSoon);
    const tgrid = el('<div class="theme-grid"></div>');
    themes.forEach((t) => {
      const c = el(`<div class="theme-card ${t.id === s.appearance.theme ? 'on' : ''}"><div class="sw"><i style="background:${esc(t.vars.bg || '#000')}"></i><i style="background:${esc(t.vars.side || '#222')}"></i><i style="background:${esc(t.vars.accent || '#4fc8b4')}"></i><i style="background:${esc(t.vars.text || '#fff')}"></i></div><div class="n">${esc(t.name)}</div><div class="k">${t.scheme}</div></div>`);
      c.addEventListener('click', () => set({ appearance: { theme: t.id } }).then(render));
      tgrid.appendChild(c);
    });
    return [
      title('What do I look like?', 'Lyra comes as a 3D character. More characters will be added later. Pick a theme now; you can change it any time under Settings.'),
      row('My name', 'What you call me. Locked for the agent: only you can change it.', field(p.name, (v) => v.trim() && set({ persona: { name: v.trim() } }).then(render), { w: 220 })),
      el('<div class="group-label">Character</div>'), grid,
      el('<div class="group-label">Theme</div>'), tgrid,
      el('<div class="d" style="font-size:12px;color:var(--muted)">Your own 3D model, custom skins and the floating character are under Settings › Appearance.</div>'),
    ];
  }

  async function voice() {
    const s = S(); const { title, row, toggle, select, btn } = ui(); const v = s.voice;
    const paths = await lyra.app.paths(); const vs = await lyra.voice.status();
    let voices = ['Rosie', 'Bella', 'Jasmine', 'Luna', 'Jasper', 'Leo', 'Ben', 'Axel'];
    if (paths.voiceReady) { try { voices = await lyra.voice.voices(); } catch {} }
    const status = el(`<div class="card"><div class="status-line"><span class="dot ${paths.voiceReady ? '' : 'off'}"></span>${paths.voiceReady ? 'Voice engine installed: KittenTTS to speak, Whisper to listen.' : 'Voice engine not installed. Until it is, replies use the system voice where there is one, and I cannot hear you.'}</div>${paths.voiceReady ? '' : '<div class="d" style="font-size:12px;color:var(--muted)">It installs under my own data folder: needs uv or python3, takes a few minutes and downloads about 300 MB. You can also do this later under Settings › Voice.</div><div style="display:flex;gap:8px"></div>'}</div>`);
    if (!paths.voiceReady) {
      const install = btn(vs.installing ? 'Installing…' : 'Install voice engine', async (e) => { const b = e.currentTarget; b.disabled = true; b.textContent = 'Installing…'; const r = await lyra.voice.setup(); toast(r.ok ? 'Voice engine installed.' : 'Install failed: ' + String(r.log || '').slice(-200), r.ok ? '' : 'error'); render(); }, { primary: true, ic: 'download' });
      install.disabled = !!vs.installing;
      status.lastElementChild.appendChild(install);
    }
    const sample = btn('Play sample', async (e) => { const b = e.currentTarget; b.disabled = true; try { const a = await lyra.voice.speak({ text: `Hi, I’m ${s.persona.name}. This is how I sound.` }); if (a) window.LyraApp.playFile(a.path); } catch (err) { toast(err.message, 'error'); } finally { b.disabled = false; } }, { ic: 'play' });
    sample.disabled = !paths.voiceReady;
    return [
      title('Do you want to hear me?', 'I can read my replies aloud, and you can talk to me with the microphone. Both run on this computer.'),
      status,
      row('Read replies aloud', 'Every reply is spoken.', toggle(v.readAloud, (x) => set({ voice: { readAloud: x } }))),
      row('Voice', paths.voiceReady ? 'KittenTTS voices.' : 'Takes effect once the engine is installed.', [select(voices.map((x) => ({ v: x, l: x })), v.voice, (x) => set({ voice: { voice: x } }), 150), sample]),
      row('Speak in chat', 'Tap the mic to record, tap again to send. Whisper transcribes it here, on this computer.', toggle(v.stt, (x) => set({ voice: { stt: x } }))),
      el('<div class="d" style="font-size:12px;color:var(--muted)">Your own TTS endpoint and the Whisper model size are under Settings › Voice.</div>'),
    ];
  }

  async function images() {
    const s = S(); const { title, row, toggle, seg, field, btn } = ui(); const g = s.imagegen;
    const epKey = g.backend === 'comfyui' ? 'comfyEndpoint' : 'swarmEndpoint'; const ep = g[epKey];
    const test = btn('Test', async (e) => { e.currentTarget.disabled = true; try { const r = await lyra.imagegen.test({}); imageTest = { key: ep, ...r }; } catch (err) { imageTest = { key: ep, ok: false, error: err.message }; } finally { render(); } }, { ic: 'refresh' });
    const st = imageTest && imageTest.key === ep
      ? (imageTest.ok ? `<span class="dot"></span>Connected · ${imageTest.count} model${imageTest.count === 1 ? '' : 's'}` : `<span class="dot off"></span>Not reachable: ${esc(imageTest.error || 'unknown error')}`)
      : '<span class="dot off"></span>Not tested yet.';
    return [
      title('Can I draw?', 'Optional. If SwarmUI or ComfyUI runs on this computer or your network, I get a generate_image tool and the pictures land in my workspace. Skip this if you do not run either.'),
      row('Image generation', 'Adds the generate_image tool.', toggle(g.enabled, (x) => set({ imagegen: { enabled: x } }))),
      row('Backend', '', seg([{ v: 'swarmui', l: 'SwarmUI' }, { v: 'comfyui', l: 'ComfyUI' }], g.backend, (x) => set({ imagegen: { backend: x } }).then(render))),
      row('Endpoint', g.backend === 'comfyui' ? 'ComfyUI, usually port 8188.' : 'SwarmUI, usually port 7801.', [field(ep, (x) => set({ imagegen: { [epKey]: x.trim().replace(/\/$/, '') } }).then(render), { w: 240, mono: true }), test]),
      el(`<div class="status-line">${st}</div>`),
      el('<div class="d" style="font-size:12px;color:var(--muted)">Model, size and sampling are under Settings › Image generation.</div>'),
    ];
  }

  async function safety() {
    const s = S(); const { title, row, toggle, select } = ui(); const sf = s.safety;
    const modes = [
      ['ask', 'Ask me first', 'I ask before running commands, writing outside my workspace or submitting forms. With smart approvals on, low-risk steps run on their own.'],
      ['auto', 'Let me approve my own actions', 'Every action is still listed in the chat as it happens.'],
      ['none', 'No restrictions', 'Nothing is gated. Only on a machine you can afford to lose.'],
    ];
    const cards = el('<div style="display:flex;flex-direction:column;gap:8px"></div>');
    modes.forEach(([v, t, d]) => { const c = el(`<div class="radio-card ${sf.approvalMode === v ? 'on' : ''}"><div class="r"></div><div><div class="t ${v === 'none' ? 'warn' : ''}">${t}</div><div class="d">${d}</div></div></div>`); c.addEventListener('click', () => set({ safety: { approvalMode: v } }).then(render)); cards.appendChild(c); });
    return [
      title('How much may I do on my own?', 'I run commands, write files and browse. This decides when I ask you first. Only you can change it: the agent is locked out of this page.'),
      cards,
      row('Smart approvals', 'Reads, browsing and writes inside my workspace run without asking; commands and writes elsewhere still ask.', toggle(s.model.smartApprovals, (x) => set({ model: { smartApprovals: x } }))),
      row('Approval timeout', 'How long I wait for your answer before giving up on that step.', select([{ v: 60, l: '1 minute' }, { v: 300, l: '5 minutes' }, { v: 900, l: '15 minutes' }, { v: 1800, l: '30 minutes' }, { v: 86400, l: 'A day' }], sf.timeoutSec, (x) => set({ safety: { timeoutSec: Number(x) } }), 150)),
      row('Ask before downloads', 'A file my browser downloads counts as an approval.', toggle(s.browser.askBeforeDownloads, (x) => set({ browser: { askBeforeDownloads: x } }))),
    ];
  }

  async function tools() {
    const s = S(); const { title, row, toggle, field, btn } = ui(); const t = s.tools; const w = s.workspace;
    const list = el('<div class="list"></div>');
    window.Settings.toolItems().forEach(([k, ic, n, d]) => {
      const scripts = k === 'shell' || k === 'run_code';
      const it = el(`<div class="item ${t[k] ? 'on' : 'off'}">${icon(ic, 16)}<div class="col"><span class="n">${n}${scripts ? '<span class="tag-scripts">scripts</span>' : ''}</span><span class="d">${d}</span></div></div>`);
      it.appendChild(toggle(t[k], (v) => { set({ tools: { [k]: v } }); it.classList.toggle('on', v); it.classList.toggle('off', !v); }));
      list.appendChild(it);
    });
    return [
      title('Tools and scripts', 'What I can reach. Shell commands and code execution are what let me run scripts; they follow the safety rules from the last page. Anything switched off here disappears from my side.'),
      row('My workspace', 'My own folder. Files, scripts and images I make land here.', [field(w.folder, null, { w: 260, mono: true, ro: true }), btn('Change', async () => { if (await lyra.workspace.choose()) render(); })]),
      row('I can use tools', 'The master switch.', toggle(t.enabled, (v) => set({ tools: { enabled: v } }))),
      list,
    ];
  }

  async function done() {
    const s = S(); const { title } = ui();
    const provs = s.providers.list; const prov = provs.find((p) => p.id === s.model.chat.provider) || provs[0];
    const known = models || window.LyraApp.models(); const info = known && known.byProvider ? known.byProvider[prov.id] : null;
    const packs = await lyra.packs.list(); const pack = packs.find((k) => k.id === packOf(s));
    const theme = (await lyra.themes.list()).find((t) => t.id === s.appearance.theme);
    const on = Object.keys(s.tools).filter((k) => k !== 'enabled' && s.tools[k]).length;
    const ig = s.imagegen;
    const rows = [
      ['Model', info && info.ok ? `${prov.name} · ${s.model.chat.model || 'auto'}` : `${prov.name} · not reachable yet, so I cannot answer until it is`],
      ['Look', `${s.persona.name} · ${pack ? pack.name : s.appearance.source === 'gif' ? 'your own GIF pack' : s.appearance.source} · ${theme ? theme.name : s.appearance.theme}`],
      ['Voice', `${s.voice.readAloud ? `reads aloud as ${s.voice.voice}` : 'does not read aloud'} · ${s.voice.stt ? 'listens to the mic' : 'mic off'}`],
      ['Images', ig.enabled ? `${ig.backend === 'comfyui' ? 'ComfyUI' : 'SwarmUI'} at ${ig.backend === 'comfyui' ? ig.comfyEndpoint : ig.swarmEndpoint}` : 'off'],
      ['Safety', { ask: 'asks first', auto: 'approves her own actions', none: 'no restrictions' }[s.safety.approvalMode] + (s.model.smartApprovals ? ', smart approvals on' : '')],
      ['Tools', s.tools.enabled ? `${on} switched on` : 'off'],
    ];
    return [
      title('I’m ready.', 'Here is what you chose. Everything can be changed later under Settings, where this guide lives too, under About.'),
      el(`<div class="card"><div class="kv">${rows.map(([k, v]) => `<b>${k}</b><span>${esc(v)}</span>`).join('')}</div></div>`),
    ];
  }

  /* ---- page ---- */
  function renderNav() {
    const box = $('#setup-steps');
    box.innerHTML = STEPS.map((st, i) => `<button class="nav-item setup-step ${i === step ? 'on' : ''} ${i < step ? 'done' : ''}" data-i="${i}"><span class="num">${i < step ? icon('check', 11, 3) : i + 1}</span><span class="nav-text">${esc(st.name)}</span></button>`).join('');
    box.querySelectorAll('.setup-step').forEach((b) => b.addEventListener('click', () => go(Number(b.dataset.i))));
  }
  async function render() {
    if (!open) return;
    const mine = ++seq; renderNav();
    const last = step === STEPS.length - 1;
    $('#setup-back').hidden = step === 0; $('#setup-skip').hidden = last;
    $('#setup-next').textContent = step === 0 ? 'Let’s go' : last ? 'Start chatting' : 'Next';
    const c = $('#setup-content'); c.innerHTML = '<div class="settings-inner"></div>'; const inner = c.firstElementChild;
    try { const parts = await STEPS[step].render(); if (mine !== seq) return; parts.filter(Boolean).forEach((p) => inner.appendChild(p)); }
    catch (e) { if (mine !== seq) return; inner.appendChild(el(`<div class="md error">Could not load this page: ${esc(e.message)}</div>`)); inner.appendChild(ui().btn('Try again', () => render(), { ic: 'refresh' })); console.error(e); }
    c.scrollTop = 0;
  }
  function go(i) { step = Math.max(0, Math.min(STEPS.length - 1, i)); render(); }
  async function finish(skipped) {
    await set({ ui: { setupDone: true } });
    window.Setup.close();
    if (skipped) toast('Skipped. The setup guide is under Settings › About whenever you want it.');
  }
  window.Setup = {
    open(at = 0) { step = at; models = null; modelChecked = false; open = true; $('#setup').hidden = false; window.LyraApp.browserVisible(false); render(); },
    close() {
      open = false; $('#setup').hidden = true;
      // The settings page may be open underneath: it hides the browser too, and it shows what was changed here.
      const settingsOpen = !!(window.Settings && window.Settings.isOpen());
      window.LyraApp.browserVisible(!settingsOpen);
      if (settingsOpen) window.Settings.refresh(); else $('#input').focus();
    },
    isOpen: () => open,
  };
  $('#setup-next').addEventListener('click', () => (step === STEPS.length - 1 ? finish(false) : go(step + 1)));
  $('#setup-back').addEventListener('click', () => go(step - 1));
  $('#setup-skip').addEventListener('click', () => finish(true));
})();
