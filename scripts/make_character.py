#!/usr/bin/env python3
"""Lyra character pipeline: draft a portrait, generate animation frames by inpainting,
and assemble a transparent GIF pack the app can use as a live character.

Requirements (be honest with the user about these):
  - A SwarmUI server reachable over HTTP (Settings › Image generation shows the URL).
    ComfyUI is not supported by this script; SwarmUI's /API is used for inpainting.
  - The model `ZImage/SwarmUI_Z-Image-Turbo-FP8Mix.safetensors` (or any model the
    server lists); Z-Image-Turbo does clean 16-bit pixel art in ~4 s per frame.
  - Python with Pillow and numpy. Lyra's voice environment has both:
    voice/.venv/bin/python (or run: uv pip install --python <python> pillow numpy).

Usage:
  make_character.py draft   --server URL --out DIR --id fox --desc "a fox girl…" [--n 3]
  make_character.py frames  --server URL --spec spec.json --base base.png --out DIR
  make_character.py assemble --spec spec.json --frames DIR --out renderer/character/<id>
See docs/AVATARS.md for the spec format and the full recipe.
"""
import argparse, base64, json, math, os, random, sys, urllib.request

STYLE = '16-bit SNES pixel art, clean dithering, chunky pixels, flat deep purple background, centered bust portrait, game character portrait, cute chibi proportions'
MODEL = 'ZImage/SwarmUI_Z-Image-Turbo-FP8Mix.safetensors'
NEG = 'blurry, photo, realistic, 3d render, text, watermark, extra limbs, deformed, different character'


def post(url, payload):
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers={'content-type': 'application/json'})
    with urllib.request.urlopen(req, timeout=600) as r:
        return json.loads(r.read().decode())


def session(server):
    return post(f'{server.rstrip("/")}/API/GetNewSession', {})['session_id']


def fetch_image(server, ref):
    if ref.startswith('data:'):
        return base64.b64decode(ref.split(',', 1)[1])
    with urllib.request.urlopen(f'{server.rstrip("/")}/{ref.lstrip("/")}', timeout=120) as r:
        return r.read()


def generate(server, sid, prompt, *, model=MODEL, width=768, height=768, init=None, mask=None, creativity=0.95, seed=-1, negative=NEG):
    body = {'session_id': sid, 'images': 1, 'prompt': prompt, 'negativeprompt': negative, 'model': model, 'width': width, 'height': height, 'steps': 8, 'cfgscale': 1, 'seed': seed}
    if init is not None:
        body['initimage'] = base64.b64encode(init).decode(); body['initimagecreativity'] = creativity
    if mask is not None:
        body['maskimage'] = base64.b64encode(mask).decode(); body['maskblur'] = 4
    d = post(f'{server.rstrip("/")}/API/GenerateText2Image', body)
    if d.get('error'):
        raise RuntimeError(d['error'])
    return fetch_image(server, d['images'][0])


def cmd_draft(a):
    os.makedirs(a.out, exist_ok=True); sid = session(a.server)
    for i in range(1, a.n + 1):
        png = generate(a.server, sid, f'{STYLE}, {a.desc}', model=a.model)
        p = os.path.join(a.out, f'{a.id}-{i}.png'); open(p, 'wb').write(png); print(p)


def cmd_frames(a):
    from PIL import Image, ImageDraw
    spec = json.load(open(a.spec)); os.makedirs(a.out, exist_ok=True); sid = session(a.server)
    base = Image.open(a.base).convert('RGB'); bg = base.getpixel((4, 4))
    canvas = Image.new('RGB', (768, 1024), bg); canvas.paste(base, (0, 0))
    import io
    def png_bytes(im):
        b = io.BytesIO(); im.save(b, 'PNG'); return b.getvalue()
    for name, boxes in spec['masks'].items():
        tall = name == 'type' and boxes[0][3] > 768
        m = Image.new('L', (768, 1024 if tall else 768), 0); d = ImageDraw.Draw(m)
        for b in boxes: d.rectangle(b, fill=255)
        m.save(os.path.join(a.out, f'mask-{name}.png'))
    for job, mask, desc, n in spec['jobs']:
        tall = job == 'type' and spec['masks']['type'][0][3] > 768
        for i in range(1, n + 1):
            png = generate(a.server, sid, f"{spec['style']}, {desc}", model=a.model, height=1024 if tall else 768, init=png_bytes(canvas if tall else base), mask=open(os.path.join(a.out, f'mask-{mask}.png'), 'rb').read())
            p = os.path.join(a.out, f'{job}-{i}.png'); open(p, 'wb').write(png); print(p)


def key(path, centre=(384, 420)):
    from PIL import Image, ImageDraw
    import numpy as np
    im = Image.open(path).convert('RGBA'); w, h = im.size
    rgb = im.convert('RGB').copy(); SENT = (255, 0, 255)
    for xy in [(2, 2), (w - 3, 2), (2, h - 3), (w - 3, h - 3), (w // 2, 2), (2, h // 2), (w - 3, h // 2)]:
        if rgb.getpixel(xy) != SENT: ImageDraw.floodfill(rgb, xy, SENT, thresh=60)
    arr = np.array(rgb); alpha = np.where(np.all(arr == SENT, axis=2), 0, 255).astype('uint8')
    am = Image.fromarray(alpha, 'L').convert('RGB'); ImageDraw.floodfill(am, centre, (0, 255, 0), thresh=10)
    body = np.all(np.array(am) == (0, 255, 0), axis=2); out = np.array(im); out[:, :, 3] = np.where(body, 255, 0)
    return out


def cmd_assemble(a):
    from PIL import Image, ImageDraw
    import numpy as np
    spec = json.load(open(a.spec)); P = spec['pack']; F = a.frames; OUT = a.out; os.makedirs(OUT, exist_ok=True)
    random.seed(7)
    def load(name):
        p = P['frames'][name]; return key(os.path.join(F, p) if not os.path.isabs(p) else p, tuple(P.get('centre', (384, 420))))
    bust = {k: load(k) for k in P['frames'] if k != 'type'}
    S = 256
    ys, xs = np.where(np.any([v[:, :, 3] > 0 for v in bust.values()], axis=0)); m = 24
    box = (max(0, xs.min() - m), max(0, ys.min() - m), min(768, xs.max() + m), min(768, ys.max() + m))
    fr = {}
    for k, v in bust.items():
        im = Image.fromarray(v, 'RGBA').crop(box); fr[k] = im.resize((S, int(S * im.height / im.width)), Image.NEAREST)
    W, H = fr['base'].size; CH = H + 16
    def place(img, dy=0, extra=None):
        c = Image.new('RGBA', (W, CH), (0, 0, 0, 0)); c.alpha_composite(img, (0, 8 + int(dy)))
        if extra: extra(c)
        return c
    def bob(i, n, amp=3): return -amp * (0.5 - 0.5 * math.cos(2 * math.pi * i / n))
    def dots(step):
        def draw(c):
            d = ImageDraw.Draw(c); pts = [(W - 52, 26, 6), (W - 38, 14, 8), (W - 20, 0, 10)]
            for x, y, r in pts[:step]: d.ellipse((x, y, x + r * 2, y + r * 2), fill=(220, 205, 255, 255), outline=(90, 60, 140, 255))
        return draw
    def hearts(i):
        def draw(c):
            d = ImageDraw.Draw(c)
            for k in range(2):
                t = (i + k * 5) % 10; x = W - 40 + k * 18; y = 40 - t * 4
                d.polygon([(x, y + 3), (x + 3, y), (x + 6, y + 3), (x + 3, y + 7)], fill=(255, 105, 160, 255))
        return draw
    def waves(i):
        def draw(c):
            d = ImageDraw.Draw(c)
            for k in range(1 + i % 3): r = 10 + k * 8; d.arc((W - 30 - r, 30 - r, W - 30 + r, 30 + r), 300, 60, fill=(79, 200, 180, 255), width=2)
        return draw
    def save(name, frames, dur):
        pal = []
        for f in frames:
            rgb = f.convert('RGB').quantize(colors=255, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
            arr = np.array(rgb); alpha = np.array(f)[:, :, 3]; arr[alpha == 0] = 255
            p = Image.fromarray(arr.astype('uint8'), 'P'); pl = rgb.getpalette(); p.putpalette(pl + [0, 0, 0] * (256 - len(pl) // 3)); pal.append(p)
        pal[0].save(os.path.join(OUT, name), save_all=True, append_images=pal[1:], duration=dur, loop=0, disposal=2, transparency=255, optimize=False); print(name, len(frames))
    blink = fr.get('blink'); N = 48; blinks = {14, 15, 38, 39, 40}
    save('idle.gif', [place(blink if (blink is not None and i in blinks) else fr['base'], bob(i, N)) for i in range(N)], 83)
    g = P.get('gesture', [])
    if g: save('idle-2.gif', [place(fr[g[(i // 6) % len(g)]], bob(i, 12, 4)) for i in range(24)] + [place(fr['base'], bob(i, 12)) for i in range(12)], 83)
    if 'talk_a' in fr: save('idle-3.gif', [place(fr[{0: 'base', 1: 'talk_c' if 'talk_c' in fr else 'talk_a', 2: 'base', 3: 'talk_a'}[(i // 6) % 4]], bob(i, 48, 2)) for i in range(48)], 83)
    g4 = P.get('gesture2', [])
    if g4: save('idle-4.gif', [place(fr[g4[(i // 8) % len(g4)]], bob(i, 16, 3)) for i in range(32)] + [place(fr['base'], bob(i, 12)) for i in range(12)], 83)
    th = P.get('think', ['base']); save('thinking.gif', [place(fr[th[(i // 18) % len(th)]], bob(i, 36, 2), dots(min(3, 1 + i // 12))) for i in range(36)], 83)
    if 'talk_a' in fr:
        cyc = {0: 'base', 1: 'talk_a', 2: 'talk_b' if 'talk_b' in fr else 'talk_a', 3: 'talk_a', 4: 'base', 5: 'talk_c' if 'talk_c' in fr else 'talk_a', 6: 'talk_b' if 'talk_b' in fr else 'talk_a', 7: 'talk_c' if 'talk_c' in fr else 'talk_a'}
        fx = hearts if P.get('speakFx') == 'hearts' else None
        save('speaking.gif', [place(fr[cyc[i % 8]], bob(i, 16, 2), fx(i) if fx else None) for i in range(16)], 110)
    else:
        save('speaking.gif', [place(fr['base'], bob(i, 16, 2), waves(i)) for i in range(16)], 110)
    tp = P['frames'].get('type')
    if tp:
        typ = key(os.path.join(F, tp), tuple(P.get('centre', (384, 420)))); t = Image.fromarray(typ, 'RGBA'); ys, xs = np.where(typ[:, :, 3] > 0)
        tb = (max(0, xs.min() - m), max(0, ys.min() - m), min(t.width, xs.max() + m), min(t.height, ys.max() + m)); t = t.crop(tb)
        TW = 256; t = t.resize((TW, int(TW * t.height / t.width)), Image.NEAREST); TH = t.height + 16
        hy0, hy1 = int(t.height * P.get('handsY', [0.60, 0.70])[0]), int(t.height * P.get('handsY', [0.60, 0.70])[1]); hx0, hx1 = int(t.width * 0.28), int(t.width * 0.72)
        def typing(i):
            c = Image.new('RGBA', (TW, TH), (0, 0, 0, 0)); c.alpha_composite(t, (0, 8)); band = t.crop((hx0, hy0, hx1, hy1)); left = (i // 2) % 2 == 0; half = (hx1 - hx0) // 2
            c.alpha_composite(band.crop((0, 0, half, band.height)), (hx0, 8 + hy0 + (2 if left else 0))); c.alpha_composite(band.crop((half, 0, band.width, band.height)), (hx0 + half, 8 + hy0 + (0 if left else 2)))
            if i % 2 == 0: x = hx0 + random.randint(10, band.width - 10); y = 8 + hy0 - 6; ImageDraw.Draw(c).rectangle((x, y, x + 2, y + 2), fill=(255, 255, 255, 255))
            return c
        save('writing.gif', [typing(i) for i in range(16)], 90)
    else:
        save('writing.gif', [place(fr[P.get('write', 'base')], bob(i, 12, 2)) for i in range(24)], 90)
    ab = P.get('avatarBox', [100, 60, 668, 628]); Image.open(P['basePath']).convert('RGB').crop(tuple(ab)).resize((256, 256), Image.NEAREST).save(os.path.join(OUT, 'avatar.png'))
    print('pack written to', OUT)


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter); sub = ap.add_subparsers(dest='cmd', required=True)
    d = sub.add_parser('draft'); d.add_argument('--server', required=True); d.add_argument('--out', required=True); d.add_argument('--id', required=True); d.add_argument('--desc', required=True); d.add_argument('--n', type=int, default=3); d.add_argument('--model', default=MODEL)
    f = sub.add_parser('frames'); f.add_argument('--server', required=True); f.add_argument('--spec', required=True); f.add_argument('--base', required=True); f.add_argument('--out', required=True); f.add_argument('--model', default=MODEL)
    s = sub.add_parser('assemble'); s.add_argument('--spec', required=True); s.add_argument('--frames', required=True); s.add_argument('--out', required=True)
    a = ap.parse_args(); {'draft': cmd_draft, 'frames': cmd_frames, 'assemble': cmd_assemble}[a.cmd](a)
