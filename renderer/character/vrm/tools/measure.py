"""Print the median face-skin colour of the shipped lyra.vrm, the way the story
measured it: decode the face base-colour texture from the VRM (no Blender
needed), convert sRGB -> linear, mask skin by hue/saturation/value (feathered
thresholds), and take the median.

QA gate (story 08): the median must read #e1bda2 within +/-3 per channel.

Usage: python tools/measure.py [path-to-lyra.vrm]
Exit code 0 when the shipped file is inside the gate, 1 otherwise.
"""
import json
import struct
import sys

import numpy as np
from PIL import Image


def vrm_images(path):
    """Return {texture name: PNG bytes} for every image packed in the VRM."""
    data = open(path, 'rb').read()
    magic, version, length = struct.unpack_from('<III', data, 0)
    assert magic == 0x46546c67 and version == 2, 'not a glTF binary (VRM)'
    chunks = {}
    off = 12
    while off < len(data):
        clen, ctype = struct.unpack_from('<II', data, off)
        chunks[ctype] = data[off + 8:off + 8 + clen]
        off += 8 + clen
    gltf = json.loads(chunks[0x4E4F534A])
    bin_ = chunks[0x004E4942]
    out = {}
    for img in gltf.get('images', []):
        bv = gltf['bufferViews'][img['bufferView']]
        seg = bin_[bv['byteOffset']:bv['byteOffset'] + bv['byteLength']]
        out[img.get('name') or img['mimeType']] = seg
    return out


def s2l(c):
    c = np.asarray(c, float)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def l2s(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


def hsv(rgb):
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    mx, mn = rgb.max(-1), rgb.min(-1)
    d = mx - mn + 1e-9
    hh = np.where(mx == r, ((g - b) / d) % 6, np.where(mx == g, (b - r) / d + 2, (r - g) / d + 4)) * 60
    return hh, (mx - mn) / (mx + 1e-9), mx


def skin_mask(a):
    """Feathered skin mask, identical to the one in paint.py (see SKIN_DARKEN)."""
    hh, s, v = hsv(a[..., :3])
    return (a[..., 3] > 0.5) & ((hh < 45) | (hh > 340)) & (s > 0.12) & (s < 0.62) & (v > 0.25)


def median_skin_srgb(png_bytes):
    import io
    a = Image.open(io.BytesIO(png_bytes)).convert('RGBA')
    a = np.asarray(a, float) / 255
    m = skin_mask(a)
    lin = s2l(a[..., :3])[m]
    return l2s(np.median(lin, 0)), int(m.sum())


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else None
    if path is None:
        import os
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'lyra.vrm')
    images = vrm_images(path)
    name = 'F00_000_00_Face_00'
    if name not in images:
        print(f'{name}: not found in {path}', file=sys.stderr)
        return 1
    med, px = median_skin_srgb(images[name])
    got = tuple(int(round(c * 255)) for c in med)
    target = (0xE1, 0xBD, 0xA2)
    print(f'{name}: median face skin #{got[0]:02x}{got[1]:02x}{got[2]:02x} '
          f'(rgb {got}) over {px} skin pixels')
    ok = all(abs(g - t) <= 3 for g, t in zip(got, target))
    print(f'gate: target #{target[0]:02x}{target[1]:02x}{target[2]:02x} +/- 3 -> {"PASS" if ok else "FAIL"}')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
