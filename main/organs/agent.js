// The agent loop: builds the context (soul, profile, memory, workspace), streams
// the model, runs tools behind the approval gate, compresses context, speaks.
const fs = require('fs');
const path = require('path');
const os = require('os');
const llm = require('./llm');
const ws = require('./workspace');
const { enabledTools, schemaFor, byName } = require('./tools');
const { maybeCompress, messagesTokens } = require('./compression');
const { estimateTokens, clampText, id } = require('./util');
const { SpeechQueue, joinWavs } = require('./speech-queue');

// How far a single turn may go before it stops on its own. Both are settings
// (Model › How far Lyra goes), these are only the floor and ceiling.
const STEP_RANGE = [1, 500];
const MINUTE_RANGE = [1, 480];
const clamp = (v, [lo, hi], d) => Math.max(lo, Math.min(hi, Number.isFinite(+v) ? Math.round(+v) : d));

class Agent {
  constructor(ctx) {
    this.ctx = ctx; // settings, store, approvals, browser, voice, notify, emit, root(), runShell, mediaDir
    this.runs = new Map(); this.models = { at: 0, byProvider: {} }; this.repoCache = { at: 0, list: [] };
    this.state = 'idle';
    // Speak while writing (story 05): one speech queue per chat, and the reply
    // whose audio the window reports as playing right now.
    this.speech = new Map(); this.playing = null;
  }
  isBusy() { return this.runs.size > 0; }
  setState(state, extra = {}) { this.state = state; this.ctx.emit(null, 'state', { state, ...extra }); }
  // What the turn is doing (thinking, writing, idle). While her voice is
  // playing she shows "speaking" instead, and goes back to this when it stops.
  turnState(state, extra = {}) { this.runState = { state, extra }; if (!this.playing) this.setState(state, extra); }
  stopAll() { for (const id of [...this.runs.keys()]) this.stop(id); for (const id of [...this.speech.keys()]) this.cancelSpeech(id); }
  stop(chatId) {
    const r = this.runs.get(chatId);
    if (r) { r.stopped = true; r.abort.abort(); }
    this.ctx.approvals.cancelAll(chatId); this.ctx.browser.stop();
    // Stop also silences her: no more sentences are synthesised, and the window drops what it queued.
    this.cancelSpeech(chatId);
    this.ctx.emit(chatId, 'tts:stop', {});
    if (this.playing && this.playing.chatId === chatId) { this.playing = null; if (!r) this.setState('idle'); }
  }

  // The reply is cut into sentences as it streams, and each one is spoken as
  // soon as it is synthesised. The window plays the chunks in seq order.
  startSpeech(chatId, msgId) {
    this.cancelSpeech(chatId);
    const { voice, emit } = this.ctx; const logs = this.ctx.kernel.logs; let failures = 0;
    const q = new SpeechQueue({
      tts: (text) => voice.tts(text),
      onChunk: (c) => emit(chatId, 'tts:chunk', { id: msgId, seq: c.seq, path: c.path, ...(c.final ? { final: true } : {}) }),
      onError: (e, job) => { logs.warn('voice', `Could not speak sentence ${job.seq}: ${e.message}`); if (!failures++) emit(chatId, 'notice', { text: `Voice failed: ${e.message}` }); },
      onLimit: (chars) => { logs.warn('voice', `Reply too long to speak in full: stopped after ${chars} characters`); emit(chatId, 'notice', { text: 'That reply was too long to read out in full.' }); },
    });
    q.chatId = chatId; q.msgId = msgId;
    this.speech.set(chatId, q);
    q.done.then(() => { if (this.speech.get(chatId) === q) this.speech.delete(chatId); });
    return q;
  }
  cancelSpeech(chatId) { const q = this.speech.get(chatId); if (q) { q.cancel(); this.speech.delete(chatId); } }
  // Once every sentence is out, the pieces are joined into one file so the
  // message keeps a single audio pill after a reload.
  async saveSpeech(q, asst, content) {
    const r = await q.done;
    if (r.cancelled || !r.chunks.length) return;
    const parts = r.chunks.map((c) => c.path);
    let file = parts[0];
    if (parts.length > 1) {
      const out = this.ctx.voice.outPath('wav');
      if (joinWavs(parts, out)) {
        file = out;
        // The window may still be playing the pieces, so they go a little later.
        const t = setTimeout(() => { for (const p of parts) fs.rm(p, { force: true }, () => {}); }, 10 * 60000); if (t.unref) t.unref();
      } else content.audioParts = parts;
    }
    content.audio = { path: file, engine: r.chunks[0].engine, chunks: parts.length };
    this.ctx.store.updateMessage(asst.id, content);
    this.ctx.emit(q.chatId, 'tts', { id: asst.id, path: file, parts: content.audioParts || null, streamed: true });
  }
  // The window reports when sound really starts and stops. Only then is she
  // "speaking", so the mouth never moves over silence.
  voicePlaying({ chatId = null, id: msgId = null, playing } = {}) {
    if (playing) {
      const first = !this.playing || this.playing.id !== msgId;
      this.playing = { chatId, id: msgId };
      if (first && this.timing && this.timing.id === msgId) {
        const t = this.timing; const now = Date.now();
        t.firstAudioMs = now - t.firstToken; t.afterSentenceMs = t.firstSentence ? now - t.firstSentence : null;
        this.ctx.kernel.logs.info('voice', `First audio ${t.firstAudioMs} ms after the reply started${t.afterSentenceMs != null ? `, ${t.afterSentenceMs} ms after its first sentence` : ''} (${t.streamed ? 'speak while writing' : 'whole reply'})`);
      }
      this.setState('speaking');
    } else {
      if (this.playing && msgId && this.playing.id !== msgId) return true;
      this.playing = null;
      if (this.state === 'speaking') { const r = this.runs.size && this.runState ? this.runState : { state: 'idle', extra: {} }; this.setState(r.state, r.extra); }
    }
    return true;
  }

  providers() { return this.ctx.settings.get().providers.list; }
  providerById(id) { const l = this.providers(); return l.find((p) => p.id === id) || l[0]; }
  async detectModels(force = false) {
    if (!force && Date.now() - this.models.at < 60000) return this.models;
    const byProvider = {};
    await Promise.all(this.providers().map(async (p) => {
      const r = await llm.listModels({ endpoint: p.endpoint, apiKey: p.apiKey });
      byProvider[p.id] = { ok: r.ok, list: r.models, error: r.error, source: r.source, router: r.router, needsKey: r.needsKey, version: r.version || null, summary: llm.summarize(r), endpoint: p.endpoint };
    }));
    // Remember what each server turned out to be, so its logo shows before the
    // next check. A name that is still a default ("LM Studio", "Server 2")
    // follows what was found; a name the user typed is left alone.
    const list = this.providers(); const updated = list.map((p) => {
      const r = byProvider[p.id]; if (!r || !r.ok) return p;
      const name = llm.isDefaultName(p.name) && p.name !== llm.KIND_NAMES[r.source] ? llm.KIND_NAMES[r.source] : p.name;
      return r.source !== p.detected || name !== p.name ? { ...p, detected: r.source, name } : p;
    });
    if (updated.some((p, i) => p !== list[i])) this.ctx.settings.set({ providers: { list: updated } });
    this.models = { at: Date.now(), byProvider };
    this.ctx.emit(null, 'models', this.models);
    return this.models;
  }
  // Resolves the model for a role (chat = brain, vision) to {id, context, endpoint, apiKey, ...}.
  async pickModel(needVision) {
    const s = this.ctx.settings.get();
    const m = await this.detectModels();
    const resolve = (role) => {
      const sel = s.model[role] || {}; const prov = this.providerById(sel.provider); const info = m.byProvider[prov.id] || { ok: false, list: [], error: 'not checked' };
      const find = (mid) => info.list.find((x) => x.id === mid) || null;
      let chosen = sel.model ? find(sel.model) : null;
      if (!chosen && !sel.model) chosen = llm.autoPick(info.list, role === 'vision' ? (x) => x.vision : undefined);
      if (!chosen && sel.model) chosen = { id: sel.model, context: null, vision: role === 'vision', tools: true, undetected: true };
      return chosen ? { ...chosen, provider: prov.id, providerName: prov.name, endpoint: prov.endpoint, apiKey: prov.apiKey, error: info.error } : { missing: true, provider: prov, error: info.error };
    };
    let chosen = needVision ? resolve('vision') : null;
    if (!chosen || chosen.missing || (needVision && !chosen.vision && !chosen.undetected)) { const c = resolve('chat'); if (!needVision || !chosen || chosen.missing) chosen = c; }
    if (chosen.missing) throw new Error(chosen.error ? `No model reachable at ${chosen.provider.endpoint} for “${chosen.provider.name}” (${chosen.error}). Check Settings › Provider.` : `No models found on “${chosen.provider.name}”. Load one in your runtime, then pick it under Settings › Model.`);
    const context = s.model.contextMode === 'manual' ? s.model.contextOverride : (chosen.context || chosen.maxContext || 8192);
    return { ...chosen, context: Math.max(2048, context) };
  }

  repos() {
    const s = this.ctx.settings.get();
    if (!s.workspace.repoDiscovery) return [];
    if (Date.now() - this.repoCache.at > 120000) this.repoCache = { at: Date.now(), list: ws.discoverRepos(this.ctx.root()) };
    return this.repoCache.list;
  }

  systemPrompt(chatId, modelInfo) {
    const s = this.ctx.settings.get(); const p = s.persona; const st = this.ctx.store;
    const parts = [];
    const profileBudget = s.memory.profileBudget * 4;
    parts.push(`You are ${p.name}, a personal AI assistant running locally on the user's ${os.platform() === 'darwin' ? 'Mac' : os.platform()}.`);
    parts.push(p.soul.slice(0, profileBudget));
    parts.push(`Now: ${new Date().toLocaleString()}. Workspace (your folder for files, projects, images, notes): ${this.ctx.root()}.`);
    const repos = this.repos();
    if (repos.length) parts.push(`Repositories in the workspace: ${repos.map((r) => `${r.name} (${r.branch})`).join(', ')}.`);
    if (p.memoryEnabled) {
      if (p.longTerm && s.memory.longTerm) {
        let used = 0; const lines = [];
        for (const m of st.listMemories('long')) { const t = estimateTokens(m.text); if (used + t > s.memory.memoryBudget) break; used += t; lines.push(`- ${m.text}`); }
        if (lines.length) parts.push(`Long-term memory (persists across all chats):\n${lines.join('\n')}`);
      }
      if (p.shortTerm) {
        const short = st.listMemories('short', chatId).map((m) => `- ${m.text}`);
        if (short.length) parts.push(`Notes from this chat:\n${short.slice(0, 40).join('\n')}`);
      }
      parts.push(`Memory rules: only you write to memory. Use the remember tool with scope "long" for durable facts about the user, their machines, network, preferences and projects, and scope "short" for working notes in this chat. Do not ask permission to remember ordinary things.`);
    }
    const tools = enabledTools(s, this.extraTools());
    if (tools.length) {
      const bmode = s.browser.mode === 'headless' ? 'headless (the user only sees a status line in chat)' : 'visible inside the app (the user watches and can take over)';
      parts.push(`You have tools. Use them instead of guessing: read files before editing, run commands to verify, open pages to check facts. Some actions need the user's approval; if one is denied, respect it and say so. Your browser runs ${bmode}. Keep files you create inside the workspace.`);
      const mcpNames = [...new Set(tools.filter((t) => t.key === 'mcp').map((t) => t.mcpServer))];
      if (mcpNames.length) parts.push(`Tools named mcp_<server>_<tool> come from MCP servers the user connected (${mcpNames.join(', ')}). Use them for what they offer, such as generating images, music, speech or video on the user's media hub. A tool that returns a job_id runs in the background: poll its jobs_status tool until it is done.`);
    }
    if (s.tools.app && tools.some((t) => t.key === 'app')) {
      const k = this.ctx.kernel; const st = k.appState();
      parts.push(`You live inside Lyra ${st.version}, a desktop app built so you can customize and extend it. You may change settings (configure_app), the look (themes), your picture, voice, image backend, add abilities as extensions, and edit the app's own organs in the state folder (${k.paths.state}). Before changing the app for the first time in a chat, call read_docs with topic agent. The user has locked: your name, safety rules, providers and API keys. Every change is checkpointed and can be rolled back; ${st.budget.limit - st.budget.used} self-modification writes remain today.${st.pendingChanges ? ' There are unapplied changes; call apply_changes.' : ''}`);
    }
    const r = s.model.reasoning;
    if (r === 'off') parts.push('Answer directly without lengthy deliberation. /no_think');
    else if (r === 'high') parts.push('Think carefully and check your work before answering.');
    parts.push('Style: plain, concise, no filler. Use markdown sparingly (code blocks for code). Answer in the language the user writes in.');
    return parts.join('\n\n');
  }

  imagePart(file) {
    const ext = path.extname(file).slice(1).toLowerCase(); const mime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }[ext] || 'image/png';
    return { type: 'image_url', image_url: { url: `data:${mime};base64,${fs.readFileSync(file).toString('base64')}` } };
  }
  history(chatId) {
    const chat = this.ctx.store.getChat(chatId);
    const all = this.ctx.store.listMessages(chatId).slice(chat.summarized_count || 0);
    const userIdx = all.map((m, i) => (m.role === 'user' ? i : -1)).filter((i) => i >= 0);
    const recentImages = new Set(userIdx.slice(-2));
    const out = [];
    all.forEach((m, i) => {
      const c = m.content || {};
      if (m.role === 'user') {
        const text = [c.text, c.transcript && !c.text ? c.transcript : null].filter(Boolean).join('\n') || (c.images?.length ? 'What do you see?' : '');
        const imgs = (c.images || []).filter((im) => fs.existsSync(im.path));
        if (imgs.length && recentImages.has(i)) out.push({ role: 'user', content: [{ type: 'text', text }, ...imgs.map((im) => this.imagePart(im.path))] });
        else out.push({ role: 'user', content: imgs.length ? `${text}\n[${imgs.length} image(s) attached earlier: ${imgs.map((x) => x.name).join(', ')}]` : text });
      } else if (m.role === 'assistant' && (c.text || '').trim()) out.push({ role: 'assistant', content: c.text });
    });
    return { chat, messages: out };
  }

  // What the next request to the model would carry, without sending anything.
  async contextInfo(chatId) {
    const s = this.ctx.settings.get(); const store = this.ctx.store;
    const chat = store.getChat(chatId); if (!chat) return null;
    let model;
    try { model = await this.pickModel(false); }
    catch (e) { model = { id: (s.model.chat && s.model.chat.model) || 'no model', label: 'no model reachable', providerName: '', context: s.model.contextMode === 'manual' ? s.model.contextOverride : 8192, error: e.message }; }
    const tools = schemaFor(enabledTools(s, this.extraTools()));
    const { messages: hist } = this.history(chatId);
    const parts = {
      system: estimateTokens(this.systemPrompt(chatId, model)),
      tools: estimateTokens(JSON.stringify(tools)),
      summary: estimateTokens(chat.summary || ''),
      history: messagesTokens(hist),
    };
    const used = parts.system + parts.tools + parts.summary + parts.history;
    return {
      used, context: model.context, model: model.id, label: model.label || model.id, provider: model.providerName || '',
      parts, messages: hist.length, summarized: chat.summarized_count || 0, error: model.error || null,
      contextMode: s.model.contextMode, threshold: s.memory.threshold, target: s.memory.target,
      compression: !!(s.model.compression && s.memory.autoCompression),
    };
  }

  async describeImage(file, question) {
    const s = this.ctx.settings.get();
    if (!s.tools.vision) return 'Vision is turned off in Settings › Tools.';
    const m = await this.pickModel(true);
    if (!m.vision) return `No vision model is configured (Settings › Model). Cannot look at ${path.basename(file)}.`;
    const text = await llm.chatOnce({ endpoint: m.endpoint, apiKey: m.apiKey, model: m.id, temperature: 0.2, maxTokens: 800, messages: [{ role: 'user', content: [{ type: 'text', text: question }, this.imagePart(file)] }] });
    return text || '(no description)';
  }

  // Tools from extensions and from connected MCP servers.
  extraTools() { const k = this.ctx.kernel; return k.extensions.tools().concat(this.ctx.mcp ? this.ctx.mcp.tools() : []); }
  async run({ chatId, text = '', images = [], audio = null, internal = false, skipPersist = false, origin = 'desktop' }) {
    const { settings, store, emit, approvals, browser, voice, notify } = this.ctx;
    const s = settings.get();
    const active = this.runs.get(chatId);
    if (active) {
      if (s.chat.followUp === 'cancel') { this.stop(chatId); await active.promise.catch(() => {}); }
      else {
        // Steer: show the message now and fold it into the running task at the next model call.
        const m = store.addMessage(chatId, 'user', { text: text.trim(), images, audio, transcript: null, steer: true });
        emit(chatId, 'message', { message: m }); active.queue.push({ id: m.id, text: text.trim(), images });
        emit(chatId, 'notice', { text: 'Folded into the current task.' });
        return { ok: true, steered: true };
      }
    }
    // A new message ends whatever she was still saying.
    if (this.speech.has(chatId) || (this.playing && this.playing.chatId === chatId)) { this.cancelSpeech(chatId); this.ctx.emit(chatId, 'tts:stop', {}); this.playing = null; }
    const run = { abort: new AbortController(), stopped: false, started: Date.now(), queue: [], origin };
    let resolveDone; run.promise = new Promise((r) => { resolveDone = r; });
    this.runs.set(chatId, run);
    const chat = store.getChat(chatId); if (!chat) { this.runs.delete(chatId); throw new Error('Chat not found'); }
    let userMsg = null, asst = null, speech = null;
    try {
      // 1. The user's message (transcribe audio first).
      let transcript = null;
      if (audio && s.voice.stt) {
        this.turnState('thinking', { step: 'Transcribing' });
        try { transcript = (await voice.stt(audio.path)).text; } catch (e) { transcript = null; emit(chatId, 'notice', { text: `Could not transcribe: ${e.message}` }); }
      }
      const userText = text.trim() || transcript || '';
      if (!skipPersist) { userMsg = store.addMessage(chatId, 'user', { text: text.trim(), images, audio, transcript }); emit(chatId, 'message', { message: userMsg }); }
      if (chat.title === 'New chat' && userText) { store.updateChat(chatId, { title: userText.slice(0, 48) }); emit(null, 'chats', {}); }
      if (!userText && !images.length) throw new Error('Nothing to send.');

      // 2. Context.
      this.turnState('thinking', { step: 'Thinking' });
      browser.beginTurn(chatId);
      const model = await this.pickModel(images.length > 0);
      const system = this.systemPrompt(chatId, model);
      let { chat: c, messages: hist } = this.history(chatId);
      let summary = c.summary || null;
      let toolDefs = enabledTools(s, this.extraTools()); let toolSchema = schemaFor(toolDefs);
      const fixed = estimateTokens(system) + estimateTokens(JSON.stringify(toolSchema));
      if (s.model.compression && s.memory.autoCompression) {
        const r = await maybeCompress({ history: hist, previousSummary: summary, fixedTokens: fixed, contextLength: model.context, settings: s, llm, model: model.id, endpoint: model.endpoint, apiKey: model.apiKey, log: (t) => emit(chatId, 'notice', { text: t }) }).catch((e) => { emit(chatId, 'notice', { text: `Compression skipped: ${e.message}` }); return null; });
        if (r) { summary = r.summary; store.updateChat(chatId, { summary, summarized_count: (c.summarized_count || 0) + r.cut }); hist = hist.slice(r.cut); emit(chatId, 'activity', { icon: 'database', text: `Compressed ${r.cut} older messages into a summary` }); }
      }
      const messages = [{ role: 'system', content: system }];
      if (summary) messages.push({ role: 'system', content: `Summary of the earlier part of this conversation:\n${summary}` });
      messages.push(...hist);
      emit(chatId, 'context', { used: fixed + estimateTokens(summary || '') + messagesTokens(hist), context: model.context, model: model.id, label: model.label || model.id, provider: model.providerName });

      // 3. Assistant turn.
      asst = store.addMessage(chatId, 'assistant', { text: '', steps: [], model: model.id });
      emit(chatId, 'assistant:start', { message: asst });
      const content = asst.content; const visited = new Set();
      const readAloud = s.voice.readAloud && !internal;
      if (readAloud && s.voice.streamSpeech !== false) speech = this.startSpeech(chatId, asst.id);
      const timing = this.timing = { id: asst.id, streamed: !!speech, firstToken: null, firstSentence: null };
      const toolCtx = { settings: s, store, chatId, root: this.ctx.root(), abs: (p) => ws.resolvePath(this.ctx.root(), p), runShell: this.ctx.runShell, browser, browserMode: () => (s.browser.mode === 'headless' ? 'headless' : 'visible'), describeImage: (f, q) => this.describeImage(f, q), emit, notify, tools: byName, kernel: this.ctx.kernel };
      const maxSteps = clamp(s.model.maxSteps, STEP_RANGE, 30);
      const runMinutes = clamp(s.model.runMinutes, MINUTE_RANGE, 30);
      run.cap = setTimeout(() => { if (this.runs.get(chatId) === run) { emit(chatId, 'notice', { text: `This turn hit the ${runMinutes} minute limit and was stopped. Raise it under Settings › Model.` }); this.stop(chatId); } }, runMinutes * 60000);
      let steps = 0, firstToken = true;
      const drainQueue = () => { let n = 0; while (run.queue.length) { const q = run.queue.shift(); const imgs = (q.images || []).filter((im) => fs.existsSync(im.path)); messages.push({ role: 'user', content: imgs.length ? [{ type: 'text', text: `[Follow-up from the user while you work] ${q.text}` }, ...imgs.map((im) => this.imagePart(im.path))] : `[Follow-up from the user while you work] ${q.text}` }); n++; } return n; };
      while (steps++ < maxSteps) {
        if (run.stopped) break;
        drainQueue();
        emit(chatId, 'progress', { id: asst.id, step: steps, max: maxSteps });
        toolDefs = enabledTools(s, this.extraTools()); toolSchema = schemaFor(toolDefs);
        const res = await llm.chatStream({
          endpoint: model.endpoint, apiKey: model.apiKey, model: model.id, messages, tools: model.tools === false ? undefined : toolSchema, temperature: s.model.temperature, reasoning: s.model.reasoning, signal: run.abort.signal,
          onDelta: (d) => {
            if (firstToken) { firstToken = false; timing.firstToken = Date.now(); this.turnState('writing'); }
            content.text += d; emit(chatId, 'delta', { id: asst.id, text: d });
            if (speech) { speech.push(d); if (!timing.firstSentence && speech.firstChunkAt) timing.firstSentence = speech.firstChunkAt; }
          },
          onReasoning: (d) => { content.reasoning = (content.reasoning || '') + d; this.turnState('thinking', { step: 'Thinking' }); emit(chatId, 'reasoning', { id: asst.id, text: d }); },
        });
        if (!res.toolCalls.length) {
          // A steering message arrived while the model was answering: keep going in the same turn.
          if (run.queue.length && !run.stopped) { messages.push({ role: 'assistant', content: res.text || '' }); content.text += '\n\n'; emit(chatId, 'delta', { id: asst.id, text: '\n\n' }); if (speech) speech.push('\n\n'); continue; }
          break;
        }
        // Text the model wrote before calling tools was already streamed; separate it from what follows.
        if (res.text) { content.text += '\n\n'; emit(chatId, 'delta', { id: asst.id, text: '\n\n' }); if (speech) speech.push('\n\n'); }
        messages.push({ role: 'assistant', content: res.text || '', tool_calls: res.toolCalls });
        for (const tc of res.toolCalls) {
          if (run.stopped) break;
          let args = {}; try { args = JSON.parse(tc.function.arguments || '{}'); } catch { args = {}; }
          const liveDefs = enabledTools(s, this.extraTools()); const tool = liveDefs.find((t) => t.name === tc.function.name);
          const step = { id: id(), type: 'tool', name: tc.function.name, icon: tool ? tool.icon : 'tool', summary: tool ? safe(() => tool.summary(args, toolCtx), tc.function.name) : `Unknown tool ${tc.function.name}`, status: 'running', args: clampText(JSON.stringify(args), 600) };
          content.steps.push(step); emit(chatId, 'step', { id: asst.id, step });
          let result;
          if (!tool) result = `Tool ${tc.function.name} is not available. Available tools: ${liveDefs.map((t) => t.name).join(', ')}.`;
          else {
            const risk = safe(() => tool.risk(args, toolCtx), 'high');
            if (tool.name === 'browser_open') { const h = new URL(/^https?:/.test(args.url || '') ? args.url : 'https://' + args.url).host; if (!visited.has(h)) { visited.add(h); } }
            this.turnState('thinking', { step: step.summary });
            const ap = await approvals.request({ chatId, tool: tool.name, summary: step.summary, detail: step.args, risk, reason: args.reason, origin: run.origin });
            if (ap.decision !== 'approved') { result = `The user ${ap.timedOut ? 'did not answer in time; the action was' : ''} denied: ${step.summary}. Do not retry it; ask or choose another way.`; step.status = 'denied'; }
            else {
              step.approval = ap.auto ? ap.why : 'approved by user';
              try { toolCtx.step = step; result = await tool.run(args, toolCtx); step.status = 'done'; }
              catch (e) { result = `Error: ${e.message}`; step.status = 'error'; this.ctx.kernel.logs.error('tools', `Tool ${tool.name} failed: ${e.message}`, `arguments: ${step.args}\n${e.stack || ''}`); }
            }
          }
          step.result = clampText(String(result), 400);
          emit(chatId, 'step', { id: asst.id, step });
          messages.push({ role: 'tool', tool_call_id: tc.id, content: String(result) });
          store.updateMessage(asst.id, content);
        }
        this.turnState('thinking', { step: 'Thinking' });
      }
      const ranOut = steps > maxSteps && !run.stopped;
      if (ranOut) { content.stoppedAt = maxSteps; emit(chatId, 'notice', { text: `Stopped after ${maxSteps} tool steps. Say “carry on” to continue, or raise the limit under Settings › Model.` }); this.ctx.kernel.logs.info('agent', `Turn reached the ${maxSteps}-step limit`); }
      if (!content.text.trim()) content.text = run.stopped ? '(stopped)' : `I used all ${maxSteps} tool steps for this turn without finishing. Say “carry on” and I will pick up where I left off, or raise the limit under Settings › Model.`;
      content.text = content.text.trim();
      store.updateMessage(asst.id, content);
      emit(chatId, 'assistant:done', { id: asst.id, message: { ...asst, content } });

      // 4. Voice, title, notifications. She is only "speaking" once the window
      // reports that sound is playing (voicePlaying), never before.
      this.turnState('idle');
      if (speech) {
        if (run.stopped) this.cancelSpeech(chatId);
        else { speech.finish(); this.saveSpeech(speech, asst, content).catch((e) => this.ctx.kernel.logs.error('voice', `Could not save the spoken reply: ${e.message}`)); }
      } else if (readAloud && content.text && !run.stopped) {
        try { const a = await voice.tts(content.text); if (a) { content.audio = { path: a.path, engine: a.engine }; store.updateMessage(asst.id, content); emit(chatId, 'tts', { id: asst.id, path: a.path }); } }
        catch (e) { emit(chatId, 'notice', { text: `Voice failed: ${e.message}` }); }
      }
      if (store.countMessages(chatId) === 2 && !internal) this.title(chatId, userText, content.text).catch(() => {});
      if (Date.now() - run.started > 20000) notify('longTask', `${s.persona.name} finished`, clampText(content.text, 120));
      return { ok: true, id: asst.id };
    } catch (e) {
      const msg = run.abort.signal.aborted ? 'Stopped.' : e.message;
      if (!run.abort.signal.aborted) this.ctx.kernel.logs.error('agent', `The turn failed: ${e.message}`, e.detail || e.stack || String(e));
      if (asst) { asst.content.text = asst.content.text || msg; asst.content.error = run.abort.signal.aborted ? null : msg; store.updateMessage(asst.id, asst.content); }
      emit(chatId, 'error', { id: asst ? asst.id : null, message: msg });
      if (speech) this.cancelSpeech(chatId);
      this.turnState('idle');
      return { ok: false, error: msg };
    } finally { clearTimeout(run.cap); this.runs.delete(chatId); resolveDone(); this.ctx.kernel.afterRun(chatId).catch((e) => console.error('afterRun', e)); }
  }

  async title(chatId, userText, reply) {
    const m = await this.pickModel(false);
    const t = await llm.chatOnce({ endpoint: m.endpoint, apiKey: m.apiKey, model: m.id, temperature: 0.2, maxTokens: 20, messages: [{ role: 'system', content: 'Reply with a 2-5 word title for this chat. No quotes, no punctuation. /no_think' }, { role: 'user', content: `User: ${userText.slice(0, 500)}\nAssistant: ${(reply || '').slice(0, 500)}` }] });
    const title = t.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/["'.]/g, '').trim().slice(0, 48);
    if (title) { this.ctx.store.updateChat(chatId, { title }); this.ctx.emit(null, 'chats', {}); }
  }
}
function safe(fn, fallback) { try { return fn(); } catch { return fallback; } }
module.exports = { Agent };
