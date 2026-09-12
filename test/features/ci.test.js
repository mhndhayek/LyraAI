// The gate protects itself: these tests fail if a CI job stops being blocking,
// if a command CI runs does not exist, or if the merge rule loses its teeth.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('../helpers/tmp');

const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const CI = read('.github', 'workflows', 'ci.yml');
const RELEASE = read('.github', 'workflows', 'release.yml');
const pkg = JSON.parse(read('package.json'));

// The workflows are small and regular, so they are read with targeted patterns
// rather than by pulling in a YAML parser the project does not otherwise need.
const JOBS = CI.slice(CI.indexOf('\njobs:'));
const jobNames = [...JOBS.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((m) => m[1]);
// The YAML of one job, from its name up to the next job at the same indent.
function jobSection(name) {
  const starts = [...JOBS.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)];
  const i = starts.findIndex((m) => m[1] === name);
  assert.ok(i >= 0, `there is no ${name} job`);
  return JOBS.slice(starts[i].index, i + 1 < starts.length ? starts[i + 1].index : JOBS.length);
}
const gateMatch = /needs: \[([^\]]+)\]/.exec(CI);
const gateNeeds = (gateMatch ? gateMatch[1] : '').split(',').map((s) => s.trim()).filter(Boolean);

test('the pipeline runs on every pull request to main', () => {
  assert.match(CI, /pull_request:/);
  assert.match(CI, /branches: \[main\]/);
  assert.match(CI, /workflow_dispatch:/, 'it must be possible to rerun the gate by hand');
});

test('the gate covers every job in the pipeline', () => {
  const checked = new Set(gateNeeds);
  const missing = jobNames.filter((j) => j !== 'gate' && !checked.has(j));
  assert.deepEqual(missing, [], `these jobs could fail without blocking a merge: ${missing.join(', ')}`);
});

test('the gate fails unless every job succeeded outright', () => {
  assert.match(CI, /if: always\(\)/, 'the gate must run even after a job fails');
  // Anything other than "success" — failed, cancelled, or skipped because a
  // dependency failed — has to block the merge.
  assert.match(CI, /\.value\.result != "success"/, 'the gate must treat anything but success as a failure');
  assert.match(CI, /exit 1/);
  assert.ok(!/grep/.test(CI.slice(CI.indexOf('name: QA Gate'))), 'the verdict must not depend on the shape of the printed JSON');
});

test('the gate is named so branch protection can require it', () => {
  assert.match(CI, /name: QA Gate/);
  assert.match(read('scripts', 'setup-branch-protection.sh'), /CHECK="QA Gate"/, 'the protection script must require that exact check');
});

test('the quality steps are all in the pipeline', () => {
  for (const step of ['check:syntax', 'lint', 'test:unit', 'selftest', 'smoke']) {
    assert.ok(CI.includes(`npm run ${step}`), `CI never runs npm run ${step}`);
  }
  assert.match(CI, /npm audit/, 'dependencies are not audited');
});

test('every command the workflows run is a real script', () => {
  const commands = [...(CI + RELEASE).matchAll(/npm run ([a-z:]+)/g)].map((m) => m[1]);
  assert.ok(commands.length > 5);
  for (const c of new Set(commands)) assert.ok(pkg.scripts[c], `CI runs "npm run ${c}", which is not defined in package.json`);
});

test('the app is fetched before any job tries to start it', () => {
  // The electron package downloads its binary lazily on first use, so a job that
  // starts the app without fetching it first fails on a network blip instead of
  // on anything about the change under test.
  for (const job of ['selftest', 'smoke', 'build']) {
    assert.match(jobSection(job), /ensure-electron\.js/, `the ${job} job starts the app without making sure it is downloaded`);
  }
  assert.equal((CI.match(/Cache the Electron download/g) || []).length, 3, 'each job that downloads Electron should cache it');
});

test('every script the workflows call exists on disk', () => {
  const files = [...(CI + RELEASE).matchAll(/node (scripts\/[a-z-]+\.js)/g)].map((m) => m[1]);
  for (const f of new Set(files)) assert.ok(fs.existsSync(path.join(ROOT, f)), `CI runs ${f}, which does not exist`);
});

test('the tests run on all three platforms the app ships to', () => {
  for (const os of ['ubuntu-latest', 'macos-latest', 'windows-latest']) {
    assert.ok(CI.includes(os), `${os} is never tested`);
  }
  assert.match(CI, /xvfb/, 'Electron needs a virtual display to run on Linux CI');
});

test('the build job produces installers for every platform', () => {
  for (const cmd of ['dist:mac', 'dist:win', 'dist:linux']) assert.ok(CI.includes(cmd), `CI never builds with ${cmd}`);
  assert.match(CI, /check-artifacts\.js --launch/, 'CI must check the packaged app actually starts');
  assert.match(CI, /if-no-files-found: error/, 'a build that produced nothing must fail, not warn');
});

test('the release runs the same gate before publishing anything', () => {
  assert.match(RELEASE, /uses: \.\/\.github\/workflows\/ci\.yml/, 'the release must reuse the QA pipeline');
  assert.match(CI, /workflow_call:/, 'ci.yml must be callable for that to work');
  assert.match(RELEASE, /needs: qa/, 'installers must not be built before the gate passes');
  assert.match(RELEASE, /tag .* does not match package\.json version/, 'a mistyped tag must not ship');
});

test('CI installs from the lockfile rather than resolving fresh versions', () => {
  assert.ok(!/npm install\b/.test(CI), 'npm install in CI would ignore the lockfile');
  assert.match(CI, /npm ci/);
});

test('the workflow asks for no more permission than it needs', () => {
  assert.match(CI, /permissions:\s*\n\s*contents: read/, 'the QA pipeline must be read-only');
});
