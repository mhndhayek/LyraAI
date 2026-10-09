// Story 08: the 3D avatar's face colour is a measured spec, not a vibe.
// The skin must read #e1bda2 (10% darker, still warm), the face texture must
// carry the subtle base blush, and the renderer must deepen the blush when the
// 'happy' expression is on. The heavy checks (median colour, GLB integrity)
// shell out to the committed Python tools; the renderer checks read the source,
// the same way wiring.test.js does.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { ROOT } = require('../helpers/tmp');

const VRM = path.join(ROOT, 'renderer', 'character', 'vrm', 'lyra.vrm');
const TOOLS = path.join(ROOT, 'renderer', 'character', 'vrm', 'tools');
const CHARACTER_JS = path.join(ROOT, 'renderer', 'character.js');

const read = (p) => fs.readFileSync(p, 'utf8');
const run = (args) => execFileSync('python3', args, { encoding: 'utf8', timeout: 120000 });

test('the colour gate passes: median face skin is #e1bda2 within +/-3', () => {
  const out = run([path.join(TOOLS, 'measure.py'), VRM]);
  assert.match(out, /PASS/, `measure.py did not pass the gate:\n${out}`);
  const m = /median face skin #([0-9a-f]{6})/.exec(out);
  assert.ok(m, `measure.py printed no median:\n${out}`);
  const got = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  const target = [0xE1, 0xBD, 0xA2];
  got.forEach((g, i) => assert.ok(Math.abs(g - target[i]) <= 3, `channel ${i} is ${g}, target ${target[i]} +/- 3`));
});

test('the shipped VRM is still a healthy model: 15 expressions and the full rig', () => {
  const script = `
import struct, json, sys
data = open(sys.argv[1], 'rb').read()
off = 12; chunks = {}
while off < len(data):
    clen, ctype = struct.unpack_from('<II', data, off)
    chunks[ctype] = data[off+8:off+8+clen]; off += 8 + clen
g = json.loads(chunks[0x4E4F534A])
v = g['extensions']['VRM']
groups = len(v.get('blendShapeMaster', {}).get('blendShapeGroups', []))
joints = set()
for s in g.get('skins', []):
    for j in s['joints']: joints.add(j)
print(groups, len(joints))
`;
  const out = run(['-c', script, VRM]);
  const [groups, joints] = out.trim().split(/\s+/).map(Number);
  assert.equal(groups, 15, `the model must keep its 15 expressions, has ${groups}`);
  assert.ok(joints >= 50, `the model must keep its full rig (55 humanoid bones), has ${joints} joints`);
});

test('the face texture carries the base blush and the skin is not washed out', () => {
  // The blush check samples the cheek zones of the shipped face texture directly.
  const script = `
import struct, json, sys, io
import numpy as np
from PIL import Image
data = open(sys.argv[1], 'rb').read()
off = 12; chunks = {}
while off < len(data):
    clen, ctype = struct.unpack_from('<II', data, off)
    chunks[ctype] = data[off+8:off+8+clen]; off += 8 + clen
g = json.loads(chunks[0x4E4F534A]); b = chunks[0x004E4942]
name = 'F00_000_00_Face_00'
i = [k for k in range(len(g['images'])) if g['images'][k].get('name') == name][0]
img = g['images'][i]; bv = g['bufferViews'][img['bufferView']]
a = np.asarray(Image.open(io.BytesIO(b[bv['byteOffset']:bv['byteOffset']+bv['byteLength']])).convert('RGBA'), float) / 255
def pinkish(c): return (c[0] - max(c[1], c[2])) * 255
cheeks = [a[665, 355], a[665, 660]]
skin = a[450, 512]
print(pinkish(cheeks[0]), pinkish(cheeks[1]), pinkish(skin))
`;
  const [l, r, skinPink] = run(['-c', script, VRM]).trim().split(/\s+/).map(Number);
  // The cheeks must be visibly pinker than the plain forehead skin.
  assert.ok(Math.max(l, r) > skinPink + 6, `cheeks (pinkness ${l}/${r}) must read pinker than the skin (${skinPink})`);
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
