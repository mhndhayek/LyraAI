// Approval gate for agent actions: mode (ask / auto / none), the user's own
// grants (story 06), smart approvals, and a timeout with a configurable outcome.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { id } = require('./util');

// Tools whose argument is a file or folder, so "in this folder" makes sense.
const FILE_TOOLS = new Set(['read_file', 'list_dir', 'write_file', 'edit_file', 'search_files', 'find_files', 'look_at_image']);
// Tools that run one shell command, so "this exact command" makes sense.
const COMMAND_TOOLS = new Set(['shell']);
const HIGH_RISK_NOTE = "This is a high-risk action. You're allowing it without asking until Lyra restarts.";

const tilde = (p) => { const h = os.homedir(); return p === h ? '~' : p.startsWith(h + path.sep) ? '~' + p.slice(h.length) : p; };
// The card shows the home folder as ~, so a screenshot of it doesn't carry the user's name.
// The detail is often JSON text, where a Windows path's \\ is written \\\\, so swap the
// JSON-escaped form of the home folder too.
const tildeAll = (text) => {
  const h = os.homedir();
  if (!h || h.length <= 1) return text;
  const esc = (s) => JSON.stringify(s).slice(1, -1);
  let out = text.split(h + path.sep).join('~' + path.sep);
  if (esc(h + path.sep) !== h + path.sep) out = out.split(esc(h + path.sep)).join(esc('~' + path.sep));
  return out;
};

class Approvals {
  constructor({ settings, emit, notify, grants = null }) {
    this.settings = settings; this.emit = emit; this.notify = notify; this.pending = new Map();
    this.grants = grants; // the kernel's Grants: outlives this organ, gone on quit
  }

  // call = { chatId, tool, command, path } describes the action, for grants.
  decide(risk, origin, call = null) {
    const s = this.settings.get();
    if (origin === 'mobile' && risk === 'high' && !s.mobile.allowHighRiskTools) return { decision: 'denied', auto: true, why: 'high-risk actions are switched off for phone sessions' };
    const mode = s.safety.approvalMode;
    if (mode === 'none') return { decision: 'approved', auto: true, why: 'no restrictions' };
    if (mode === 'auto') return { decision: 'approved', auto: true, why: 'auto-approve' };
    // A rule the user made on the desktop never waves a high-risk action through
    // for the phone: there the phone's own rule decides, so it asks.
    if (call && this.grants && !(origin === 'mobile' && risk === 'high')) {
      const g = this.grants.match(call);
      if (g) return { decision: 'approved', auto: true, grant: g.id, why: `approved by your rule: ${g.label} (${g.scope === 'chat' ? 'this chat' : 'this session'})` };
    }
    if (s.model.smartApprovals && risk === 'low') return { decision: 'approved', auto: true, why: 'smart approval: low risk' };
    return null;
  }

  // What the card may offer for this call. Each option carries the exact rule
  // it would create; the window only says which option was picked.
  options({ chatId, tool, command, path: target, risk }) {
    if (!this.grants) return [];
    const out = [{ kind: 'chat', label: `Allow ${tool} for this chat`, rule: { scope: 'chat', chatId, tool, match: {}, risk, label: tool } }];
    if (COMMAND_TOOLS.has(tool) && command != null) {
      const c = this.grants.normalise(command);
      if (c) out.push({ kind: 'command', label: 'Always allow this exact command (until Lyra restarts)', value: c, rule: { scope: 'session', tool, match: { command: c }, risk, label: c } });
    }
    if (FILE_TOOLS.has(tool) && target) {
      let dir = target; try { if (!fs.statSync(target).isDirectory()) dir = path.dirname(target); } catch { dir = path.dirname(target); }
      out.push({ kind: 'folder', label: `Always allow ${tool} in this folder (until Lyra restarts)`, value: tilde(dir), rule: { scope: 'session', tool, match: { pathPrefix: dir }, risk, label: `${tool} in ${tilde(dir)}` } });
    }
    return out;
  }

  request({ chatId, tool, summary, detail, risk, reason, origin, command = null, path: target = null }) {
    const call = { chatId, tool, command, path: target };
    const pre = this.decide(risk, origin, call);
    if (pre) return Promise.resolve(pre);
    const s = this.settings.get().safety;
    const reqId = id();
    const timeoutMs = Math.max(5, s.timeoutSec) * 1000;
    const expiresAt = Date.now() + timeoutMs;
    // The phone can't create grants (its approve call has no `remember`), and a
    // phone turn's high-risk card mustn't suggest a rule the phone would ignore.
    const opts = origin === 'mobile' ? [] : this.options({ ...call, risk });
    this.emit(chatId, 'approval', { id: reqId, tool, summary, detail: typeof detail === 'string' ? tildeAll(detail) : detail, risk, reason, expiresAt, onTimeout: s.onTimeout, remember: opts.map(({ kind, label, value }) => ({ kind, label, value })), highRiskNote: risk === 'high' && opts.length ? HIGH_RISK_NOTE : null });
    this.notify('approvals', 'Lyra needs your approval', summary);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        const decision = s.onTimeout === 'approve' ? 'approved' : 'denied';
        this.emit(chatId, 'approval:resolved', { id: reqId, decision, timedOut: true });
        resolve({ decision, timedOut: true });
      }, timeoutMs);
      this.pending.set(reqId, { resolve, timer, chatId, options: opts });
    });
  }

  // remember = { kind } picks one of the options offered on the card. Only an
  // approval can remember anything, and only an option the card offered.
  respond(reqId, decision, remember = null) {
    const p = this.pending.get(reqId); if (!p) return false;
    clearTimeout(p.timer); this.pending.delete(reqId);
    let grant = null;
    if (decision === 'approved' && remember && this.grants) {
      const o = p.options.find((x) => x.kind === remember.kind);
      if (o) grant = this.grants.add(o.rule);
    }
    this.emit(p.chatId, 'approval:resolved', { id: reqId, decision, remembered: grant ? { id: grant.id, label: grant.label, scope: grant.scope } : null });
    p.resolve(grant ? { decision, grant: grant.id, why: `approved by you, and remembered: ${grant.label} (${grant.scope === 'chat' ? 'this chat' : 'this session'})` } : { decision });
    return true;
  }

  cancelAll(chatId) {
    for (const [reqId, p] of [...this.pending]) if (!chatId || p.chatId === chatId) { clearTimeout(p.timer); this.pending.delete(reqId); this.emit(p.chatId, 'approval:resolved', { id: reqId, decision: 'denied', cancelled: true }); p.resolve({ decision: 'denied', cancelled: true }); }
  }
}
module.exports = { Approvals, FILE_TOOLS, COMMAND_TOOLS, HIGH_RISK_NOTE };
