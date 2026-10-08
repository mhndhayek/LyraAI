// MCP client: connects to remote MCP servers over Streamable HTTP (the transport of
// the 2025 MCP spec: JSON-RPC over POST, answers as JSON or a short SSE stream, a
// session id in the Mcp-Session-Id header) and turns their tools into agent tools.
// The servers live in settings.mcp.servers; only the user edits them (the guard
// locks `mcp` because the entries carry tokens).
const fs = require('fs');
const path = require('path');
const { clampText, id } = require('./util');

const PROTOCOL = '2025-06-18';
const CALL_TIMEOUT_MS = 180000; // image and music tools on a home GPU can take a while
const LIST_TIMEOUT_MS = 20000;
const RESULT_MAX = 20000;

// OpenAI-style tool names: [a-zA-Z0-9_-], at most 64 characters.
function toolName(server, tool) {
  const clean = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return `mcp_${clean(server) || 'server'}_${clean(tool)}`.slice(0, 64);
}

// A Streamable HTTP answer is either plain JSON or a text/event-stream whose events
// carry JSON-RPC messages (progress notifications may come before the response).
function parseMessages(contentType, body) {
  if (!body || !body.trim()) return [];
  if (/text\/event-stream/i.test(contentType || '')) {
    const out = [];
    for (const ev of body.split(/\r?\n\r?\n/)) {
      const data = ev.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
      if (data.trim()) { try { out.push(JSON.parse(data)); } catch {} }
    }
    return out;
  }
  const j = JSON.parse(body);
  return Array.isArray(j) ? j : [j];
}

// Turns an MCP tools/call result into the text the model reads. Images are saved
// to the media folder so the model can pass the path on (look_at_image, the chat).
function formatResult(result, { mediaDir } = {}) {
  if (!result) return '(no result)';
  const parts = [];
  for (const c of result.content || []) {
    if (c.type === 'text') parts.push(c.text);
    else if ((c.type === 'image' || c.type === 'audio') && c.data && mediaDir) {
      const ext = ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/ogg': '.ogg' })[c.mimeType] || (c.type === 'image' ? '.png' : '.bin');
      const dir = path.join(mediaDir, 'mcp'); fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${Date.now()}-${id()}${ext}`); fs.writeFileSync(file, Buffer.from(c.data, 'base64'));
      parts.push(`[${c.type} saved to ${file}]`);
    } else if (c.type === 'resource_link') parts.push(`[${c.name || 'resource'}: ${c.uri}]`);
    else if (c.type === 'resource' && c.resource) parts.push(c.resource.text != null ? c.resource.text : `[resource ${c.resource.uri}]`);
    else parts.push(`[${c.type} content]`);
  }
  if (!parts.length && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent, null, 2));
  const text = clampText(parts.join('\n').trim() || '(empty result)', RESULT_MAX);
  return result.isError ? `Error from the MCP tool: ${text}` : text;
}

// A read-only tool runs under smart approvals like any other low-risk tool; anything
// else asks first, because a remote server can do anything its tools say.
function riskOf(tool) { const a = tool.annotations || {}; return a.readOnlyHint === true ? 'low' : 'medium'; }

class McpSession {
  constructor(server, { fetchImpl = fetch } = {}) { this.server = server; this.fetch = fetchImpl; this.sessionId = null; this.seq = 0; this.ready = null; }
  headers() {
    const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': PROTOCOL };
    if (this.server.token) h.Authorization = `Bearer ${this.server.token}`;
    if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId;
    return h;
  }
  async post(msg, timeoutMs) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try { res = await this.fetch(this.server.url, { method: 'POST', headers: this.headers(), body: JSON.stringify(msg), signal: ctl.signal }); }
    catch (e) { clearTimeout(t); throw new Error(e.name === 'AbortError' ? `no answer from ${this.server.name} within ${Math.round(timeoutMs / 1000)} s` : `cannot reach ${this.server.url}: ${e.cause ? e.cause.message || e.cause.code : e.message}`); }
    try {
      const sid = res.headers.get('mcp-session-id'); if (sid) this.sessionId = sid;
      const body = await res.text();
      if (res.status === 401 || res.status === 403) throw Object.assign(new Error(`${this.server.name} refused the token (HTTP ${res.status})`), { auth: true });
      if (res.status === 404 && this.sessionId && msg.method !== 'initialize') throw Object.assign(new Error('session expired'), { expired: true });
      if (!res.ok && res.status !== 202) throw new Error(`HTTP ${res.status} from ${this.server.name}: ${clampText(body, 200)}`);
      return parseMessages(res.headers.get('content-type'), body);
    } finally { clearTimeout(t); }
  }
  async request(method, params, timeoutMs = LIST_TIMEOUT_MS) {
    const reqId = ++this.seq;
    const msgs = await this.post({ jsonrpc: '2.0', id: reqId, method, params }, timeoutMs);
    const m = msgs.find((x) => x && x.id === reqId);
    if (!m) throw new Error(`${this.server.name} did not answer ${method}`);
    if (m.error) throw new Error(`${this.server.name}: ${m.error.message || JSON.stringify(m.error)}`);
    return m.result;
  }
  async initialize() {
    this.sessionId = null;
    const r = await this.request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'Lyra', version: '1' } });
    this.info = r && r.serverInfo; this.instructions = r && r.instructions;
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, LIST_TIMEOUT_MS).catch(() => {});
    return r;
  }
  // Re-initialises once when the server forgot the session (restart, idle timeout).
  async call(method, params, timeoutMs) {
    if (!this.ready) this.ready = this.initialize();
    try { await this.ready; } catch (e) { this.ready = null; throw e; }
    try { return await this.request(method, params, timeoutMs); }
    catch (e) { if (!e.expired) throw e; this.ready = this.initialize(); await this.ready; return this.request(method, params, timeoutMs); }
  }
  async listTools() {
    const out = []; let cursor;
    for (let page = 0; page < 20; page++) {
      const r = await this.call('tools/list', cursor ? { cursor } : {});
      out.push(...((r && r.tools) || [])); cursor = r && r.nextCursor; if (!cursor) break;
    }
    return out;
  }
  close() {
    if (!this.sessionId) return;
    const h = this.headers(); this.sessionId = null; this.ready = null;
    this.fetch(this.server.url, { method: 'DELETE', headers: h }).catch(() => {});
  }
}

// Keeps one session per enabled server, caches its tools, and reports status to the UI.
class McpManager {
  constructor({ settings, emit = () => {}, log = () => {}, mediaDir, fetchImpl } = {}) {
    this.settings = settings; this.emit = emit; this.log = log; this.mediaDir = mediaDir; this.fetchImpl = fetchImpl;
    this.conns = new Map(); // server id -> { server, session, state, error, tools, defs }
  }
  servers() { const m = this.settings.get().mcp; return (m && Array.isArray(m.servers) ? m.servers : []).filter((s) => s && s.id && s.url); }
  status() {
    return this.servers().map((s) => { const c = this.conns.get(s.id); return { id: s.id, name: s.name, url: s.url, enabled: s.enabled !== false, state: s.enabled === false ? 'off' : c ? c.state : 'idle', error: c ? c.error : null, server: c && c.session.info ? c.session.info : null, tools: c && c.tools ? c.tools.map((t) => ({ name: t.name, as: toolName(s.name, t.name), description: t.description || '', readOnly: riskOf(t) === 'low' })) : [] }; });
  }
  // Reconnects only the servers whose entry changed (or all, with force).
  sync({ force = false } = {}) {
    const want = new Map(this.servers().filter((s) => s.enabled !== false).map((s) => [s.id, s]));
    for (const [sid, c] of this.conns) {
      const s = want.get(sid);
      if (!s || force || s.url !== c.server.url || s.token !== c.server.token || s.name !== c.server.name) { c.session.close(); this.conns.delete(sid); }
    }
    const jobs = [];
    for (const s of want.values()) if (!this.conns.has(s.id)) jobs.push(this.connect(s));
    if (!jobs.length) this.emit(null, 'mcp', { status: this.status() });
    return Promise.all(jobs).then(() => this.status());
  }
  async connect(server) {
    const c = { server: { ...server }, session: new McpSession(server, this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}), state: 'connecting', error: null, tools: null, defs: [] };
    this.conns.set(server.id, c); this.emit(null, 'mcp', { status: this.status() });
    try {
      const tools = await c.session.listTools();
      if (this.conns.get(server.id) !== c) return;
      c.tools = tools; c.defs = tools.map((t) => this.toDef(c, t)); c.state = 'ready';
      this.log('info', `MCP ${server.name}: ${tools.length} tools`);
    } catch (e) {
      if (this.conns.get(server.id) !== c) return;
      c.state = 'error'; c.error = e.message; c.defs = [];
      this.log('warn', `MCP ${server.name}: ${e.message}`);
    }
    this.emit(null, 'mcp', { status: this.status() });
  }
  toDef(c, t) {
    const name = toolName(c.server.name, t.name);
    const params = { ...(t.inputSchema || { type: 'object', properties: {} }) }; delete params.$schema;
    if (params.type !== 'object') { params.type = 'object'; params.properties = params.properties || {}; }
    const risk = riskOf(t);
    return {
      name, key: 'mcp', icon: 'server', mcp: c.server.id, mcpServer: c.server.name, mcpTool: t.name,
      description: `[MCP · ${c.server.name}] ${t.description || t.title || t.name}`.slice(0, 1024),
      parameters: params,
      risk: () => risk,
      summary: (a) => { const hint = a && (a.prompt || a.text || a.job_id || a.query); return `${c.server.name}: ${t.title || t.name}${hint ? ` · ${clampText(String(hint), 60)}` : ''}`; },
      run: async (args) => {
        const conn = this.conns.get(c.server.id);
        if (!conn || conn.state !== 'ready') throw new Error(`MCP server ${c.server.name} is not connected${conn && conn.error ? `: ${conn.error}` : ''}`);
        const r = await conn.session.call('tools/call', { name: t.name, arguments: args || {} }, CALL_TIMEOUT_MS);
        return formatResult(r, { mediaDir: this.mediaDir });
      },
    };
  }
  tools() { return [...this.conns.values()].flatMap((c) => (c.state === 'ready' ? c.defs : [])); }
  // Used by the settings page to check a server before saving it.
  async test(server) {
    const s = new McpSession({ name: server.name || 'server', url: server.url, token: server.token }, this.fetchImpl ? { fetchImpl: this.fetchImpl } : {});
    try { const tools = await s.listTools(); return { ok: true, server: s.info || null, tools: tools.length }; }
    catch (e) { return { ok: false, error: e.message }; }
    finally { s.close(); }
  }
  dispose() { for (const c of this.conns.values()) c.session.close(); this.conns.clear(); }
}

module.exports = { McpManager, McpSession, toolName, parseMessages, formatResult, riskOf, PROTOCOL };
