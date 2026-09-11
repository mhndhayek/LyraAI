/* Lyra on the phone. Talks only to its own origin over TLS inside the tailnet. */
(() => {
  const $ = (s) => document.querySelector(s);
  const el = (h) => { const t = document.createElement('template'); t.innerHTML = h.trim(); return t.content.firstElementChild; };
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const KEY = 'lyra.token';
  let token = localStorage.getItem(KEY) || localStorage.getItem('nova.token') || '';
  const state = { chatId: null, chats: [], persona: 'Lyra', atts: [], rec: null, es: null, streams: new Map(), busy: false };

  const api = async (p, opts = {}) => {
    const r = await fetch(p, { ...opts, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
    if (r.status === 401) { unpair(); throw new Error('not paired'); }
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    return r.json();
  };
  const media = (p) => `/api/media?f=${encodeURIComponent(p)}&token=${encodeURIComponent(token)}`;
  const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  /* --- tiny markdown --- */
  function md(t) {
    const blocks = String(t || '').split(/```/);
    return blocks.map((b, i) => {
      if (i % 2) return `<pre><code>${esc(b.replace(/^\w*\n/, ''))}</code></pre>`;
      return esc(b)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
        .replace(/(^|\n)[-*] (.+)/g, '$1• $2')
        .split(/\n{2,}/).map((p) => (p.trim() ? `<p>${p.replace(/\n/g, '<br>')}</p>` : '')).join('');
    }).join('');
  }

  /* --- pairing --- */
  function unpair() { token = ''; localStorage.removeItem(KEY); localStorage.removeItem('nova.token'); $('#app').hidden = true; $('#pair').hidden = false; }
  async function pair(codeText) {
    const msg = $('#pair-msg'); msg.textContent = '';
    try {
      const r = await fetch('/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: String(codeText || '').toUpperCase().trim(), name: deviceName() }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'could not pair');
      token = j.token; localStorage.setItem(KEY, token);
      history.replaceState(null, '', '/');
      start();
    } catch (e) { msg.textContent = e.message; }
  }
  function deviceName() {
    const ua = navigator.userAgent;
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua)) return 'iPad';
    if (/Android/.test(ua)) return 'Android phone';
    return 'Phone';
  }
  $('#pair-go').addEventListener('click', () => pair($('#pair-code').value));
  $('#pair-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') pair(e.target.value); });

  /* --- rendering --- */
  function messageEl(m) {
    const c = m.content || {};
    if (m.role === 'user') {
      const w = el(`<div class="row me" data-id="${m.id}"><div><div class="col"></div><div class="time" style="text-align:right">${fmtTime(m.created_at)}</div></div></div>`);
      const col = w.querySelector('.col');
      if (c.text) col.appendChild(el(`<div class="bubble">${esc(c.text)}</div>`));
      (c.images || []).forEach((im) => col.appendChild(el(`<div class="imgcard"><img src="${media(im.path)}" alt=""></div>`)));
      if (c.audio) col.appendChild(el(`<div class="bubble audio"><audio controls preload="none" src="${media(c.audio.path)}"></audio></div>`));
      if (c.transcript) col.appendChild(el(`<div class="time">“${esc(c.transcript)}”</div>`));
      return w;
    }
    const w = el(`<div class="row"><div class="ai"><img class="avatar" src="/avatar.png" alt=""><div class="body"><div class="steps"></div><div class="md"></div><div class="audio-slot"></div><div class="time">${fmtTime(m.created_at)}</div></div></div></div>`);
    w.dataset.id = m.id;
    (c.steps || []).forEach((s) => w.querySelector('.steps').appendChild(stepEl(s)));
    w.querySelector('.md').innerHTML = md(c.text || (c.error ? c.error : '…'));
    if (c.audio) w.querySelector('.audio-slot').appendChild(el(`<div class="audio"><audio controls preload="none" src="${media(c.audio.path)}"></audio></div>`));
    return w;
  }
  const stepIcon = { done: '✓', running: '…', error: '✕', denied: '✕' };
  function stepEl(s) { return el(`<div class="step ${s.status}" data-step="${s.id}">${stepIcon[s.status] || '·'} ${esc(s.summary)}</div>`); }
  function msgEl(id) { return document.querySelector(`[data-id="${id}"]`); }
  function scroll(force) { const t = $('#thread'); const near = t.scrollHeight - t.scrollTop - t.clientHeight < 200; if (force || near) t.scrollTop = t.scrollHeight; }

  function approvalEl(a) {
    const w = el(`<div class="approval" data-approval="${a.id}"><div><b>Approval needed</b> <span class="muted">· ${esc(a.risk)} risk</span></div><div class="cmd">${esc(a.summary)}</div><div class="btns"><button class="ok">Approve</button><button class="no">Deny</button></div></div>`);
    w.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      api('/api/approval', { method: 'POST', body: JSON.stringify({ id: a.id, decision: b.classList.contains('ok') ? 'approved' : 'denied' }) }).catch(() => {});
    }));
    return w;
  }

  /* --- events --- */
  function connect() {
    if (state.es) state.es.close();
    const es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
    state.es = es;
    es.onopen = () => setStatus('Connected');
    es.onerror = () => setStatus('Reconnecting…');
    es.onmessage = (ev) => { let e; try { e = JSON.parse(ev.data); } catch { return; } handle(e); };
  }
  function setStatus(t, busy) { const s = $('#status'); s.textContent = t; s.classList.toggle('busy', !!busy); }
  function handle(e) {
    const mine = !e.chatId || e.chatId === state.chatId;
    switch (e.type) {
      case 'message': if (mine) { $('#thread').appendChild(messageEl(e.message)); scroll(true); } break;
      case 'assistant:start': if (mine) { $('#thread').appendChild(messageEl(e.message)); state.streams.set(e.message.id, ''); scroll(true); } break;
      case 'delta': { if (!state.streams.has(e.id)) return; const t = state.streams.get(e.id) + e.text; state.streams.set(e.id, t); const m = msgEl(e.id); if (m) { m.querySelector('.md').innerHTML = md(t); scroll(); } break; }
      case 'step': if (mine) { const m = msgEl(e.id); if (m) { const box = m.querySelector('.steps'); const ex = box.querySelector(`[data-step="${e.step.id}"]`); const n = stepEl(e.step); ex ? ex.replaceWith(n) : box.appendChild(n); scroll(); } } break;
      case 'approval': if (mine) { const all = document.querySelectorAll('.ai .body'); const host = all[all.length - 1] || $('#thread'); host.appendChild(approvalEl(e)); scroll(true); } break;
      case 'approval:resolved': { const c = document.querySelector(`[data-approval="${e.id}"]`); if (c) { c.classList.add('done'); c.querySelector('.btns').innerHTML = `<span class="muted">${e.decision === 'approved' ? 'Approved' : 'Denied'}${e.timedOut ? ' (timed out)' : ''}</span>`; } break; }
      case 'assistant:done': { state.streams.delete(e.id); const m = msgEl(e.id); if (m) m.querySelector('.md').innerHTML = md(e.message.content.text); break; }
      case 'tts': { const m = msgEl(e.id); if (m) { const slot = m.querySelector('.audio-slot'); slot.innerHTML = ''; const a = el(`<div class="audio"><audio controls preload="auto" src="${media(e.path)}"></audio></div>`); slot.appendChild(a); a.querySelector('audio').play().catch(() => {}); } break; }
      case 'state': setStatus({ idle: 'Connected', thinking: 'Thinking…', writing: 'Writing…', speaking: 'Speaking…' }[e.state] || e.state, e.state !== 'idle'); setBusy(e.state === 'thinking' || e.state === 'writing'); break;
      case 'context': if (mine && e.context) $('#ctx').textContent = `${Math.round(e.used / 100) / 10}k / ${Math.round(e.context / 1000)}k tokens`; break;
      case 'notice': if (mine) { $('#thread').appendChild(el(`<div class="notice">${esc(e.text)}</div>`)); scroll(); } break;
      case 'error': { const m = e.id && msgEl(e.id); if (m) m.querySelector('.md').innerHTML = md(e.message); else $('#thread').appendChild(el(`<div class="notice">${esc(e.message)}</div>`)); setBusy(false); break; }
      case 'chats': loadChats(); break;
    }
  }
  function setBusy(b) { state.busy = b; const s = $('#btn-send'); s.classList.toggle('stop', b); s.textContent = b ? '■' : '↑'; }

  /* --- data --- */
  async function loadChats() { const st = await api('/api/state'); state.chats = st.chats; state.persona = st.persona.name; $('#persona').textContent = st.persona.name; renderChats(); return st; }
  function renderChats() {
    const box = $('#chat-list'); box.innerHTML = '';
    state.chats.forEach((c) => { const r = el(`<div class="chat-row ${c.id === state.chatId ? 'on' : ''}">${esc(c.title)}</div>`); r.addEventListener('click', () => { openChat(c.id); $('#drawer').hidden = true; }); box.appendChild(r); });
  }
  async function openChat(id) {
    state.chatId = id; localStorage.setItem('lyra.chat', id);
    const { messages, context } = await api(`/api/chat/${id}`);
    const t = $('#thread'); t.innerHTML = '';
    messages.forEach((m) => t.appendChild(messageEl(m)));
    if (!messages.length) t.appendChild(el(`<div class="notice">New chat with ${esc(state.persona)}.</div>`));
    if (context && context.context) $('#ctx').textContent = `${Math.round(context.used / 100) / 10}k / ${Math.round(context.context / 1000)}k tokens`;
    renderChats(); scroll(true);
  }

  /* --- composing --- */
  const input = $('#input');
  const autosize = () => { input.style.height = 'auto'; input.style.height = Math.min(140, input.scrollHeight) + 'px'; };
  input.addEventListener('input', autosize);
  $('#btn-img').addEventListener('click', () => $('#file').click());
  $('#file').addEventListener('change', async (e) => { for (const f of e.target.files) state.atts.push(await shrink(f)); e.target.value = ''; renderAtts(); });
  function shrink(file) {
    return new Promise((resolve) => {
      const img = new Image(); const url = URL.createObjectURL(file);
      img.onload = () => {
        const max = 1280; const scale = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas'); c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
        resolve({ name: file.name || 'photo.jpg', dataUrl: c.toDataURL('image/jpeg', 0.85) });
      };
      img.onerror = () => resolve(null); img.src = url;
    });
  }
  function renderAtts() {
    const box = $('#atts'); box.innerHTML = ''; box.hidden = !state.atts.length;
    state.atts.forEach((a, i) => { const d = el(`<div class="att"><img src="${a.dataUrl}" alt=""><button>✕</button></div>`); d.querySelector('button').addEventListener('click', () => { state.atts.splice(i, 1); renderAtts(); }); box.appendChild(d); });
  }
  async function send() {
    if (state.busy) { await api(`/api/chat/${state.chatId}/stop`, { method: 'POST' }).catch(() => {}); return; }
    const text = input.value.trim();
    if (!text && !state.atts.length) return;
    const images = state.atts.slice(); state.atts = []; renderAtts();
    input.value = ''; autosize();
    await api(`/api/chat/${state.chatId}/send`, { method: 'POST', body: JSON.stringify({ text, images }) }).catch((e) => alert(e.message));
  }
  $('#btn-send').addEventListener('click', send);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });

  /* --- voice --- */
  $('#btn-mic').addEventListener('click', async () => {
    if (state.rec) { state.rec.stop(); return; }
    let stream; try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) { alert('Microphone not available: ' + e.message); return; }
    const rec = new MediaRecorder(stream); const chunks = []; const t0 = Date.now();
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop()); state.rec = null; $('#btn-mic').classList.remove('rec');
      const dur = (Date.now() - t0) / 1000; if (dur < 0.6) return;
      const fr = new FileReader();
      fr.onload = () => api(`/api/chat/${state.chatId}/send`, { method: 'POST', body: JSON.stringify({ audio: { dataUrl: fr.result, mime: 'audio/webm', duration: dur } }) }).catch((e) => alert(e.message));
      fr.readAsDataURL(new Blob(chunks, { type: 'audio/webm' }));
    };
    rec.start(); state.rec = rec; $('#btn-mic').classList.add('rec');
  });

  /* --- chrome --- */
  $('#btn-chats').addEventListener('click', () => { $('#drawer').hidden = !$('#drawer').hidden; });
  $('#btn-new').addEventListener('click', async () => { const c = await api('/api/chat', { method: 'POST' }); await loadChats(); openChat(c.id); $('#drawer').hidden = true; });
  $('#a2hs-close').addEventListener('click', () => { $('#a2hs').hidden = true; localStorage.setItem('lyra.a2hs', '1'); });

  /* --- boot --- */
  async function start() {
    $('#pair').hidden = true; $('#app').hidden = false;
    const st = await loadChats();
    const want = localStorage.getItem('lyra.chat');
    const pick = state.chats.find((c) => c.id === want) || state.chats.find((c) => c.kind !== 'goal') || state.chats[0];
    if (pick) await openChat(pick.id); else { const c = await api('/api/chat', { method: 'POST' }); await loadChats(); await openChat(c.id); }
    connect();
    const standalone = window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;
    if (!standalone && /iPhone|iPad/.test(navigator.userAgent) && !localStorage.getItem('lyra.a2hs')) $('#a2hs').hidden = false;
    void st;
  }
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get('p') && !token) pair(hash.get('p'));
  else if (token) start().catch((e) => {
    console.error('start failed', e);
    // A network hiccup should not force pairing again; only a rejected token does.
    if (/not paired/i.test(e.message)) unpair();
    else { $('#pair').hidden = true; $('#app').hidden = false; $('#thread').innerHTML = ''; $('#thread').appendChild(el(`<div class="notice">Could not load: ${esc(e.message)}<br>Pull down to retry.</div>`)); }
  });
  else unpair();
  document.addEventListener('visibilitychange', () => { if (!document.hidden && token && state.es && state.es.readyState === 2) connect(); });
})();
