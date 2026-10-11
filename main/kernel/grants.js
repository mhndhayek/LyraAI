// Approval grants (story 06): "allow this for this chat / until Lyra restarts".
//
// They live here, in the kernel, and only in memory:
// - an organ hot-swap rebuilds the approval gate but keeps the grants;
// - quitting Lyra drops them, because nothing is ever written to disk;
// - the agent cannot make one: there is no tool for it, filterPatch refuses an
//   `approvalGrants` key, and the only caller of add() is the approval gate
//   answering the user's own click (approval:respond from the window).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Anything that chains, pipes, redirects or substitutes is never granted and
// never matched, so a rule for `git status` can't be stretched into
// `git status; rm -rf ~`. A single `&` (run in background, then the next
// command) is refused for the same reason as `&&`.
const UNSAFE = [';', '&', '|', '`', '$(', '>', '<', '\n', '\r'];

// Trim and collapse runs of whitespace outside quotes. Inside quotes the text is
// kept as it is: `echo "a  b"` and `echo "a b"` print different things.
function normaliseCommand(cmd) {
  if (typeof cmd !== 'string') return null;
  if (UNSAFE.some((t) => cmd.includes(t))) return null;
  let out = '', quote = null, space = false;
  for (const ch of cmd.trim()) {
    if (quote) { out += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { if (space) { out += ' '; space = false; } quote = ch; out += ch; continue; }
    if (/\s/.test(ch)) { space = out.length > 0; continue; }
    if (space) { out += ' '; space = false; }
    out += ch;
  }
  if (quote) return null; // an unclosed quote: the shell would read on past the line
  return out || null;
}

// path.resolve + realpath. A path that doesn't exist yet (a file about to be
// written) resolves through its nearest existing folder, so a symlinked folder
// on the way is still followed to where it really points.
function realPath(p) {
  if (typeof p !== 'string' || !p) return null;
  let cur = path.resolve(p); const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(cur), ...rest.reverse()); }
    catch {
      const up = path.dirname(cur);
      if (up === cur) return path.resolve(p);
      rest.push(path.basename(cur)); cur = up;
    }
  }
}

// `child` is `dir` itself or inside it, on a separator boundary: /a/b holds
// /a/b/c.txt but not /a/bc/x.
function under(child, dir) {
  if (!child || !dir) return false;
  const rel = path.relative(dir, child);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

class Grants {
  constructor({ onChange } = {}) { this.items = []; this.onChange = onChange || (() => {}); }
  normalise(cmd) { return normaliseCommand(cmd); }

  // Makes a grant from the user's answer. Returns null when the rule can't be
  // expressed safely (a command that doesn't normalise, a missing chat).
  add({ scope, chatId = null, tool, match = {}, risk = 'medium', label = '' }) {
    if (!['chat', 'session'].includes(scope) || typeof tool !== 'string' || !tool) return null;
    if (scope === 'chat' && !chatId) return null;
    const m = {};
    if (match.command != null) { m.command = normaliseCommand(match.command); if (!m.command) return null; }
    if (match.pathPrefix != null) { m.pathPrefix = realPath(match.pathPrefix); if (!m.pathPrefix) return null; }
    // A session grant always names a command or a folder; "everything this tool
    // does, everywhere, until restart" isn't one of the choices.
    if (scope === 'session' && !m.command && !m.pathPrefix) return null;
    const g = { id: crypto.randomUUID(), scope, chatId: scope === 'chat' ? chatId : null, tool, match: m, risk, label: String(label || ''), createdAt: Date.now() };
    // The same rule twice is one rule.
    const same = this.items.find((x) => x.scope === g.scope && x.chatId === g.chatId && x.tool === g.tool && x.match.command === g.match.command && x.match.pathPrefix === g.match.pathPrefix);
    if (same) return same;
    this.items.push(g); this.onChange();
    return g;
  }

  // The grant that covers this call, or null.
  match({ chatId, tool, command, path: target }) {
    for (const g of this.items) {
      if (g.tool !== tool) continue;
      if (g.scope === 'chat' && g.chatId !== chatId) continue;
      if (g.match.command) { const c = normaliseCommand(command); if (c && c === g.match.command) return g; continue; }
      if (g.match.pathPrefix) { if (target && under(realPath(target), realPath(g.match.pathPrefix))) return g; continue; }
      if (g.scope === 'chat') return g; // "allow <tool> for this chat"
    }
    return null;
  }

  list() { return this.items.map((g) => ({ ...g, match: { ...g.match } })); }
  revoke(id) { const n = this.items.length; this.items = this.items.filter((g) => g.id !== id); if (this.items.length !== n) this.onChange(); return n !== this.items.length; }
  revokeAll() { const n = this.items.length; this.items = []; if (n) this.onChange(); return n; }
  dropChat(chatId) { const n = this.items.length; this.items = this.items.filter((g) => g.chatId !== chatId); if (this.items.length !== n) this.onChange(); }
}

module.exports = { Grants, normaliseCommand, realPath, under, UNSAFE };
