// Checkpoints: the state folder is a git repository owned by the kernel. A snapshot is
// taken before the agent changes anything, a healthy boot moves the last-known-good
// tag, and rollback is a checkout. The agent never drives git here directly.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

class Checkpoints {
  constructor(stateDir, log = () => {}) { this.dir = stateDir; this.log = log; this.available = false; }
  git(args, opts = {}) {
    return execFileSync('git', args, { cwd: this.dir, encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, ...opts }).trim();
  }
  init() {
    try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { this.log('git not found: checkpoints disabled'); return false; }
    fs.mkdirSync(this.dir, { recursive: true });
    if (!fs.existsSync(path.join(this.dir, '.git'))) {
      this.git(['init', '-q']);
      fs.writeFileSync(path.join(this.dir, '.gitignore'), '*.log\n*.tmp\n.DS_Store\n');
    }
    for (const [k, v] of [['user.name', 'Lyra kernel'], ['user.email', 'kernel@lyra.local'], ['commit.gpgsign', 'false']]) this.git(['config', k, v]);
    this.available = true;
    if (!this.head()) this.commit('Initial state');
    return true;
  }
  head() { try { return this.git(['rev-parse', '--short', 'HEAD']); } catch { return null; } }
  isDirty() { if (!this.available) return false; return this.git(['status', '--porcelain']) !== ''; }
  commit(label) {
    if (!this.available) return null;
    this.git(['add', '-A']);
    if (this.head() && this.git(['status', '--porcelain']) === '') return null;
    this.git(['commit', '-q', '-m', (label || 'checkpoint').slice(0, 120), '--allow-empty']);
    const hash = this.head(); this.log(`checkpoint ${hash}: ${label}`);
    return { hash, label };
  }
  list(n = 40) {
    if (!this.available || !this.head()) return [];
    const lkg = this.lastKnownGood();
    return this.git(['log', `-${n}`, '--format=%h|%ct|%s']).split('\n').filter(Boolean).map((l) => { const [hash, ts, ...rest] = l.split('|'); return { hash, time: Number(ts) * 1000, label: rest.join('|'), lkg: hash === lkg }; });
  }
  lastKnownGood() { try { return this.git(['rev-parse', '--short', 'lkg']); } catch { return null; } }
  markGood() { if (!this.available) return; this.commit('Healthy boot'); this.git(['tag', '-f', 'lkg']); }
  changedSince(ref = 'lkg') { try { return this.git(['diff', '--stat', ref, '--']).split('\n').filter(Boolean); } catch { return []; } }
  changedFiles(ref = 'HEAD') { try { const a = this.git(['diff', '--name-only', ref, '--']).split('\n'); const b = this.git(['ls-files', '--others', '--exclude-standard']).split('\n'); return [...new Set([...a, ...b])].filter(Boolean); } catch { return []; } }
  rollback(ref, { subdir = null } = {}) {
    if (!this.available) throw new Error('Checkpoints unavailable (git not found)');
    this.commit(`Before rollback to ${ref}`);
    const target = subdir ? [ref, '--', subdir] : [ref, '--', '.'];
    this.git(['checkout', '-q', ...target]);
    if (!subdir) this.git(['clean', '-fdq']);
    else this.git(['clean', '-fdq', '--', subdir]);
    return this.commit(`Rolled back ${subdir || 'everything'} to ${ref}`);
  }
}
module.exports = { Checkpoints };
