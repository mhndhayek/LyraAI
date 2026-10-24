// Story 07: Lyra on the desktop. The page inside the transparent companion window:
// her full-body 3D character, the line bubble over her head and the mini chat.
// It talks to the same chat as the main window (the chat that window has open),
// so a message sent here lands in that chat's history, and the reply streams,
// speaks and lip-syncs here the way it does in the main window.
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  marked.setOptions({ breaks: true, gfm: true });
  const md = (t) => marked.parse(esc(t));
  const fileUrl = (p) => (p && p.startsWith('file://') ? p : 'file://' + encodeURI(p || ''));
  const fmtDur = (s) => `${Math.floor((s || 0) / 60)}:${String(Math.floor((s || 0) % 60)).padStart(2, '0')}`;
  const plain = (t) => String(t || '').replace(/```[\s\S]*?```/g, ' ').replace(/[*_`#>[\]]/g, '').replace(/\(https?:[^)]*\)/g, '').replace(/\s+/g, ' ').trim();

  const S = { settings: null, themes: [], chatId: null, chatOpen: false, visible: false, side: 'right', state: 'idle', walking: false,
    reply: { id: null, text: '', done: true, error: null }, lineTimer: null, recording: null, approval: null, hoverOver: false, lastHit: 0 };
  const stage = $('#c-stage'); const card = $('#c-card'); const line = $('#c-line'); const input = $('#c-input');
  const char = new LyraCharacter(stage, { framing: 'full', fps: 10 });
  window.LyraCompanion = { state: () => ({ ...S, settings: undefined, themes: undefined }), char: () => char };

  /* ---------- theme and look ---------- */
  function applyTheme() {
    const a = S.settings.appearance; const t = S.themes.find((x) => x.id === a.theme) || S.themes.find((x) => x.id === 'lyra-dark') || S.themes[0];
    if (t) { const l = $('#theme-css'); if (l.getAttribute('href') !== t.css) l.setAttribute('href', t.css); document.documentElement.dataset.theme = t.id; document.documentElement.dataset.scheme = t.scheme; }
    const name = S.settings.persona.name || 'Lyra';
    $('#c-name').textContent = name; input.placeholder = `Message ${name}`; document.title = `${name} on the desktop`;
    char.configure({ vrmModel: a.vrmModel });
  }
  // ≤ 30 fps while she is doing something you can see, ≤ 10 fps while she just stands there.
  function paceFrames() { char.fps = S.walking || S.chatOpen || S.state !== 'idle' || S.dragging ? 30 : 10; }

  /* ---------- click-through: only her body and the cards take the mouse ---------- */
  const probe = document.createElement('canvas'); probe.width = probe.height = 1; const pctx = probe.getContext('2d', { willReadFrequently: true });
  function overHer(x, y) {
    const cv = stage.querySelector('canvas'); if (!cv) return false;
    const r = cv.getBoundingClientRect(); if (x < r.left || y < r.top || x >= r.right || y >= r.bottom) return false;
    const px = Math.floor((x - r.left) * cv.width / r.width), py = Math.floor((y - r.top) * cv.height / r.height);
    // A few pixels' slack around her, so the edge of a sleeve still counts.
    pctx.clearRect(0, 0, 1, 1);
    try { pctx.drawImage(cv, Math.max(0, px - 3), Math.max(0, py - 3), 7, 7, 0, 0, 1, 1); } catch { return false; }
    return pctx.getImageData(0, 0, 1, 1).data[3] > 8;
  }
  function overCards(t) { return !!(t && t.closest && t.closest('.c-card, .c-line')); }
  function setOver(over) { if (over === S.hoverOver) return; S.hoverOver = over; lyra.companion.ignoreMouse(over); }
  window.addEventListener('mousemove', (e) => {
    if (S.drag) return;
    const cards = overCards(e.target); const her = !cards && overHer(e.clientX, e.clientY);
    setOver(cards || her);
    // Hover: she looks at the cursor.
    if (her || cards) { const r = stage.getBoundingClientRect(); char.gaze = { x: Math.max(-0.6, Math.min(0.6, (e.clientX - (r.left + r.width / 2)) / 260)), y: Math.max(-0.4, Math.min(0.4, ((r.top + r.height * 0.18) - e.clientY) / 300)) }; }
    else char.gaze = null;
  });
  document.addEventListener('mouseleave', () => { if (!S.drag) { setOver(false); char.gaze = null; } });

  /* ---------- drag her, click her, right-click her ---------- */
  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !overHer(e.clientX, e.clientY)) return;
    stage.setPointerCapture(e.pointerId);
    S.drag = { x: e.screenX, y: e.screenY, moved: false };
    lyra.companion.drag({ phase: 'start', screenX: e.screenX, screenY: e.screenY });
  });
  stage.addEventListener('pointermove', (e) => {
    if (!S.drag) return;
    if (!S.drag.moved && Math.hypot(e.screenX - S.drag.x, e.screenY - S.drag.y) < 4) return;
    if (!S.drag.moved) { S.drag.moved = true; S.dragging = true; document.body.classList.add('dragging'); paceFrames(); }
    lyra.companion.drag({ phase: 'move', screenX: e.screenX, screenY: e.screenY });
  });
  stage.addEventListener('pointerup', (e) => {
    if (!S.drag) return; const d = S.drag; S.drag = null; S.dragging = false; document.body.classList.remove('dragging');
    try { stage.releasePointerCapture(e.pointerId); } catch {}
    lyra.companion.drag({ phase: 'end', screenX: e.screenX, screenY: e.screenY });
    paceFrames();
    if (!d.moved) { // a click: a little happy bounce, and the chat opens (or closes)
      char.cheer(); char.gesture('happy_bounce');
      openChat(!S.chatOpen);
    }
  });
  stage.addEventListener('contextmenu', (e) => { e.preventDefault(); if (overHer(e.clientX, e.clientY)) lyra.companion.menu(); });
  line.addEventListener('click', () => openChat(true));

  /* ---------- the mini chat ---------- */
  async function openChat(open) {
    if (open) S.chatId = await lyra.companion.chat();
    const r = await lyra.companion.open({ open }); applyLayout(r.chatOpen, r.side);
    if (r.chatOpen) { hideLine(); renderReply(); if (!S.reply.id && !S.reply.text) await loadLastReply(); setTimeout(() => input.focus(), 30); }
  }
  function applyLayout(open, side) {
    S.chatOpen = !!open; S.side = side || S.side || 'right';
    document.body.dataset.side = S.chatOpen ? S.side : 'none';
    card.hidden = !S.chatOpen; if (!S.chatOpen) setOver(false);
    paceFrames();
  }
  async function loadLastReply() {
    if (!S.chatId) return;
    try {
      const { messages } = await lyra.chats.get({ id: S.chatId });
      const last = [...messages].reverse().find((m) => m.role === 'assistant' && m.content && m.content.text);
      S.reply = { id: last ? last.id : null, text: last ? last.content.text : '', done: true, error: null };
    } catch {}
    renderReply();
  }
  function renderReply() {
    const el = $('#c-reply'); const r = S.reply; const name = S.settings ? S.settings.persona.name : 'Lyra';
    el.classList.toggle('error', !!r.error);
    if (r.error) { el.classList.remove('empty'); el.innerHTML = md(r.error); }
    else if (r.text) { el.classList.remove('empty'); el.innerHTML = md(r.text); }
    else { el.classList.add('empty'); el.textContent = r.done ? `Say hi to ${name}.` : '…'; }
    el.scrollTop = el.scrollHeight;
    const busy = { thinking: 'thinking…', writing: 'writing…', speaking: 'speaking' }[S.state] || '';
    $('#c-state').textContent = busy;
    const note = $('#c-note');
    if (S.approval) { note.hidden = false; note.innerHTML = `<span>${esc(name)} needs your approval.</span>`; const b = document.createElement('button'); b.className = 'btn small'; b.textContent = 'Open full chat'; b.addEventListener('click', () => lyra.companion.openMain()); note.appendChild(b); }
    else note.hidden = true;
  }
  function showLine(text) {
    const t = plain(text); if (!t) return;
    line.textContent = t.length > 140 ? t.slice(0, 138).trimEnd() + '…' : t; line.hidden = false;
    clearTimeout(S.lineTimer); S.lineTimer = setTimeout(hideLine, 6000);
  }
  function hideLine() { clearTimeout(S.lineTimer); line.hidden = true; }

  async function send(extra = {}) {
    const text = input.value.trim(); if (!text && !extra.audio) return;
    if (!S.chatId) S.chatId = await lyra.companion.chat();
    input.value = '';
    S.reply = { id: null, text: '', done: false, error: null }; renderReply();
    const r = await lyra.chat.send({ chatId: S.chatId, text, images: [], audio: extra.audio || null, origin: 'desktop' });
    if (!r || !r.ok) { S.reply = { id: null, text: '', done: true, error: (r && r.error) || 'Could not send.' }; renderReply(); }
  }
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); send(); } });
  $('#c-send').addEventListener('click', () => send());
  $('#c-close').addEventListener('click', () => openChat(false));
  $('#c-full').addEventListener('click', () => lyra.companion.openMain());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.chatOpen) openChat(false); });

  // The mic: record, then send the voice message the way the main window does.
  async function toggleRecording() {
    if (S.recording) { S.recording.rec.stop(); return; }
    if (!S.settings.voice.stt) { S.reply = { ...S.reply, error: 'Speech to text is off (Settings › Voice).' }; renderReply(); return; }
    let stream; try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (e) { S.reply = { ...S.reply, error: 'Microphone not available: ' + e.message }; renderReply(); return; }
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    const rec = new MediaRecorder(stream, { mimeType: mime }); const chunks = []; const started = Date.now();
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop()); clearInterval(S.recording.timer); const duration = (Date.now() - started) / 1000; S.recording = null;
      $('#c-rec').hidden = true; $('#c-mic').classList.remove('rec');
      if (duration < 0.6) return;
      const r = new FileReader(); r.onload = () => send({ audio: { dataUrl: r.result, mime: 'audio/webm', duration } }); r.readAsDataURL(new Blob(chunks, { type: 'audio/webm' }));
    };
    rec.start(250); S.recording = { rec, timer: setInterval(() => { $('#c-rec-time').textContent = fmtDur((Date.now() - started) / 1000); }, 500) };
    $('#c-rec').hidden = false; $('#c-rec-time').textContent = '0:00'; $('#c-mic').classList.add('rec');
  }
  $('#c-mic').addEventListener('click', toggleRecording);

  /* ---------- her voice (same contract as the main window, story 05) ---------- */
  const reportPlaying = (playing, id) => { try { lyra.voice.playing({ chatId: S.chatId, id, playing }); } catch {} };
  let speech = null; let single = null; const silenced = new Set();
  function stopAll() { if (speech) finishSpeech(speech); if (single) { try { single.a.pause(); } catch {} const s = single; single = null; char.detachAudio(); reportPlaying(false, s.id); } }
  function onChunk(e) {
    if (silenced.has(e.id)) return;
    if (!speech || speech.id !== e.id) { stopAll(); speech = { id: e.id, chunks: new Map(), next: 1, audio: null, started: false, ended: false }; }
    const a = e.path ? new Audio(fileUrl(e.path)) : null; if (a) a.preload = 'auto';
    speech.chunks.set(e.seq, { audio: a, final: !!e.final }); if (!speech.audio) playNext(speech);
  }
  function playNext(sp) {
    if (speech !== sp || sp.ended) return;
    const c = sp.chunks.get(sp.next); if (!c) return; sp.chunks.delete(sp.next); sp.next++;
    if (c.final) sp.final = true;
    if (!c.audio) { if (c.final) finishSpeech(sp); else playNext(sp); return; }
    sp.audio = c.audio; let done = false;
    const after = () => { if (done) return; done = true; char.detachAudio(); sp.audio = null; if (c.final) finishSpeech(sp); else playNext(sp); };
    c.audio.addEventListener('ended', after); c.audio.addEventListener('error', after);
    c.audio.play().then(() => { if (speech !== sp || sp.ended) { c.audio.pause(); return; } char.attachAudio(c.audio); if (!sp.started) { sp.started = true; reportPlaying(true, sp.id); } }).catch(after);
  }
  function finishSpeech(sp) {
    if (sp.ended) return; sp.ended = true;
    if (!(sp.final && !sp.chunks.size && !sp.audio)) silenced.add(sp.id);
    if (sp.audio) { try { sp.audio.pause(); } catch {} sp.audio = null; }
    sp.chunks.clear(); char.detachAudio(); if (sp.started) reportPlaying(false, sp.id); if (speech === sp) speech = null;
  }
  function playWhole(e) {
    stopAll(); const a = new Audio(fileUrl(e.path)); single = { a, id: e.id }; let done = false;
    const end = () => { if (done) return; done = true; char.detachAudio(); if (single && single.a === a) single = null; reportPlaying(false, e.id); };
    a.addEventListener('ended', end); a.addEventListener('error', end);
    a.play().then(() => { char.attachAudio(a); reportPlaying(true, e.id); }).catch(end);
  }

  /* ---------- events ---------- */
  lyra.onEvent((e) => {
    const mine = !e.chatId || e.chatId === S.chatId;
    switch (e.type) {
      case 'companion':
        S.visible = !!e.visible; applyLayout(e.chatOpen, e.side);
        if (S.visible) lyra.companion.chat().then((id) => { if (id !== S.chatId) { S.chatId = id; S.reply = { id: null, text: '', done: true, error: null }; } }).catch(() => {});
        else { hideLine(); stopAll(); S.drag = null; setOver(false); }
        break;
      case 'companion:walk': S.walking = !!e.walking; char.setMotion(S.walking ? 'walk' : null); char.face(S.walking ? e.dir : 0); paceFrames(); break;
      case 'companion:gesture': char.gesture(e.name); break;
      case 'state': S.state = e.state; char.setState(e.state); paceFrames(); if (S.chatOpen) renderReply(); break;
      case 'assistant:start': if (mine && e.message) { S.reply = { id: e.message.id, text: '', done: false, error: null }; if (S.chatOpen) renderReply(); } break;
      case 'delta': if (e.id === S.reply.id) { S.reply.text += e.text; if (S.chatOpen) renderReply(); } break;
      case 'assistant:done': if (e.id === S.reply.id || (mine && e.message && e.message.role === 'assistant')) { S.reply = { id: e.id, text: (e.message && e.message.content && e.message.content.text) || S.reply.text, done: true, error: null }; if (S.chatOpen) renderReply(); else if (S.visible) showLine(S.reply.text); } break;
      case 'error': if (mine && (!e.id || e.id === S.reply.id)) { S.reply = { ...S.reply, done: true, error: e.message }; if (S.chatOpen) renderReply(); else if (S.visible) showLine(e.message); } break;
      case 'approval': if (mine) { S.approval = e.id; if (!S.chatOpen && S.visible) showLine(`${S.settings.persona.name} needs your approval: ${e.summary}`); renderReply(); } break;
      case 'approval:resolved': if (S.approval === e.id) { S.approval = null; renderReply(); } break;
      case 'tts:chunk': if (mine) onChunk(e); break;
      case 'tts:stop': if (mine) stopAll(); break;
      case 'tts': if (mine && !e.streamed && e.path) playWhole(e); break;
      case 'settings': S.settings = e.settings; applyTheme(); break;
      case 'profiles': case 'chats': if (!S.chatOpen) S.chatId = null; break;
    }
  });

  (async () => {
    S.settings = await lyra.settings.get(); S.themes = await lyra.themes.list();
    applyTheme(); fillIcons(); renderReply();
    const st = await lyra.companion.state(); if (st) { S.visible = st.visible; applyLayout(st.chatOpen, st.side); if (st.walking) { S.walking = true; char.setMotion('walk'); } }
  })();
})();
