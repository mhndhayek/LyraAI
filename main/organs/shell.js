// A shell that stays open between commands (cwd, env and variables carry over),
// plus a one-shot runner for when the persistent shell is switched off.
const { spawn, execFile } = require('child_process');
const { id } = require('./util');

const ENV = { ...process.env, TERM: 'dumb', NO_COLOR: '1', PAGER: 'cat', GIT_PAGER: 'cat', CLICOLOR: '0', PYTHONUNBUFFERED: '1' };

class PersistentShell {
  constructor(cwd) { this.cwd = cwd; this.proc = null; this.queue = Promise.resolve(); }
  start() {
    this.proc = spawn('/bin/zsh', ['-f'], { cwd: this.cwd, env: ENV, stdio: ['pipe', 'pipe', 'pipe'] });
    this.out = ''; this.err = '';
    this.proc.stdout.on('data', (d) => { this.out += d.toString(); this.check && this.check(); });
    this.proc.stderr.on('data', (d) => { this.err += d.toString(); });
    this.proc.on('exit', () => { this.proc = null; });
    this.proc.stdin.write(`cd ${JSON.stringify(this.cwd)}\n`);
  }
  run(command, timeoutMs = 60000) {
    const job = () => new Promise((resolve) => {
      if (!this.proc) this.start();
      const marker = `__LYRA_DONE_${id()}__`;
      this.out = ''; this.err = '';
      let finished = false;
      const timer = setTimeout(() => { if (finished) return; finished = true; this.check = null; try { this.proc.kill('SIGKILL'); } catch {} this.proc = null; resolve({ stdout: this.out, stderr: this.err + `\n[timed out after ${timeoutMs / 1000}s; shell restarted]`, code: 124 }); }, timeoutMs);
      this.check = () => {
        const i = this.out.indexOf(marker); if (i < 0) return;
        const tail = this.out.slice(i + marker.length); const m = tail.match(/^_(\d+)_(.*)__END__/s);
        if (!m) return;
        finished = true; clearTimeout(timer); this.check = null;
        const cwd = m[2].trim(); if (cwd) this.cwd = cwd;
        resolve({ stdout: this.out.slice(0, i).replace(/\n$/, ''), stderr: this.err.trim(), code: Number(m[1]), cwd: this.cwd });
      };
      this.proc.stdin.write(`${command}\n__lyra_rc=$?; printf '\\n${marker}_%s_%s__END__\\n' "$__lyra_rc" "$PWD"\n`);
    });
    this.queue = this.queue.then(job, job);
    return this.queue;
  }
  kill() { try { this.proc && this.proc.kill('SIGKILL'); } catch {} this.proc = null; }
}

function runOnce(command, cwd, timeoutMs = 60000) {
  return new Promise((resolve) => {
    execFile('/bin/zsh', ['-lc', command], { cwd, env: ENV, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ stdout: (stdout || '').replace(/\n$/, ''), stderr: (stderr || '').trim() + (err && err.killed ? `\n[timed out after ${timeoutMs / 1000}s]` : ''), code: err ? (err.code ?? 1) : 0, cwd });
    });
  });
}

module.exports = { PersistentShell, runOnce };
