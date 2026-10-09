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
  // Extract the pure opacity mapping (and the BLUSH_MAX it multiplies by) and
  // assert its behaviour: 0 at rest, a gain of ~3x the painted base (0.16) at
  // full happy, clamped outside [0,1].
  const fn = new Function(`
    const src = ${JSON.stringify(js)};
    const max = /const BLUSH_MAX = ([\\d.]+)/.exec(src);
    if (!max) throw new Error('BLUSH_MAX constant not found');
    const BLUSH_MAX = Number(max[1]);
    const m = /const blushOpacity = \\((\\w+)\\) => (.+?);/.exec(src);
    if (!m) throw new Error('blushOpacity mapping not found');
    const blushOpacity = new Function(m[1], 'BLUSH_MAX', 'return ' + m[2]);
    return (h) => blushOpacity(h, BLUSH_MAX);
  `)();
  assert.equal(fn(0), 0, 'no blush at rest (happy = 0)');
  assert.ok(fn(1) >= 0.3, `full happy should reach ~3x the base blush (0.16), got ${fn(1)}`);
  assert.ok(fn(1) <= 0.5, `full happy blush should stay a tint, not a sticker, got ${fn(1)}`);
  assert.equal(fn(0.5), fn(1) / 2, 'the mapping should be linear in the happy value');
  assert.equal(fn(-2), 0, 'out-of-range low happy clamps to no blush');
  assert.equal(fn(5), fn(1), 'out-of-range high happy clamps to full blush');
});

test('the warm MToon shade is applied only to skin materials, including multi-material meshes', () => {
  const js = read(CHARACTER_JS);
  // Only the _SKIN materials (face + body) take the warm shade — hair, eyes,
  // cloth and the painted face overlays keep their own.
  assert.match(js, /matIsSkin\s*=\s*\(m\)\s*=>[^;]*\/_SKIN\/i/, 'the shade must be limited to the _SKIN materials');
  assert.match(js, /Array\.isArray\(o\.material\)\s*\?\s*o\.material\s*:\s*\[o\.material\]/, 'multi-material meshes (o.material arrays) must be walked, not skipped');
});

test('the renderer gives the face real light and warm shadows', () => {
  const js = read(CHARACTER_JS);
  assert.match(js, /DirectionalLight\(0xffffff, 2\.2\)/, 'the key light must be ~2.2, about 45° to the side');
  assert.match(js, /fill = new THREE\.DirectionalLight/, 'a weak fill is needed from the other side');
  assert.match(js, /rim = new THREE\.DirectionalLight/, 'a soft rim from behind keeps the hair edge readable');
  assert.match(js, /AmbientLight\(0xffffff, 0\.35\)/, 'the ambient must come down from 0.6');
  assert.match(js, /#c99a86/, 'the MToon shade colour must be a warm skin tone, not white');
});
