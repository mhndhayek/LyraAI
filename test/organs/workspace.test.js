const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { tmpdir, cleanup } = require('../helpers/tmp');
const ws = require('../../main/organs/workspace');

test.after(cleanup);

test('ensure creates the workspace and its standard folders', () => {
  const root = ws.ensure(path.join(tmpdir(), 'Lyra', 'workspace'));
  for (const d of ['projects', 'images', 'notes', 'downloads', 'tmp']) {
    assert.ok(fs.statSync(path.join(root, d)).isDirectory(), `${d} missing`);
  }
  assert.equal(ws.ensure(root), root, 'calling it again is harmless');
});

test('ensure expands a home-relative folder', () => {
  const root = ws.ensure('~/.lyra-test-workspace');
  assert.equal(root, path.join(os.homedir(), '.lyra-test-workspace'));
  fs.rmSync(root, { recursive: true, force: true });
});

// Absolute paths differ per platform, so they are built rather than written out.
const ROOT_DIR = path.join(path.sep, 'tmp', 'lyra-root');
const OUTSIDE = path.join(path.sep, 'etc', 'hosts');

test('relative paths resolve inside the workspace, absolute ones do not move', () => {
  const root = ROOT_DIR;
  assert.equal(ws.resolvePath(root, 'notes/a.md'), path.join(root, 'notes', 'a.md'));
  assert.equal(ws.resolvePath(root, './a.md'), path.join(root, 'a.md'));
  assert.equal(ws.resolvePath(root, OUTSIDE), OUTSIDE, 'an absolute path is left where it is');
  assert.equal(ws.resolvePath(root, ''), root, 'no path means the workspace itself');
  assert.equal(ws.resolvePath(root, '~'), os.homedir());
});

test('inside() is not fooled by traversal or by prefix collisions', () => {
  const root = ROOT_DIR;
  assert.equal(ws.inside(root, root), true);
  assert.equal(ws.inside(root, path.join(root, 'deep', 'file.txt')), true);
  assert.equal(ws.inside(root, path.join(path.sep, 'tmp', 'lyra-root-other', 'file.txt')), false, 'a shared prefix is not containment');
  assert.equal(ws.inside(root, ws.resolvePath(root, '../secrets.txt')), false, 'traversal escapes are caught');
  assert.equal(ws.inside(root, OUTSIDE), false);
});

test('tree lists directories first with counts, and hides dotfiles', () => {
  const root = tmpdir();
  fs.mkdirSync(path.join(root, 'projects'));
  fs.writeFileSync(path.join(root, 'projects', 'one.txt'), 'x');
  fs.writeFileSync(path.join(root, 'projects', 'two.txt'), 'y');
  fs.writeFileSync(path.join(root, 'b.txt'), 'hello');
  fs.writeFileSync(path.join(root, '.hidden'), 'secret');
  const out = ws.tree(root);
  assert.deepEqual(out.map((e) => e.name), ['projects/', 'b.txt']);
  assert.equal(out[0].count, 2);
  assert.equal(out[1].size, 5);
});

test('tree on a missing folder is empty rather than an error', () => {
  assert.deepEqual(ws.tree(path.join(tmpdir(), 'nope')), []);
});

test('repo discovery finds checkouts and stops descending into them', () => {
  const root = tmpdir();
  const repo = path.join(root, 'projects', 'app');
  fs.mkdirSync(path.join(repo, 'nested', 'deeper'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'nested', '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'pkg', '.git'), { recursive: true });
  const repos = ws.discoverRepos(root);
  assert.deepEqual(repos.map((r) => r.name), ['app'], 'nested repos and node_modules are skipped');
  assert.equal(repos[0].path, repo);
});

test('repo discovery respects the depth limit', () => {
  const root = tmpdir();
  fs.mkdirSync(path.join(root, 'a', 'b', 'c', 'd', '.git'), { recursive: true });
  assert.deepEqual(ws.discoverRepos(root, 2), []);
  assert.equal(ws.discoverRepos(root, 5).length, 1);
});

test('a real repository reports its branch and dirty state', () => {
  const { execFileSync } = require('child_process');
  const root = tmpdir();
  const repo = path.join(root, 'proj');
  fs.mkdirSync(repo, { recursive: true });
  const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@lyra.local');
  git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one');
  git('add', '-A');
  git('commit', '-q', '-m', 'first commit');
  let found = ws.discoverRepos(root)[0];
  assert.equal(found.branch, 'main');
  assert.match(found.last, /first commit/);
  assert.equal(found.dirty, false);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two');
  found = ws.discoverRepos(root)[0];
  assert.equal(found.dirty, true);
});
