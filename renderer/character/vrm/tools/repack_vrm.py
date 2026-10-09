"""Swap painted textures back into lyra.vrm, the proven fallback for story 08
(when texA/texB from the Blender export are not available): decode the GLB
images, apply the paint.py steps, and re-pack. The mesh, rig, spring bones,
expressions and the embedded licence are untouched.

Usage:
  python tools/paint.py pinkblue            # writes out_pinkblue/*.png
  python tools/repack_vrm.py [lyra.vrm] [out_pinkblue] [lyra.vrm]

Only the textures that exist in the output folder are replaced; every other
packed image (nml, spe, matcaps, thumbnail, hair, outfit) keeps its exact bytes.
"""
import io
import json
import os
import struct
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import s2l, l2s, skin_mask, dark_skin, paint_blush, feather, BROW_DARKEN, deepen_mouth, SKIN_TARGET

VRM_IN = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'lyra.vrm')
VRM_OUT = sys.argv[2] if len(sys.argv) > 2 else VRM_IN


def read_glb(path):
    data = open(path, 'rb').read()
    magic, version, length = struct.unpack_from('<III', data, 0)
    assert magic == 0x46546c67 and version == 2, 'not a glTF binary (VRM)'
    chunks = {}
    off = 12
    while off < len(data):
        clen, ctype = struct.unpack_from('<II', data, off)
        chunks[ctype] = data[off + 8:off + 8 + clen]
        off += 8 + clen
    return json.loads(chunks[0x4E4F534A]), chunks[0x004E4942]


def write_glb(path, gltf, bin_):
    js = json.dumps(gltf, separators=(',', ':')).encode('utf8')
    pad = (-len(js)) % 4
    js += b' ' * pad  # glTF JSON chunk is padded with spaces
    out = struct.pack('<III', 0x46546c67, 2, 12 + 8 + len(js) + 8 + len(bin_))
    out += struct.pack('<II', len(js), 0x4E4F534A) + js
    out += struct.pack('<II', len(bin_), 0x004E4942) + bin_
    open(path, 'wb').write(out)


gltf, bin_ = read_glb(VRM_IN)


def decode(i):
    img = gltf['images'][i]
    bv = gltf['bufferViews'][img['bufferView']]
    seg = bin_[bv['byteOffset']:bv['byteOffset'] + bv['byteLength']]
    return np.asarray(Image.open(io.BytesIO(seg)).convert('RGBA'), float) / 255


def encode(a, i):
    png = Image.fromarray((np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8), 'RGBA')
    buf = io.BytesIO()
    png.save(buf, format='PNG')
    return buf.getvalue()


# Which image indices hold the textures we repaint?
names = {i: gltf['images'][i].get('name', '') for i in range(len(gltf['images']))}
idx = {v: k for k, v in names.items()}
FACE = 'F00_000_00_Face_00'
BODY = 'F00_000_00_Body_00'
BROW = 'F00_000_00_FaceBrow_00'
MOUTH = 'F00_000_00_FaceMouth_00'
for n in (FACE, BODY, BROW, MOUTH):
    if n not in idx:
        sys.exit(f'{n} not found in {VRM_IN}')

replacements = {}

# ---------- face: skin shift + blush (dark_skin works in linear RGB) ----------
face = decode(idx[FACE])
m = skin_mask(face)
mf = feather(m, 1.2)
face_lin = s2l(face[..., :3])
new = face_lin * (1 - mf[..., None]) + dark_skin(face_lin, m, SKIN_TARGET) * mf[..., None]
new = paint_blush(face, new, mf)
out = face.copy(); out[..., :3] = l2s(new)
replacements[idx[FACE]] = encode(out, idx[FACE])
print(FACE, 'skin px', int(m.sum()))

# ---------- body: same skin shift, no blush (face and neck must match) ----------
body = decode(idx[BODY])
m = skin_mask(body)
mf = feather(m, 1.2)
body_lin = s2l(body[..., :3])
new = body_lin * (1 - mf[..., None]) + dark_skin(body_lin, m, SKIN_TARGET) * mf[..., None]
out = body.copy(); out[..., :3] = l2s(new)
replacements[idx[BODY]] = encode(out, idx[BODY])
print(BODY, 'skin px', int(m.sum()))

# ---------- brows a touch darker ----------
br = decode(idx[BROW])
brow_lin = s2l(br[..., :3]) * BROW_DARKEN
out = br.copy(); out[..., :3] = l2s(brow_lin)
replacements[idx[BROW]] = encode(out, idx[BROW])
print(BROW, 'darkened x', BROW_DARKEN)

# ---------- mouth tongue toward a deeper rose ----------
out = deepen_mouth(decode(idx[MOUTH]))
replacements[idx[MOUTH]] = encode(out, idx[MOUTH])
print(MOUTH, 'deepened')

# ---------- re-pack: rewrite only the images that changed ----------
# Each replaced image becomes a standalone bufferView (aligned to 4) appended
# to the BIN chunk; the JSON bufferView entries are rewritten to match.
bin2 = bytearray(bin_)
for i, png in replacements.items():
    img = gltf['images'][i]
    old = gltf['bufferViews'][img['bufferView']]
    if 'byteStride' in old:
        sys.exit(f'image {i} has a byteStride; it cannot be replaced standalone')
    align = (-len(bin2)) % 4
    if align:
        bin2 += b'\x00' * align
    gltf['bufferViews'][img['bufferView']] = {
        'buffer': 0, 'byteOffset': len(bin2), 'byteLength': len(png)}
    bin2 += png
    print(f'image {i} ({names[i]}): {old["byteLength"]} -> {len(png)} bytes')

write_glb(VRM_OUT, gltf, bytes(bin2))
print('WROTE', VRM_OUT, os.path.getsize(VRM_OUT))
