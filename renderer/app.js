// Lyra renderer: chat, sidebar, composer, live character panel, agent browser panel.
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const state = { settings: null, themes: [], chats: [], chatId: null, messages: [], attachments: [], audioAtt: null, recording: null, browser: { shown: false }, models: null, lastContext: null, now: { browser: 'Idle', shell: 'Idle', memory: 0 }, char: null, currentAudio: null, busy: false, charState: 'idle' };
  const approvalTimers = new Map();
  marked.setOptions({ breaks: true, gfm: true });
  const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const md = (t) => marked.parse(esc(t));
  const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const fmtDur = (s) => `${Math.floor((s || 0) / 60)}:${String(Math.floor((s || 0) % 60)).padStart(2, '0')}`;
  const fileUrl = (p) => (p && p.startsWith('file://') ? p : 'file://' + encodeURI(p || ''));
  const avatarUrl = (a) => (a && a.startsWith('builtin:') ? `character/${a.slice(8)}/avatar.png` : a ? fileUrl(a) : null);
  window.avatarUrl = avatarUrl;
  const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  const hostOf = (u) => { try { return new URL(u).host; } catch { return u; } };
  const toast = (text, kind = '') => { const t = el(`<div class="toast ${kind}">${esc(text)}</div>`); $('#toasts').appendChild(t); setTimeout(() => t.remove(), kind === 'error' ? 7000 : 4000); };
  window.LyraApp = { settings: () => state.settings, set: (patch) => setSettings(patch), toast, lastContext: () => state.lastContext, char: () => state.char, browserVisible: (on) => syncBrowserView(on), chatId: () => state.chatId, models: () => state.models, playFile: playFile };

  async function setSettings(patch) { state.settings = await lyra.settings.set(patch); applyAll(); return state.settings; }

  /* ---------- theme, persona, character ---------- */
  function currentTheme() { return state.themes.find((t) => t.id === state.settings.appearance.theme) || state.themes.find((t) => t.id === 'lyra-dark') || state.themes[0]; }
  function applyTheme() {
    const t = currentTheme(); if (!t) return;
    const link = $('#theme-css'); if (link.getAttribute('href') !== t.css) link.setAttribute('href', t.css);
    document.documentElement.dataset.theme = t.id; document.documentElement.dataset.scheme = t.scheme;
    document.documentElement.style.setProperty('--transition', `${state.settings.appearance.transitionMs}ms`);
  }
  function applyPersona() {
    const p = state.settings.persona; const a = state.settings.appearance; const t = currentTheme();
    $('#persona-name').textContent = p.name; document.title = p.name; $('#input').placeholder = `Message ${p.name}`;
    $('#settings-persona-name').textContent = p.name;
    const av = $('#persona-avatar'); const au = avatarUrl(p.avatar); av.innerHTML = au ? `<img src="${au}" alt="">` : esc(p.name.slice(0, 1).toUpperCase());
    $$('.ai-avatar').forEach((x) => { x.innerHTML = av.innerHTML; });
    const showPanel = a.liveCharacter && a.placement === 'panel' && state.settings.ui.livePanel;
    const floating = a.liveCharacter && a.placement === 'floating';
    $('#live-panel').hidden = !showPanel; $('#btn-live').classList.toggle('active', showPanel || floating); $('#float-char').hidden = !floating;
    const host = floating ? $('#float-stage') : $('#stage');
    if (state.char.el !== host) { state.char.dispose(); state.char = new LyraCharacter(host); state.char.setState(state.charState); }
    if (floating && a.floatPos) { $('#float-char').style.left = a.floatPos.x + 'px'; $('#float-char').style.top = a.floatPos.y + 'px'; $('#float-char').style.right = 'auto'; $('#float-char').style.bottom = 'auto'; }
    state.char.configure({ source: a.source, gifFolder: a.gifFolder, live2dModel: a.live2dModel, petFolder: a.petFolder, variant: t && t.character === 'pixel' ? 'pixel' : 'default' });
    $('#stage-caption').textContent = a.source === 'pet' ? `Hermes pet · ${a.petFolder ? a.petFolder.split('/').pop() : 'none chosen'}` : a.source === 'gif' && a.gifFolder.startsWith('builtin:') ? `Built-in pack · ${a.gifFolder.slice(8)}` : a.source === 'gif' ? `GIF pack · ${a.gifFolder ? a.gifFolder.split('/').pop() : 'no folder chosen'}` : a.source === 'live2d' ? `Live2D · ${a.live2dModel ? a.live2dModel.split('/').pop() : 'no model chosen'}` : t && t.character === 'pixel' ? 'Built-in character · pixel' : 'Built-in character';
    renderPills(); requestAnimationFrame(sendBounds);
  }
  function applyAll() { applyTheme(); applyPersona(); renderNow(); if (window.Settings && Settings.isOpen()) Settings.refresh(); }

  function setCharState(s) {
    state.charState = s; state.char.setState(s);
    const chip = $('#state-chip'); chip.dataset.state = s; $('#state-label').textContent = s[0].toUpperCase() + s.slice(1);
    $('#persona-avatar').dataset.state = s; renderPills(); const fs = $('#float-state'); fs.dataset.state = s; fs.textContent = s === 'idle' ? '' : { thinking: 'thinking…', writing: 'writing…', speaking: 'speaking' }[s];
    const busy = s === 'thinking' || s === 'writing';
    $('#btn-stop').hidden = !busy; $('#input').placeholder = busy ? (state.settings.chat.followUp === 'steer' ? `Steer ${state.settings.persona.name} while it works…` : `Message ${state.settings.persona.name} (cancels the current reply)`) : `Message ${state.settings.persona.name}`;
    state.busy = busy;
    setStatus();
  }
  function setStatus(step) {
    const s = state.charState; const d = $('#status-dot'); const t = $('#status-text');
    const brain = brainInfo();
    if (brain && !brain.ok) { d.className = 'dot off'; t.textContent = `${brain.name} not reachable`; return; }
    d.className = 'dot' + (s === 'idle' ? '' : ' busy');
    const p = state.progress && s !== 'idle' && s !== 'speaking' ? ` · step ${state.progress.step} of ${state.progress.max}` : '';
    t.textContent = s === 'idle' ? (brain && brain.list.length ? `Online · ${brain.name}` : 'Online · no models found') : (step || { thinking: 'Thinking…', writing: 'Writing…', speaking: 'Speaking…' }[s]) + p;
  }
  function brainInfo() { if (!state.models || !state.settings) return null; const provs = state.settings.providers.list; const p = provs.find((x) => x.id === state.settings.model.chat.provider) || provs[0]; const info = state.models.byProvider[p.id]; return info ? { ...info, name: p.name } : null; }
  function renderPills() {
    $('#state-pills').innerHTML = ['idle', 'thinking', 'writing', 'speaking'].map((s) => `<button class="pill ${s === state.charState ? 'on' : ''}" data-s="${s}">${s[0].toUpperCase() + s.slice(1)}</button>`).join('');
    $$('#state-pills .pill').forEach((b) => b.addEventListener('click', () => { const s = b.dataset.s; state.char.setState(s); setTimeout(() => state.char.setState(state.charState), 2500); }));
  }
  function renderNow() {
    const b = state.settings.browser; const n = state.now;
    $('#now-rows').innerHTML = [
      ['globe', 'Browser', b.enabled ? `${b.mode === 'headless' ? 'Headless' : 'Visible'} · ${n.browser}` : 'Off', b.enabled ? 'Show' : ''],
      ['terminal', 'Shell', n.shell, ''],
      ['database', 'Memory', n.memory ? `${n.memory} note${n.memory > 1 ? 's' : ''} written this chat` : 'Nothing written yet', ''],
      ['cpu', 'Turn', state.progress ? `Step ${state.progress.step} of ${state.progress.max}` : 'Idle', ''],
    ].map(([ic, k, v, link]) => `<div class="now-row">${icon(ic, 15)}<div class="col"><span class="k">${k}</span><span class="v">${esc(v)}</span></div>${link ? `<span class="link" data-link="${k}">${link}</span>` : ''}</div>`).join('');
    const l = $('#now-rows [data-link=Browser]'); if (l) l.addEventListener('click', () => showBrowserPanel(true));
  }

  /* ---------- chats ---------- */
  async function loadChats() { state.chats = await lyra.chats.list(); renderChatList(); }
  function renderChatList() {
    const q = $('#chat-search').value.trim().toLowerCase(); const list = $('#chat-list'); list.innerHTML = '';
    const day = 86400000; const now = Date.now(); const start = new Date(); start.setHours(0, 0, 0, 0);
    const groups = [['Today', (t) => t >= start.getTime()], ['Yesterday', (t) => t >= start.getTime() - day], ['Last 7 days', (t) => t >= now - 7 * day], ['Older', () => true]];
    let rest = state.chats.filter((c) => !q || c.title.toLowerCase().includes(q));
    for (const [label, test] of groups) {
      const mine = rest.filter((c) => test(c.updated_at)); rest = rest.filter((c) => !test(c.updated_at));
      if (!mine.length) continue;
      list.appendChild(el(`<div class="section-label">${label}</div>`));
      for (const c of mine) {
        const it = el(`<div class="chat-item ${c.id === state.chatId ? 'active' : ''} ${c.kind === 'goal' ? 'goal' : ''}" data-id="${c.id}"><span class="title">${esc(c.title)}</span><button class="icon-btn" title="Delete">${icon('trash', 14)}</button></div>`);
        it.addEventListener('click', () => openChat(c.id));
        it.querySelector('button').addEventListener('click', async (e) => { e.stopPropagation(); if (!confirm(`Delete “${c.title}”?`)) return; await lyra.chats.delete({ id: c.id }); if (state.chatId === c.id) { state.chatId = null; await loadChats(); await ensureChat(); } });
        list.appendChild(it);
      }
    }
  }
  async function ensureChat() { const first = state.chats.find((c) => c.kind !== 'goal') || state.chats[0]; if (first) await openChat(first.id); else await newChat(); }
  async function newChat() { const c = await lyra.chats.create(); await loadChats(); await openChat(c.id); $('#input').focus(); }
  async function openChat(cid) {
    state.chatId = cid; const { chat, messages } = await lyra.chats.get({ id: cid }); state.messages = messages; state.now.memory = 0;
    renderThread(); $$('.chat-item').forEach((x) => x.classList.toggle('active', x.dataset.id === cid)); renderNow(); refreshContext(50);
    if (chat && chat.kind === 'goal') toast('This is one of Lyra’s own goal sessions.');
  }

  /* ---------- thread ---------- */
  function scrollBottom(force) { const t = $('#thread'); const near = t.scrollHeight - t.scrollTop - t.clientHeight < 160; if (force || near) t.scrollTop = t.scrollHeight; }
  function renderThread() {
    const t = $('#thread'); t.innerHTML = '';
    if (!state.messages.length) t.appendChild(el(`<div class="notice">${icon('sparkle', 14)} New chat with ${esc(state.settings.persona.name)}. Type, attach a picture, or hold the mic.</div>`));
    let lastDay = '';
    for (const m of state.messages) { const d = new Date(m.created_at).toDateString(); if (d !== lastDay) { lastDay = d; t.appendChild(el(`<div class="divider-line">${d === new Date().toDateString() ? 'Today' : esc(new Date(m.created_at).toLocaleDateString())}</div>`)); } t.appendChild(renderMessage(m)); }
    scrollBottom(true);
  }
  function audioPill(src, duration, cls = '') {
    const bars = [6, 10, 16, 12, 20, 14, 8, 18, 22, 12, 6, 14, 18, 10, 16, 20, 8, 12, 16, 6, 10, 14].map((h) => `<i style="height:${h}px"></i>`).join('');
    const p = el(`<div class="audio-pill ${cls}"><button class="play">${icon('play', 11)}</button><span class="wave">${bars}</span><span class="dur">${fmtDur(duration)}</span></div>`);
    const a = new Audio(src); p._audio = a;
    a.addEventListener('loadedmetadata', () => { if (isFinite(a.duration)) p.querySelector('.dur').textContent = fmtDur(a.duration); });
    a.addEventListener('timeupdate', () => { const f = a.duration ? a.currentTime / a.duration : 0; $$('.wave i', p).forEach((b, i, arr) => b.classList.toggle('on', i / arr.length <= f)); });
    a.addEventListener('ended', () => { p.querySelector('.play').innerHTML = icon('play', 11); });
    p.querySelector('.play').addEventListener('click', () => { if (a.paused) { stopCurrentAudio(); state.currentAudio = a; a.play(); p.querySelector('.play').innerHTML = icon('pause', 11); } else { a.pause(); p.querySelector('.play').innerHTML = icon('play', 11); } });
    return p;
  }
  function stopCurrentAudio() { if (state.currentAudio) { try { state.currentAudio.pause(); state.currentAudio.currentTime = 0; } catch {} } state.currentAudio = null; }
  function renderMessage(m) {
    const c = m.content || {};
    if (m.role === 'user') {
      const w = el(`<div class="msg-user" data-id="${m.id}"><div class="col"></div></div>`); const col = w.firstElementChild;
      if (c.text) col.appendChild(el(`<div class="bubble">${esc(c.text)}</div>`));
      for (const im of c.images || []) col.appendChild(el(`<div class="img-card"><img src="${fileUrl(im.path)}" alt="${esc(im.name)}"></div>`));
      if (c.audio) { const b = el(`<div class="bubble audio"></div>`); b.appendChild(audioPill(fileUrl(c.audio.path), c.audio.duration)); col.appendChild(b); if (c.transcript && state.settings.voice.showTranscript) col.appendChild(el(`<div class="transcript"><b>Transcript</b> “${esc(c.transcript)}”</div>`)); }
      col.appendChild(el(`<div class="time">${fmtTime(m.created_at)}</div>`));
      return w;
    }
    const p = state.settings.persona;
    const w = el(`<div class="msg-ai" data-id="${m.id}"><div class="avatar persona-avatar ai-avatar">${$('#persona-avatar').innerHTML}</div><div class="col"><div class="who"><span class="name">${esc(p.name)}</span><span class="time">${fmtTime(m.created_at)}</span></div><details class="reasoning" hidden><summary>${icon('sparkle', 12)}<span class="rl">Thought</span></summary><div class="body"></div></details><div class="steps"></div><div class="md"></div><div class="audio-slot"></div></div></div>`);
    if (c.reasoning) { const r = w.querySelector('.reasoning'); r.hidden = false; r.querySelector('.body').textContent = c.reasoning; }
    for (const s of c.steps || []) w.querySelector('.steps').appendChild(stepEl(s));
    const mdEl = w.querySelector('.md'); mdEl.innerHTML = md(c.text || (c.error ? '' : '…')); if (c.error) { mdEl.classList.add('error'); mdEl.innerHTML = md(c.text || c.error); }
    if (c.audio) w.querySelector('.audio-slot').appendChild(audioPill(fileUrl(c.audio.path)));
    return w;
  }
  function stepEl(s) {
    const tag = s.status === 'denied' ? '<span class="tag denied">denied</span>' : s.status === 'error' ? '<span class="tag denied">error</span>' : s.name === 'browser_open' && state.settings.browser.mode === 'visible' ? '<span class="tag link" data-show="1">Show</span>' : '';
    const w = el(`<div class="step-wrap" data-step="${s.id}"><div class="step ${s.status}">${icon(s.icon || 'tool', 14)}<span class="txt">${esc(s.summary)}</span>${tag}</div><div class="detail"></div></div>`);
    w.querySelector('.detail').textContent = `${s.args || ''}${s.result ? '\n→ ' + s.result : ''}${s.approval ? '\n(' + s.approval + ')' : ''}`;
    if (s.image) w.appendChild(el(`<div class="step-image"><img src="${fileUrl(s.image)}" alt=""></div>`));
    if (s.todo) w.appendChild(el(`<div class="todo">${s.todo.map((t) => `<div class="${t.done ? 'done' : ''}"><span class="box">${t.done ? icon('check', 9, 3) : ''}</span><span>${esc(t.text)}</span></div>`).join('')}</div>`));
    w.querySelector('.step').addEventListener('click', (e) => { if (e.target.closest('[data-show]')) { showBrowserPanel(true); return; } w.classList.toggle('open'); });
    return w;
  }
  function msgEl(id) { return $(`.msg-ai[data-id="${id}"]`); }
  function upsertStep(id, step) {
    const m = msgEl(id); if (!m) return; const steps = m.querySelector('.steps');
    const ex = steps.querySelector(`[data-step="${step.id}"]`); const n = stepEl(step); if (ex) { if (ex.classList.contains('open')) n.classList.add('open'); ex.replaceWith(n); } else steps.appendChild(n);
    if (step.name && step.name.startsWith('browser')) { state.now.browser = step.summary.split('·').pop().trim(); }
    if (step.name === 'shell' || step.name === 'run_code') state.now.shell = step.status === 'running' ? step.summary : `${step.summary} · ${step.status}`;
    if (step.name === 'remember' && step.status === 'done') state.now.memory += 1;
    renderNow(); scrollBottom();
  }
  const streams = new Map();
  function scheduleRender(id) { const s = streams.get(id); if (!s || s.raf) return; s.raf = requestAnimationFrame(() => { s.raf = null; if (!streams.has(id)) return; const m = msgEl(id); if (!m) return; const mdEl = m.querySelector('.md'); mdEl.innerHTML = md(s.text) || ''; mdEl.classList.add('cursor'); if (s.reasoning) { const r = m.querySelector('.reasoning'); r.hidden = false; r.querySelector('.body').textContent = s.reasoning; r.querySelector('.rl').textContent = 'Thinking…'; } scrollBottom(); }); }

  function approvalCard(a) {
    const card = el(`<div class="approval" data-approval="${a.id}"><div class="head">${icon('shield', 16)}<b>Approval needed</b><span class="meta">${a.risk} risk${a.tool ? ' · ' + esc(a.tool) : ''}</span></div><div class="cmd"><span>${esc(a.summary)}</span></div>${a.detail ? `<div class="result">${esc(a.detail.slice(0, 300))}</div>` : ''}${a.reason ? `<div class="result">${esc(a.reason)}</div>` : ''}<div class="foot"><button class="btn small primary" data-d="approved">Approve</button><button class="btn small" data-d="denied">Deny</button><span class="timer">${icon('clock', 13)}<span class="t"></span></span></div></div>`);
    const tEl = card.querySelector('.t');
    const tick = () => { const left = Math.max(0, Math.round((a.expiresAt - Date.now()) / 1000)); tEl.textContent = `Auto-${a.onTimeout === 'approve' ? 'approves' : 'denies'} in ${fmtDur(left)}`; if (left <= 0) clearInterval(approvalTimers.get(a.id)); };
    tick(); approvalTimers.set(a.id, setInterval(tick, 1000));
    card.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => lyra.approvals.respond({ id: a.id, decision: b.dataset.d })));
    return card;
  }
  function resolveApproval(a) {
    const card = $(`[data-approval="${a.id}"]`); if (!card) return; clearInterval(approvalTimers.get(a.id));
    card.classList.add('resolved'); card.querySelector('.foot').innerHTML = `<span class="result">${a.decision === 'approved' ? 'Approved' : 'Denied'}${a.timedOut ? ' (timed out)' : a.cancelled ? ' (stopped)' : ''}</span>`;
  }
  function currentAssistantEl() { const all = $$('.msg-ai'); return all[all.length - 1]; }

  /* ---------- playback ---------- */
  function playFile(path, onEnd) {
    stopCurrentAudio(); const a = new Audio(fileUrl(path)); state.currentAudio = a;
    a.addEventListener('ended', () => { state.char.detachAudio(); onEnd && onEnd(); });
    a.addEventListener('error', () => { onEnd && onEnd(); });
    a.play().then(() => state.char.attachAudio(a)).catch(() => onEnd && onEnd());
    return a;
  }

  /* ---------- context meter ---------- */
  const kfmt = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k' : String(n));
  function paintContext(c) {
    if (!c) return; state.lastContext = c;
    const draft = Math.ceil((input.value || '').length / 4);
    const used = c.used + draft; const pct = c.context ? Math.min(100, (used / c.context) * 100) : 0;
    const fill = $('#ctx-fill'); fill.style.width = pct + '%';
    fill.className = pct >= 95 ? 'full' : pct >= (c.threshold || 0.8) * 100 ? 'warn' : '';
    $('#ctx-mark').style.left = `${Math.round((c.threshold || 0.8) * 100)}%`;
    $('#ctx-mark').hidden = !c.compression;
    $('#ctx-text').textContent = c.context ? `${kfmt(used)} / ${kfmt(c.context)} · ${Math.round(pct)}%` : 'context unknown';
    $('#ctx-meter').hidden = false;
    $('#ctx-meter').title = c.error ? c.error : [`Model: ${c.label}${c.provider ? ' · ' + c.provider : ''}`, `Context: ${c.context ? c.context.toLocaleString() + ' tokens' : 'unknown'}${c.contextMode === 'manual' ? ' (set by hand)' : ''}`, `Persona and tools: ${(c.parts.system + c.parts.tools).toLocaleString()}`, `Conversation: ${c.parts.history.toLocaleString()}${c.parts.summary ? ' + summary ' + c.parts.summary.toLocaleString() : ''}`, draft ? `Draft: ${draft.toLocaleString()}` : '', c.compression ? `Compresses older turns at ${Math.round(c.threshold * 100)}%` : 'Compression off'].filter(Boolean).join('\n');
    $('#composer-hint').innerHTML = `<span>${esc(c.label || c.model)}${c.provider ? ' · ' + esc(c.provider) : ''}</span>`;
  }
  let ctxTimer = null;
  async function refreshContext(delay = 0) {
    clearTimeout(ctxTimer);
    ctxTimer = setTimeout(async () => { if (!state.chatId) return; try { paintContext(await lyra.chat.context({ chatId: state.chatId })); } catch {} }, delay);
  }
  $('#ctx-meter').addEventListener('click', () => Settings.open('memory'));

  /* ---------- events from main ---------- */
  lyra.onEvent((e) => {
    const mine = !e.chatId || e.chatId === state.chatId;
    switch (e.type) {
      case 'message': if (mine) { state.messages.push(e.message); const t = $('#thread'); const n = t.querySelector('.notice'); if (n) n.remove(); t.appendChild(renderMessage(e.message)); scrollBottom(true); } break;
      case 'assistant:start': if (mine) { state.messages.push(e.message); $('#thread').appendChild(renderMessage(e.message)); streams.set(e.message.id, { text: '', reasoning: '' }); msgEl(e.message.id).querySelector('.md').innerHTML = ''; scrollBottom(true); } break;
      case 'delta': { const s = streams.get(e.id); if (s) { s.text += e.text; scheduleRender(e.id); } break; }
      case 'reasoning': { const s = streams.get(e.id); if (s) { s.reasoning += e.text; scheduleRender(e.id); } break; }
      case 'step': if (mine) upsertStep(e.id, e.step); break;
      case 'progress': if (mine) { state.progress = e; setStatus(); renderNow(); } break;
      case 'approval': if (mine) { const m = currentAssistantEl(); const card = approvalCard(e); (m ? m.querySelector('.steps') : $('#thread')).appendChild(card); scrollBottom(true); } break;
      case 'approval:resolved': resolveApproval(e); break;
      case 'assistant:done': { refreshContext(300); state.progress = null; setStatus(); renderNow(); streams.delete(e.id); const m = msgEl(e.id); if (m) { const mdEl = m.querySelector('.md'); mdEl.classList.remove('cursor'); mdEl.innerHTML = md(e.message.content.text); const r = m.querySelector('.reasoning'); if (!r.hidden) r.querySelector('.rl').textContent = 'Thought'; } const i = state.messages.findIndex((x) => x.id === e.id); if (i >= 0) state.messages[i] = e.message; break; }
      case 'tts': { const m = msgEl(e.id); if (m) { const slot = m.querySelector('.audio-slot'); slot.innerHTML = ''; const pill = audioPill(fileUrl(e.path)); slot.appendChild(pill); if (mine) { playFile(e.path, () => { lyra.state.set({ state: 'idle' }); pill.querySelector('.play').innerHTML = icon('play', 11); }); pill.querySelector('.play').innerHTML = icon('pause', 11); } } else if (mine) playFile(e.path, () => lyra.state.set({ state: 'idle' })); break; }
      case 'state': setCharState(e.state); if (e.step) setStatus(e.step); break;
      case 'error': { toast(e.message, 'error'); const m = e.id && msgEl(e.id); if (m) { const mdEl = m.querySelector('.md'); mdEl.classList.remove('cursor'); mdEl.classList.add('error'); if (!mdEl.textContent.trim() || mdEl.textContent.trim() === '…') mdEl.innerHTML = md(e.message); } streams.delete(e.id); break; }
      case 'notice': if (mine) toast(e.text); break;
      case 'activity': if (mine) { const m = currentAssistantEl(); const n = el(`<div class="step done">${icon(e.icon || 'info', 14)}<span class="txt">${esc(e.text)}</span></div>`); (m ? m.querySelector('.steps') : $('#thread')).appendChild(n); } break;
      case 'context': if (mine) paintContext({ ...(state.lastContext || { parts: { system: 0, tools: 0, history: 0, summary: 0 }, threshold: 0.8, compression: true }), ...e }); break;
      case 'browser': updateBrowser(e); break;
      case 'browser:show': showBrowserPanel(true); break;
      case 'chats': loadChats(); break;
      // A different profile is in force: her chats, her look and her name all change at once.
      case 'profiles': state.chatId = null; loadChats(); if (window.Settings && Settings.isOpen()) Settings.refresh(); break;
      case 'settings': state.settings = e.settings; applyAll(); refreshContext(100); break;
      case 'models': state.models = e; setStatus(); if (window.Settings && Settings.isOpen()) Settings.refresh(); break;
      case 'memory': toast(`Remembered (${e.scope}): ${e.text.slice(0, 80)}`); break;
      case 'goals': if (window.Settings && Settings.isOpen()) Settings.refresh(); break;
      case 'kernel': toast(e.text, e.level === 'warn' ? 'error' : ''); if (e.chatId && e.chatId === state.chatId) { const m = currentAssistantEl(); if (m) m.querySelector('.steps').appendChild(el(`<div class="step ${e.level === 'warn' ? 'error' : 'done'}">${icon('cpu', 14)}<span class="txt">${esc(e.text)}</span></div>`)); } if (window.Settings && Settings.isOpen()) Settings.refresh(); break;
      case 'log': if (e.entry && e.entry.level === 'error') { state.lastLogError = e.entry; if (window.Settings) Settings.noteError(); } break;
      case 'mobile': if (window.Settings && Settings.isOpen()) Settings.refresh(); break;
      case 'extensions': renderPanels(); if (window.Settings && Settings.isOpen()) Settings.refresh(); break;
      case 'debug': if (e.open && e.open.startsWith('settings')) Settings.open(e.open.split(':')[1] || 'model'); if (e.scroll) setTimeout(() => { const c = $('#settings-content'); if (c) c.scrollTop = e.scroll === 'bottom' ? c.scrollHeight : Number(e.scroll) || 0; }, 900); if (e.send) { input.value = e.send; send(); } if (e.browser) showBrowserPanel(true); break;
    }
  });

  /* ---------- composer ---------- */
  const input = $('#input');
  function autosize() { input.style.height = 'auto'; input.style.height = Math.min(180, input.scrollHeight) + 'px'; }
  input.addEventListener('input', () => { autosize(); if (state.lastContext) paintContext(state.lastContext); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
  input.addEventListener('paste', (e) => { const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/')); if (files.length) { e.preventDefault(); files.forEach(addImageFile); } });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => { e.preventDefault(); [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/')).forEach(addImageFile); });
  function addImageFile(f) { const r = new FileReader(); r.onload = () => { state.attachments.push({ name: f.name || 'image.png', dataUrl: r.result }); renderAttachments(); }; r.readAsDataURL(f); }
  function renderAttachments() {
    const box = $('#attachments'); box.innerHTML = ''; box.hidden = !state.attachments.length && !state.audioAtt;
    state.attachments.forEach((a, i) => { const d = el(`<div class="att"><img src="${a.dataUrl}" alt=""><button class="rm">${icon('x', 11, 2.4)}</button></div>`); d.querySelector('.rm').addEventListener('click', () => { state.attachments.splice(i, 1); renderAttachments(); }); box.appendChild(d); });
    if (state.audioAtt) { const d = el(`<div class="att audio">${icon('mic', 14)}<span>Voice message · ${fmtDur(state.audioAtt.duration)}</span><button class="icon-btn" style="width:22px;height:22px">${icon('x', 12)}</button></div>`); d.querySelector('button').addEventListener('click', () => { state.audioAtt = null; renderAttachments(); }); box.appendChild(d); }
  }
  $('#btn-attach').addEventListener('click', async () => { const imgs = await lyra.files.pickImages(); state.attachments.push(...imgs); renderAttachments(); });
  async function send() {
    const text = input.value.trim(); if (!text && !state.attachments.length && !state.audioAtt) return;
    if (!state.chatId) await newChat();
    const payload = { chatId: state.chatId, text, images: state.attachments, audio: state.audioAtt ? { dataUrl: state.audioAtt.dataUrl, mime: state.audioAtt.mime, duration: state.audioAtt.duration } : null };
    input.value = ''; autosize(); state.attachments = []; state.audioAtt = null; renderAttachments(); stopCurrentAudio();
    const r = await lyra.chat.send(payload); if (!r.ok) toast(r.error || 'Could not send', 'error'); refreshContext(400);
  }
  $('#btn-send').addEventListener('click', send);
  $('#btn-stop').addEventListener('click', () => lyra.chat.stop({ chatId: state.chatId }));

  // voice recording
  async function toggleRecording() {
    if (state.recording) { state.recording.rec.stop(); return; }
    if (!state.settings.voice.stt) { toast('Speech to text is off (Settings › Voice).'); return; }
    let stream; try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (e) { toast('Microphone not available: ' + e.message, 'error'); return; }
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    const rec = new MediaRecorder(stream, { mimeType: mime }); const chunks = []; const started = Date.now();
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop()); clearInterval(state.recording.timer); const duration = (Date.now() - started) / 1000; state.recording = null;
      $('#rec').hidden = true; $('#btn-mic').classList.remove('rec'); $('#composer-hint').textContent = '';
      if (duration < 0.6) return;
      const blob = new Blob(chunks, { type: 'audio/webm' }); const r = new FileReader();
      r.onload = () => { state.audioAtt = { dataUrl: r.result, mime: 'audio/webm', duration }; send(); };
      r.readAsDataURL(blob);
    };
    rec.start(250); state.recording = { rec, timer: setInterval(() => { $('#rec-time').textContent = fmtDur((Date.now() - started) / 1000); }, 500) };
    $('#rec').hidden = false; $('#rec-time').textContent = '0:00'; $('#btn-mic').classList.add('rec'); $('#composer-hint').textContent = 'Recording… tap the mic again to send.';
  }
  $('#btn-mic').addEventListener('click', toggleRecording);

  /* ---------- browser panel ---------- */
  function sendBounds() { if (!state.browser.shown || $('#settings').hidden === false) return; const r = $('#bp-view').getBoundingClientRect(); lyra.browser.bounds({ x: r.left, y: r.top, width: r.width, height: r.height }); }
  function syncBrowserView(on) { lyra.browser.show({ on: !!on && state.browser.shown }); if (on) requestAnimationFrame(sendBounds); }
  function showBrowserPanel(on) {
    state.browser.shown = !!on; $('#browser-panel').hidden = !on; $('#btn-browser').classList.toggle('active', !!on); $('#app').classList.toggle('browsing', !!on);
    if (on && state.settings.browser.mode === 'headless') $('.bp-placeholder').textContent = 'Headless mode: browsing shows as a status line in chat. Switch to “Visible in app” under Settings › Browser to watch.';
    else $('.bp-placeholder').textContent = 'The browser appears here when Lyra opens a page.';
    lyra.browser.show({ on: !!on && $('#settings').hidden }); requestAnimationFrame(sendBounds);
  }
  new ResizeObserver(() => sendBounds()).observe($('#bp-view')); window.addEventListener('resize', sendBounds);
  $('#btn-browser').addEventListener('click', () => showBrowserPanel(!state.browser.shown));
  $('#bp-close').addEventListener('click', () => showBrowserPanel(false));
  $('#bp-takeover').addEventListener('click', async () => { const st = await lyra.browser.takeOver({ on: !state.browser.takenOver }); updateBrowser(st); });
  $('#bp-stop').addEventListener('click', async () => updateBrowser(await lyra.browser.stop()));
  $('#bp-back').addEventListener('click', () => lyra.browser.back());
  $('#bp-reload').addEventListener('click', () => lyra.browser.reload());
  $('#bp-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') { lyra.browser.navigate({ url: e.target.value.trim() }); e.target.blur(); } });
  function updateBrowser(s) {
    state.browser = { ...state.browser, ...s };
    const badge = $('#bp-badge'); badge.className = 'badge ' + (s.takenOver ? 'user' : s.busy || s.step ? '' : 'idle');
    $('#bp-badge-text').textContent = s.takenOver ? 'You have the browser' : s.busy ? `${state.settings.persona.name} is driving` : s.step ? `${state.settings.persona.name} is driving` : 'Idle';
    $('#bp-takeover').textContent = s.takenOver ? 'Hand back' : 'Take over';
    const u = $('#bp-url'); if (document.activeElement !== u && s.url && s.url !== 'about:blank') u.value = s.url;
    $('#bp-step').textContent = s.step || 'Idle'; $('#bp-mode').textContent = s.mode === 'headless' ? 'Headless' : 'Visible';
    $('#bp-eq').classList.toggle('paused', !s.busy); $('#browser-dot').hidden = !(s.busy || (s.url && s.url !== 'about:blank' && !state.browser.shown));
    if (s.url && s.url !== 'about:blank') state.now.browser = hostOf(s.url); renderNow();
  }

  /* ---------- extension panels ---------- */
  let panels = []; let activePanel = 'live';
  async function renderPanels() {
    try { panels = await lyra.extensions.panels(); } catch { panels = []; }
    const tabs = $('#panel-tabs'); tabs.hidden = !panels.length; if (!panels.some((p) => p.id === activePanel)) activePanel = 'live';
    tabs.innerHTML = [{ id: 'live', name: 'Live' }, ...panels].map((p) => `<button class="pill ${p.id === activePanel ? 'on' : ''}" data-p="${esc(p.id)}">${esc(p.name)}</button>`).join('');
    tabs.querySelectorAll('.pill').forEach((b) => b.addEventListener('click', () => { activePanel = b.dataset.p; renderPanels(); }));
    const frame = $('#ext-frame'); const p = panels.find((x) => x.id === activePanel);
    $('#live-panel').classList.toggle('ext-mode', !!p); frame.hidden = !p; if (p && frame.dataset.src !== p.url) { frame.dataset.src = p.url; frame.src = p.url; }
  }
  window.addEventListener('message', async (e) => { const d = e.data; if (!d || (d.lyra !== 'call' && d.nova !== 'call')) return; const p = panels.find((x) => x.id === activePanel); if (!p) return; const r = await lyra.extensions.call({ id: p.id, tool: d.tool, args: d.args }); e.source && e.source.postMessage({ lyra: 'result', nova: 'result', id: d.id, ...r }, '*'); });

  /* ---------- floating character drag ---------- */
  (() => { const fc = $('#float-char'); let drag = null;
    fc.addEventListener('mousedown', (e) => { const r = fc.getBoundingClientRect(); const m = $('.main').getBoundingClientRect(); drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, m }; fc.classList.add('dragging'); e.preventDefault(); });
    window.addEventListener('mousemove', (e) => { if (!drag) return; const x = Math.max(0, Math.min(drag.m.width - fc.offsetWidth, e.clientX - drag.m.left - drag.dx)); const y = Math.max(0, Math.min(drag.m.height - fc.offsetHeight, e.clientY - drag.m.top - drag.dy)); fc.style.left = x + 'px'; fc.style.top = y + 'px'; fc.style.right = 'auto'; fc.style.bottom = 'auto'; });
    window.addEventListener('mouseup', () => { if (!drag) return; drag = null; fc.classList.remove('dragging'); lyra.settings.set({ appearance: { floatPos: { x: parseInt(fc.style.left) || 0, y: parseInt(fc.style.top) || 0 } } }); });
  })();

  /* ---------- header, keys ---------- */
  $('#btn-new-chat').addEventListener('click', newChat);
  $('#chat-search').addEventListener('input', renderChatList);
  $('#btn-live').addEventListener('click', () => { if (state.settings.appearance.placement === 'floating') setSettings({ appearance: { placement: 'panel' }, ui: { livePanel: true } }); else setSettings({ ui: { livePanel: !state.settings.ui.livePanel } }); });
  $('#btn-notify').addEventListener('click', () => Settings.open('notifications'));
  $('#btn-settings').addEventListener('click', () => Settings.open('model'));
  $('#btn-settings-side').addEventListener('click', () => Settings.open('model'));
  $('#settings-close').addEventListener('click', () => Settings.close());
  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Escape' && Settings.isOpen()) Settings.close();
    else if (mod && e.key === ',') { e.preventDefault(); Settings.open('model'); }
    else if (mod && e.key.toLowerCase() === 'n') { e.preventDefault(); newChat(); }
    else if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); showBrowserPanel(!state.browser.shown); }
  });

  /* ---------- report UI failures into the app log ---------- */
  window.addEventListener('error', (e) => { try { lyra.logs.write({ level: 'error', source: 'ui', message: e.message || 'Script error', detail: `${e.filename || ''}:${e.lineno || 0}\n${(e.error && e.error.stack) || ''}` }); } catch {} });
  window.addEventListener('unhandledrejection', (e) => { try { const r = e.reason; lyra.logs.write({ level: 'error', source: 'ui', message: `Unhandled promise rejection: ${(r && r.message) || r}`, detail: (r && r.stack) || '' }); } catch {} });

  /* ---------- init ---------- */
  (async () => {
    fillIcons();
    state.settings = await lyra.settings.get(); state.themes = await lyra.themes.list();
    state.char = new LyraCharacter($('#stage'));
    applyAll(); setCharState('idle');
    await loadChats(); await ensureChat();
    updateBrowser(await lyra.browser.status());
    lyra.models.detect().then((m) => { state.models = m; setStatus(); const b = brainInfo(); if (b && !b.ok) toast(`${b.name} is not reachable at ${b.endpoint}. Start it, or fix the preset under Settings › Provider.`, 'error'); }).catch(() => {});
    const paths = await lyra.app.paths(); if (!paths.voiceReady && (state.settings.voice.readAloud || state.settings.voice.stt)) $('#composer-hint').innerHTML = `Voice sidecar not installed: run <kbd>npm run voice:setup</kbd> for KittenTTS and Whisper. Replies will use the system voice.`;
    renderPanels();
    lyra.kernel.ready();
    input.focus();
  })();
})();
