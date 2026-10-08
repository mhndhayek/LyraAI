// The MCP client organ against a fake Streamable HTTP server, plus the rules that
// keep MCP tokens out of the agent's reach.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { tmpdir, cleanup } = require('../helpers/tmp');
const { McpManager, McpSession, toolName, parseMessages, formatResult, riskOf } = require('../../main/organs/mcp');
const { enabledTools } = require('../../main/organs/tools');
const { filterPatch } = require('../../main/kernel/guard');
const { DEFAULTS, merge } = require('../../main/kernel/settings');

test.after(cleanup);

const TOOLS = [
  { name: 'hub_status', description: 'Hub health', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'swarm_generate_image', description: 'Make an image', inputSchema: { $schema: 'x', type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] } },
];

// A tiny MCP server: answers initialize/tools/list/tools/call, as SSE when `sse`.
function fakeServer({ token = 'secret-token', sse = true, expireAfterCalls = Infinity } = {}) {
  const seen = { auth: [], sessions: new Set(), calls: 0, inits: 0, deletes: 0 };
  let session = null;
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.auth.push(req.headers.authorization || '');
      if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"invalid_token"}'); }
      if (req.method === 'DELETE') { seen.deletes++; session = null; res.writeHead(200); return res.end(); }
      const msg = JSON.parse(body);
      if (msg.method !== 'initialize' && req.headers['mcp-session-id'] !== session) { res.writeHead(404); return res.end('unknown session'); }
      if (!msg.id) { res.writeHead(202); return res.end(); }
      let result;
      if (msg.method === 'initialize') { seen.inits++; session = `s${seen.inits}`; seen.sessions.add(session); result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-hub', version: '1.0' } }; }
      else if (msg.method === 'tools/list') result = msg.params && msg.params.cursor ? { tools: [TOOLS[1]] } : { tools: [TOOLS[0]], nextCursor: 'p2' };
      else if (msg.method === 'tools/call') {
        seen.calls++;
        if (seen.calls > expireAfterCalls && seen.calls === expireAfterCalls + 1) { session = 'gone'; res.writeHead(404); return res.end('expired'); }
        result = { content: [{ type: 'text', text: `ran ${msg.params.name} with ${JSON.stringify(msg.params.arguments)}` }] };
      }
      const out = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });
      const headers = { 'mcp-session-id': session };
      if (sse) { res.writeHead(200, { ...headers, 'content-type': 'text/event-stream' }); res.end(`event: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\r\n\r\nevent: message\r\ndata: ${out}\r\n\r\n`); }
      else { res.writeHead(200, { ...headers, 'content-type': 'application/json' }); res.end(out); }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}/mcp`, seen, close: () => new Promise((r) => server.close(r)) })));
}
const fakeSettings = (servers, tools = {}) => ({ get: () => merge(DEFAULTS, { mcp: { servers }, tools }) });

test('tool names are safe for every model API and prefixed by the server', () => {
  assert.equal(toolName('Media hub', 'swarm_generate_image'), 'mcp_media_hub_swarm_generate_image');
  assert.match(toolName('Ünïcode!!', 'a.b/c'), /^mcp_[a-z0-9_-]+$/);
  assert.ok(toolName('x'.repeat(80), 'y'.repeat(80)).length <= 64);
});

test('answers parse as JSON or as an SSE stream with progress events first', () => {
  assert.deepEqual(parseMessages('application/json', '{"id":1,"result":{}}'), [{ id: 1, result: {} }]);
  const sse = 'event: message\ndata: {"method":"notifications/progress"}\n\nevent: message\ndata: {"id":2,"result":{"ok":true}}\n\n';
  assert.deepEqual(parseMessages('text/event-stream; charset=utf-8', sse).map((m) => m.id), [undefined, 2]);
  assert.deepEqual(parseMessages('application/json', ''), []);
});

test('results become text; images are saved to the media folder; errors are marked', () => {
  const dir = tmpdir();
  const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
  const out = formatResult({ content: [{ type: 'text', text: 'done' }, { type: 'image', data: png, mimeType: 'image/png' }] }, { mediaDir: dir });
  const file = /saved to (.+\.png)\]/.exec(out)[1];
  assert.ok(out.startsWith('done'));
  assert.ok(fs.existsSync(file) && file.startsWith(path.join(dir, 'mcp')));
  assert.equal(formatResult({ content: [], structuredContent: { a: 1 } }), '{\n  "a": 1\n}');
  assert.match(formatResult({ isError: true, content: [{ type: 'text', text: 'boom' }] }), /^Error from the MCP tool: boom/);
});

test('read-only tools are low risk, everything else asks', () => {
  assert.equal(riskOf(TOOLS[0]), 'low');
  assert.equal(riskOf(TOOLS[1]), 'medium');
});

for (const sse of [true, false]) {
  test(`the manager connects with the Bearer token and pages through tools/list (${sse ? 'SSE' : 'JSON'})`, async () => {
    const srv = await fakeServer({ sse });
    const events = [];
    const m = new McpManager({ settings: fakeSettings([{ id: 'hub', name: 'Hub', url: srv.url, token: 'secret-token' }]), emit: (_c, type, p) => events.push([type, p]) });
    const status = await m.sync();
    assert.equal(status[0].state, 'ready');
    assert.equal(status[0].server.name, 'fake-hub');
    assert.deepEqual(m.tools().map((t) => t.name), ['mcp_hub_hub_status', 'mcp_hub_swarm_generate_image']);
    assert.ok(!('$schema' in m.tools()[1].parameters), 'the JSON-schema dialect marker is dropped for model APIs');
    assert.ok(srv.seen.auth.every((a) => a === 'Bearer secret-token'));
    const res = await m.tools()[1].run({ prompt: 'a cat' });
    assert.equal(res, 'ran swarm_generate_image with {"prompt":"a cat"}');
    assert.ok(events.some(([t]) => t === 'mcp'), 'status changes reach the UI');
    m.dispose(); await new Promise((r) => setTimeout(r, 50));
    assert.equal(srv.seen.deletes, 1, 'the session is closed on dispose');
    await srv.close();
  });
}

test('an expired session is re-initialised once and the call goes through', async () => {
  const srv = await fakeServer({ expireAfterCalls: 1 });
  const s = new McpSession({ name: 'Hub', url: srv.url, token: 'secret-token' });
  await s.call('tools/call', { name: 'hub_status', arguments: {} });
  const r = await s.call('tools/call', { name: 'hub_status', arguments: {} });
  assert.match(r.content[0].text, /ran hub_status/);
  assert.equal(srv.seen.inits, 2);
  s.close(); await srv.close();
});

test('a wrong token shows as an error on the server and adds no tools', async () => {
  const srv = await fakeServer();
  const m = new McpManager({ settings: fakeSettings([{ id: 'hub', name: 'Hub', url: srv.url, token: 'wrong' }]) });
  const [st] = await m.sync();
  assert.equal(st.state, 'error');
  assert.match(st.error, /refused the token \(HTTP 401\)/);
  assert.deepEqual(m.tools(), []);
  const t = await m.test({ url: srv.url, token: 'secret-token' });
  assert.deepEqual([t.ok, t.tools], [true, 2]);
  m.dispose(); await srv.close();
});

test('changing a server reconnects only that one; switching it off removes its tools', async () => {
  const srv = await fakeServer();
  let servers = [{ id: 'a', name: 'A', url: srv.url, token: 'secret-token' }, { id: 'b', name: 'B', url: srv.url, token: 'secret-token' }];
  const m = new McpManager({ settings: { get: () => merge(DEFAULTS, { mcp: { servers } }) } });
  await m.sync(); const inits = srv.seen.inits;
  servers = [servers[0], { ...servers[1], enabled: false }];
  await m.sync();
  assert.equal(srv.seen.inits, inits, 'A was not reconnected');
  assert.ok(m.tools().every((t) => t.mcpServer === 'A'));
  assert.equal(m.status().find((s) => s.id === 'b').state, 'off');
  m.dispose(); await srv.close();
});

test('MCP tools have their own switch and follow the master switch', () => {
  const mcpTool = { name: 'mcp_hub_x', key: 'mcp' }; const extTool = { name: 'ext_y', key: 'ext' };
  const names = (tools) => enabledTools(merge(DEFAULTS, { tools }), [mcpTool, extTool]).map((t) => t.name);
  assert.ok(names({}).includes('mcp_hub_x'));
  assert.ok(!names({ mcp: false }).includes('mcp_hub_x'));
  assert.ok(names({ mcp: false }).includes('ext_y'), 'extensions keep their own switch');
  assert.deepEqual(names({ enabled: false }), []);
});

test('the agent cannot add, edit or read MCP servers', () => {
  const r = filterPatch({ mcp: { servers: [{ url: 'https://evil', token: 'x' }] } });
  assert.equal(r.rejected.length, 1);
  assert.match(r.rejected[0].why, /MCP/);
  assert.deepEqual(r.allowed, {});
});

test('settings.json is written owner-only, since it holds tokens', () => {
  const { Settings } = require('../../main/kernel/settings');
  const f = path.join(tmpdir(), 'state', 'settings.json');
  const st = new Settings(f); st.set({ mcp: { servers: [{ id: 'h', name: 'Hub', url: 'https://x/mcp', token: 't' }] } });
  if (process.platform !== 'win32') assert.equal(fs.statSync(f).mode & 0o777, 0o600);
});
