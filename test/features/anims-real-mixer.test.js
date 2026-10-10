// Story 09 (QA gate 2, real-mixer half): drive the animation state machine
// against the REAL three.js mixer and the REAL .vrma clips on the real Lyra VRM,
// not mocks. The mocked tests in anims.test.js prove the routing logic; these
// tests prove the pose maths holds on the engine we ship.
//
// Why they exist: three's PropertyMixer only writes a track when its value
// changed. A clip that keeps the arms constant never re-writes them, so the
// per-frame arms-down multiply in character.js compounded ~70° per frame and
// her arms spun in writing/speaking. A one-shot that "returned" via a bare
// crossFadeTo faded the return clip in but never played it, so the body froze
// with every action at weight 0. Both held in the mocks, both broke on the real
// mixer.
//
// The vendored bundle (renderer/vendor/three-vrm.min.js) is the exact three.js
// + three-vrm stack the app ships, and it runs in plain Node — no `three`
// devDependency, no WebGL, no network: GLTFLoader.parse() reads the .vrm/.vrma
// bytes straight off disk.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('../helpers/tmp');

const BUNDLE = path.join(ROOT, 'renderer', 'vendor', 'three-vrm.min.js');
const VRM = path.join(ROOT, 'renderer', 'character', 'vrm', 'lyra.vrm');
const ANIMS_DIR = path.join(ROOT, 'renderer', 'character', 'anims');

// ---- load the vendored stack the way the app does --------------------------
globalThis.self = globalThis;
globalThis.window = globalThis;
if (typeof globalThis.URL === 'undefined') globalThis.URL = class {};
globalThis.Image = class { set src(v) { setTimeout(() => this.onload && this.onload(), 0); } };
// three's FileLoader expects the browser's ProgressEvent; give Node a stub.
if (typeof globalThis.ProgressEvent === 'undefined') globalThis.ProgressEvent = class ProgressEvent { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } };
const LyraVRM = (0, eval)(
  '(function(){' + fs.readFileSync(BUNDLE, 'utf8') + '; return window.LyraVRM;})()'
);
const THREE = LyraVRM.THREE;
require(path.join(ROOT, 'renderer', 'character', 'anim.js'));
const { AnimationState } = globalThis.LyraAnimation;

const loader = new LyraVRM.GLTFLoader();
loader.register((p) => new LyraVRM.VRMLoaderPlugin(p));
loader.register((p) => new LyraVRM.VRMAnimationLoaderPlugin(p));
function parseFile(p) {
  const buf = fs.readFileSync(p);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Promise((res, rej) => loader.parse(ab, '', res, rej));
}

let vrm, scene, manifest, anim;
let arm, AD;
const AD_BASE = {};
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _dir = new THREE.Vector3();

// World direction of the left upper arm (shoulder → elbow). The bug spins
// exactly this bone, so it is the most sensitive probe.
function uaDir() {
  scene.updateMatrixWorld(true);
  _a.copy(arm.lUA.getWorldPosition(_a));
  _b.copy(arm.lLA.getWorldPosition(_b));
  _dir.subVectors(_b, _a);
  return _dir.lengthSq() < 1e-9 ? null : _dir.normalize().clone();
}

// The exact per-frame order character.js uses: mixer, additive arms-down
// correction on all four arm bones, vrm.update, render, then undo the
// correction so the next frame's mixer writes onto the clip's own pose.
// `corrected=false` reproduces the buggy per-frame multiply with no undo.
const DT = 1 / 60;
function frame(corrected) {
  anim.update(DT);
  for (const k of ['lUA', 'rUA', 'lLA', 'rLA']) {
    AD_BASE[k].copy(arm[k].quaternion);
    arm[k].quaternion.multiply(AD[k]);
  }
  vrm.update(DT);
  // (renderer.render is a no-op for the pose)
  if (corrected) for (const k of ['lUA', 'rUA', 'lLA', 'rLA']) arm[k].quaternion.copy(AD_BASE[k]);
}

// Total per-frame travel of the upper-arm direction over `frames` frames: the
// sum of the angle the arm direction moves between consecutive frames. A clip's
// own motion shows up as a few hundred degrees over 10 s; a compounding
// correction shows up as tens of thousands (70° × 600 frames ≈ 42,000°).
function travel(state, frames, corrected) {
  anim.setState(state);
  let prev = null, total = 0;
  for (let i = 0; i < frames; i++) {
    frame(corrected);
    const d = uaDir();
    if (d && prev) total += prev.angleTo(d) * 180 / Math.PI;
    prev = d;
  }
  return total;
}

test('real mixer: the arms-down correction does not accumulate through every state', async () => {
  const vrmGltf = await parseFile(VRM);
  vrm = vrmGltf.userData.vrm;
  LyraVRM.VRMUtils.combineSkeletons(vrmGltf.scene);
  scene = vrmGltf.scene;
  manifest = JSON.parse(fs.readFileSync(path.join(ANIMS_DIR, 'anims.json'), 'utf8'));
  anim = new AnimationState({ THREE, loader, vrm, baseClipFactory: LyraVRM.createVRMAnimationClip }, manifest, '');
  // Load every clip through the real loader + retarget, with the manifest's loop mode.
  for (const name of Object.keys(manifest.clips)) {
    const g = await parseFile(path.join(ANIMS_DIR, manifest.clips[name].file));
    const va = (g.userData && g.userData.vrmAnimations) || [];
    assert.ok(va.length, `clip ${name} has a VRMA`);
    const action = anim.mixer.clipAction(LyraVRM.createVRMAnimationClip(va[0], vrm));
    action.setLoop(manifest.clips[name].loop === false ? THREE.LoopOnce : THREE.LoopRepeat, manifest.clips[name].loop === false ? 1 : Infinity);
    anim.actions.set(name, action);
  }
  const hum = vrm.humanoid;
  arm = {
    lUA: hum.getNormalizedBoneNode('leftUpperArm'), rUA: hum.getNormalizedBoneNode('rightUpperArm'),
    lLA: hum.getNormalizedBoneNode('leftLowerArm'), rLA: hum.getNormalizedBoneNode('rightLowerArm'),
  };
  for (const k of ['lUA', 'rUA', 'lLA', 'rLA']) AD_BASE[k] = new THREE.Quaternion();
  // The same rest correction character.js applies (left +1.22 / right −1.22 rad).
  AD = {
    lUA: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, 1.22)),
    rUA: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -1.22)),
    lLA: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, 0.12)),
    rLA: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -0.12)),
  };

  // 10 s per state, at 60 fps, with and without the per-frame undo.
  for (const state of ['idle', 'writing', 'speaking', 'thinking']) {
    const raw = travel(state, 600, false);
    const fixed = travel(state, 600, true);
    // With the undo, the arm's extra motion over the raw clip is bounded by the
    // correction's own size (~70°) applied a handful of times at the state
    // crossfade — nowhere near the clip's own travel, and nowhere near 70°/frame.
    assert.ok(fixed < raw + 500,
      `${state}: corrected arm travel ${fixed.toFixed(0)}° far exceeds the clip's own ` +
      `${raw.toFixed(0)}°. The arms-down correction is not being undone after render.`);
    // Direct regression for the bug as shipped: writing/speaking held the arms
    // constant, so the compounding multiply spun the arm ~70° every frame
    // (23,000–42,000° over 10 s). A few hundred is natural clip motion.
    assert.ok(fixed < 2000,
      `${state}: the left upper arm travelled ${fixed.toFixed(0)}° over 10 s — it is spinning, not resting.`);
  }
}, { timeout: 180000 });

test('real mixer: a one-shot ends on its return clip, not on a frozen body', async () => {
  // The clip set from the previous test is loaded on `anim`.
  anim.setState('idle');
  for (let i = 0; i < 120; i++) frame(true);
  anim.playOnce('nod', 'idle_breathe');
  // nod is ~1.25 s; run long enough for it to finish and the return crossfade
  // (0.35 s) to complete.
  for (let i = 0; i < 720; i++) frame(true);
  const back = anim.actions.get('idle_breathe');
  assert.ok(back.isRunning(), 'the return clip must be playing after the one-shot ends');
  assert.ok(back.getEffectiveWeight() > 0.99, `the return clip must be at full weight; it is ${back.getEffectiveWeight().toFixed(2)}`);
  assert.equal(anim.current, 'idle_breathe', 'the machine must remember it is back on the base loop');
  // And the body is not frozen: the pose keeps changing on the return clip.
  const before = uaDir();
  for (let i = 0; i < 60; i++) frame(true);
  const after = uaDir();
  assert.ok(before && after && before.angleTo(after) > 1e-4, 'the pose keeps changing on the return clip (no freeze)');
}, { timeout: 120000 });
