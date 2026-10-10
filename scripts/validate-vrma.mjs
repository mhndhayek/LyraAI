// Validate every .vrma against the real Lyra VRM: load with the exact three-vrm
// stack the app uses, retarget to Lyra's humanoid, and report the clip duration.
// A zero/negative duration means the clip is empty and would do nothing.
import { readFileSync, readdirSync } from 'fs';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from '@pixiv/three-vrm-animation';

// three's GLTFLoader is written for the browser; give Node the globals it expects.
globalThis.self = globalThis;
globalThis.URL = globalThis.URL || class {};
globalThis.Image = class { set src(v) { setTimeout(() => this.onload && this.onload(), 0); } };

const VRM = 'renderer/character/vrm/lyra.vrm';
const ANIMS = 'renderer/character/anims';

const loader = new GLTFLoader();
loader.register((p) => new VRMLoaderPlugin(p));
loader.register((p) => new VRMAnimationLoaderPlugin(p));

async function load(path) {
  const buf = readFileSync(path);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Promise((res, rej) => loader.parse(ab, '', res, rej));
}

const vrmGltf = await load(VRM);
const vrm = vrmGltf.userData.vrm;
VRMUtils.combineSkeletons(vrmGltf.scene);

let ok = 0, total = 0;
for (const f of readdirSync(ANIMS).sort()) {
  if (!f.endsWith('.vrma')) continue;
  total++;
  try {
    const g = await load(`${ANIMS}/${f}`);
    const anims = g.userData.vrmAnimations || [];
    if (!anims.length) { console.log(`${f}: NO vrmAnimations in userData`); continue; }
    const clip = createVRMAnimationClip(anims[0], vrm);
    const d = clip ? clip.duration : 0;
    const ntracks = clip ? clip.tracks.length : 0;
    if (d > 0 && ntracks > 0) { ok++; console.log(`${f}: OK  duration=${d.toFixed(2)}s  tracks=${ntracks}`); }
    else { console.log(`${f}: EMPTY  duration=${d}s tracks=${ntracks}`); }
  } catch (e) {
    console.log(`${f}: ERROR ${e.message}`);
  }
}
console.log(`\n${ok}/${total} clips retarget to a non-empty AnimationClip on Lyra`);
process.exit(ok === total ? 0 : 1);
