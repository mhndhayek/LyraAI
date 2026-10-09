// Story 08: the 3D avatar's face colour is a measured spec, not a vibe.
// The skin must read #e1bda2 (10% darker, still warm), the face texture must
// carry the subtle base blush, and the renderer must deepen the blush when the
// 'happy' expression is on. The VRM checks decode the file in pure Node (the
// same maths as tools/measure.py, the committed Blender-free QA gate) so CI's
// Node-only runners need no Python; the renderer checks read the source, the
// way wiring.test.js does.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('../helpers/tmp');
const { vrmGltf, vrmImages, pngToRgba, measureFaceSkin } = require('../helpers/vrm-color');

const VRM = path.join(ROOT, 'renderer', 'character', 'vrm', 'lyra.vrm');
const CHARACTER_JS = path.join(ROOT, 'renderer', 'character.js');

const read = (p) => fs.readFileSync(p, 'utf8');
const vrmBuf = () => fs.readFileSync(VRM);
// A pixel (x, y) of a decoded RGBA texture.
const px = (rgba, x, y) => {
  const i = (y * rgba.width + x) * 4;
  return [rgba.data[i], rgba.data[i + 1], rgba.data[i + 2], rgba.data[i + 3]];
};
const faceTex = () => pngToRgba(vrmImages(vrmBuf())['F00_000_00_Face_00']);

test('the colour gate passes: median face skin is #e1bda2 within +/-3', () => {
  const r = measureFaceSkin(VRM);
  assert.ok(r.pixels > 50000, `too few skin pixels measured (${r.pixels}) — the face texture is wrong`);
  assert.ok(r.pass, `median face skin is ${r.hex} (rgb ${r.rgb}), target #e1bda2 within +/-3`);
});

test('the shipped VRM is still a healthy model: 15 expressions and the full rig', () => {
  const g = vrmGltf(vrmBuf());
  const v = g.extensions.VRM;
  const groups = (v.blendShapeMaster?.blendShapeGroups || []).length;
  const joints = new Set();
  for (const s of g.skins || []) for (const j of s.joints) joints.add(j);
  assert.equal(groups, 15, `the model must keep its 15 expressions, has ${groups}`);
  assert.ok(joints.size >= 50, `the model must keep its full rig (55 humanoid bones), has ${joints.size} joints`);
});

test('the face texture carries the base blush and the skin is not washed out', () => {
  const face = faceTex();
  const pinkish = ([r, g, b]) => (r - Math.max(g, b)) * 255;
  const cheekL = px(face, 355, 665);
  const cheekR = px(face, 660, 665);
  const skin = px(face, 512, 450); // plain forehead, away from the cheeks
  // The cheeks must be visibly pinker than the plain skin, and the skin itself
  // must be a saturated warm tan, not a washed-out grey.
  assert.ok(Math.max(pinkish(cheekL), pinkish(cheekR)) > pinkish(skin) + 6,
    `cheeks (pinkness ${pinkish(cheekL)}/${pinkish(cheekR)}) must read pinker than the skin (${pinkish(skin)})`);
  const [sr, sg, sb] = skin;
  assert.ok(sr > sg && sg > sb, `the skin should be warm (R>G>B), got rgb ${sr},${sg},${sb}`);
  assert.ok(sr - sb > 40, `the skin should be a saturated tan, not grey, got rgb ${sr},${sg},${sb}`);
});

test('the renderer deepens the blush as the happy expression rises', () => {
  const js = read(CHARACTER_JS);
  // The overlay opacity is driven by the live 'happy' value...
  assert.match(js, /ex\.getValue\('happy'\)/, 'the blush must read the happy expression at runtime');
  // ...and applied to the blush overlay material.
  assert.match(js, /blushMats\.push\(mat\)/, 'the renderer must build the blush overlay');
  assert.match(js, /bm\.opacity = blushA/, 'the blush opacity must follow happy');
  // Full happy must reach roughly 3x the painted base (base alpha 0.16 in tools/common.py, overlay up to 0.45).
  const m = /blushA = Math\.min\(1, ex\.getValue\('happy'\)\) \* ([\d.]+)/.exec(js);
  assert.ok(m, 'the blush gain constant is missing');
  assert.ok(Number(m[1]) >= 0.3, `full happy should reach ~3x the base blush, gain is ${m[1]}`);
});

test('the renderer gives the face real light and warm shadows', () => {
  const js = read(CHARACTER_JS);
  assert.match(js, /DirectionalLight\(0xffffff, 2\.2\)/, 'the key light must be ~2.2, about 45° to the side');
  assert.match(js, /fill = new THREE\.DirectionalLight/, 'a weak fill is needed from the other side');
  assert.match(js, /rim = new THREE\.DirectionalLight/, 'a soft rim from behind keeps the hair edge readable');
  assert.match(js, /AmbientLight\(0xffffff, 0\.35\)/, 'the ambient must come down from 0.6');
  assert.match(js, /#c99a86/, 'the MToon shade colour must be a warm skin tone, not white');
});
