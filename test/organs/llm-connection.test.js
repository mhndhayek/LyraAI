// Story 02: one connection. A base URL (plus a key if needed) is all the user
// gives; what is behind it is detected, and a model is only "loaded" when the
// server says so. The fixtures copy the shapes real servers return, including
// a llama.cpp router like the one on our test server.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const llm = require('../../main/organs/llm');

const servers = [];
test.after(() => { for (const s of servers) s.close(); });

async function serve(routes, { key } = {}) {
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    if (key && req.headers.authorization !== `Bearer ${key}`) { res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Invalid API Key', type: 'authentication_error' } })); return; }
    const route = routes[req.url.split('?')[0]];
    if (!route) { res.writeHead(404).end('not found'); return; }
    route(req, res, body ? JSON.parse(body) : null);
  });
  servers.push(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}/v1`;
}
const json = (res, obj, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

// What llama-server in router mode (--models-preset) answers.
const routerModel = (id, value, ctx) => ({
  id, object: 'model', owned_by: 'llamacpp',
  status: { value, args: ['llama-server', '--alias', id, '--ctx-size', String(ctx), '--model', `/m/${id}.gguf`] },
  architecture: { input_modalities: id.includes('vl') ? ['text', 'image'] : ['text'], output_modalities: ['text'] },
});
const routerRoutes = {
  '/props': (req, res) => json(res, { role: 'router', max_instances: 2, models_autoload: true, model_alias: 'llama-server', model_path: 'none', default_generation_settings: { params: null, n_ctx: 0 }, build_info: 'b11438-cbb7d52ec' }),
  '/v1/models': (req, res) => json(res, { data: [
    routerModel('qwen3.8-27b-cold', 'unloaded', 147456),
    routerModel('qwen3.5-4b', 'loaded', 32768),
    routerModel('gemma-vl-12b', 'unloaded', 65536),
    routerModel('qwen3.8-27b-uncensored', 'loaded', 172032),
  ] }),
};

test('a llama.cpp router reports only its loaded models as loaded', async () => {
  const endpoint = await serve(routerRoutes);
  const r = await llm.listModels({ endpoint });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'llama.cpp');
  assert.equal(r.router, true);
  assert.equal(r.models.length, 4, 'every model the router can start is listed');
  assert.deepEqual(r.models.filter((m) => m.loaded).map((m) => m.id), ['qwen3.5-4b', 'qwen3.8-27b-uncensored']);
  assert.equal(r.models.find((m) => m.id === 'qwen3.8-27b-cold').loaded, false);
  assert.equal(r.models.find((m) => m.id === 'qwen3.5-4b').context, 32768, 'the context each model is started with');
  assert.equal(r.models.find((m) => m.id === 'gemma-vl-12b').vision, true, 'input modalities say what can see');
  assert.equal(r.version, 'b11438');
  assert.equal(llm.summarize(r), 'llama.cpp (router) · 2 of 4 models loaded');
});

test('a server behind a key says it needs one, and opens with it', async () => {
  const endpoint = await serve(routerRoutes, { key: 'sekrit' });
  const without = await llm.listModels({ endpoint });
  assert.equal(without.ok, false);
  assert.equal(without.needsKey, true, 'a 401 is "needs a key", not "unreachable"');
  assert.match(without.error, /API key/);
  const wrong = await llm.listModels({ endpoint, apiKey: 'nope' });
  assert.equal(wrong.needsKey, true);
  assert.match(wrong.error, /refused/);
  const right = await llm.listModels({ endpoint, apiKey: 'sekrit' });
  assert.equal(right.ok, true);
  assert.equal(right.source, 'llama.cpp');
});

test('every probe carries the key, Ollama included', async () => {
  const seen = new Set();
  const endpoint = await serve({
    '/api/tags': (req, res) => { seen.add(`tags:${req.headers.authorization}`); json(res, { models: [{ name: 'qwen3:8b' }] }); },
    '/api/ps': (req, res) => { seen.add(`ps:${req.headers.authorization}`); json(res, { models: [] }); },
    '/api/show': (req, res) => { seen.add(`show:${req.headers.authorization}`); json(res, {}); },
  });
  await llm.listModels({ endpoint, apiKey: 'k1' });
  for (const p of ['tags', 'ps', 'show']) assert.ok(seen.has(`${p}:Bearer k1`), `${p} was sent without the key`);
});

test('Ollama: loaded means present in /api/ps', async () => {
  const endpoint = await serve({
    '/api/tags': (req, res) => json(res, { models: [{ name: 'qwen3:8b' }, { name: 'llama3.2:3b' }] }),
    '/api/ps': (req, res) => json(res, { models: [{ name: 'llama3.2:3b', model: 'llama3.2:3b' }] }),
    '/api/show': (req, res) => json(res, { capabilities: ['tools'] }),
  });
  const r = await llm.listModels({ endpoint });
  assert.equal(r.source, 'ollama');
  assert.deepEqual(r.models.map((m) => [m.id, m.loaded]), [['qwen3:8b', false], ['llama3.2:3b', true]]);
  assert.equal(llm.summarize(r), 'Ollama · 1 of 2 models loaded');
});

test('each runtime is recognised from the same kind of URL', async () => {
  const lms = await serve({ '/api/v0/models': (req, res) => json(res, { data: [{ id: 'a', type: 'llm', state: 'loaded' }] }) });
  const single = await serve({
    '/props': (req, res) => json(res, { default_generation_settings: { n_ctx: 8192 }, model_path: '/m/one.gguf' }),
    '/v1/models': (req, res) => json(res, { data: [{ id: 'one', meta: { n_ctx_train: 32768 } }] }),
  });
  const vllm = await serve({
    '/version': (req, res) => json(res, { version: '0.11.0' }),
    '/v1/models': (req, res) => json(res, { data: [{ id: 'Qwen/Qwen3-8B', owned_by: 'vllm', max_model_len: 40960 }] }),
  });
  const generic = await serve({ '/v1/models': (req, res) => json(res, { data: [{ id: 'gpt-x' }] }) });
  const got = await Promise.all([lms, single, vllm, generic].map((endpoint) => llm.listModels({ endpoint })));
  assert.deepEqual(got.map((r) => r.source), ['lmstudio', 'llama.cpp', 'vllm', 'openai']);
  assert.equal(got[1].router, false);
  assert.equal(got[1].models[0].loaded, true, 'a single-model llama-server has its one model loaded');
  assert.equal(got[2].models[0].context, 40960, 'vLLM reports max_model_len');
  assert.equal(got[2].version, '0.11.0');
  for (const r of got.slice(2)) assert.equal(r.models[0].loaded, null, 'servers that do not say are unknown, not "loaded"');
  assert.equal(llm.summarize(got[3]), 'OpenAI-compatible · 1 model');
});

test('Auto picks a loaded model, never a cold one when a loaded one exists', () => {
  const list = [{ id: 'cold', loaded: false }, { id: 'embed-x', loaded: true }, { id: 'warm', loaded: true }];
  assert.equal(llm.autoPick(list).id, 'warm', 'skips the cold model and the embedding model');
  assert.equal(llm.autoPick([{ id: 'cold', loaded: false }, { id: 'unknown', loaded: null }]).id, 'unknown', 'unknown beats known-cold');
  assert.equal(llm.autoPick([{ id: 'cold', loaded: false }]).id, 'cold', 'all cold: still something, it loads on first use');
  assert.equal(llm.autoPick([{ id: 'a', loaded: true }, { id: 'v', loaded: true, vision: true }], (x) => x.vision).id, 'v');
  assert.equal(llm.autoPick([]), null);
});

test('whatever is typed becomes a /v1 base URL', () => {
  const cases = [
    ['localhost:1234', 'http://localhost:1234/v1'],
    ['http://localhost:1234/v1/', 'http://localhost:1234/v1'],
    ['http://lucix:8080', 'http://lucix:8080/v1'],
    ['https://api.example.com/v1', 'https://api.example.com/v1'],
    ['  192.168.0.9:11434/  ', 'http://192.168.0.9:11434/v1'],
    ['https://openrouter.ai/api/v1', 'https://openrouter.ai/api/v1'],
    ['', ''],
  ];
  for (const [input, want] of cases) assert.equal(llm.normalizeEndpoint(input), want, JSON.stringify(input));
});

test('only names the app made up follow what was detected; a typed name stays', () => {
  for (const n of ['LM Studio', 'Ollama 2', 'llama.cpp server', 'Server 3', 'OpenAI-compatible / remote API', '']) assert.equal(llm.isDefaultName(n), true, JSON.stringify(n));
  for (const n of ['Lucix', 'my LM Studio box', 'Work API']) assert.equal(llm.isDefaultName(n), false, n);
  assert.equal(llm.KIND_NAMES['llama.cpp'], 'llama.cpp');
});
