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
function jobSection(name, workflow = JOBS) {
  const body = workflow.slice(workflow.indexOf('\njobs:') >= 0 ? workflow.indexOf('\njobs:') : 0);
  const starts = [...body.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)];
  const i = starts.findIndex((m) => m[1] === name);
  assert.ok(i >= 0, `there is no ${name} job`);
  return body.slice(starts[i].index, i + 1 < starts.length ? starts[i + 1].index : body.length);
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

test('macOS builds are signed even when there is no certificate', () => {
  // Apple silicon refuses an unsigned app outright ("damaged, move to Trash"),
  // so a build without a certificate signs ad hoc rather than not at all.
  assert.match(pkg.scripts['dist:mac:adhoc'] || '', /identity=-/, 'dist:mac:adhoc must sign with the ad-hoc identity');
  assert.match(jobSection('build'), /npm run dist:mac:adhoc/, 'CI has no certificate, so its build must sign ad hoc');
  // electron-builder refuses to sign at all, ad hoc included, on a pull request build unless told otherwise.
  assert.match(jobSection('build'), /CSC_FOR_PULL_REQUEST: true/, 'pull request builds must still be signed ad hoc, or the signature check fails on every PR');
  const release = jobSection('build', RELEASE);
  assert.match(release, /MAC_DIST=dist:mac"/, 'a release with a certificate must sign with it');
  assert.match(release, /MAC_DIST=dist:mac:adhoc"/, 'a release without a certificate must fall back to the ad-hoc signature');
  for (const m of RELEASE.matchAll(/MAC_DIST=([a-z:]+)/g)) assert.ok(pkg.scripts[m[1]], `MAC_DIST points at npm run ${m[1]}, which is not defined`);
  assert.match(read('scripts', 'check-artifacts.js'), /codesign', \['--verify'/, 'the artifact check must prove every bundle\'s signature is intact');
});

test('the release runs the same gate before publishing anything', () => {
  assert.match(RELEASE, /uses: \.\/\.github\/workflows\/ci\.yml/, 'the release must reuse the QA pipeline');
  assert.match(CI, /workflow_call:/, 'ci.yml must be callable for that to work');
  assert.match(jobSection('build', RELEASE), /needs: \[decide, qa\]/, 'installers must not be built before the gate passes');
  assert.match(RELEASE, /tag .* does not match package\.json version/, 'a tag that disagrees with package.json must not ship');
});

test('a push to main releases only when the version changed', () => {
  assert.match(RELEASE, /branches: \[main\]/, 'a release has to be able to start from a push to main');
  const decide = jobSection('decide', RELEASE);
  assert.match(decide, /there is nothing new to release/, 'an ordinary push must not cut a release');
  assert.match(decide, /is already tagged/, 're-running a release must not ship the same version twice');
  for (const job of ['qa', 'build', 'publish']) {
    const section = jobSection(job, RELEASE);
    const gated = /needs\.decide\.outputs\.release == 'true'/.test(section) || /needs: \[decide/.test(section);
    assert.ok(gated, `the ${job} job would run even when there is nothing to release`);
  }
});

test('an unset signing certificate is never passed as an empty one', () => {
  // electron-builder reads a defined-but-empty CSC_LINK as the path to a
  // certificate and fails on it, so the macOS build broke only in the release,
  // where the variable was set from a secret that did not exist.
  const build = jobSection('build', RELEASE);
  assert.ok(!/CSC_LINK: \$\{\{ secrets\./.test(build), 'CSC_LINK must not be set straight from a secret that may be empty');
  assert.match(build, /if \[ -n "\$\{CERTIFICATE:-\}" \]/, 'the signing variables must only be set when there is a certificate');
  assert.match(build, /CSC_IDENTITY_AUTO_DISCOVERY=false/, 'and signing must be switched off when there is not');
});

test('a release goes live complete, and only once every platform is built', () => {
  const publish = jobSection('publish', RELEASE);
  assert.match(publish, /needs: \[decide, build\]/, 'publishing must wait for every platform');
  assert.match(publish, /download-artifact/, 'the installers must be collected before the release is created');
  assert.match(publish, /these installers never arrived/, 'a missing installer must stop the release, not ship half of it');
  assert.match(publish, /draft: false/, 'the release is published rather than left as a draft');
  for (const ext of ['dmg', 'exe', 'AppImage', 'deb']) {
    assert.ok(publish.includes(ext), `the release does not check for a ${ext}`);
  }
});

test('CI installs from the lockfile rather than resolving fresh versions', () => {
  assert.ok(!/npm install\b/.test(CI), 'npm install in CI would ignore the lockfile');
  assert.match(CI, /npm ci/);
});

test('the workflow asks for no more permission than it needs', () => {
  assert.match(CI, /permissions:\s*\n\s*contents: read/, 'the QA pipeline must be read-only');
});
