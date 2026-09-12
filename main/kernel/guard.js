// Guardrails: which settings the agent may not touch, which it may only change when
// idle, which paths are off-limits, which shell commands are blocked, and the daily
// self-modification budget.
const path = require('path');

const LOCKED = ['persona.name', 'safety', 'providers', 'tools.enabled', 'tools.app', 'kernel', 'chat.followUp', 'mobile', 'profiles'];
const QUEUED = ['model'];
const REASONS = { 'persona.name': 'only the user renames the assistant', safety: 'safety rules are the user’s', providers: 'model runtimes and API keys are the user’s', 'tools.enabled': 'the master tool switch is the user’s', 'tools.app': 'self-customization cannot switch itself off', kernel: 'kernel settings (checkpoints, budget) are the user’s', 'chat.followUp': 'the user decides how follow-ups behave', mobile: 'only the user opens or closes phone access', profiles: 'only the user adds, switches or removes profiles' };

const matches = (p, prefix) => p === prefix || p.startsWith(prefix + '.');
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
function flatten(obj, prefix = '', out = []) { for (const [k, v] of Object.entries(obj || {})) { const p = prefix ? `${prefix}.${k}` : k; if (isObj(v)) flatten(v, p, out); else out.push([p, v]); } return out; }
function unflatten(pairs) { const o = {}; for (const [p, v] of pairs) { const parts = p.split('.'); let cur = o; parts.slice(0, -1).forEach((s) => { cur[s] = cur[s] || {}; cur = cur[s]; }); cur[parts[parts.length - 1]] = v; } return o; }

function filterPatch(patch) {
  const allowed = [], queued = [], rejected = [];
  for (const [p, v] of flatten(patch)) {
    const lock = LOCKED.find((l) => matches(p, l));
    if (lock) { rejected.push({ path: p, why: REASONS[lock] }); continue; }
    if (QUEUED.some((q) => matches(p, q))) queued.push([p, v]); else allowed.push([p, v]);
  }
  return { allowed: unflatten(allowed), queued: unflatten(queued), rejected, queuedPaths: queued.map(([p]) => p) };
}

const SHELL_BLOCK = [
  [/\b(killall|pkill|kill)\b.*\b(Electron|Lyra)\b/i, 'stopping the app process'],
  [/\brm\b.*(state[/\\]\.git|Lyra( AI Agent)?\.app|app\.asar|\/organs\b)/i, 'deleting the app, its organs or the checkpoint repository'],
  [/\bgit\b.*(state[/\\]|--git-dir)/i, 'driving the checkpoint repository directly (use the checkpoint tools)'],
  [/\bosascript\b.*\bquit\b/i, 'quitting the app'],
  [/\b(launchctl|shutdown|reboot)\b/i, 'system power or service control'],
];

class Guard {
  constructor(k) { this.k = k; }
  forbiddenPath(abs) {
    const p = this.k.paths; const inside = (root) => { const r = path.relative(root, abs); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
    if (inside(p.appPath)) return 'the app bundle (kernel and shipped organs) is read-only; edit the live copies under the state folder instead';
    if (inside(path.join(p.state, '.git'))) return 'the checkpoint repository is kernel-owned';
    if ([p.bootFile, p.extensionsState].includes(abs) || /(lyra|nova)\.(sqlite|json)/.test(path.basename(abs))) return 'app data files are kernel-owned';
    return null;
  }
  inState(abs) { const r = path.relative(this.k.paths.state, abs); return r !== '' && !r.startsWith('..') && !path.isAbsolute(r); }
  stateRisk(abs) { const rel = path.relative(this.k.paths.state, abs); return rel.startsWith('organs') ? 'high' : 'low'; }
  shellBlocked(cmd) { const hit = SHELL_BLOCK.find(([re]) => re.test(cmd)); return hit ? hit[1] : null; }
  budget() {
    const limit = this.k.settings.get().kernel.dailyWrites; const today = new Date().toISOString().slice(0, 10);
    const u = this.k.store.kvGet('kernel:writes', { date: today, used: 0 }); return { date: today, used: u.date === today ? u.used : 0, limit };
  }
  consume(n = 1) { const b = this.budget(); if (b.used + n > b.limit) return { ok: false, ...b }; this.k.store.kvSet('kernel:writes', { date: b.date, used: b.used + n }); return { ok: true, used: b.used + n, limit: b.limit }; }
}
module.exports = { Guard, filterPatch, LOCKED, QUEUED, REASONS, flatten };
