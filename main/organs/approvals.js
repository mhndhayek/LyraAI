// Approval gate for agent actions: mode (ask / auto / none), smart approvals,
// and a timeout with a configurable outcome.
const { id } = require('./util');

class Approvals {
  constructor({ settings, emit, notify }) { this.settings = settings; this.emit = emit; this.notify = notify; this.pending = new Map(); }

  decide(risk, origin) {
    const s = this.settings.get();
    if (origin === 'mobile' && risk === 'high' && !s.mobile.allowHighRiskTools) return { decision: 'denied', auto: true, why: 'high-risk actions are switched off for phone sessions' };
    const mode = s.safety.approvalMode;
    if (mode === 'none') return { decision: 'approved', auto: true, why: 'no restrictions' };
    if (mode === 'auto') return { decision: 'approved', auto: true, why: 'auto-approve' };
    if (s.model.smartApprovals && risk === 'low') return { decision: 'approved', auto: true, why: 'smart approval: low risk' };
    return null;
  }

  request({ chatId, tool, summary, detail, risk, reason, origin }) {
    const pre = this.decide(risk, origin);
    if (pre) return Promise.resolve(pre);
    const s = this.settings.get().safety;
    const reqId = id();
    const timeoutMs = Math.max(5, s.timeoutSec) * 1000;
    const expiresAt = Date.now() + timeoutMs;
    this.emit(chatId, 'approval', { id: reqId, tool, summary, detail, risk, reason, expiresAt, onTimeout: s.onTimeout });
    this.notify('approvals', 'Lyra needs your approval', summary);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        const decision = s.onTimeout === 'approve' ? 'approved' : 'denied';
        this.emit(chatId, 'approval:resolved', { id: reqId, decision, timedOut: true });
        resolve({ decision, timedOut: true });
      }, timeoutMs);
      this.pending.set(reqId, { resolve, timer, chatId });
    });
  }

  respond(reqId, decision) {
    const p = this.pending.get(reqId); if (!p) return false;
    clearTimeout(p.timer); this.pending.delete(reqId);
    this.emit(p.chatId, 'approval:resolved', { id: reqId, decision });
    p.resolve({ decision });
    return true;
  }

  cancelAll(chatId) {
    for (const [reqId, p] of [...this.pending]) if (!chatId || p.chatId === chatId) { clearTimeout(p.timer); this.pending.delete(reqId); this.emit(p.chatId, 'approval:resolved', { id: reqId, decision: 'denied', cancelled: true }); p.resolve({ decision: 'denied', cancelled: true }); }
  }
}
module.exports = { Approvals };
