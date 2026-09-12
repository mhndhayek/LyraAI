// Deterministic kernel self-test: run with `electron . --user-data-dir=<tmp> --kernel-test`.
// Breaks organs on purpose and checks that verification, rollback, quarantine,
// guardrails and the budget behave. Prints one JSON report and exits 0/1.
const fs = require('fs');
const path = require('path');
const { filterPatch } = require('./guard');

async function run(k, markHealthy) {
  const p = k.paths; const results = []; const ok = (name, pass, detail) => results.push({ name, pass: !!pass, detail });
  const read = (f) => fs.readFileSync(f, 'utf8'); const write = (f, s) => fs.writeFileSync(f, s);
  // A broken UI is detected by the window failing to report ready in time, so the
  // test has to sit through that timeout twice. The shipped 10s suits a real
  // machine; a loaded build agent can take longer to bring the window back after
  // a rollback, which looks like a rollback that did not work. Be patient here,
  // then put the user's setting back: what is being checked is the rollback, not
  // how fast this machine happens to be.
  const shippedUiTimeout = k.settings.get().kernel.uiReadyTimeoutMs;
  k.settings.set({ kernel: { uiReadyTimeoutMs: 30000 } });
  // A boot that stays up for 20s tags itself as the last known good. This test
  // spends its time deliberately breaking organs, so that timer would tag the
  // broken state and the rollbacks below would restore the breakage. The test
  // tags the last known good itself, on the line after this one.
  if (k.healthyTimer) { clearTimeout(k.healthyTimer); k.healthyTimer = null; }
  markHealthy(); // tag lkg with the current, healthy organs
  const toolsFile = path.join(p.organsMain, 'tools.js'), indexFile = path.join(p.organsMain, 'index.js'), appFile = path.join(p.organsRenderer, 'app.js');
  const good = { tools: read(toolsFile), index: read(indexFile), app: read(appFile) };

  // 1. clean verify
  const v0 = await k.loader.verify('all'); ok('verify clean organs', v0.ok, v0.errors);

  // 2. syntax error in a main organ: verify must fail, nothing applied, file left for the agent to fix
  write(toolsFile, 'this is broken (\n' + good.tools);
  const r1 = await k.loader.reload('main', { label: 'selftest syntax' });
  ok('syntax error is rejected before apply', !r1.ok && r1.errors.length > 0 && r1.applied.length === 0, r1.errors[0]);
  ok('organs still generation before', !!k.organs, k.loader.generation);
  write(toolsFile, good.tools);

  // 3. runtime error in create(): verify passes, swap fails, rollback to lkg restores the file and reloads
  const genBefore = k.loader.generation;
  write(indexFile, good.index.replace('function create(k) {', "function create(k) { throw new Error('selftest boom');"));
  const r2 = await k.loader.reload('main', { label: 'selftest runtime' });
  ok('runtime error triggers rollback', !r2.ok && /rolled/i.test(r2.note || ''), r2.note);
  ok('index.js restored from last known good', read(indexFile) === good.index);
  ok('organs reloaded after rollback', !!k.organs && k.loader.generation > genBefore, k.loader.generation);

  // 4. broken UI: reload must time out, roll back and recover
  write(appFile, "throw new Error('selftest ui boom');\n" + good.app);
  const r3 = await k.loader.reload('renderer', { label: 'selftest ui' });
  ok('broken UI is rolled back', !r3.ok && /rolled/i.test(r3.note || ''), r3.note);
  ok('app.js restored', read(appFile) === good.app);
  ok('not in safe mode', !k.safeMode, k.safeMode);

  // 5. extension quarantine
  const bad = path.join(p.extensions, 'selftest-bad'); fs.mkdirSync(bad, { recursive: true });
  write(path.join(bad, 'manifest.json'), JSON.stringify({ id: 'selftest-bad', name: 'Bad', capabilities: [] })); write(path.join(bad, 'main.js'), "throw new Error('bad extension');");
  const e1 = k.extensions.approve('selftest-bad'); const st = k.extensions.list().find((x) => x.id === 'selftest-bad');
  ok('broken extension is quarantined', !e1.ok && st && st.status === 'quarantined', st && st.error);
  fs.rmSync(bad, { recursive: true, force: true }); delete k.extensions.state['selftest-bad']; k.extensions.saveState();

  // 6. guardrails
  const f = filterPatch({ persona: { name: 'Evil' }, safety: { approvalMode: 'none' }, model: { chat: { model: 'x' } }, appearance: { theme: 'pixel' } });
  ok('locked settings are refused', f.rejected.length === 2 && f.rejected.every((x) => /name|safety/.test(x.path)), f.rejected);
  ok('model change is queued, theme allowed', f.queuedPaths.length === 1 && f.allowed.appearance && f.allowed.appearance.theme === 'pixel', f.queuedPaths);
  ok('shell guard blocks killing the app', !!k.guard.shellBlocked('killall Electron') && !!k.guard.shellBlocked('rm -rf ~/x/state/.git'), k.guard.shellBlocked('killall Electron'));
  ok('bundle and repo paths are forbidden', !!k.guard.forbiddenPath(path.join(p.appPath, 'main', 'main.js')) && !!k.guard.forbiddenPath(path.join(p.state, '.git', 'HEAD')) && !k.guard.forbiddenPath(path.join(p.organsMain, 'tools.js')));

  // 7. budget
  const limit = k.settings.get().kernel.dailyWrites; k.store.kvSet('kernel:writes', { date: new Date().toISOString().slice(0, 10), used: limit - 1 });
  ok('budget allows the last write and refuses the next', k.guard.consume(1).ok && !k.guard.consume(1).ok, k.guard.budget());
  k.store.kvSet('kernel:writes', { date: new Date().toISOString().slice(0, 10), used: 0 });

  // 8. the 0.9 rename: old Nova data is adopted, store and settings migrate
  { const os = require('os'); const { adoptOldUserData } = require('./paths'); const { openStore } = require('./store'); const { Settings } = require('./settings');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-adopt-')); const oldDir = path.join(tmp, 'Nova'), newDir = path.join(tmp, 'Lyra');
    fs.mkdirSync(path.join(oldDir, 'state'), { recursive: true }); fs.writeFileSync(path.join(oldDir, 'nova.sqlite'), '');
    fs.writeFileSync(path.join(oldDir, 'state', 'settings.json'), JSON.stringify({ persona: { name: 'Nova' }, appearance: { theme: 'nova-dark' } }));
    const ad = adoptOldUserData(newDir);
    ok('old Nova data folder is adopted', !!ad && ad.moved.includes('state') && fs.existsSync(path.join(newDir, 'nova.sqlite')) && !fs.existsSync(oldDir), ad);
    const st2 = openStore(newDir, 'sqlite'); if (st2.close) st2.close();
    ok('store file renamed to lyra.sqlite', fs.existsSync(path.join(newDir, 'lyra.sqlite')) && !fs.existsSync(path.join(newDir, 'nova.sqlite')));
    const s2 = new Settings(path.join(newDir, 'state', 'settings.json')); if (!s2.data || !s2.data.persona) s2.load(); const d2 = s2.get();
    ok('settings migrate renames persona and theme', d2.persona.name === 'Lyra' && d2.appearance.theme === 'lyra-dark', { name: d2.persona.name, theme: d2.appearance.theme });
    fs.rmSync(tmp, { recursive: true, force: true }); }

  // 9. checkpoints history sane
  const cps = k.checkpoints.list(10); ok('checkpoints recorded', cps.length >= 3 && cps.some((c) => /Before rollback/.test(c.label)), cps.map((c) => c.label));
  k.checkpoints.commit('Selftest done');

  k.settings.set({ kernel: { uiReadyTimeoutMs: shippedUiTimeout } });
  const pass = results.every((r) => r.pass);
  const report = { pass, results };
  console.log('[selftest] ' + JSON.stringify(report, null, 2));
  try { fs.writeFileSync(path.join(p.userData, 'selftest.json'), JSON.stringify(report, null, 2)); } catch {}
  return report;
}
module.exports = { run };
