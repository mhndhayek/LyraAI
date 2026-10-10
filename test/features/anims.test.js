// Story 09 (QA gate 1, failing-first): every entry in anims.json has a source, a
// licence and a url, the file it points at exists and is under 1 MB, and every
// app state maps to at least one clip. The gate checks the assets in pure Node —
// the same Blender-free maths the colour story uses — so CI's Node-only runners
// need no Python. A second part unit-tests the state machine with a fake clock:
// idle → thinking crossfades, a one-shot returns to the base loop, and a missing
// clip falls back to procedural without throwing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('../helpers/tmp');
const { vrmGltf } = require('../helpers/vrm-color');

const ANIMS_DIR = path.join(ROOT, 'renderer', 'character', 'anims');
const ANIMS_JSON = path.join(ANIMS_DIR, 'anims.json');
const ANIM_JS = path.join(ROOT, 'renderer', 'character', 'anim.js');
const CHARACTER_JS = path.join(ROOT, 'renderer', 'character.js');

const read = (p) => fs.readFileSync(p, 'utf8');
const manifest = JSON.parse(read(ANIMS_JSON));
const clipBuf = (name) => fs.readFileSync(path.join(ANIMS_DIR, manifest.clips[name].file));

// The app states the character can be in. Every one must resolve to a clip.
const APP_STATES = ['idle', 'thinking', 'writing', 'speaking'];

test('every manifest entry records its provenance: source, licence and url', () => {
  for (const [name, c] of Object.entries(manifest.clips)) {
    assert.ok(c.source, `clip '${name}' is missing its source`);
    assert.ok(c.licence, `clip '${name}' is missing its licence`);
    assert.ok(c.url, `clip '${name}' is missing its url`);
    assert.ok(c.file && c.file.endsWith('.vrma'), `clip '${name}' has no .vrma file`);
  }
});

test('every clip file exists, is under 1 MB, and is a valid VRMA', () => {
  const names = Object.keys(manifest.clips);
  for (const n of names) {
    const f = path.join(ANIMS_DIR, manifest.clips[n].file);
    assert.ok(fs.existsSync(f), `clip '${n}' is missing its file ${manifest.clips[n].file}`);
    const kb = fs.statSync(f).size / 1024;
    assert.ok(kb < 1024, `clip '${n}' is ${kb.toFixed(0)}KB, must be under 1MB`);
    const g = vrmGltf(clipBuf(n));
    const declares = (g.extensionsUsed || []).includes('VRMC_vrm_animation')
      || (g.animations || []).some((a) => a.extensions && a.extensions.VRMC_vrm_animation);
    const ntracks = (g.animations || []).reduce((x, a) => x + (a.channels || []).length, 0);
    assert.ok(declares, `clip '${n}' does not declare VRMC_vrm_animation`);
    assert.ok(ntracks > 0, `clip '${n}' has no tracks to animate`);
  }
});

test('the story calls for ten clips', () => {
  assert.equal(Object.keys(manifest.clips).length, 10, `manifest lists ${Object.keys(manifest.clips).length} clips`);
});

test('every app state maps to at least one clip, and each maps to a real clip', () => {
  for (const s of APP_STATES) {
    const list = manifest.states[s] && manifest.states[s].clips;
    assert.ok(Array.isArray(list) && list.length >= 1, `state '${s}' must map to at least one clip`);
    for (const c of list) assert.ok(manifest.clips[c], `state '${s}' maps to a missing clip '${c}'`);
  }
  // A clip that claims a state should have that state listed back in its manifest.
  for (const [n, c] of Object.entries(manifest.clips)) {
    for (const s of c.states || []) {
      if (manifest.states[s]) assert.ok(manifest.states[s].clips.includes(n), `clip '${n}' lists state '${s}' but the state does not list it back`);
    }
  }
});

// ---- the state machine (load anim.js into Node and drive it with mocks) -------
require(ANIM_JS);
const { AnimationState, clipForState } = globalThis.LyraAnimation;

test('clipForState routes each app state to one of its clips', () => {
  assert.ok(manifest.states.thinking.clips.includes(clipForState(manifest, 'thinking', () => 0)));
  assert.equal(clipForState(manifest, 'writing', () => 0), 'lean_type');
  assert.equal(clipForState(manifest, 'speaking', () => 0), 'talk_idle');
  // Unknown states fall back to the idle pool so the model never freezes.
  assert.ok(manifest.states.idle.clips.includes(clipForState(manifest, 'nonsense', () => 0)));
  // A state with several clips (idle) picks within the pool.
  assert.ok(manifest.states.idle.clips.includes(clipForState(manifest, 'idle', () => 0.999)));
});

// A minimal stand-in for the three.js pieces the machine reaches for, so the
// routing logic can be exercised in Node without a WebGL context.
function fakeEnv() {
  const calls = { crossFade: [], fadeOut: [] };
  const makeAction = (name) => ({
    name, running: false, plays: 0,
    isRunning() { return this.running; },
    reset() { return this; },
    play() { this.running = true; this.plays++; return this; },
    setEffectiveTimeScale() { return this; },
    setLoop() { return this; },
    crossFadeTo(target, fade) { calls.crossFade.push([name, target.name, fade]); return this; },
    fadeOut(f) { calls.fadeOut.push([name, f]); return this; },
  });
  const actions = {};
  for (const n of ['idle_breathe', 'idle_shift', 'think_chin', 'lean_type', 'talk_idle', 'nod']) actions[n] = makeAction(n);
  const mixer = { updated: 0, update(dt) { this.updated += dt; }, clipAction() { return makeAction('x'); }, stopAllAction() {}, uncacheRoot() {}, addEventListener() {} };
  const loader = { loadAsync: (url) => Promise.resolve({ userData: { vrmAnimations: [{ x: 1 }] } }) };
  return { THREE: { AnimationMixer: function () { return mixer; }, LoopOnce: 1, LoopRepeat: 2 }, vrm: { scene: {} }, baseClipFactory: () => ({}), loader, mixer, actions, calls };
}

test('idle → thinking crossfades from the idle clip to the think clip', () => {
  const env = fakeEnv();
  const machine = new AnimationState(env, manifest, '');
  for (const [n, a] of Object.entries(env.actions)) machine.actions.set(n, a);
  machine.setState('idle');
  assert.ok(manifest.states.idle.clips.includes(machine.current), 'idle starts on a breathing clip');
  assert.ok(env.actions[machine.current].isRunning(), 'the idle clip is playing');
  const fromIdle = machine.current;
  machine.setState('thinking');
  assert.equal(machine.current, 'think_chin', 'thinking plays the think clip');
  assert.deepEqual(env.calls.crossFade[0], [fromIdle, 'think_chin', manifest.crossfade], 'a crossfade runs from the idle clip to think');
  assert.ok(env.calls.fadeOut.length >= 1, 'the outgoing idle clip fades out');
});

test('a one-shot returns to the base loop when it finishes', () => {
  const env = fakeEnv();
  const machine = new AnimationState(env, manifest, '');
  for (const [n, a] of Object.entries(env.actions)) machine.actions.set(n, a);
  machine.setState('idle');
  const base = machine.current;
  machine.playOnce('nod', base);
  assert.equal(machine.current, 'nod', 'the one-shot is playing now');
  machine._onFinished({ action: machine.currentAction });
  assert.ok(env.calls.crossFade.some(([, to]) => to === base), 'it crossfades back to the base loop');
  assert.equal(machine.oneShotReturn, null, 'the return target is consumed');
});

test('a missing clip falls back to procedural without throwing', () => {
  const env = fakeEnv();
  const machine = new AnimationState(env, manifest, '');
  // Seed only some clips so a state whose clip is absent has nothing to play.
  machine.actions.set('idle_breathe', env.actions.idle_breathe);
  // A state with no loaded action: playClip must return undefined, not throw.
  assert.doesNotThrow(() => {
    const action = machine.playClip('does_not_exist');
    assert.equal(action, undefined, 'a missing clip resolves to undefined so the procedural layer owns the pose');
  });
  // update() must still advance the mixer either way.
  assert.doesNotThrow(() => machine.update(0.016));
});

test('a clip that fails to load drops only itself; the rest still load', async () => {
  const env = fakeEnv();
  const machine = new AnimationState(env, manifest, '');
  // The loader succeeds for every clip except one, which rejects.
  machine.env.loader.loadAsync = (url) => {
    const name = url.split('/').pop();
    return name === 'lean_type.vrma' ? Promise.reject(new Error('404')) : Promise.resolve({ userData: { vrmAnimations: [{ x: 1 }] } });
  };
  let warned = 0;
  const origWarn = console.warn; console.warn = () => { warned++; };
  try {
    await machine.loadAll(); // must not throw even though one clip failed
  } finally { console.warn = origWarn; }
  assert.ok(machine.actions.has('idle_breathe'), 'a healthy clip still loads');
  assert.ok(!machine.actions.has('lean_type'), 'the failed clip is dropped, not left half-built');
  assert.ok(warned >= 1, 'a failed clip logs a warning');
});

test('update forwards time to the mixer (drives the body)', () => {
  const env = fakeEnv();
  const machine = new AnimationState(env, manifest, '');
  machine.update(0.016);
  machine.update(0.033);
  assert.ok(Math.abs(env.mixer.updated - 0.049) < 1e-9, `mixer should advance by the summed dt, advanced ${env.mixer.updated}`);
});

test('re-setting the same state does not restart the clip (idempotent)', () => {
  const env = fakeEnv();
  const machine = new AnimationState(env, manifest, '');
  for (const [n, a] of Object.entries(env.actions)) machine.actions.set(n, a);
  machine.setState('writing');
  assert.equal(env.actions.lean_type.plays, 1, 'the first setState starts the clip');
  machine.setState('writing');
  assert.equal(env.actions.lean_type.plays, 1, 're-setting a running clip does not replay it');
});

// ---- character.js wiring: the procedural layer must stay additive -------------
test('character.js registers the VRMA plugin and builds the state machine', () => {
  const js = read(CHARACTER_JS);
  assert.match(js, /VRMAnimationLoaderPlugin/, 'the loader must register the VRMA plugin');
  assert.match(js, /AnimationState/, 'character.js must build the animation state machine');
  assert.match(js, /anims\.json/, 'the manifest must be loaded from anims.json');
});

test('character.js runs the mixer every frame and keeps the procedural layer additive', () => {
  const js = read(CHARACTER_JS);
  assert.match(js, /anim\.update\(dt\)/, 'the mixer must advance every frame');
  // The arms-down correction is a local-frame rotation MULTIPLIED on top of the
  // mixer pose (multiply, not assign) so a clip's arm motion survives it.
  assert.match(js, /pose\.lUA\.quaternion\.multiply\(AD\.lUA\)/, 'the left-arm rest correction must be additive (multiply)');
  assert.match(js, /pose\.rUA\.quaternion\.multiply\(AD\.rUA\)/, 'the right-arm rest correction must be additive (multiply)');
  // The procedural layer survives: blink, glance, happy→blush and lip-sync keep
  // running every frame on top of the mixer.
  assert.match(js, /ex\.setValue\('blink', bl\)/, 'blinking keeps running over the clips');
  assert.match(js, /if \(!this\.audio\) ex\.setValue\('aa', 0\)/, 'without audio the mouth stays closed (story 05); attachAudio drives lip-sync');
  assert.match(js, /bm\.opacity = blushA/, 'blush keeps tracking happy');
});

test('character.js drives the machine from setState and disposes it cleanly', () => {
  const js = read(CHARACTER_JS);
  assert.match(js, /this\.anim\.setState\(state\)/, 'a state change re-routes the animation');
  assert.match(js, /this\.anim\.dispose\(\)/, 'the machine is disposed when the VRM is destroyed');
});

test('anim.js is loaded before character.js in the page', () => {
  const html = read(path.join(ROOT, 'renderer', 'index.html'));
  const anim = html.indexOf('character/anim.js');
  const char = html.indexOf('character.js');
  assert.ok(anim > -1, 'anim.js must be included in index.html');
  assert.ok(anim < char, 'anim.js must load before character.js so LyraAnimation exists');
});
