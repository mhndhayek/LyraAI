// OpenAI-compatible client for local runtimes (LM Studio, Ollama, llama.cpp, ...).
// The user gives one base URL ending in /v1 (plus a key if the server needs
// one); which runtime is behind it is detected, never chosen.
const baseOf = (endpoint) => endpoint.replace(/\/+$/, '').replace(/\/v1$/, '');
const v1Of = (endpoint) => endpoint.replace(/\/+$/, '');

// "localhost:1234", "http://host:8080/v1/", "https://api.x.com" → a /v1 base URL.
function normalizeEndpoint(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
  s = s.replace(/\/+$/, '');
  if (!/\/v\d+$/.test(s)) s += '/v1';
  return s;
}

function authHeaders(apiKey) { return apiKey ? { Authorization: `Bearer ${apiKey}` } : {}; }
const looksVisual = (s) => /vision|vl\b|llava|gemma-?[34]|pixtral|qwen.*vl|minicpm-v/i.test(s);
// Model ids can be full file paths; show something a person can read.
const nameOf = (id) => String(id || '').split(/[\\/]/).pop().replace(/\.(gguf|safetensors|bin)$/i, '') || String(id || '');
const PROBE_MS = 4000;

// One GET, never thrown: { status, body } with status 0 when unreachable.
async function probe(url, headers, opts = {}) {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(PROBE_MS), ...opts });
    let body = null; try { body = await r.json(); } catch {}
    return { status: r.status, body };
  } catch (e) { return { status: 0, body: null, error: e.cause && e.cause.code ? e.cause.code : e.message }; }
}
const ok = (p) => p.status >= 200 && p.status < 300 && p.body && typeof p.body === 'object';
const denied = (p) => p.status === 401 || p.status === 403;

// Router mode llama-server lists every model it can start, each with
// status.value "loaded" | "loading" | "unloaded"; the args carry its context.
function routerContext(m) {
  const a = (m.status && m.status.args) || []; const i = a.findIndex((x) => x === '--ctx-size' || x === '-c');
  const n = i >= 0 ? Number(a[i + 1]) : NaN; return Number.isFinite(n) && n > 0 ? n : null;
}

async function listModels({ endpoint, apiKey }) {
  const out = { ok: false, models: [], error: null, source: null, needsKey: false, router: false };
  const headers = authHeaders(apiKey); const base = baseOf(endpoint); const v1 = v1Of(endpoint);
  // Every runtime's own discovery route at once, each with the key: a server
  // behind a key answers 401 to all of them, not only to /v1.
  const [lms, oll, props, vver, models] = await Promise.all([
    probe(`${base}/api/v0/models`, headers),
    probe(`${base}/api/tags`, headers),
    probe(`${base}/props`, headers),
    probe(`${base}/version`, headers),
    probe(`${v1}/models`, headers),
  ]);

  // LM Studio: rich metadata (type vlm = vision, context length, loaded state).
  if (ok(lms) && Array.isArray(lms.body.data)) {
    out.models = lms.body.data.filter((m) => m.type !== 'embeddings').map((m) => ({
      id: m.id, label: nameOf(m.id), vision: m.type === 'vlm', context: m.loaded_context_length || m.max_context_length || null,
      maxContext: m.max_context_length || null, loaded: m.state === 'loaded', tools: (m.capabilities || []).includes('tool_use'),
    }));
    out.ok = true; out.source = 'lmstudio'; return out;
  }
  // Ollama: /api/ps is what is actually in memory right now.
  if (ok(oll) && Array.isArray(oll.body.models)) {
    const ps = await probe(`${base}/api/ps`, headers);
    const running = ok(ps) && Array.isArray(ps.body.models) ? new Set(ps.body.models.map((m) => m.name || m.model)) : null;
    out.models = await Promise.all(oll.body.models.map(async (m) => {
      let context = null, vision = /llava|vision|vl\b|minicpm-v|gemma3|gemma-3/i.test(m.name), tools = true;
      const s = await probe(`${base}/api/show`, { 'content-type': 'application/json', ...headers }, { method: 'POST', body: JSON.stringify({ model: m.name }) });
      if (ok(s)) { for (const [k, v] of Object.entries(s.body.model_info || {})) if (k.endsWith('.context_length')) context = v; if (Array.isArray(s.body.capabilities)) { vision = s.body.capabilities.includes('vision'); tools = s.body.capabilities.includes('tools'); } }
      return { id: m.name, label: nameOf(m.name), vision, context, maxContext: context, loaded: running ? running.has(m.name) : null, tools };
    }));
    out.ok = true; out.source = 'ollama'; return out;
  }
  // llama.cpp server (llama-server): /props reports the context actually loaded,
  // which is the number that matters, not the model's trained maximum.
  if (ok(props) && (props.body.default_generation_settings || props.body.role || props.body.model_path)) {
    const p = props.body; const router = p.role === 'router';
    const loadedCtx = (p.default_generation_settings && p.default_generation_settings.n_ctx) || null;
    const vision = !!(p.modalities && (p.modalities.vision || p.modalities.image));
    let list = ok(models) ? (models.body.data || models.body.models || []).map((m) => {
      const meta = m.meta || {}; const id = m.id || m.name;
      const mods = (m.architecture && m.architecture.input_modalities) || [];
      if (router) {
        const st = (m.status && m.status.value) || 'unloaded'; const ctx = routerContext(m);
        return { id, label: nameOf(id), vision: mods.includes('image') || looksVisual(id), context: meta.n_ctx || ctx, maxContext: meta.n_ctx_train || ctx, loaded: st === 'loaded', loading: st === 'loading', tools: true, params: meta.n_params || null, quant: meta.ftype || null };
      }
      return { id, label: nameOf(id), vision: vision || mods.includes('image') || looksVisual(id || ''), context: meta.n_ctx || loadedCtx || null, maxContext: meta.n_ctx_train || meta.n_ctx || loadedCtx || null, loaded: true, tools: true, params: meta.n_params || null, quant: meta.ftype || null };
    }) : [];
    if (!list.length && !router && p.model_path) list = [{ id: p.model_alias || p.model_path, label: nameOf(p.model_alias || p.model_path), vision, context: loadedCtx, maxContext: loadedCtx, loaded: true, tools: true }];
    out.models = list; out.ok = true; out.source = 'llama.cpp'; out.router = router; out.sleeping = !!p.is_sleeping;
    if (p.build_info) out.version = String(p.build_info).split('-')[0];
    return out;
  }
  // Anything a key would have opened: say so, instead of "unreachable".
  if ([lms, oll, props, models].some(denied)) {
    out.needsKey = true; out.error = apiKey ? 'The server refused this API key (401/403).' : 'This server needs an API key.';
    return out;
  }
  // Generic OpenAI-compatible, including vLLM. Neither says what is loaded,
  // so loaded is unknown (null) rather than a guess.
  if (ok(models)) {
    const data = models.body.data || models.body.models || [];
    const isVllm = data.some((m) => m.owned_by === 'vllm') || (ok(vver) && typeof vver.body.version === 'string');
    out.models = data.map((m) => { const meta = m.meta || {}; const id = m.id || m.name; return { id, label: nameOf(id), vision: looksVisual(id || ''), context: meta.n_ctx || m.max_model_len || m.context_length || m.max_context_length || null, maxContext: meta.n_ctx_train || m.max_model_len || m.max_context_length || null, loaded: null, tools: true }; });
    out.ok = true; out.source = isVllm ? 'vllm' : 'openai';
    if (isVllm && ok(vver)) out.version = vver.body.version;
    return out;
  }
  out.error = models.status ? `HTTP ${models.status}` : (models.error || 'unreachable');
  return out;
}

async function testConnection({ endpoint, apiKey }) {
  const r = await listModels({ endpoint, apiKey });
  return { ok: r.ok, count: r.models.length, source: r.source, error: r.error };
}

const KIND_NAMES = { lmstudio: 'LM Studio', ollama: 'Ollama', 'llama.cpp': 'llama.cpp', vllm: 'vLLM', openai: 'OpenAI-compatible' };
// Names the app gave a server itself, as opposed to ones the user typed.
const isDefaultName = (n) => !n || /^server( \d+)?$/i.test(n) || /^(LM Studio|Ollama|llama\.cpp( server)?|vLLM|OpenAI-compatible( \/ remote API)?)( \d+)?$/.test(n);

// What a connection found, in one line: "llama.cpp (router) · 2 of 4 models loaded".
function summarize(r) {
  if (!r || !r.ok) return null;
  const NAMES = KIND_NAMES;
  const n = r.models.length; const known = r.models.filter((m) => m.loaded !== null && m.loaded !== undefined);
  const loaded = known.filter((m) => m.loaded).length;
  const what = `${NAMES[r.source] || r.source}${r.router ? ' (router)' : ''}`;
  const count = known.length === n && n ? `${loaded} of ${n} model${n === 1 ? '' : 's'} loaded` : `${n} model${n === 1 ? '' : 's'}`;
  return `${what} · ${count}`;
}

// Auto: the first model that is loaded; failing that one whose state is
// unknown (a plain API); never one we know is not loaded, unless that is all
// there is (it loads on first use, slowly).
function autoPick(list, want = () => true) {
  const usable = (list || []).filter((x) => !String(x.id).includes('embed') && want(x));
  return usable.find((x) => x.loaded === true) || usable.find((x) => x.loaded === null || x.loaded === undefined) || usable[0] || null;
}

// Streams a chat completion. Resolves with the assembled message (text, reasoning, tool calls).
async function chatStream({ endpoint, apiKey, model, messages, tools, temperature = 0.7, reasoning, maxTokens, signal, onDelta, onReasoning }) {
  const body = { model, messages, stream: true, temperature };
  if (tools && tools.length) { body.tools = tools; body.tool_choice = 'auto'; }
  if (reasoning && reasoning !== 'off' && reasoning !== 'medium') body.reasoning_effort = reasoning;
  if (maxTokens) body.max_tokens = maxTokens;
  const r = await fetch(`${v1Of(endpoint)}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders(apiKey) }, body: JSON.stringify(body), signal,
  });
  if (!r.ok) { const body = (await r.text()).slice(0, 600); const err = new Error(`Model request failed (${r.status}): ${body.slice(0, 300)}`); err.detail = `POST ${v1Of(endpoint)}/chat/completions\nmodel=${model}\n${body}`; throw err; }
  const reader = r.body.getReader(); const dec = new TextDecoder();
  let buf = '', text = '', reasoningText = '', finish = null, inThink = false, carry = '';
  const toolCalls = [];
  // Runtimes stream thinking inline in several dialects; route it to reasoning.
  const OPEN = ['<think>', '<|channel>thought', '<|channel|>thought', '<thought>'];
  const CLOSE = ['</think>', '<channel|>', '<|channel|>', '</thought>'];
  const firstOf = (s, list) => { let best = null; for (const t of list) { const i = s.indexOf(t); if (i >= 0 && (best === null || i < best.i)) best = { i, t }; } return best; };
  const prefixTail = (s, list) => { let keep = 0; for (const t of list) for (let n = Math.min(t.length - 1, s.length); n > 0; n--) if (s.endsWith(t.slice(0, n))) { keep = Math.max(keep, n); break; } return keep; };
  const emitText = (t) => { if (!t) return; text += t; onDelta && onDelta(t); };
  const emitThink = (t) => { if (!t) return; reasoningText += t; onReasoning && onReasoning(t); };
  const pushText = (chunk, final = false) => {
    let s = carry + chunk; carry = '';
    while (s.length) {
      const hit = firstOf(s, inThink ? CLOSE : OPEN);
      if (hit) { (inThink ? emitThink : emitText)(s.slice(0, hit.i)); s = s.slice(hit.i + hit.t.length); inThink = !inThink; if (!inThink) s = s.replace(/^\n+/, ''); continue; }
      const keep = final ? 0 : prefixTail(s, inThink ? CLOSE : OPEN);
      (inThink ? emitThink : emitText)(s.slice(0, s.length - keep)); carry = s.slice(s.length - keep); break;
    }
  };
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim(); if (data === '[DONE]') continue;
      let j; try { j = JSON.parse(data); } catch { continue; }
      if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
      const ch = j.choices && j.choices[0]; if (!ch) continue;
      const d = ch.delta || {};
      if (d.content) pushText(d.content);
      const rc = d.reasoning_content || d.reasoning; if (rc) { reasoningText += rc; onReasoning && onReasoning(rc); }
      if (d.tool_calls) for (const tc of d.tool_calls) {
        const i = tc.index ?? toolCalls.length;
        toolCalls[i] = toolCalls[i] || { id: tc.id || `call_${i}`, type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) toolCalls[i].id = tc.id;
        if (tc.function?.name) toolCalls[i].function.name += tc.function.name;
        if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments;
      }
      if (ch.finish_reason) finish = ch.finish_reason;
    }
  }
  pushText('', true);
  return { text: text.trim(), reasoning: reasoningText.trim(), toolCalls: toolCalls.filter(Boolean), finish };
}

async function chatOnce(opts) { const r = await chatStream({ ...opts, tools: undefined }); return r.text; }

module.exports = { listModels, testConnection, chatStream, chatOnce, normalizeEndpoint, summarize, autoPick, isDefaultName, KIND_NAMES };
