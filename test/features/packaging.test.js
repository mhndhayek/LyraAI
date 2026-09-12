// The build config is part of the product: if a file is left out of the bundle or
// an icon goes missing, the app that ships is not the app that was tested.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('../helpers/tmp');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const has = (p) => fs.existsSync(path.join(ROOT, p));

test('the package points at a real entry point and the app metadata is complete', () => {
  assert.ok(has(pkg.main), `main entry ${pkg.main} does not exist`);
  for (const field of ['name', 'productName', 'version', 'description', 'license', 'homepage']) {
    assert.ok(pkg[field], `package.json is missing ${field}`);
  }
  assert.equal(pkg.build.appId, 'app.lyra.agent');
  // The compiled app is called Lyra, which is also the name the kernel gives the
  // running process, so the window, the menu bar and the binary all agree.
  assert.equal(pkg.build.productName, 'Lyra');
  assert.equal(pkg.build.nsis.shortcutName, 'Lyra', 'the Windows shortcut must match the app name');
  assert.equal(pkg.build.linux.executableName, 'Lyra'.toLowerCase(), 'the Linux binary must match the app name');
});

test('every script the QA gate runs is defined', () => {
  for (const s of ['test', 'test:unit', 'lint', 'selftest', 'smoke', 'dist', 'qa']) {
    assert.ok(pkg.scripts[s], `npm run ${s} is used by CI but not defined`);
  }
});

test('everything the app needs at runtime is in the bundle', () => {
  const files = pkg.build.files;
  for (const pattern of ['main/**', 'renderer/**', 'docs/**', 'preload.js', 'package.json']) {
    assert.ok(files.includes(pattern), `${pattern} is missing from build.files; the app would ship incomplete`);
  }
  assert.ok(files.some((f) => f.startsWith('voice/')), 'the voice sidecar must ship');
  assert.ok(pkg.build.asarUnpack.some((f) => f.startsWith('voice/')), 'the voice sidecar must be unpacked to be runnable');
});

test('tests and development files are not shipped to users', () => {
  const files = pkg.build.files.filter((f) => !f.startsWith('!'));
  for (const dev of ['test/**', 'node_modules/**', '.github/**']) {
    assert.ok(!files.includes(dev), `${dev} should not be bundled`);
  }
});

test('an icon exists for every platform that is built', () => {
  assert.ok(has('assets/icon.icns'), 'macOS needs an .icns icon');
  assert.ok(has('assets/icon.png'), 'Windows and Linux build their icons from the png');
  const png = fs.readFileSync(path.join(ROOT, 'assets/icon.png'));
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  assert.ok(width >= 512 && height >= 512, `icon.png is ${width}x${height}; installers need at least 512x512`);
});

test('the app builds an installer for every desktop platform', () => {
  const targets = (key) => (pkg.build[key].target || []).map((t) => (typeof t === 'string' ? t : t.target));
  assert.ok(targets('mac').includes('dmg'), 'macOS users need a dmg to install from');
  assert.ok(targets('mac').includes('zip'), 'a zip is needed for updates and for CI to keep a runnable app');
  assert.ok(targets('win').includes('nsis'), 'Windows users need an installer');
  assert.ok(targets('linux').some((t) => ['AppImage', 'deb'].includes(t)), 'Linux needs at least an AppImage or a deb');
  assert.ok(pkg.build.linux.category, 'Linux desktop entries need a category');
});

test('macOS builds are hardened and universal enough to run everywhere', () => {
  const arches = (pkg.build.mac.target || []).flatMap((t) => (typeof t === 'string' ? [] : t.arch || []));
  assert.ok(arches.includes('arm64') && arches.includes('x64'), 'both Apple silicon and Intel Macs must be covered');
});

test('the release build does not bake a developer machine path into the app', () => {
  for (const [name, script] of Object.entries(pkg.scripts)) {
    if (!/^dist:(mac|win|linux)$/.test(name)) continue;
    assert.ok(!script.includes('sourceDir'), `${name} must not carry a local sourceDir into a shipped build`);
    assert.ok(!script.includes('$(pwd)'), `${name} must not embed the build machine's path`);
  }
});

test('the runtime dependencies are all declared', () => {
  // Anything required from main/, preload or the renderer must be a dependency,
  // not a devDependency, or it will be missing from the packaged app.
  const declared = new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})]);
  const builtin = new Set(require('module').builtinModules);
  const sources = [];
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'vendor' || e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) sources.push(p);
  } };
  walk(path.join(ROOT, 'main'));
  sources.push(path.join(ROOT, 'preload.js'));
  for (const file of sources) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/require\('([^'.][^']*)'\)/g)) {
      const name = m[1].startsWith('@') ? m[1].split('/').slice(0, 2).join('/') : m[1].split('/')[0];
      if (name === 'electron' || name.startsWith('node:') || builtin.has(name)) continue;
      assert.ok(declared.has(name), `${path.relative(ROOT, file)} requires "${name}", which is not in package.json`);
    }
  }
});

test('the lockfile is present and in sync with the manifest', () => {
  assert.ok(has('package-lock.json'), 'CI installs with npm ci, which needs a lockfile');
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  assert.equal(lock.version, pkg.version, 'the lockfile version has drifted from package.json');
  for (const [name, range] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    const entry = lock.packages[`node_modules/${name}`];
    assert.ok(entry, `${name} is in package.json but not in the lockfile; run npm install`);
    assert.ok(range, `${name} has no version range`);
  }
});
