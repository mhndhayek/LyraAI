// OpenAI-compatible client for local runtimes (LM Studio, Ollama, llama.cpp, ...).
const baseOf = (endpoint) => endpoint.replace(/\/+$/, '').replace(/\/v1$/, '');
const v1Of = (endpoint) => endpoint.replace(/\/+$/, '');

function authHeaders(apiKey) { return apiKey ? { Authorization: `Bearer ${apiKey}` } : {}; }
const j = (r) => r.json();
const looksVisual = (s) => /vision|vl\b|llava|gemma-?[34]|pixtral|qwen.*vl|minicpm-v/i.test(s);
// Model ids can be full file paths; show something a person can read.
const nameOf = (id) => String(id || '').split(/[\\/]/).pop().replace(/\.(gguf|safetensors|bin)$/i, '') || String(id || '');

async function listModels({ endpoint, apiKey }) {
  const out = { ok: false, models: [], error: null, source: null };
  const headers = authHeaders(apiKey);
  // LM Studio: rich metadata (type vlm = vision, context length, loaded state).
  try {
    const r = await fetch(`${baseOf(endpoint)}/api/v0/models`, { headers, signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      const j = await r.json();
      out.models = (j.data || []).filter((m) => m.type !== 'embeddings').map((m) => ({
        id: m.id, label: nameOf(m.id), vision: m.type === 'vlm', context: m.loaded_context_length || m.max_context_length || null,
        maxContext: m.max_context_length || null, loaded: m.state === 'loaded', tools: (m.capabilities || []).includes('tool_use'),
      }));
      out.ok = true; out.source = 'lmstudio'; return out;
    }
  } catch {}
  // Ollama
  try {
    const r = await fetch(`${baseOf(endpoint)}/api/tags`, { signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      const j = await r.json(); const models = [];
      for (const m of j.models || []) {
        let context = null, vision = /llava|vision|vl\b|minicpm-v|gemma3|gemma-3/i.test(m.name), tools = true;
        try {
          const s = await fetch(`${baseOf(endpoint)}/api/show`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: m.name }), signal: AbortSignal.timeout(4000) });
          if (s.ok) { const sj = await s.json(); for (const [k, v] of Object.entries(sj.model_info || {})) if (k.endsWith('.context_length')) context = v; if (Array.isArray(sj.capabilities)) { vision = sj.capabilities.includes('vision'); tools = sj.capabilities.includes('tools'); } }
        } catch {}
        models.push({ id: m.name, label: nameOf(m.name), vision, context, maxContext: context, loaded: true, tools });
      }
      out.models = models; out.ok = true; out.source = 'ollama'; return out;
    }
  } catch {}
  // llama.cpp server (llama-server): /props reports the context actually loaded,
  // which is the number that matters, not the model's trained maximum.
  try {
    const pr = await fetch(`${baseOf(endpoint)}/props`, { headers, signal: AbortSignal.timeout(4000) });
    if (pr.ok) {
      const props = await j(pr);
      const loaded = props.default_generation_settings && props.default_generation_settings.n_ctx;
      const vision = !!(props.modalities && (props.modalities.vision || props.modalities.image));
      let list = [];
      try {
        const mj = await j(await fetch(`${v1Of(endpoint)}/models`, { headers, signal: AbortSignal.timeout(4000) }));
        list = (mj.data || mj.models || []).map((m) => {
          const meta = m.meta || {};
          return { id: m.id || m.name, label: nameOf(m.id || m.name), vision: vision || looksVisual(m.id || ''), context: meta.n_ctx || loaded || null, maxContext: meta.n_ctx_train || meta.n_ctx || loaded || null, loaded: true, tools: true, params: meta.n_params || null, quant: meta.ftype || null };
        });
      } catch {}
      if (!list.length && props.model_path) list = [{ id: props.model_alias || props.model_path, label: nameOf(props.model_alias || props.model_path), vision, context: loaded, maxContext: loaded, loaded: true, tools: true }];
      out.models = list; out.ok = true; out.source = 'llama.cpp'; out.sleeping = !!props.is_sleeping;
      return out;
    }
  } catch {}
  // Generic OpenAI-compatible
  try {
    const r = await fetch(`${v1Of(endpoint)}/models`, { headers, signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    out.models = (j.data || j.models || []).map((m) => { const meta = m.meta || {}; return { id: m.id || m.name, label: nameOf(m.id || m.name), vision: looksVisual(m.id || ''), context: meta.n_ctx || m.context_length || m.max_context_length || null, maxContext: meta.n_ctx_train || m.max_context_length || null, loaded: true, tools: true }; });
    out.ok = true; out.source = 'openai'; return out;
  } catch (e) { out.error = e.message; return out; }
}

async function testConnection({ endpoint, apiKey }) {
  const r = await listModels({ endpoint, apiKey });
  return { ok: r.ok, count: r.models.length, source: r.source, error: r.error };
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

module.exports = { listModels, testConnection, chatStream, chatOnce };
