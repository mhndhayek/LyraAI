"""Shared colour science for the Lyra VRM paint pipeline (paint.py, repack_vrm.py).
Pure numpy/PIL. Story 08 added the skin darken + blush here so both entry points
apply exactly the same steps.
"""
import numpy as np
from PIL import Image, ImageDraw, ImageFilter


def s2l(c):
    c = np.asarray(c, float)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def l2s(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


def hex2(c):
    return np.array([int(c[i:i + 2], 16) / 255 for i in (1, 3, 5)])


def hsv(a):
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    mx, mn = a.max(-1), a.min(-1)
    d = mx - mn + 1e-9
    hh = np.where(mx == r, ((g - b) / d) % 6, np.where(mx == g, (b - r) / d + 2, (r - g) / d + 4)) * 60
    return hh, (mx - mn) / (mx + 1e-9), mx


def rgb2hsv(h, s, v):
    h = np.asarray(h, float) % 360 / 60
    s = np.asarray(s, float)
    v = np.asarray(v, float)
    i = h.astype(int) % 6
    f = h - h.astype(int)
    p = v * (1 - s)
    q = v * (1 - f * s)
    t = v * (1 - (1 - f) * s)
    r = np.select([i == 0, i == 1, i == 2, i == 3, i == 4, i == 5], [v, q, p, p, t, v])
    g = np.select([i == 0, i == 1, i == 2, i == 3, i == 4, i == 5], [t, v, v, q, p, p])
    b = np.select([i == 0, i == 1, i == 2, i == 3, i == 4, i == 5], [p, p, q, v, v, t])
    return np.stack([r, g, b], -1)


def feather(mm, r):
    """Gaussian feather of a 0/1 mask into a smooth 0..1 field (no hard seams)."""
    return np.asarray(Image.fromarray((mm * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(r)), float) / 255


# --- story 08: 10% darker skin, staying warm ---------------------------------
# value x0.785 / saturation x1.105 were calibrated against the shipped texture so
# tools/measure.py reports #e1bda2 +/- 3 on the shipped VRM (a plain RGB multiply
# reads greyish; the story's 0.90/1.08 was calibrated on a slightly lighter
# export, and the post-transform measurement shifts the mask). Applied to face
# AND body so neck and face match.
SKIN_VALUE_SCALE = 0.787
SKIN_SAT_SCALE = 1.125
SKIN_TARGET = '#e1bda2'  # story-08 goal: the masked skin median on face AND body
BLUSH: dict = {'color': '#ff7d9c', 'alpha': 0.16}  # subtle base, painted on the face texture
BROW_DARKEN = 0.80                          # brows a bit darker (deepen PAL.brow)


def skin_mask(a):
    """Feathered skin mask: warm hues, mid saturation, not too dark.
    The same mask is used by measure.py, so the QA gate measures what was painted."""
    hh, s, v = hsv(a[..., :3])
    return (a[..., 3] > 0.5) & ((hh < 45) | (hh > 340)) & (s > 0.12) & (s < 0.62) & (v > 0.25)


def dark_skin(rgb, mask=None, target=None):
    """Darken skin toward a target median, hue relationships preserved.

    Scales every skin pixel in linear RGB so the masked skin median lands on
    ``target`` (sRGB hex). Face and body start at different tones, so a fixed
    0.90/1.08 factor cannot match both to the same goal; deriving the scale
    from each texture's own measured median guarantees face and body land on
    the same tone. With no mask/target it falls back to the fixed story-08
    factors (value x0.787, saturation x1.125) for backwards compatibility."""
    rgb = np.asarray(rgb, float)
    if mask is None or target is None:
        hh, s, v = hsv(rgb)
        return rgb2hsv(hh, np.clip(s * SKIN_SAT_SCALE, 0, 1), v * SKIN_VALUE_SCALE)
    # rgb is linear; the target is sRGB, so convert before deriving the scale.
    med = np.median(rgb[mask], axis=0)
    tgt = s2l(hex2(target))
    scale = tgt / np.clip(med, 1e-6, None)
    return rgb * scale[None, None, :]


def paint_blush(im, rgb, mf):
    """Subtle radial blush on both cheeks, painted after the skin shift so the
    darkening never eats it. Cheek centres come from the face texture layout
    (eyes ~ (351,555)/(665,555), mouth line ~ y 765): soft ellipses on the flat
    skin below the eyes. Returns a new linear-RGB array with blush applied."""
    h, w = rgb.shape[:2]
    canvas = Image.new('L', (w, h), 0)
    d = ImageDraw.Draw(canvas)
    for cx in (355, 660):
        d.ellipse([cx - 58, 665 - 44, cx + 58, 665 + 44], fill=255)
    canvas = canvas.filter(ImageFilter.GaussianBlur(20))  # feathered edges, no seams
    t = np.asarray(canvas, float) / 255 * BLUSH['alpha'] * mf
    bc = s2l(hex2(BLUSH['color']))
    return rgb * (1 - t[..., None]) + bc * t[..., None]


def deepen_mouth(im):
    """The mouth texture is three flat blocks: white (closed mouth), maroon
    (interior) and a pink tongue blob. Nudge the tongue toward a deeper rose so
    the aa/oh lip-sync reads; the other blocks stay put. Returns RGBA 0..1."""
    hh, s, v = hsv(im[..., :3])
    tongue = (im[..., 3] > 0.05) & ((hh > 330) | (hh < 25)) & (s > 0.15) & (s < 0.45)
    rose = s2l(hex2('#c26a74'))
    lin = s2l(im[..., :3])
    lin = np.where(tongue[..., None], lin * 0.85 + (rose - lin) * 0.15, lin)
    out = im.copy()
    out[..., :3] = l2s(lin)
    return out
