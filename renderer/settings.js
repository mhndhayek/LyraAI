// Settings page: one section per menu entry. Controls write straight to settings.
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  // Menu groups: the brain, the character, what surrounds it, and the app itself.
  const NAV = [
    ['Brain', [['model', 'Model', 'cpu'], ['provider', 'Provider', 'server'], ['memory', 'Memory & context', 'database'], ['tools', 'Tools', 'tool'], ['imagegen', 'Image generation', 'image']]],
    ['Character', [['persona', 'Persona & chat', 'persona'], ['appearance', 'Appearance', 'sun'], ['voice', 'Voice', 'volume'], ['goals', 'AI goals', 'target']]],
    ['Around it', [['workspace', 'Workspace', 'folder'], ['browser', 'Browser', 'globe'], ['safety', 'Safety', 'shield'], ['notifications', 'Notifications', 'bell'], ['mobile', 'Mobile', 'phone']]],
    ['App', [['extensions', 'Extensions', 'plus'], ['recovery', 'Recovery', 'git'], ['about', 'About', 'info']]],
  ];
  const SECTIONS = NAV.flatMap(([, items]) => items);
  let current = 'model', open = false, previewChar = null, errorCount = 0;
  const logFilter = { level: 'warn', source: '', search: '' };
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  const S = () => window.LyraApp.settings();
  const set = (patch) => window.LyraApp.set(patch);
  const toast = (t, k) => window.LyraApp.toast(t, k);
  const fmtWhen = (ts) => { const d = (Date.now() - ts) / 86400000; return d < 1 ? 'today' : d < 2 ? 'yesterday' : `${Math.floor(d)} days ago`; };

  /* ---- controls ---- */
  const row = (t, d, ctl, opts = {}) => { const r = el(`<div class="row"><div class="lbl"><div class="t">${t}</div>${d ? `<div class="d">${d}</div>` : ''}</div><div class="ctl"></div></div>`); (Array.isArray(ctl) ? ctl : [ctl]).filter(Boolean).forEach((c) => r.querySelector('.ctl').appendChild(typeof c === 'string' ? el(`<span>${c}</span>`) : c)); return r; };
  const group = (label, rows) => { const g = el(`<div>${label ? `<div class="group-label">${label}</div>` : ''}</div>`); rows.forEach((r) => g.appendChild(r)); return g; };
  const toggle = (on, cb) => { const t = el(`<button class="toggle ${on ? 'on' : ''}" role="switch" aria-checked="${!!on}"></button>`); t.addEventListener('click', () => { const v = !t.classList.contains('on'); t.classList.toggle('on', v); cb(v); }); return t; };
  const seg = (opts, val, cb) => { const s = el(`<div class="seg">${opts.map((o) => `<button data-v="${esc(o.v)}" class="${o.v === val ? 'on' : ''}">${esc(o.l)}</button>`).join('')}</div>`); s.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { s.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); cb(b.dataset.v); })); return s; };
  const select = (opts, val, cb, w = 220) => { const s = el(`<select class="select" style="width:${w}px">${opts.map((o) => `<option value="${esc(o.v)}" ${String(o.v) === String(val) ? 'selected' : ''}>${esc(o.l)}</option>`).join('')}</select>`); s.addEventListener('change', () => cb(s.value)); return s; };
  const field = (val, cb, { w = 260, mono = false, type = 'text', ph = '', ro = false } = {}) => { const f = el(`<input class="field ${mono ? 'mono' : ''}" type="${type}" style="width:${w}px" placeholder="${esc(ph)}" ${ro ? 'readonly' : ''}>`); f.value = val ?? ''; if (cb) { f.addEventListener('change', () => cb(type === 'number' ? Number(f.value) : f.value)); f.addEventListener('keydown', (e) => e.key === 'Enter' && f.blur()); } return f; };
  const slider = (min, max, step, val, fmt, cb) => { const s = el(`<div class="slider"><span class="val">${fmt(val)}</span><input type="range" min="${min}" max="${max}" step="${step}" value="${val}"></div>`); const i = s.querySelector('input'); i.addEventListener('input', () => { s.querySelector('.val').textContent = fmt(Number(i.value)); }); i.addEventListener('change', () => cb(Number(i.value))); return s; };
  const btn = (label, cb, { primary = false, ic = '', danger = false, small = true } = {}) => { const b = el(`<button class="btn ${small ? 'small' : ''} ${primary ? 'primary' : ''} ${danger ? 'danger' : ''}">${ic ? icon(ic, 14) : ''}${esc(label)}</button>`); b.addEventListener('click', cb); return b; };
  const status = (ok, text) => el(`<div class="status-line"><span class="dot ${ok ? '' : 'off'}"></span>${esc(text)}</div>`);
  const title = (t, sub) => el(`<div><div class="s-title">${t}</div><div class="s-sub">${sub}</div></div>`);

  /* ---- sections ---- */
  const sections = {
    about: async () => {
      const st = await lyra.kernel.state(); const L = st.links || {}; const s = S();
      const go = (url) => () => lyra.app.openExternal({ url });
      const hero = el(`<div class="card" style="flex-direction:row;align-items:center;gap:18px"><img src="character/catgirl/avatar.png" alt="" style="width:76px;height:76px;image-rendering:pixelated;border-radius:18px;background:var(--hover)"><div><div style="font-size:17px;font-weight:600;color:var(--bright)">Lyra AI Agent</div><div class="d" style="font-size:12px;color:var(--muted);margin-top:3px">A local-first AI agent that lives on your computer, remembers, uses tools, and can grow itself. Your chats never leave this machine.</div></div></div>`);
      const credits = el(`<div class="d" style="font-size:12px;color:var(--muted);line-height:1.6">Built with Electron, marked, PixiJS, pixi-live2d-display and qrcode. Voice by KittenTTS and faster-whisper. Pixel font Pixelify Sans. The characters were drawn with SwarmUI and Z-Image-Turbo, then animated by hand; the recipe is in the docs (ask ${esc(s.persona.name)} to read the avatars topic).</div>`);
      return [
        title('About', 'Version, license, source code and how to support the project.'),
        hero,
        group('', [
          row('Version', 'The app, and the version of the live organs it is running.', el(`<span class="d" style="font-family:var(--mono);font-size:12px;color:var(--muted)">${esc(st.version)} · organs ${esc(st.organsVersion || st.version)}</span>`)),
          row('License', 'Free for personal use. Commercial use needs permission from the author.', btn('Read the license', go(L.license), { ic: 'file' })),
          row('Source code', 'Issues, ideas and pull requests are welcome.', [btn('GitHub', go(L.repo), { ic: 'git' }), btn('Report a problem', go(L.issues), { ic: 'bell' })]),
          row('Support the project', 'Lyra is free. If it has earned a place on your desk, a coffee keeps it growing.', btn('Donate', go(L.donate), { primary: true, ic: 'heart' })),
          row('App data', 'Chats, memory, settings, checkpoints and logs on this machine.', btn('Open folder', () => lyra.kernel.openState(), { ic: 'folder' })),
        ]),
        credits,
      ];
    },

    async model() {
      const s = S(); const m = window.LyraApp.models() || { byProvider: {} }; const provs = s.providers.list;
      const provOpts = provs.map((p) => ({ v: p.id, l: p.name }));
      const roleBlock = (role, label, desc, filter) => {
        const sel = s.model[role]; const prov = provs.find((p) => p.id === sel.provider) || provs[0]; const info = m.byProvider[prov.id];
        const list = (info && info.list) || []; const usable = list.filter(filter);
        const opts = [{ v: '', l: role === 'vision' ? 'Auto (first vision model on this preset)' : 'Auto (first loaded model on this preset)' }, ...usable.map((x) => ({ v: x.id, l: `${x.label || x.id}${x.context ? ` · ${Math.round(x.context / 1024)}k context` : ''}${x.quant ? ' · ' + x.quant : ''}${x.loaded && !x.quant ? ' · loaded' : ''}` }))];
        if (sel.model && !usable.some((x) => x.id === sel.model)) opts.push({ v: sel.model, l: `${sel.model} (not detected)` });
        const card = el(`<div class="card"><div style="display:flex;align-items:center;justify-content:space-between;gap:12px"><div><div class="t" style="font-size:14px;font-weight:500;color:var(--bright)">${label}</div><div class="d" style="font-size:12px;color:var(--muted)">${desc}</div></div></div><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"></div><div class="status-line"></div></div>`);
        const ctl = card.children[1];
        ctl.appendChild(select(provOpts, prov.id, (v) => set({ model: { [role]: { provider: v, model: '' } } }).then(refresh), 180));
        ctl.appendChild(select(opts, sel.model, (v) => set({ model: { [role]: { model: v } } }), 360));
        const st = card.lastElementChild;
        st.innerHTML = info ? (info.ok ? `<span class="dot"></span>${esc(prov.name)} · ${esc(info.endpoint)} · ${usable.length} ${role === 'vision' ? 'vision ' : ''}model${usable.length === 1 ? '' : 's'}${info.source === 'lmstudio' ? ' · context and vision read from LM Studio' : info.source === 'llama.cpp' ? ' · context read from llama.cpp' : ''}` : `<span class="dot off"></span>${esc(prov.name)} not reachable at ${esc(info.endpoint)}: ${esc(info.error || 'unknown error')}`) : '<span class="dot off"></span>Not checked yet';
        return card;
      };
      const chatSel = s.model.chat; const chatProv = provs.find((p) => p.id === chatSel.provider) || provs[0]; const chatInfo = m.byProvider[chatProv.id]; const detected = chatInfo && chatInfo.list.find((x) => x.id === (chatSel.model || (chatInfo.list[0] || {}).id));
      const ctxSel = select([{ v: 'auto', l: 'Auto-detect' }, { v: 'manual', l: 'Manual' }], s.model.contextMode, (v) => { set({ model: { contextMode: v } }).then(refresh); }, 140);
      const ctxField = field(s.model.contextOverride, (v) => set({ model: { contextOverride: Math.max(2048, v || 8192) } }).then(refresh), { w: 110, type: 'number' }); ctxField.disabled = s.model.contextMode !== 'manual';
      const ctxHint = s.model.contextMode === 'auto'
        ? (detected && detected.context ? `${detected.context.toLocaleString()} tokens, read from the server${detected.maxContext && detected.maxContext > detected.context ? ` (trained for ${detected.maxContext.toLocaleString()}, loaded with less)` : ''}` : 'this server does not report it, so 8,192 is assumed. Set it by hand to match how the model was loaded.')
        : `tokens. Auto would use ${detected && detected.context ? detected.context.toLocaleString() : '8,192'}. More than the server loaded causes errors or silent truncation.`;
      const toolsRow = el('<div style="display:flex;gap:8px"></div>');
      toolsRow.appendChild(btn('Detect models on all presets', async (e) => { e.target.disabled = true; try { await lyra.models.detect(); } finally { refresh(); } }, { ic: 'refresh' }));
      toolsRow.appendChild(btn('Manage presets', () => { current = 'provider'; render(); }, { ic: 'server' }));
      return [
        title('Model', 'The brain and the vision model can come from different provider presets (LM Studio, Ollama, llama.cpp, a remote API). Presets are set up under Provider.'),
        toolsRow,
        roleBlock('chat', 'Brain', 'Used for conversation, tools, summaries and goals.', (x) => !x.id.includes('embed')),
        roleBlock('vision', 'Vision model', 'Used when you send a picture or Lyra looks at one. Falls back to the brain if it can see.', (x) => x.vision),
        group('Context', [row('Context length', ctxHint, [ctxSel, ctxField])]),
        group('Behavior', [
          row('Reasoning', 'How long Lyra thinks before answering (sent as reasoning effort; “Off” adds /no_think for Qwen-style models).', seg([{ v: 'off', l: 'Off' }, { v: 'low', l: 'Low' }, { v: 'medium', l: 'Medium' }, { v: 'high', l: 'High' }], s.model.reasoning, (v) => set({ model: { reasoning: v } }))),
          row('Smart approvals', 'Low-risk actions (reads, browsing, writes inside the workspace) run without asking; commands and outside writes still ask. Mode and timeout live under Safety.', toggle(s.model.smartApprovals, (v) => set({ model: { smartApprovals: v } }))),
          row('Context compression', 'Fold older turns into a summary when the context fills up. Thresholds live under Memory & context.', toggle(s.model.compression, (v) => set({ model: { compression: v } }))),
          row('Temperature', '', slider(0, 1.5, 0.05, s.model.temperature, (v) => v.toFixed(2), (v) => set({ model: { temperature: v } }))),
        ]),
        group('How far Lyra goes in one turn', [
          row('Tool steps', `One step is one round of tool calls: reading a file, running a command, opening a page. A long job like editing several files or browsing a site needs many. ${esc(s.persona.name)} stops at this number and offers to carry on.`, [slider(5, 200, 5, Math.min(200, s.model.maxSteps || 30), (v) => `${v} steps`, (v) => set({ model: { maxSteps: v } })), field(s.model.maxSteps, (v) => set({ model: { maxSteps: Math.max(1, Math.min(500, v || 30)) } }).then(refresh), { w: 80, type: 'number' })]),
          row('Time limit', 'A turn that runs longer than this is stopped, so nothing loops forever while you are away.', select([5, 10, 30, 60, 120, 240].map((n) => ({ v: n, l: n >= 60 ? `${n / 60} hour${n > 60 ? 's' : ''}` : `${n} minutes` })), s.model.runMinutes || 30, (v) => set({ model: { runMinutes: Number(v) } }), 150)),
        ]),
      ];
    },
    async imagegen() {
      const s = S(); const g = s.imagegen; const ep = g.backend === 'comfyui' ? g.comfyEndpoint : g.swarmEndpoint; const epKey = g.backend === 'comfyui' ? 'comfyEndpoint' : 'swarmEndpoint';
      let models = window.__igModels && window.__igModels.key === ep ? window.__igModels.list : null;
      const modelOpts = [{ v: '', l: 'Backend default' }, ...(models || []).map((m) => ({ v: m, l: m }))]; if (g.model && !(models || []).includes(g.model)) modelOpts.push({ v: g.model, l: g.model });
      const sizes = [['1024x1024', 'Square 1024'], ['832x1216', 'Portrait 832×1216'], ['1216x832', 'Landscape 1216×832'], ['1344x768', 'Wide 1344×768'], ['768x1344', 'Tall 768×1344'], ['512x512', 'Small 512'], ['custom', 'Custom']];
      const cur = `${g.width}x${g.height}`; const isPreset = sizes.some(([v]) => v === cur);
      const status = el('<div class="status-line"><span class="dot off"></span>Not tested</div>');
      const testBtn = btn('Test and list models', async (e) => { e.target.disabled = true; try { const r = await lyra.imagegen.test({}); if (r.ok) { window.__igModels = { key: ep, list: r.models }; toast(`${g.backend === 'comfyui' ? 'ComfyUI' : 'SwarmUI'}: ${r.count} models`); refresh(); } else toast(`Not reachable: ${r.error}`, 'error'); } finally { e.target.disabled = false; } }, { ic: 'refresh' });
      return [
        title('Image generation', 'Gives Lyra a generate_image tool backed by SwarmUI or ComfyUI on this machine (or your network). Images land in the workspace and show up in the chat.'),
        group('', [
          row('Enable image generation', 'Adds the generate_image tool. Also listed under Tools.', toggle(g.enabled, (v) => set({ imagegen: { enabled: v } }))),
          row('Backend', 'SwarmUI uses its /API; ComfyUI uses a built-in text-to-image workflow.', seg([{ v: 'swarmui', l: 'SwarmUI' }, { v: 'comfyui', l: 'ComfyUI' }], g.backend, (v) => set({ imagegen: { backend: v } }).then(refresh))),
          row('Endpoint', g.backend === 'comfyui' ? 'ComfyUI server, usually port 8188.' : 'SwarmUI server, usually port 7801.', [field(ep, (v) => set({ imagegen: { [epKey]: v.trim().replace(/\/$/, '') } }).then(refresh), { w: 260, mono: true }), testBtn]),
        ]),
        group('Model', [
          row('Default model', models ? `${models.length} models from the backend.` : 'Press “Test and list models” to fill this list, or leave the backend default.', select(modelOpts, g.model, (v) => set({ imagegen: { model: v } }), 320)),
          row('Let the AI choose the model', 'Lyra may pick a different model per request when it has a reason.', toggle(g.letAiChooseModel, (v) => set({ imagegen: { letAiChooseModel: v } }))),
        ]),
        group('Size', [
          row('Default size', '', [select(sizes.map(([v, l]) => ({ v, l })), isPreset ? cur : 'custom', (v) => { if (v === 'custom') { refresh(); return; } const [w, h] = v.split('x').map(Number); set({ imagegen: { width: w, height: h } }).then(refresh); }, 200), ...(isPreset ? [] : [field(g.width, (v) => set({ imagegen: { width: Math.max(256, v || 1024) } }), { w: 80, type: 'number' }), el('<span style="color:var(--muted)">×</span>'), field(g.height, (v) => set({ imagegen: { height: Math.max(256, v || 1024) } }), { w: 80, type: 'number' })])]),
          row('Let the AI choose the size', 'Lyra can ask for square, portrait, landscape, wide, tall or small to fit the request.', toggle(g.letAiChooseSize, (v) => set({ imagegen: { letAiChooseSize: v } }))),
        ]),
        group('Sampling', [
          row('Steps', '', slider(4, 60, 1, g.steps, (v) => `${v}`, (v) => set({ imagegen: { steps: v } }))),
          row('CFG scale', 'How strictly the prompt is followed.', slider(1, 15, 0.5, g.cfg, (v) => v.toFixed(1), (v) => set({ imagegen: { cfg: v } }))),
          ...(g.backend === 'comfyui' ? [row('Sampler', '', select(['euler', 'euler_ancestral', 'dpmpp_2m', 'dpmpp_2m_sde', 'dpmpp_sde', 'ddim', 'uni_pc'].map((x) => ({ v: x, l: x })), g.sampler, (v) => set({ imagegen: { sampler: v } }), 200)), row('Scheduler', '', select(['normal', 'karras', 'exponential', 'sgm_uniform', 'simple', 'beta'].map((x) => ({ v: x, l: x })), g.scheduler, (v) => set({ imagegen: { scheduler: v } }), 200))] : []),
          row('Seed', '-1 picks a random seed each time.', field(g.seed, (v) => set({ imagegen: { seed: Number.isFinite(v) ? v : -1 } }), { w: 140, type: 'number' })),
          row('Negative prompt', 'Added to every request.', field(g.negativePrompt, (v) => set({ imagegen: { negativePrompt: v } }), { w: 320, ph: 'blurry, low quality' })),
          row('Save to', 'Folder inside the workspace.', field(g.folder, (v) => set({ imagegen: { folder: v.trim() || 'images' } }), { w: 160, mono: true })),
        ]),
      ];
    },
    async persona() {
      const s = S(); const p = s.persona;
      const head = el(`<div style="display:flex;align-items:center;gap:16px"><div class="avatar persona-avatar" style="width:56px;height:56px;font-size:22px">${window.avatarUrl(p.avatar) ? `<img src="${esc(window.avatarUrl(p.avatar))}">` : esc(p.name[0] || 'N')}</div><div style="display:flex;flex-direction:column;gap:6px"><div class="d" style="font-size:12px;color:var(--muted);font-weight:500">Name</div><div style="display:flex;gap:8px"></div></div></div>`);
      const r = head.querySelector('div > div:last-child'); r.appendChild(field(p.name, (v) => v.trim() && set({ persona: { name: v.trim() } }), { w: 220 })); r.appendChild(el(`<span class="status-line" title="Only you can change the name">${icon('lock', 13)} locked for the agent</span>`));
      r.appendChild(btn('Change picture', async () => { const f = await lyra.files.pickFile({ filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] }); if (f) set({ persona: { avatar: f } }).then(refresh); }));
      if (p.avatar && !p.avatar.startsWith('builtin:')) r.appendChild(btn('Use the character’s avatar', () => set({ persona: { avatar: s.appearance.gifFolder.startsWith('builtin:') ? s.appearance.gifFolder : 'builtin:catgirl' } }).then(refresh)));
      if (p.avatar) r.appendChild(btn('Remove', () => set({ persona: { avatar: '' } }).then(refresh)));
      const soul = el(`<div style="display:flex;flex-direction:column;gap:6px"><div style="display:flex;align-items:baseline;gap:8px"><span class="t" style="font-size:14px;font-weight:500;color:var(--bright)">Soul</span><span class="d" style="font-size:12px;color:var(--muted)">The character. ${esc(p.name)} reads this at the start of every chat.</span></div><textarea class="field" spellcheck="false"></textarea></div>`);
      const ta = soul.querySelector('textarea'); ta.value = p.soul; ta.addEventListener('change', () => set({ persona: { soul: ta.value } }));
      const longMem = await lyra.memory.list({ scope: 'long' }); const shortMem = await lyra.memory.list({ scope: 'short', chatId: window.LyraApp.chatId() });
      const memList = (items, scope) => { const box = el(`<div class="card" style="gap:0"></div>`); if (!items.length) box.appendChild(el(`<div class="d" style="font-size:12px;color:var(--muted);padding:6px 0">Nothing here yet. ${esc(p.name)} writes entries with the remember tool.</div>`)); items.forEach((m) => { const it = el(`<div class="mem-item"><span class="txt">${esc(m.text)}</span><span class="when">${fmtWhen(m.created_at)}</span><button class="icon-btn" style="width:24px;height:24px" title="Delete">${icon('trash', 13)}</button></div>`); it.querySelector('button').addEventListener('click', async () => { await lyra.memory.delete({ id: m.id }); refresh(); }); box.appendChild(it); }); return box; };
      return [
        title('Persona & chat', `Who ${esc(p.name)} is, and what it remembers.`), head, soul,
        group('Chat', [row(`Messages sent while ${esc(p.name)} is working`, 'Steer folds your message into the running task so it can adjust course. Cancel stops the reply and sends the new message instead. The Stop button always works.', seg([{ v: 'steer', l: 'Steer' }, { v: 'cancel', l: 'Cancel and resend' }], s.chat.followUp, (v) => set({ chat: { followUp: v } })))]),
        group('Memory', [
          row('Memory', `${esc(p.name)} keeps notes between messages and between chats.`, toggle(p.memoryEnabled, (v) => set({ persona: { memoryEnabled: v } }))),
          row('Store', 'Where memory, chats and goals live. Switching migrates the data.', seg([{ v: 'sqlite', l: 'SQLite' }, { v: 'json', l: 'NoSQL (JSON)' }], p.store, (v) => set({ persona: { store: v } }))),
          row('Who writes', `Only ${esc(p.name)} writes to memory. You can read and delete entries here.`, el(`<div class="status-line">${icon('lock', 14)} Only ${esc(p.name)}</div>`)),
          row('Short-term memory', 'Lives inside the current chat.', toggle(p.shortTerm, (v) => set({ persona: { shortTerm: v } }))),
          row('Long-term memory', 'Shared across every chat, e.g. your home network layout.', toggle(p.longTerm, (v) => set({ persona: { longTerm: v } }))),
        ]),
        group('Long-term entries', [memList(longMem, 'long'), longMem.length ? row('', '', btn('Clear all long-term memory', async () => { if (confirm('Delete all long-term memory?')) { await lyra.memory.clear({ scope: 'long' }); refresh(); } }, { danger: true })) : null].filter(Boolean)),
        group('Notes in this chat', [memList(shortMem, 'short')]),
      ];
    },
    async appearance() {
      const s = S(); const a = s.appearance; const themes = await lyra.themes.list();
      const grid = el('<div class="theme-grid"></div>');
      themes.forEach((t) => { const c = el(`<div class="theme-card ${t.id === a.theme ? 'on' : ''}"><div class="sw"><i style="background:${esc(t.vars.bg || '#000')}"></i><i style="background:${esc(t.vars.side || '#222')}"></i><i style="background:${esc(t.vars.accent || '#4fc8b4')}"></i><i style="background:${esc(t.vars.text || '#fff')}"></i></div><div class="n">${esc(t.name)}</div><div class="k">${t.scheme}${t.character === 'pixel' ? ' · pixel character' : ''}${t.builtin ? '' : ' · yours'}</div></div>`); c.addEventListener('click', () => set({ appearance: { theme: t.id } }).then(refresh)); grid.appendChild(c); });
      const themeBtns = el('<div style="display:flex;gap:8px"></div>'); themeBtns.appendChild(btn('Open themes folder', () => lyra.themes.openFolder(), { ic: 'folder' })); themeBtns.appendChild(btn('Rescan', refresh, { ic: 'refresh' }));
      const srcRows = [];
      if (a.source === 'pet') {
        const pets = await lyra.pets.list();
        const opts = [{ v: '', l: pets.length ? 'Choose a pet…' : 'No Hermes pets found' }, ...pets.map((p) => ({ v: p.path, l: `${p.name} (${p.slug}${p.profile !== 'default' ? ' · ' + p.profile : ''})` }))];
        if (a.petFolder && !pets.some((p) => p.path === a.petFolder)) opts.push({ v: a.petFolder, l: a.petFolder.split('/').pop() });
        srcRows.push(row('Hermes pet', 'Installed pets from ~/.hermes (pet.json + spritesheet). Or pick any folder with a petdex spritesheet.', [select(opts, a.petFolder, (v) => set({ appearance: { petFolder: v } }).then(refresh), 300), btn('Folder…', async () => { const f = await lyra.files.pickFolder(); if (f) set({ appearance: { petFolder: f } }).then(refresh); })]));
        srcRows.push(el(`<div class="d" style="font-size:12px;color:var(--muted);padding:4px 0">States: idle → idle row · thinking → review · writing → running · speaking → waving.</div>`));
      }
      if (a.source === 'gif') {
        const packs = await lyra.packs.list(); const cur = a.gifFolder.startsWith('builtin:') ? a.gifFolder.slice(8) : null;
        const grid = el('<div class="theme-grid" style="grid-template-columns:repeat(4,minmax(0,1fr))"></div>');
        packs.forEach((p) => { const c = el(`<div class="theme-card ${p.id === cur ? 'on' : ''}" style="align-items:center;text-align:center"><img src="character/${esc(p.id)}/avatar.png" alt="" style="width:72px;height:72px;border-radius:50%;image-rendering:pixelated"><div class="n">${esc(p.name)}</div>${p.description ? `<div class="k">${esc(p.description)}</div>` : ''}</div>`); c.addEventListener('click', () => { const patch = { appearance: { gifFolder: `builtin:${p.id}` } }; if (!s.persona.avatar || s.persona.avatar.startsWith('builtin:')) patch.persona = { avatar: `builtin:${p.id}` }; set(patch).then(refresh); }); grid.appendChild(c); });
        srcRows.push(el('<div class="group-label">Built-in characters</div>'), grid);
        srcRows.push(row('Your own GIF pack', 'A folder with idle.gif, thinking.gif, writing.gif and speaking.gif; idle-2.gif … idle-6.gif play as idle variations. Ask Lyra to draw a new character (it knows the recipe).', [field(cur ? `Built-in: ${cur}` : a.gifFolder, null, { w: 220, mono: true, ro: true }), btn('Choose folder', async () => { const f = await lyra.files.pickFolder(); if (f) set({ appearance: { gifFolder: f } }).then(refresh); })]));
      }
      if (a.source === 'live2d') srcRows.push(row('Model file', 'A Cubism 4 model (.model3.json). Put live2dcubismcore.min.js from the Live2D site in the same folder.', [field(a.live2dModel, null, { w: 240, mono: true, ro: true }), btn('Choose', async () => { const f = await lyra.files.pickFile({ filters: [{ name: 'Live2D model', extensions: ['json'] }] }); if (f) set({ appearance: { live2dModel: f } }).then(refresh); })]));
      const preview = el(`<div style="display:flex;gap:16px;align-items:stretch"><div class="mini-stage" id="mini-stage"></div><div style="display:flex;flex-direction:column;gap:8px;justify-content:center"><div class="d" style="font-size:12px;color:var(--muted);font-weight:500">Preview a state</div></div></div>`);
      const col = preview.lastElementChild; ['idle', 'thinking', 'writing', 'speaking'].forEach((st, i) => { const b = el(`<button class="btn small ${i === 1 ? 'primary' : ''}" style="justify-content:flex-start">${st[0].toUpperCase() + st.slice(1)}</button>`); b.addEventListener('click', () => { col.querySelectorAll('.btn').forEach((x) => x.classList.toggle('primary', x === b)); previewChar && previewChar.setState(st); }); col.appendChild(b); });
      setTimeout(() => { const t = themes.find((x) => x.id === a.theme); previewChar = new LyraCharacter($('#mini-stage')); previewChar.configure({ source: a.source, gifFolder: a.gifFolder, live2dModel: a.live2dModel, petFolder: a.petFolder, variant: t && t.character === 'pixel' ? 'pixel' : 'default' }); previewChar.setState('thinking'); }, 0);
      return [
        title('Appearance', 'Themes restyle the whole app, and the live character shows how Lyra is doing.'),
        group('Theme', [grid, themeBtns]),
        group('Live character', [
          row(`Show ${esc(s.persona.name)} as a live character`, 'Animates while thinking, writing and speaking, with lip sync when it talks.', toggle(a.liveCharacter, (v) => set({ appearance: { liveCharacter: v } }))),
          row('Source', 'Built-in follows the theme. A Hermes pet is a petdex spritesheet. A GIF pack uses one loop per state. Live2D animates a model you provide.', seg([{ v: 'svg', l: 'Built-in' }, { v: 'pet', l: 'Hermes pet' }, { v: 'gif', l: 'GIF pack' }, { v: 'live2d', l: 'Live2D' }], a.source, (v) => set({ appearance: { source: v } }).then(refresh))),
          ...srcRows,
          row('Where', 'Floating puts the character over the chat; drag it anywhere.', seg([{ v: 'panel', l: 'Right panel' }, { v: 'floating', l: 'Floating' }, { v: 'header', l: 'Header only' }], a.placement, (v) => set({ appearance: { placement: v } }))),
          row('Transitions', 'Speed of UI and state transitions.', slider(0, 800, 50, a.transitionMs, (v) => `${v} ms`, (v) => set({ appearance: { transitionMs: v } }))),
        ]),
        preview,
      ];
    },
    async workspace() {
      const s = S(); const w = s.workspace; const tree = await lyra.workspace.tree(); const repos = await lyra.workspace.repos();
      const list = el('<div class="list"></div>');
      tree.slice(0, 12).forEach((e) => list.appendChild(el(`<div class="item">${icon(e.dir ? 'folder' : 'file', 15)}<span class="n mono">${esc(e.name)}</span><span class="spacer"></span><span class="d">${e.dir ? `${e.count} items` : `${e.size} B`}</span></div>`)));
      if (!tree.length) list.appendChild(el('<div class="item"><span class="d">Empty. Lyra creates files here.</span></div>'));
      const repoList = el('<div class="list"></div>'); repos.forEach((r) => repoList.appendChild(el(`<div class="item on">${icon('git', 15)}<div class="col"><span class="n">${esc(r.name)}</span><span class="d">${esc(r.branch)}${r.dirty ? ' · uncommitted changes' : ''} · ${esc(r.last)}</span></div></div>`)));
      if (!repos.length) repoList.appendChild(el('<div class="item"><span class="d">No git repositories found in the workspace (searched 3 levels deep).</span></div>'));
      return [
        title('Workspace', `A folder of ${esc(s.persona.name)}’s own. Files, folders and images it makes land here.`),
        row('Folder', '', [field(w.folder, null, { w: 280, mono: true, ro: true }), btn('Change', async () => { if (await lyra.workspace.choose()) refresh(); }), btn('Open', () => lyra.workspace.open(), { ic: 'folder' })]),
        list,
        group('Abilities', [
          row('Repository discovery', 'Find git repositories in the workspace and tell Lyra about them.', toggle(w.repoDiscovery, (v) => set({ workspace: { repoDiscovery: v } }).then(refresh))),
          row('Code execution', 'Run python, node or bash snippets inside the workspace.', toggle(w.codeExecution, (v) => set({ workspace: { codeExecution: v } }))),
          row('Persistent shell', 'One shell stays open between commands, so cwd and variables carry over.', toggle(w.persistentShell, (v) => set({ workspace: { persistentShell: v } }))),
          row('File read limit', 'Characters per read; larger files are read in chunks.', [field(w.fileReadLimit, (v) => set({ workspace: { fileReadLimit: Math.max(1000, v || 100000) } }), { w: 120, type: 'number' }), 'chars']),
        ]),
        w.repoDiscovery ? group('Repositories', [repoList]) : null,
      ].filter(Boolean);
    },
    async safety() {
      const s = S(); const sf = s.safety;
      const modes = [['ask', 'Ask for approval', 'Lyra asks before running commands, writing outside the workspace, or submitting forms. With smart approvals on, low-risk steps run on their own.'], ['auto', 'Auto-approve', 'Lyra approves its own actions; every one is still listed in the chat.'], ['none', 'No restrictions', 'Nothing is gated. Only on a machine you can afford to lose.']];
      const cards = el('<div style="display:flex;flex-direction:column;gap:8px"><div class="group-label">Approval mode</div></div>');
      modes.forEach(([v, t, d]) => { const c = el(`<div class="radio-card ${sf.approvalMode === v ? 'on' : ''}"><div class="r"></div><div><div class="t ${v === 'none' ? 'warn' : ''}">${t}</div><div class="d">${d}</div></div></div>`); c.addEventListener('click', () => set({ safety: { approvalMode: v } }).then(refresh)); cards.appendChild(c); });
      return [
        title('Safety', `What ${esc(s.persona.name)} may do on its own, and how long it waits for you. This section is locked for the agent.`), cards,
        group('Waiting on you', [
          row('Approval timeout', 'How long Lyra waits for an answer before moving on.', select([{ v: 60, l: '1 minute' }, { v: 300, l: '5 minutes' }, { v: 900, l: '15 minutes' }, { v: 1800, l: '30 minutes' }, { v: 86400, l: 'A day' }], sf.timeoutSec, (v) => set({ safety: { timeoutSec: Number(v) } }), 160)),
          row('When it times out', '', seg([{ v: 'deny', l: 'Deny' }, { v: 'approve', l: 'Approve' }], sf.onTimeout, (v) => set({ safety: { onTimeout: v } }))),
          row('Smart approvals', 'Set under Model.', el(`<span style="font-size:13px;font-weight:500;color:${s.model.smartApprovals ? 'var(--accent)' : 'var(--muted)'}">${s.model.smartApprovals ? 'On' : 'Off'}</span>`)),
        ]),
      ];
    },
    async browser() {
      const s = S(); const b = s.browser;
      return [
        title('Browser', `${esc(s.persona.name)} can drive its own browser inside the app, so you can watch what it does.`),
        group('', [
          row(`${esc(s.persona.name)} can use a browser`, '', toggle(b.enabled, (v) => set({ browser: { enabled: v } }))),
          row('Mode', 'Headless browsing shows as a status line in chat instead of a panel.', seg([{ v: 'visible', l: 'Visible in app' }, { v: 'headless', l: 'Headless' }], b.mode, (v) => set({ browser: { mode: v } }))),
          row('Open the panel automatically', `When ${esc(s.persona.name)} starts browsing.`, toggle(b.autoOpen, (v) => set({ browser: { autoOpen: v } }))),
          row('Start page', '', field(b.startPage, (v) => set({ browser: { startPage: v || 'about:blank' } }), { w: 240, mono: true })),
          row('Ask before downloads', 'Downloads count as an approval under Safety and land in workspace/downloads.', toggle(b.askBeforeDownloads, (v) => set({ browser: { askBeforeDownloads: v } }))),
          row('Browsing data', `Cookies and history from ${esc(s.persona.name)}’s browser only.`, btn('Clear', async () => { await lyra.browser.clear(); toast('Browsing data cleared.'); })),
        ]),
      ];
    },
    async memory() {
      const s = S(); const m = s.memory;
      let ctx = null; try { ctx = await lyra.chat.context({ chatId: window.LyraApp.chatId() }); } catch {}
      const pct = ctx && ctx.context ? Math.min(100, Math.round((ctx.used / ctx.context) * 100)) : 0;
      const fmt = (n) => Number(n || 0).toLocaleString();
      const partRow = (label, value) => `<div style="display:flex;justify-content:space-between;font-size:12px"><span style="color:var(--muted)">${label}</span><span style="color:var(--text);font-variant-numeric:tabular-nums">${fmt(value)}</span></div>`;
      const meter = el(`<div class="card">
        <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--muted)"><span>This chat, right now</span><span style="color:var(--text);font-variant-numeric:tabular-nums">${ctx && ctx.context ? `${fmt(ctx.used)} / ${fmt(ctx.context)} tokens · ${pct}%` : 'no model reachable'}</span></div>
        <div class="meter"><div class="fill" style="width:${pct}%;background:${pct >= 95 ? 'var(--danger)' : pct >= m.threshold * 100 ? 'var(--warn)' : 'var(--accent)'}"></div><div class="mark" style="left:${Math.round(m.threshold * 100)}%"></div></div>
        <div style="font-size:11px;color:var(--muted)">${ctx ? `${esc(ctx.label || ctx.model)}${ctx.provider ? ' · ' + esc(ctx.provider) : ''} · context ${ctx.contextMode === 'manual' ? 'set by hand' : 'read from the server'}` : ''}${m.autoCompression ? ` · compresses at ${Math.round(m.threshold * 100)}%` : ' · compression off'}</div>
        ${ctx ? `<div style="display:flex;flex-direction:column;gap:3px;margin-top:4px">${partRow('Soul, memory and workspace', ctx.parts.system)}${partRow('Tool descriptions', ctx.parts.tools)}${partRow(`Conversation (${ctx.messages} messages)`, ctx.parts.history)}${ctx.parts.summary ? partRow(`Summary of folded turns (${ctx.summarized})`, ctx.parts.summary) : ''}</div>` : ''}
      </div>`);
      return [
        title('Memory & context', `How much ${esc(s.persona.name)} remembers, and what happens when the context fills up. The same figure sits under the message box in every chat.`), meter,
        group('Memory', [
          row('Long-term memory', 'Persistent across chats. Off keeps memory inside each chat.', toggle(m.longTerm, (v) => set({ memory: { longTerm: v } }))),
          row('Memory budget', 'Tokens of long-term memory loaded into each chat.', slider(500, 32000, 500, m.memoryBudget, (v) => `${v.toLocaleString()} tokens`, (v) => set({ memory: { memoryBudget: v } }))),
          row('Profile budget', 'Room reserved for the soul and profile.', slider(200, 8000, 100, m.profileBudget, (v) => `${v.toLocaleString()} tokens`, (v) => set({ memory: { profileBudget: v } }))),
        ]),
        group('Context engine', [
          row('Auto compression', 'Summarise older turns when the context fills up.', toggle(m.autoCompression, (v) => set({ memory: { autoCompression: v } }))),
          row('Compression threshold', 'Start compressing at this share of the context.', slider(0.4, 0.95, 0.05, m.threshold, (v) => `${Math.round(v * 100)}%`, (v) => set({ memory: { threshold: v } }).then(refresh))),
          row('Compression target', 'How much of the context to keep afterwards.', slider(0.2, 0.8, 0.05, m.target, (v) => `${Math.round(v * 100)}%`, (v) => set({ memory: { target: v } }))),
        ]),
      ];
    },
    async voice() {
      const s = S(); const v = s.voice; const paths = await lyra.app.paths(); const vs = await lyra.voice.status(); let voices = ['Rosie', 'Bella', 'Jasmine', 'Luna', 'Jasper', 'Leo', 'Ben', 'Axel'];
      if (paths.voiceReady) { try { voices = await lyra.voice.voices(); } catch {} }
      const lastLine = vs.last ? `Last reply spoken with ${vs.last.engine === 'kitten' ? `KittenTTS · ${vs.last.voice}${vs.last.chunks ? ` · ${vs.last.chunks} chunk${vs.last.chunks > 1 ? 's' : ''}, ${vs.last.seconds}s of audio` : ''}` : vs.last.engine === 'custom' ? 'your TTS endpoint' : 'the macOS system voice' + (vs.last.error ? ' — KittenTTS failed: ' + vs.last.error.slice(0, 140) : '')}.` : 'Nothing spoken yet this session.';
      const installCard = el(`<div class="card"><div class="status-line"><span class="dot off"></span>Voice engine not installed. Replies use the macOS system voice, which ignores the voice choice; speech to text is unavailable.</div><div class="d" style="font-size:12px;color:var(--muted)">Install it under Lyra’s own data folder (needs uv or python3, and espeak-ng from Homebrew). Takes a few minutes and downloads about 300 MB.</div><div style="display:flex;gap:8px"></div></div>`);
      installCard.lastElementChild.appendChild(btn(vs.installing ? 'Installing…' : 'Install voice engine', async (e) => { e.target.disabled = true; e.target.textContent = 'Installing…'; const r = await lyra.voice.setup(); toast(r.ok ? 'Voice engine installed' : 'Install failed: ' + r.log.slice(-200), r.ok ? '' : 'error'); refresh(); }, { primary: true, ic: 'download' }));
      const engineRows = v.engine === 'custom' ? [
        row('Endpoint', 'An OpenAI-compatible /v1 base URL with /audio/speech.', field(v.customEndpoint, (x) => set({ voice: { customEndpoint: x } }), { w: 260, mono: true })),
        row('Model', '', field(v.customModel, (x) => set({ voice: { customModel: x } }), { w: 160 })),
        row('Voice', '', field(v.customVoice, (x) => set({ voice: { customVoice: x } }), { w: 160 })),
      ] : [
        row('KittenTTS model', '', select([{ v: 'KittenML/kitten-tts-nano-0.1', l: 'kitten-tts-nano-0.1' }], v.kittenModel, (x) => set({ voice: { kittenModel: x } }), 220)),
        row('Voice', 'Names map to KittenTTS voices in voice/server.py.', [select(voices.map((x) => ({ v: x, l: x })), v.voice, (x) => set({ voice: { voice: x } }), 160), btn('Play sample', async (e) => { e.target.disabled = true; try { const a = await lyra.voice.speak({ text: `Hi, I’m ${s.persona.name}. This is how I sound.` }); if (a) window.LyraApp.playFile(a.path); } catch (err) { toast(err.message, 'error'); } finally { e.target.disabled = false; } }, { ic: 'play' })]),
      ];
      return [
        title('Voice', `${esc(s.persona.name)} speaks with KittenTTS running locally. Bring your own engine if you prefer.`),
        paths.voiceReady ? el(`<div class="card"><div class="status-line"><span class="dot"></span>Voice engine installed (KittenTTS + Whisper) · ${esc(vs.python)}</div><div class="d" style="font-size:12px;color:var(--muted)">${esc(lastLine)}</div></div>`) : installCard,
        row('Python for the sidecar', 'Leave empty to auto-detect (the source folder’s voice/.venv, or voice/.venv under the app data folder).', [field(v.sidecarPython, (x) => set({ voice: { sidecarPython: x } }).then(refresh), { w: 260, mono: true, ph: 'auto' }), btn('Choose', async () => { const f = await lyra.files.pickFile({}); if (f) set({ voice: { sidecarPython: f } }).then(refresh); })]),
        group('Text to speech', [
          row('Engine', 'KittenTTS is built in. “Your own” points at any OpenAI-compatible TTS endpoint.', seg([{ v: 'kitten', l: 'KittenTTS' }, { v: 'custom', l: 'Your own' }], v.engine, (x) => set({ voice: { engine: x } }).then(refresh))),
          ...engineRows,
          row('Read responses aloud', `${esc(s.persona.name)} speaks every reply. Long replies are split into sentences and joined, because the engine can only synthesise about 450 characters at a time.`, toggle(v.readAloud, (x) => set({ voice: { readAloud: x } }))),
          row('Voice engine status', paths.voiceReady ? 'Loads its model in the background after start.' : 'Not installed yet.', [el(`<span class="d" style="font-size:12px;color:var(--muted);max-width:260px">${esc(lastLine)}</span>`), btn('Warm up now', async (e) => { e.target.disabled = true; const ok = await lyra.voice.warm(); toast(ok ? 'Voice engine loaded and ready.' : 'Could not load the voice engine; see Settings › Recovery › Logs.', ok ? '' : 'error'); refresh(); })]),
        ]),
        group('Speech to text', [
          row('Speak in chat', 'Tap the mic to record; tap again to send. Audio is sent as a voice message.', toggle(v.stt, (x) => set({ voice: { stt: x } }))),
          row('Show transcript of your audio', 'Under each voice message.', toggle(v.showTranscript, (x) => set({ voice: { showTranscript: x } }))),
          row('Model', 'Whisper, local. Larger is slower and more accurate.', select(['tiny', 'base', 'small', 'medium', 'large-v3'].map((x) => ({ v: x, l: `Whisper ${x}` })), v.sttModel, (x) => set({ voice: { sttModel: x } }), 180)),
        ]),
      ];
    },
    async notifications() {
      const s = S(); const n = s.notifications; const st = await lyra.app.notifyStatus();
      const hint = el(`<div class="card"><div class="status-line"><span class="dot ${st.blocked ? 'off' : ''}"></span>${st.blocked ? 'macOS is blocking native notifications for this app; Lyra uses the system AppleScript banner instead (it still shows and can play a sound).' : 'Native notifications available. If none appear, allow Lyra under macOS System Settings › Notifications.'}</div><div style="display:flex;gap:8px"></div></div>`);
      hint.lastElementChild.appendChild(btn('Open macOS notification settings', () => lyra.app.openNotificationSettings(), { ic: 'bell' }));
      return [
        title('Notifications', `When ${esc(s.persona.name)} should get your attention. Except for the test button, they are sent only while the window is not focused.`), hint,
        group('', [
          row('Desktop notifications', '', toggle(n.desktop, (v) => set({ notifications: { desktop: v } }))),
          row('Needs your approval', 'A command or action is waiting on you.', toggle(n.approvals, (v) => set({ notifications: { approvals: v } }))),
          row('Long task finished', 'Replies that took more than 20 seconds.', toggle(n.longTask, (v) => set({ notifications: { longTask: v } }))),
          row(`New goal or idea from ${esc(s.persona.name)}`, 'From the AI goals menu.', toggle(n.goals, (v) => set({ notifications: { goals: v } }))),
          row('Sound', 'Plays with each notification.', toggle(n.sound, (v) => set({ notifications: { sound: v } }))),
          row('Test', '', btn('Send a test notification', async () => { const ok = await lyra.app.notifyTest(); if (!ok) toast('Notifications are off.'); })),
        ]),
      ];
    },
    async provider() {
      const s = S(); const m = window.LyraApp.models() || { byProvider: {} }; const provs = s.providers.list;
      const RUNTIMES = [{ v: 'lmstudio', l: 'LM Studio', ep: 'http://localhost:1234/v1' }, { v: 'ollama', l: 'Ollama', ep: 'http://localhost:11434/v1' }, { v: 'llamacpp', l: 'llama.cpp server', ep: 'http://localhost:8080/v1' }, { v: 'openai', l: 'OpenAI-compatible / remote API', ep: 'https://api.example.com/v1' }];
      const save = (list) => set({ providers: { list } }).then(() => lyra.models.detect()).then(refresh);
      const cards = el('<div style="display:flex;flex-direction:column;gap:10px"></div>');
      provs.forEach((p, i) => {
        const info = m.byProvider[p.id]; const inUse = [s.model.chat.provider === p.id ? 'brain' : null, s.model.vision.provider === p.id ? 'vision' : null].filter(Boolean);
        const c = el(`<div class="card" style="gap:10px"><div style="display:flex;align-items:center;gap:8px"><span style="display:flex;color:var(--muted)">${icon('server', 16)}</span><span class="spacer"></span></div><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"></div><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"></div><div class="status-line"></div></div>`);
        const head = c.children[0], l1 = c.children[1], l2 = c.children[2], st = c.children[3];
        head.insertBefore(field(p.name, (v) => { const list = provs.map((x) => x.id === p.id ? { ...x, name: v.trim() || x.name } : x); set({ providers: { list } }).then(refresh); }, { w: 200 }), head.lastElementChild);
        if (inUse.length) head.insertBefore(el(`<span class="d" style="font-size:12px;color:var(--accent)">used for ${inUse.join(' + ')}</span>`), head.lastElementChild);
        const rm = el(`<button class="icon-btn" title="Remove preset">${icon('trash', 15)}</button>`); rm.disabled = provs.length === 1; rm.addEventListener('click', () => { if (provs.length === 1) return; if (!confirm(`Remove “${p.name}”?`)) return; const list = provs.filter((x) => x.id !== p.id); const patch = { providers: { list } }; const fb = list[0].id; const mp = {}; if (s.model.chat.provider === p.id) mp.chat = { provider: fb, model: '' }; if (s.model.vision.provider === p.id) mp.vision = { provider: fb, model: '' }; if (Object.keys(mp).length) patch.model = mp; set(patch).then(() => lyra.models.detect()).then(refresh); }); head.appendChild(rm);
        l1.appendChild(select(RUNTIMES, p.runtime, (v) => { const r = RUNTIMES.find((x) => x.v === v); save(provs.map((x) => x.id === p.id ? { ...x, runtime: v, endpoint: r.ep } : x)); }, 220));
        l1.appendChild(field(p.endpoint, (v) => save(provs.map((x) => x.id === p.id ? { ...x, endpoint: v.trim().replace(/\/$/, '') } : x)), { w: 300, mono: true, ph: 'http://localhost:1234/v1' }));
        l2.appendChild(field(p.apiKey, (v) => save(provs.map((x) => x.id === p.id ? { ...x, apiKey: v.trim() } : x)), { w: 300, type: 'password', ph: p.runtime === 'openai' ? 'API key (sent as bearer token)' : 'API key (not needed locally)' }));
        l2.appendChild(btn('Test', async (e) => { e.target.disabled = true; try { const r = await lyra.app.testConnection({ endpoint: p.endpoint, apiKey: p.apiKey }); toast(r.ok ? `${p.name}: ${r.count} models (${r.source})` : `${p.name}: not reachable (${r.error || 'unknown error'})`, r.ok ? '' : 'error'); await lyra.models.detect(); refresh(); } finally { e.target.disabled = false; } }));
        st.innerHTML = info ? (info.ok ? `<span class="dot"></span>Connected · ${info.list.length} models · ${esc(info.source)}` : `<span class="dot off"></span>Not reachable: ${esc(info.error || 'unknown error')}`) : '<span class="dot off"></span>Not checked';
        cards.appendChild(c);
      });
      const add = el('<div style="display:flex;gap:8px;flex-wrap:wrap"></div>');
      RUNTIMES.forEach((r) => add.appendChild(btn(`Add ${r.l}`, () => { const id = `${r.v}-${Date.now().toString(36)}`; save([...provs, { id, name: provs.some((x) => x.name === r.l) ? `${r.l} ${provs.length + 1}` : r.l, runtime: r.v, endpoint: r.ep, apiKey: '' }]); }, { ic: 'plus' })));
      return [
        title('Provider', 'Presets for where models run. Add one per runtime or API, then pick a preset for the brain and for the vision model under Model. Local runtimes keep everything on this machine.'),
        cards, group('Add a preset', [add]),
      ];
    },
    async mobile() {
      const s = S(); const m = s.mobile;
      const st = await lyra.mobile.state();
      const net = await lyra.mobile.tailnet();
      const box = [];
      box.push(title('Mobile', `Reach ${esc(s.persona.name)} from your phone over your private Tailscale network. The connection is encrypted twice: Tailscale's own tunnel, plus a real HTTPS certificate, which is what lets the phone use the microphone.`));

      // status card
      const statusCard = el('<div class="card" style="gap:10px"></div>');
      if (!net.ok) {
        statusCard.appendChild(el(`<div class="status-line"><span class="dot off"></span>${esc(net.error || 'Tailscale not ready')}</div>`));
        const help = el('<div class="d" style="font-size:12px;color:var(--muted);line-height:1.5"></div>');
        help.innerHTML = /not found/i.test(net.error || '') ? 'Install Tailscale on this Mac and on your phone, sign both into the same account, then come back here.' : /log|sign/i.test(net.error || '') ? 'Open the Tailscale app on this Mac and sign in.' : 'Open the Tailscale app and connect, then press Check again.';
        statusCard.appendChild(help);
        const row1 = el('<div style="display:flex;gap:8px;flex-wrap:wrap"></div>');
        row1.appendChild(btn('Get Tailscale', () => lyra.app.openExternal({ url: 'https://tailscale.com/download' }), { ic: 'globe' }));
        row1.appendChild(btn('Check again', refresh, { ic: 'refresh' }));
        statusCard.appendChild(row1);
      } else {
        statusCard.appendChild(el(`<div class="status-line"><span class="dot${st.running ? '' : ' off'}"></span>${st.running ? 'Phone access is on' : 'Phone access is off'} · this Mac is <b style="color:var(--text)">${esc(net.host)}</b> on your tailnet</div>`));
        if (!net.certOk) statusCard.appendChild(el('<div class="d" style="font-size:12px;color:var(--warn)">HTTPS certificates are not enabled for your tailnet yet. Open the Tailscale admin console, DNS tab, and turn on HTTPS Certificates. Then switch this on.</div>'));
        if (st.error) statusCard.appendChild(el(`<div class="d" style="font-size:12px;color:var(--danger)">${esc(st.error)}</div>`));
        const phones = (net.devices || []).filter((d) => /ios|android/i.test(d.os || ''));
        statusCard.appendChild(el(`<div class="d" style="font-size:12px;color:var(--muted)">${phones.length ? `Phones on your tailnet: ${phones.map((d) => esc(d.name) + (d.online ? '' : ' (offline)')).join(', ')}` : 'No phone on your tailnet yet. Install Tailscale on the phone and sign in with the same account.'}${st.cert ? ` · certificate valid ${st.cert.days} more days` : ''}</div>`));
      }
      box.push(statusCard);

      box.push(group('', [
        row('Phone access', 'Serves the chat on your tailnet address only. Nothing is exposed to the internet.', toggle(m.enabled && st.running, async (v) => {
          const r = v ? await lyra.mobile.start() : await lyra.mobile.stop();
          if (r && r.ok === false) toast(r.error || 'Could not start', 'error');
          refresh();
        })),
        row('Start with the app', 'Switch it on automatically when Lyra opens.', toggle(m.autoStart, (v) => set({ mobile: { autoStart: v } }))),
        row('Port', 'Only change this if something else uses the port.', field(m.port, (v) => set({ mobile: { port: Math.max(1024, Math.min(65535, v || 8443)) } }).then(refresh), { w: 100, type: 'number' })),
        row('Allow risky actions from the phone', `Off means ${esc(s.persona.name)} will chat, look at pictures and browse from your phone, but will not run shell commands or edit the app from there.`, toggle(m.allowHighRiskTools, (v) => set({ mobile: { allowHighRiskTools: v } }))),
      ]));

      // pairing: QR always visible while running
      if (st.running && st.pairUrl) {
        const svg = await lyra.mobile.qr({ text: st.pairUrl, width: 210 });
        const pairCard = el(`<div class="card" style="flex-direction:row;gap:18px;align-items:center;flex-wrap:wrap">
          <div style="background:#fff;padding:10px;border-radius:12px;line-height:0">${svg}</div>
          <div style="display:flex;flex-direction:column;gap:8px;flex:1;min-width:240px">
            <div class="t" style="font-size:14px;font-weight:500;color:var(--bright)">Point your phone camera at this</div>
            <div class="d" style="font-size:12px;color:var(--muted);line-height:1.55">It opens Lyra in Safari and pairs the phone in one step. Or type the address and code by hand.</div>
            <div style="display:flex;flex-direction:column;gap:4px">
              <span class="d" style="font-size:11px;color:var(--muted)">Address</span>
              <span class="mono" style="font-family:var(--mono);font-size:13px;color:var(--text);word-break:break-all">${esc(st.url)}</span>
            </div>
            <div style="display:flex;align-items:center;gap:10px">
              <div style="display:flex;flex-direction:column;gap:4px"><span class="d" style="font-size:11px;color:var(--muted)">Pairing code</span><span style="font-family:var(--mono);font-size:22px;font-weight:600;letter-spacing:3px;color:var(--accent)">${esc(st.pairing)}</span></div>
            </div>
          </div>
        </div>`);
        const acts = el('<div style="display:flex;gap:8px;flex-wrap:wrap"></div>');
        acts.appendChild(btn('Copy address', async () => { await navigator.clipboard.writeText(st.url); toast('Address copied.'); }, { ic: 'file' }));
        acts.appendChild(btn('New code', async () => { await lyra.mobile.newCode(); refresh(); }, { ic: 'refresh' }));
        acts.appendChild(btn('Renew certificate', async () => { const r = await lyra.mobile.renewCert(); toast(r.ok ? `Certificate renewed, ${r.cert.days} days left.` : r.error, r.ok ? '' : 'error'); refresh(); }, { ic: 'shield' }));
        box.push(group('Pair a phone', [pairCard, acts]));

        const steps = el(`<div class="card"><div class="d" style="font-size:13px;color:var(--text);line-height:1.7">
          <b>On the iPhone, once:</b><br>
          1. Install Tailscale from the App Store and sign in with the same account as this Mac.<br>
          2. Point the Camera app at the code above and tap the link. Safari opens and pairs the phone.<br>
          3. In Safari, tap the <b>Share</b> button at the bottom, then <b>Add to Home Screen</b>, then <b>Add</b>.<br>
          4. Open Lyra from the home screen. It runs full screen, and the first time you tap the microphone, allow access.<br>
          <span class="d" style="font-size:12px;color:var(--muted)">Android is the same with Chrome: tap the three dots, then Add to Home screen.</span>
        </div></div>`);
        box.push(group('How to set it up on the phone', [steps]));
      }

      // paired devices
      const devs = st.devices || [];
      const list = el('<div class="list"></div>');
      devs.forEach((d) => {
        const it = el(`<div class="item"><span style="display:flex;color:var(--accent)">${icon('user', 16)}</span><div class="col"><span class="n">${esc(d.name)}</span><span class="d">paired ${new Date(d.created).toLocaleDateString()} · last seen ${new Date(d.lastSeen).toLocaleString()}</span></div></div>`);
        it.appendChild(btn('Remove', async () => { if (confirm(`Remove ${d.name}? It will need the code again.`)) { await lyra.mobile.revoke({ id: d.id }); refresh(); } }, { danger: true }));
        list.appendChild(it);
      });
      if (!devs.length) list.appendChild(el('<div class="item"><span class="d">No phones paired yet.</span></div>'));
      box.push(group('Paired phones', [list]));
      return box;
    },
    async extensions() {
      const s = S(); const list = await lyra.extensions.list();
      const box = el('<div style="display:flex;flex-direction:column;gap:10px"></div>');
      const color = { active: 'var(--accent)', disabled: 'var(--muted)', 'pending-approval': 'var(--warn)', quarantined: 'var(--danger)', broken: 'var(--danger)', inactive: 'var(--muted)' };
      list.forEach((x) => {
        const c = el(`<div class="card" style="gap:8px"><div style="display:flex;align-items:center;gap:10px"><span style="display:flex;color:${color[x.status]}">${icon('tool', 16)}</span><div class="col" style="flex:1;min-width:0"><div class="n" style="font-size:14px;font-weight:500;color:var(--bright)">${esc(x.name)} <span class="d" style="font-size:12px;color:var(--muted)">${esc(x.version)}</span></div><div class="d" style="font-size:12px;color:var(--muted)">${esc(x.description)}</div></div><span class="tag" style="font-size:11px;font-weight:600;color:${color[x.status]}">${x.status.replace('-', ' ')}</span></div><div class="d" style="font-size:12px;color:var(--muted)">Capabilities: ${x.capabilities.length ? x.capabilities.map(esc).join(', ') : 'none'}${x.tools.length ? ' · Tools: ' + x.tools.map(esc).join(', ') : ''}${x.panel ? ' · has a panel' : ''}${x.error ? `<br><span style=\"color:var(--danger)\">${esc(x.error)}</span>` : ''}</div><div style="display:flex;gap:8px"></div></div>`);
        const acts = c.lastElementChild;
        if (x.status === 'pending-approval') acts.appendChild(btn(`Approve (${x.pending.join(', ') || 'no capabilities'})`, async () => { await lyra.extensions.approve({ id: x.id }); refresh(); }, { primary: true }));
        if (x.status === 'active' || x.status === 'inactive') acts.appendChild(btn('Disable', async () => { await lyra.extensions.set({ id: x.id, enabled: false }); refresh(); }));
        if (x.status === 'disabled' || x.status === 'quarantined') acts.appendChild(btn(x.status === 'quarantined' ? 'Clear quarantine and enable' : 'Enable', async () => { await lyra.extensions.set({ id: x.id, enabled: true }); refresh(); }));
        box.appendChild(c);
      });
      if (!list.length) box.appendChild(el(`<div class="card dashed"><div class="d" style="font-size:12px;color:var(--muted)">No extensions yet. Ask ${esc(s.persona.name)} to build one (“add a tool that…”, “make a panel that…”), or drop a folder into the extensions folder.</div></div>`));
      return [
        title('Extensions', `Abilities added on top of the app, by you or by ${esc(s.persona.name)}. Each declares what it can reach and is approved once; ones that fail are quarantined.`),
        row('Extension tools', `${esc(s.persona.name)} may use tools from active extensions.`, toggle(s.tools.ext !== false, (v) => set({ tools: { ext: v } }))),
        el('<div style="display:flex;gap:8px"></div>'), box,
      ].map((x, i) => { if (i === 2) { x.appendChild(btn('Open extensions folder', () => lyra.extensions.openFolder(), { ic: 'folder' })); x.appendChild(btn('Reload all', async () => { await lyra.kernel.reload({ what: 'extensions' }); refresh(); }, { ic: 'refresh' })); } return x; });
    },
    async recovery() {
      const s = S(); const st = await lyra.kernel.state(); const cps = await lyra.kernel.checkpoints(); const health = await lyra.kernel.health();
      const info = el(`<div class="card"><div class="kv"><b>App version</b><span>${esc(st.version)}</span><b>Organs</b><span>${esc(st.organsVersion || '?')} · generation ${st.organsGeneration}</span><b>Last known good</b><span>${esc(st.lastKnownGood || 'none yet')}</span><b>Self-modification budget</b><span>${st.budget.used} of ${st.budget.limit} writes used today</span><b>Pending changes</b><span>${st.pendingChanges ? 'yes, will apply after the current turn' : 'none'}</span><b>State folder</b><span class="mono" style="font-family:var(--mono);font-size:12px">${esc(st.statePath)}</span></div></div>`);
      const actions = el('<div style="display:flex;gap:8px;flex-wrap:wrap"></div>');
      actions.appendChild(btn('Create checkpoint', async () => { const r = await lyra.kernel.checkpoint({ label: 'Manual checkpoint' }); toast(r ? `Checkpoint ${r.hash} saved` : 'Nothing changed since the last checkpoint'); refresh(); }, { ic: 'database' }));
      actions.appendChild(btn('Reload UI', () => lyra.kernel.reload({ what: 'renderer' }), { ic: 'refresh' }));
      actions.appendChild(btn('Hot-swap main organs', async () => { const r = await lyra.kernel.reload({ what: 'main' }); toast(r.ok ? 'Main organs reloaded' : 'Reload failed: ' + (r.errors[0] || {}).message, r.ok ? '' : 'error'); refresh(); }, { ic: 'cpu' }));
      actions.appendChild(btn('Verify organs', async () => { const v = await lyra.kernel.verify({ what: 'all' }); toast(v.ok ? 'All organs verify clean' : `${v.errors.length} problem(s): ${v.errors[0].file}`, v.ok ? '' : 'error'); }, { ic: 'check' }));
      actions.appendChild(btn('Open state folder', () => lyra.kernel.openState(), { ic: 'folder' }));
      actions.appendChild(btn('Reset organs to shipped', async () => { if (!confirm('Replace the live organs with the shipped version? A checkpoint is taken first.')) return; await lyra.kernel.resetShipped(); toast('Organs reset to shipped'); refresh(); }, { danger: true }));
      const list = el('<div class="list"></div>');
      cps.slice(0, 25).forEach((c) => { const it = el(`<div class="item"><span class="mono" style="font-family:var(--mono);font-size:12px;color:var(--muted)">${esc(c.hash)}</span><div class="col"><span class="n">${esc(c.label)}${c.lkg ? ' <span style=\"color:var(--accent);font-size:11px\">last known good</span>' : ''}</span><span class="d">${new Date(c.time).toLocaleString()}</span></div></div>`); it.appendChild(btn('Roll back', async () => { if (!confirm(`Roll everything back to ${c.hash}?`)) return; await lyra.kernel.rollback({ ref: c.hash }); toast('Rolled back'); refresh(); })); list.appendChild(it); });
      if (!cps.length) list.appendChild(el('<div class="item"><span class="d">No checkpoints (git not available?)</span></div>'));
      return [
        title('Recovery', `Checkpoints of everything ${esc(s.persona.name)} may change: organs, extensions, themes and settings. Chats and memory live outside and are never touched.`), info, actions,
        group('Kernel', [
          row('Checkpoints', 'Snapshot the state folder before agent changes and after healthy boots.', toggle(s.kernel.checkpoints, (v) => set({ kernel: { checkpoints: v } }))),
          row('Auto-apply', `Apply ${esc(s.persona.name)}’s organ edits automatically when its turn ends (it can also call apply_changes itself).`, toggle(s.kernel.autoApply, (v) => set({ kernel: { autoApply: v } }))),
          row('Daily self-modification budget', 'Writes to settings, themes, extensions and organs per day.', select([20, 60, 150, 500].map((n) => ({ v: n, l: `${n} writes` })), s.kernel.dailyWrites, (v) => set({ kernel: { dailyWrites: Number(v) } }), 140)),
          row('Safe mode', 'Three failed starts in a row open the recovery screen; you can also start Lyra with --safe.', el('<span class="d" style="font-size:12px;color:var(--muted)">automatic</span>')),
        ]),
        group('Checkpoints', [list]),
        group('Logs', [await logsBlock()]),
        group('Boot history', [el(`<div class="card"><div class="log" style="font-family:var(--mono);font-size:11px;color:var(--muted);white-space:pre-wrap;max-height:160px;overflow:auto">${esc(health || 'empty')}</div></div>`)]),
      ];
    },
    async tools() {
      const s = S(); const t = s.tools;
      const items = [['read_file', 'file', 'Read files', 'Inside the workspace, up to the read limit; outside it asks.'], ['write_file', 'pen', 'Write files', 'Create and edit files; outside the workspace asks.'], ['shell', 'terminal', 'Shell commands', 'Persistent shell in the workspace. Always asks in Ask mode.'], ['run_code', 'cpu', 'Code execution', 'Run python, node or bash snippets.'], ['browser', 'globe', 'Browser', 'Open, read, click, type, scroll, screenshot.'], ['web_search', 'search', 'Web search', 'Search the web through the headless browser.'], ['vision', 'eye', 'Vision', 'Look at pictures you send or files in the workspace.'], ['memory_write', 'database', 'Memory write', 'Save short- and long-term notes.'], ['repos', 'git', 'Repositories', 'Discover and list repos in the workspace.'], ['image_gen', 'image', 'Image generation', 'generate_image via SwarmUI or ComfyUI (set up under Image generation).'], ['http', 'globe', 'HTTP fetch', 'Fetch a URL as text (APIs, docs).'], ['app', 'cpu', 'Self-customization', 'Read docs, change settings, write themes and extensions, edit organs, checkpoints and rollback. Locked settings stay locked.'], ['notify', 'bell', 'Notifications', 'Send you a desktop notification.']];
      const list = el('<div class="list"></div>');
      items.forEach(([k, ic, n, d]) => { const it = el(`<div class="item ${t[k] ? 'on' : 'off'}">${icon(ic, 16)}<div class="col"><span class="n">${n}</span><span class="d">${d}</span></div></div>`); it.appendChild(toggle(t[k], (v) => { set({ tools: { [k]: v } }); it.classList.toggle('on', v); it.classList.toggle('off', !v); })); list.appendChild(it); });
      return [title('Tools', `What ${esc(s.persona.name)} can reach. Turn any off and it disappears from ${esc(s.persona.name)}’s side.`), row(`${esc(s.persona.name)} can use tools`, 'Master switch.', toggle(t.enabled, (v) => set({ tools: { enabled: v } }))), list];
    },
    async goals() {
      const s = S(); const g = s.goals; const list = await lyra.goals.list(); const usage = await lyra.goals.usage();
      const box = el('<div style="display:flex;flex-direction:column;gap:10px"></div>');
      const open = list.filter((x) => !x.archived); const archived = list.filter((x) => x.archived);
      const card = (x) => {
        const ic = { improve: 'trend', explore: 'compass', surprise: 'gift' }[x.type] || 'target';
        const stColor = x.status === 'done' ? 'var(--accent)' : x.status === 'blocked' ? 'var(--danger)' : x.status === 'in_progress' ? 'var(--warn)' : 'var(--muted)';
        const c = el(`<div class="goal ${x.type}"><div class="tag">${icon(ic, 12, 2)}${x.type[0].toUpperCase() + x.type.slice(1)}</div><div class="col"><div class="t">${esc(x.title)}</div><div class="why">${esc(x.why)}</div><div class="st" style="color:${stColor}">${x.status.replace('_', ' ')} · ${fmtWhen(x.updated_at)}</div>${x.log ? `<details class="reasoning"><summary>${icon('file', 12)} notes</summary><div class="log">${esc(x.log)}</div></details>` : ''}</div><div style="display:flex;gap:4px"></div></div>`);
        const acts = c.lastElementChild;
        if (!x.archived && x.status !== 'done') acts.appendChild(btn('Work on it now', async (e) => { e.target.disabled = true; toast(`${s.persona.name} is working on “${x.title}”…`); const r = await lyra.goals.run({ id: x.id }); if (!r.ok) toast(`Could not start: ${r.why}`, 'error'); refresh(); }, { ic: 'play' }));
        const ab = el(`<button class="icon-btn" title="${x.archived ? 'Unarchive' : 'Archive'}">${icon('archive', 15)}</button>`); ab.addEventListener('click', async () => { await lyra.goals.archive({ id: x.id, archived: !x.archived }); refresh(); }); acts.appendChild(ab);
        return c;
      };
      open.forEach((x) => box.appendChild(card(x)));
      if (!open.length) box.appendChild(el(`<div class="card dashed"><div class="d" style="font-size:12px;color:var(--muted)">No goals yet. ${esc(s.persona.name)} writes them after reflecting on a chat with at least four messages (about ten minutes after it goes quiet), or when you press Reflect now.</div></div>`));
      const arch = el('<div style="display:flex;flex-direction:column;gap:10px"></div>'); archived.forEach((x) => arch.appendChild(card(x)));
      return [
        title('AI goals', `Only ${esc(s.persona.name)} writes here. After a session it reflects and plans what to do better, or what to explore next. You can archive a goal, not add one.`),
        row(`Let ${esc(s.persona.name)} work on its goals on its own`, `Runs while you’re away, within the Safety rules. Used today: ${usage.minutes} min.`, [select([15, 30, 60, 120].map((m) => ({ v: m, l: `Up to ${m} min a day` })), g.dailyMinutes, (v) => set({ goals: { dailyMinutes: Number(v) } }), 170), toggle(g.autonomous, (v) => set({ goals: { autonomous: v } }))]),
        row('Reflect', 'Ask for goals from the current chat right now.', btn('Reflect now', async (e) => { e.target.disabled = true; try { const r = await lyra.goals.reflect({ chatId: window.LyraApp.chatId() }); toast(r.length ? `${r.length} new goal${r.length > 1 ? 's' : ''}` : 'Nothing new to add.'); } catch (err) { toast(err.message, 'error'); } finally { refresh(); } }, { ic: 'sparkle' })),
        box,
        archived.length ? group('Archived', [arch]) : null,
      ].filter(Boolean);
    },
  };

  /* ---- log viewer ---- */
  async function logsBlock() {
    const [rows, counts] = await Promise.all([
      lyra.logs.list({ level: logFilter.level, source: logFilter.source || null, search: logFilter.search || null, limit: 200, days: 7 }),
      lyra.logs.counts({ sinceMinutes: 1440 }),
    ]);
    const sources = [...new Set(rows.map((r) => r.source))].sort();
    const box = el('<div style="display:flex;flex-direction:column;gap:10px"></div>');
    const head = el(`<div class="card" style="gap:10px"><div class="status-line"><span class="dot ${counts.error ? 'off' : ''}"></span>Last 24 hours: ${counts.error || 0} error${counts.error === 1 ? '' : 's'}, ${counts.warn || 0} warning${counts.warn === 1 ? '' : 's'}. Kept for 7 days.</div><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"></div></div>`);
    const bar = head.lastElementChild;
    bar.appendChild(seg([{ v: 'error', l: 'Errors' }, { v: 'warn', l: '+ warnings' }, { v: 'info', l: 'Everything' }], logFilter.level, (v) => { logFilter.level = v; refresh(); }));
    bar.appendChild(select([{ v: '', l: 'All sources' }, ...sources.map((x) => ({ v: x, l: x }))], logFilter.source, (v) => { logFilter.source = v; refresh(); }, 150));
    const searchField = field(logFilter.search, (v) => { logFilter.search = v; refresh(); }, { w: 180, ph: 'Search' });
    bar.appendChild(searchField);
    bar.appendChild(btn('Copy', async () => { const t = await lyra.logs.text({ level: logFilter.level, source: logFilter.source || null, search: logFilter.search || null, limit: 200, days: 7 }); await navigator.clipboard.writeText(t || 'empty'); toast('Log copied to the clipboard.'); }, { ic: 'file' }));
    bar.appendChild(btn('Open folder', () => lyra.logs.open(), { ic: 'folder' }));
    bar.appendChild(btn('Clear', async () => { if (!confirm('Delete the stored logs?')) return; await lyra.logs.clear(); refresh(); }, { danger: true }));
    box.appendChild(head);
    const list = el('<div class="list" style="max-height:420px;overflow:auto"></div>');
    const color = { error: 'var(--danger)', warn: 'var(--warn)', info: 'var(--muted)', debug: 'var(--muted)' };
    [...rows].reverse().forEach((e) => {
      const when = new Date(e.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const it = el(`<div class="item" style="align-items:flex-start;cursor:${e.detail ? 'pointer' : 'default'}"><span class="mono" style="font-family:var(--mono);font-size:11px;color:var(--muted);white-space:nowrap">${esc(when)}</span><span class="tag" style="font-size:10px;font-weight:600;color:${color[e.level]};border:1px solid currentColor;border-radius:4px;padding:1px 5px;white-space:nowrap">${e.level}</span><div class="col"><span class="n" style="font-weight:400;color:var(--text)">${esc(e.message)}</span><span class="d">${esc(e.source)}</span><div class="detail-box" hidden style="font-family:var(--mono);font-size:11px;color:var(--muted);white-space:pre-wrap;margin-top:6px;max-height:200px;overflow:auto">${esc(e.detail || '')}</div></div></div>`);
      if (e.detail) it.addEventListener('click', () => { const d = it.querySelector('.detail-box'); d.hidden = !d.hidden; });
      list.appendChild(it);
    });
    if (!rows.length) list.appendChild(el('<div class="item"><span class="d">Nothing logged at this level. Quiet is good.</span></div>'));
    box.appendChild(list);
    box.appendChild(el(`<div class="d" style="font-size:12px;color:var(--muted)">${esc(S().persona.name)} can read this too: ask about a failure and it will check the log with its read_logs tool.</div>`));
    return box;
  }

  /* ---- page ---- */
  function renderNav() {
    const item = ([id, name, ic]) => `<button class="nav-item ${id === current ? 'on' : ''}" data-id="${id}">${icon(ic, 16)}<span class="nav-text">${name}</span>${id === 'recovery' && errorCount ? `<span class="spacer"></span><span class="err-dot" title="${errorCount} error${errorCount > 1 ? 's' : ''} in the last day">${errorCount}</span>` : ''}</button>`;
    $('#settings-nav-items').innerHTML = NAV.map(([label, items]) => `<div class="nav-group">${label}</div>${items.map(item).join('')}`).join('');
    $('#settings-nav-items').querySelectorAll('.nav-item').forEach((b) => b.addEventListener('click', () => { current = b.dataset.id; render(); }));
  }
  let renderSeq = 0;
  async function render() {
    const seq = ++renderSeq;
    try { errorCount = (await lyra.logs.counts({ sinceMinutes: 1440 })).error || 0; } catch { errorCount = 0; }
    renderNav(); const c = $('#settings-content'); c.innerHTML = '<div class="settings-inner"></div>'; const inner = c.firstElementChild;
    try { const parts = await sections[current](); if (seq !== renderSeq) return; parts.filter(Boolean).forEach((p) => inner.appendChild(p)); }
    catch (e) { if (seq !== renderSeq) return; const box = c.firstElementChild; box.appendChild(el(`<div class="md error">Could not load this section: ${esc(e.message)}</div>`)); const retry = btn('Try again', () => render(), { ic: 'refresh' }); box.appendChild(retry); console.error(e); }
  }
  function refresh() { if (open) render(); }
  window.Settings = {
    // An error arrived: update the badge only, never re-render (that could loop).
    noteError() { errorCount += 1; if (open) renderNav(); },
    open(section) { if (section && sections[section]) current = section; open = true; $('#settings').hidden = false; window.LyraApp.browserVisible(false); render(); },
    close() { open = false; $('#settings').hidden = true; if (previewChar) { previewChar.clearTimers(); previewChar.destroyLive2d(); previewChar = null; } window.LyraApp.browserVisible(true); $('#input').focus(); },
    refresh, isOpen: () => open,
  };
})();
