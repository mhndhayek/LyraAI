"""Recolour AvatarSample_B textures into Lyra variants. Pure numpy/PIL on the extracted PNGs.
Usage: python paint.py <variant> ; writes out_<variant>/*.png (only changed textures)
"""
import sys, os, colorsys
import numpy as np
from PIL import Image
import common
from common import s2l, l2s, hex2, hsv, skin_mask, dark_skin, paint_blush, feather, BROW_DARKEN, deepen_mouth

V = sys.argv[1]
SRC, A = 'texB', 'texA'
OUT = f'out_{V}'; os.makedirs(OUT, exist_ok=True)

def load(d, n): return np.asarray(Image.open(f'{d}/{n}.png').convert('RGBA'), float) / 255
def save(a, n): Image.fromarray((np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8), 'RGBA').save(f'{OUT}/{n}.png')

PAL = {
    # root -> mid -> tip, streak colour (on the purple base), accent lock colour (Hair_05)
    'pinkblue': dict(root='#ff5fb4', mid='#ff8fd0', tip='#3fb6ff', streak='#5ad2ff', lock='#ff4fa8', brow='#c2407f'),
    'goldblue': dict(root='#ffb51f', mid='#ffd54f', tip='#3f9bff', streak='#4fc8ff', lock='#ffbf2a', brow='#b5822a'),
}[V]
P = {k: s2l(hex2(v)) for k, v in PAL.items()}

def lum(rgb): return rgb @ np.array([0.2126, 0.7152, 0.0722])

def ramp(t):
    """t: 0 at root (image top) .. 1 at tip. Root colour holds, then blends to tip over the lower half.
    A pale bridge colour sits between mid and tip so gold+blue never mixes to khaki."""
    t = np.clip(t, 0, 1)[..., None]
    a = np.clip((t - 0.0) / 0.45, 0, 1); b = np.clip((t - 0.45) / 0.4, 0, 1)
    a = a * a * (3 - 2 * a); b = b * b * (3 - 2 * b)
    c1 = P['root'] * (1 - a) + P['mid'] * a
    bridge = s2l(np.array([0.93, 0.97, 1.0]))
    w = (1 - abs(b - 0.5) * 2) * 0.55
    return (c1 * (1 - b) + P['tip'] * b) * (1 - w) + bridge * w

def recolour_strip(name, streaks=True, ramp_fn=ramp, flat=None):
    im = load(SRC, name); h, w = im.shape[:2]
    rgb = s2l(im[..., :3]); L = lum(rgb)
    ref = np.percentile(L[im[..., 3] > 0.5], 70)
    shade = np.clip(L / max(ref, 1e-4), 0.35, 1.25)[..., None] ** 0.8  # keep painted strand shading
    yy, xx = np.mgrid[0:h, 0:w]
    col = ramp_fn(yy / (h - 1)) if flat is None else np.broadcast_to(flat, rgb.shape)
    new = col * shade
    if streaks:
        rng = np.random.default_rng(7)
        # sparse, uneven columns that wrap in U, starting below the crown, tapering
        cs = np.sort(rng.uniform(0, w, 7)); ws = rng.uniform(4, 13, 7) * w / 512
        m = np.zeros((h, w))
        for c, wd in zip(cs, ws):
            d = np.minimum(abs(xx - c), w - abs(xx - c))
            m = np.maximum(m, np.clip(1 - d / wd, 0, 1) ** 0.7)
        t = yy / (h - 1)
        m *= np.clip((t - 0.18) / 0.15, 0, 1) * np.clip((0.95 - t) / 0.2, 0, 1) * 0.8
        new = new * (1 - m[..., None]) + P['streak'] * shade * m[..., None]
    out = im.copy(); out[..., :3] = l2s(new)
    save(out, name); return out

def region_recolour(name, mask, colour_fn):
    im = load(SRC, name); rgb = s2l(im[..., :3]); L = lum(rgb)
    ref = np.percentile(L[mask], 70) if mask.any() else 1
    shade = np.clip(L / max(ref, 1e-4), 0.35, 1.25)[..., None] ** 0.8
    new = np.where(mask[..., None], colour_fn(im.shape[:2]) * shade, rgb)
    out = im.copy(); out[..., :3] = l2s(new); return out

def purple_mask(a):  # B's indigo/purple hair paint
    hh, s, v = hsv(a[..., :3])
    return (a[..., 3] > 0.05) & (hh > 225) & (hh < 300) & (s > 0.12)

# ---------- hair ----------
recolour_strip('F00_000_Hair_00_02')               # 90% of the hair
# short top locks (bangs, crown) get their own copy: root -> mid only, no blue at eye level
def ramp_short(t):
    t = np.clip(t, 0, 1)[..., None]; a = np.clip(t / 0.8, 0, 1); a = a * a * (3 - 2 * a)
    return P['root'] * (1 - a) + P['mid'] * a
_save = save
def save(a, n): _save(a, n + '_short' if n == 'F00_000_Hair_00_02' and SHORT else n)
SHORT = True; recolour_strip('F00_000_Hair_00_02', ramp_fn=ramp_short); SHORT = False
recolour_strip('F00_000_Hair_00_01', ramp_fn=ramp_short)   # front strand cards = the bangs: no blue at eye level
recolour_strip('F00_000_Hair_00_03', streaks=False)
recolour_strip('F00_000_Hair_00_05', streaks=False, flat=P['lock'])   # the cyan locks become the contrast colour

# ---------- skin: B -> A's tone ----------
a_face = load(A, 'F00_000_00_Face_00')
sa = s2l(a_face[..., :3])[skin_mask(a_face)]
A_tone = np.median(sa, 0)
b_face = load(SRC, 'F00_000_00_Face_00')
B_tone = np.median(s2l(b_face[..., :3])[skin_mask(b_face)], 0)
gain = A_tone / B_tone
print('A tone', l2s(A_tone).round(3), 'B tone', l2s(B_tone).round(3), 'gain', gain.round(3))

def fix_skin(name, hair_cap=True):
    im = load(SRC, name); rgb = s2l(im[..., :3])
    m = skin_mask(im)
    # A and B share VRoid's UV layout: where both are bare skin, take A's own painted
    # skin (its lighter, pinker shading); elsewhere fall back to a per-channel gain.
    a = load(A, name); am = skin_mask(a) & (a[..., :3].max(-1) > 0.85)   # bare light skin only, not A's sheer tights
    mf = feather(m, 1.2)
    both = feather(m & am, 1.5)[..., None]
    skin = np.clip(rgb * gain, 0, 1) * (1 - both) + s2l(a[..., :3]) * both
    # story 08: the same feathered mask carries the 10% darken + saturation lift,
    # so only skin moves and hair, eyes and outfit keep their colour.
    skin = skin * (1 - mf[..., None]) + dark_skin(skin) * mf[..., None]
    new = rgb * (1 - mf[..., None]) + skin * mf[..., None]
    if name == 'F00_000_00_Face_00':
        new = paint_blush(im, new, mf)  # blush goes on top of the darkened skin
    if hair_cap:  # indigo hair painted on the scalp / back of head -> root colour
        pm = purple_mask(im) & ~m
        L = lum(rgb); ref = np.percentile(L[pm], 70) if pm.any() else 1
        sh = np.clip(L / max(ref, 1e-4), 0.35, 1.25)[..., None] ** 0.8
        new = np.where(pm[..., None], P['root'] * sh, new)
    out = im.copy(); out[..., :3] = l2s(new); save(out, name)
    print(name, 'skin px', int(m.sum()), 'cap px', int((purple_mask(im) & ~m).sum()) if hair_cap else 0)

fix_skin('F00_000_00_Face_00')
fix_skin('F00_000_00_Body_00')

# ---------- brows to match ----------
br = load(SRC, 'F00_000_00_FaceBrow_00'); m = br[..., 3] > 0.02
brow = region_recolour('F00_000_00_FaceBrow_00', m, lambda s: P['brow'])
brow[..., :3] = l2s(s2l(brow[..., :3]) * BROW_DARKEN)   # story 08: brows a touch darker
save(brow, 'F00_000_00_FaceBrow_00')

# ---------- mouth: deeper so aa/oh lip sync reads ----------
out = deepen_mouth(load(SRC, 'F00_000_00_FaceMouth_00'))
save(out, 'F00_000_00_FaceMouth_00')
print('done', V)
