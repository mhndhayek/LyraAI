// The model client talks to whatever runtime the user has running. A throwaway
// local server stands in for LM Studio, Ollama and llama.cpp so the tests are
// hermetic and never touch the network.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const llm = require('../../main/organs/llm');

const servers = [];
test.after(() => { for (const s of servers) s.close(); });

// routes: { '/path': (req, res, body) => void }
async function serve(routes) {
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const route = routes[req.url];
    if (!route) { res.writeHead(404).end('not found'); return; }
    route(req, res, body ? JSON.parse(body) : null);
  });
  servers.push(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}/v1`;
}
const json = (res, obj, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const sse = (res, events) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const e of events) res.write(`data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`);
  res.end('data: [DONE]\n\n');
};
const delta = (d, finish) => ({ choices: [{ delta: d, finish_reason: finish || null }] });

test('LM Studio metadata is read in full', async () => {
  const endpoint = await serve({ '/api/v0/models': (req, res) => json(res, { data: [
    { id: '/models/qwen3-8b.gguf', type: 'llm', max_context_length: 32768, loaded_context_length: 8192, state: 'loaded', capabilities: ['tool_use'] },
    { id: 'llava-v1.6', type: 'vlm', max_context_length: 4096, state: 'not-loaded' },
    { id: 'nomic-embed', type: 'embeddings' },
  ] }) });
  const r = await llm.listModels({ endpoint });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'lmstudio');
  assert.equal(r.models.length, 2, 'embedding models are not offered as chat models');
  assert.deepEqual(r.models[0], { id: '/models/qwen3-8b.gguf', label: 'qwen3-8b', vision: false, context: 8192, maxContext: 32768, loaded: true, tools: true });
  assert.equal(r.models[1].vision, true, 'a vlm is flagged as vision-capable');
  assert.equal(r.models[1].loaded, false);
});

test('Ollama tags and capabilities are read', async () => {
  const endpoint = await serve({
    '/api/tags': (req, res) => json(res, { models: [{ name: 'qwen3:8b' }, { name: 'llava:13b' }] }),
    '/api/show': (req, res, body) => json(res, {
      model_info: { 'qwen3.context_length': 40960 },
      capabilities: body.model.startsWith('llava') ? ['vision'] : ['tools'],
    }),
  });
  const r = await llm.listModels({ endpoint });
  assert.equal(r.source, 'ollama');
  assert.equal(r.models[0].context, 40960);
  assert.equal(r.models[0].tools, true);
  assert.equal(r.models[0].vision, false);
  assert.equal(r.models[1].vision, true);
});

test('llama.cpp reports the context actually loaded', async () => {
  const endpoint = await serve({
    '/props': (req, res) => json(res, { default_generation_settings: { n_ctx: 16384 }, model_path: '/m/gemma-3-12b.gguf', modalities: { vision: true } }),
    '/v1/models': (req, res) => json(res, { data: [{ id: 'gemma-3-12b', meta: { n_ctx: 16384, n_ctx_train: 131072 } }] }),
  });
  const r = await llm.listModels({ endpoint });
  assert.equal(r.source, 'llama.cpp');
  assert.equal(r.models[0].context, 16384, 'the loaded window, not the trained maximum');
  assert.equal(r.models[0].maxContext, 131072);
  assert.equal(r.models[0].vision, true);
});

test('a plain OpenAI-compatible server is the last resort', async () => {
  const endpoint = await serve({ '/v1/models': (req, res) => json(res, { data: [{ id: 'some-vision-model' }, { id: 'plain-model' }] }) });
  const r = await llm.listModels({ endpoint });
  assert.equal(r.source, 'openai');
  assert.equal(r.models[0].vision, true, 'vision models are guessed from the name');
  assert.equal(r.models[1].vision, false);
});

test('a runtime that is not running is reported, not thrown', async () => {
  const r = await llm.listModels({ endpoint: 'http://127.0.0.1:1/v1' });
  assert.equal(r.ok, false);
  assert.ok(r.error, 'the user is told why the connection failed');
  assert.deepEqual(r.models, []);
});

test('testConnection summarises what was found', async () => {
  const endpoint = await serve({ '/v1/models': (req, res) => json(res, { data: [{ id: 'a' }, { id: 'b' }] }) });
  assert.deepEqual(await llm.testConnection({ endpoint }), { ok: true, count: 2, source: 'openai', error: null });
  const dead = await llm.testConnection({ endpoint: 'http://127.0.0.1:1/v1' });
  assert.equal(dead.ok, false);
});

test('trailing slashes on the endpoint are tolerated', async () => {
  const endpoint = await serve({ '/v1/models': (req, res) => json(res, { data: [{ id: 'a' }] }) });
  for (const variant of [endpoint, endpoint + '/', endpoint + '///']) {
    assert.equal((await llm.listModels({ endpoint: variant })).ok, true, `${variant} should work`);
  }
});

test('runtime discovery probes the server root, not the /v1 path', async () => {
  // LM Studio, Ollama and llama.cpp expose their metadata beside /v1, so an
  // endpoint entered either way still finds them.
  const endpoint = await serve({ '/api/v0/models': (req, res) => json(res, { data: [{ id: 'a', type: 'llm' }] }) });
  assert.equal((await llm.listModels({ endpoint })).source, 'lmstudio');
  assert.equal((await llm.listModels({ endpoint: endpoint.replace(/\/v1$/, '') })).source, 'lmstudio');
});

test('an api key is sent as a bearer token, and omitted when empty', async () => {
  const seen = [];
  const endpoint = await serve({ '/v1/models': (req, res) => { seen.push(req.headers.authorization); json(res, { data: [] }); } });
  await llm.listModels({ endpoint, apiKey: 'secret-key' });
  await llm.listModels({ endpoint, apiKey: '' });
  assert.equal(seen[0], 'Bearer secret-key');
  assert.equal(seen[1], undefined);
});

test('a streamed reply is assembled and pushed to the UI as it arrives', async () => {
  const endpoint = await serve({ '/v1/chat/completions': (req, res) => sse(res, [delta({ content: 'Hello' }), delta({ content: ' there' }), delta({}, 'stop')]) });
  const chunks = [];
  const r = await llm.chatStream({ endpoint, model: 'm', messages: [], onDelta: (d) => chunks.push(d) });
  assert.equal(r.text, 'Hello there');
  assert.deepEqual(chunks, ['Hello', ' there']);
  assert.equal(r.finish, 'stop');
});

test('inline thinking is routed to reasoning and kept out of the reply', async () => {
  const endpoint = await serve({ '/v1/chat/completions': (req, res) => sse(res, [
    delta({ content: '<think>I should check' }), delta({ content: ' the file</think>\n\nHere it is.' }), delta({}, 'stop'),
  ]) });
  const thoughts = [], said = [];
  const r = await llm.chatStream({ endpoint, model: 'm', messages: [], onDelta: (d) => said.push(d), onReasoning: (d) => thoughts.push(d) });
  assert.equal(r.text, 'Here it is.');
  assert.equal(r.reasoning, 'I should check the file');
  assert.ok(!said.join('').includes('<think>'), 'the tag never reaches the chat');
  assert.ok(thoughts.length > 0);
});

test('a thinking tag split across two chunks is still caught', async () => {
  const endpoint = await serve({ '/v1/chat/completions': (req, res) => sse(res, [
    delta({ content: 'before <th' }), delta({ content: 'ink>hidden</thi' }), delta({ content: 'nk>after' }), delta({}, 'stop'),
  ]) });
  const r = await llm.chatStream({ endpoint, model: 'm', messages: [] });
  assert.equal(r.text, 'before after');
  assert.equal(r.reasoning, 'hidden');
});

test('runtimes that send reasoning as its own field are handled', async () => {
  const endpoint = await serve({ '/v1/chat/completions': (req, res) => sse(res, [
    delta({ reasoning_content: 'thinking…' }), delta({ content: 'answer' }), delta({}, 'stop'),
  ]) });
  const r = await llm.chatStream({ endpoint, model: 'm', messages: [] });
  assert.equal(r.reasoning, 'thinking…');
  assert.equal(r.text, 'answer');
});

test('tool calls streamed in fragments are reassembled', async () => {
  const endpoint = await serve({ '/v1/chat/completions': (req, res) => sse(res, [
    delta({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_', arguments: '{"path":' } }] }),
    delta({ tool_calls: [{ index: 0, function: { name: 'file', arguments: '"a.txt"}' } }] }),
    delta({ tool_calls: [{ index: 1, id: 'call_2', function: { name: 'notify', arguments: '{}' } }] }),
    delta({}, 'tool_calls'),
  ]) });
  const r = await llm.chatStream({ endpoint, model: 'm', messages: [], tools: [{ type: 'function', function: { name: 'read_file' } }] });
  assert.equal(r.toolCalls.length, 2);
  assert.equal(r.toolCalls[0].function.name, 'read_file');
  assert.deepEqual(JSON.parse(r.toolCalls[0].function.arguments), { path: 'a.txt' });
  assert.equal(r.toolCalls[1].id, 'call_2');
  assert.equal(r.finish, 'tool_calls');
});

test('the request carries the tools, temperature and reasoning effort', async () => {
  let body = null;
  const endpoint = await serve({ '/v1/chat/completions': (req, res, b) => { body = b; sse(res, [delta({ content: 'ok' }, 'stop')]); } });
  await llm.chatStream({ endpoint, model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', function: { name: 'x' } }], temperature: 0.1, reasoning: 'high', maxTokens: 256 });
  assert.equal(body.model, 'm');
  assert.equal(body.stream, true);
  assert.equal(body.temperature, 0.1);
  assert.equal(body.tool_choice, 'auto');
  assert.equal(body.reasoning_effort, 'high');
  assert.equal(body.max_tokens, 256);
});

test('a failing model request explains itself', async () => {
  const endpoint = await serve({ '/v1/chat/completions': (req, res) => json(res, { error: { message: 'model not loaded' } }, 400) });
  await assert.rejects(() => llm.chatStream({ endpoint, model: 'm', messages: [] }), (e) => {
    assert.match(e.message, /Model request failed \(400\)/);
    assert.match(e.message, /model not loaded/);
    assert.match(e.detail, /chat\/completions/, 'the log gets the full request context');
    return true;
  });
});

test('an error streamed mid-reply is surfaced', async () => {
  const endpoint = await serve({ '/v1/chat/completions': (req, res) => sse(res, [delta({ content: 'partial' }), { error: { message: 'out of context' } }]) });
  await assert.rejects(() => llm.chatStream({ endpoint, model: 'm', messages: [] }), /out of context/);
});

test('malformed stream lines are skipped rather than fatal', async () => {
  const endpoint = await serve({ '/v1/chat/completions': (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': a comment\n\n');
    res.write('data: {not json\n\n');
    res.write(`data: ${JSON.stringify(delta({ content: 'survived' }, 'stop'))}\n\n`);
    res.end('data: [DONE]\n\n');
  } });
  const r = await llm.chatStream({ endpoint, model: 'm', messages: [] });
  assert.equal(r.text, 'survived');
});

test('chatOnce returns just the text and never offers tools', async () => {
  let body = null;
  const endpoint = await serve({ '/v1/chat/completions': (req, res, b) => { body = b; sse(res, [delta({ content: '  spaced  ' }, 'stop')]); } });
  const text = await llm.chatOnce({ endpoint, model: 'm', messages: [], tools: [{ type: 'function' }] });
  assert.equal(text, 'spaced');
  assert.equal(body.tools, undefined, 'a summarising call must not trigger tool use');
});

test('an aborted stream stops the request', async () => {
  const endpoint = await serve({ '/v1/chat/completions': (req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: {}\n\n'); } });
  const ac = new AbortController();
  const p = llm.chatStream({ endpoint, model: 'm', messages: [], signal: ac.signal });
  ac.abort();
  await assert.rejects(() => p, /abort/i);
});
