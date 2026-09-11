// The AI's own folder: files, images, notes, repos.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { expandHome } = require('./util');

function ensure(folder) {
  const root = expandHome(folder);
  for (const d of ['', 'projects', 'images', 'notes', 'downloads', 'tmp']) fs.mkdirSync(path.join(root, d), { recursive: true });
  return root;
}
function resolvePath(root, p) {
  if (!p) return root;
  const e = expandHome(p);
  return path.isAbsolute(e) ? path.normalize(e) : path.normalize(path.join(root, e));
}
function inside(root, abs) { const rel = path.relative(root, abs); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); }

function tree(root) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      let n = 0; try { n = fs.readdirSync(p).filter((x) => !x.startsWith('.')).length; } catch {}
      out.push({ name: e.name + '/', dir: true, count: n });
    } else out.push({ name: e.name, dir: false, size: fs.statSync(p).size });
  }
  return out.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
}

function git(args, cwd) { try { return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } }

function discoverRepos(root, maxDepth = 3) {
  const repos = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth || repos.length > 50) return;
    let entries = []; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some((e) => e.name === '.git')) {
      repos.push({ name: path.basename(dir), path: dir, branch: git(['rev-parse', '--abbrev-ref', 'HEAD'], dir), last: git(['log', '-1', '--format=%s (%cr)'], dir), dirty: git(['status', '--porcelain'], dir) !== '' });
      return;
    }
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== '.venv') walk(path.join(dir, e.name), depth + 1);
  };
  walk(root, 0);
  return repos;
}

module.exports = { ensure, resolvePath, inside, tree, discoverRepos };
