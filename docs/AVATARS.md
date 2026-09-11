# Avatars and live characters: the recipe

This is how the built-in characters (cat girl, fox girl, cowboy, agent, butter robot, succubus, and the two businessmen) were made, so you can make more, or a new one for the user.

## What it needs (tell the user before starting)

- **A SwarmUI server** the app can reach: the URL is under Settings › Image generation, or ask the user (theirs is on their network). The recipe uses SwarmUI's HTTP API for text-to-image and for **inpainting** (regenerating only a masked region). ComfyUI is not supported by the script.
- **The model** `ZImage/SwarmUI_Z-Image-Turbo-FP8Mix.safetensors`. It draws clean 16-bit pixel art in about 4 seconds per image at 8 steps, CFG 1. Dedicated "pixel art" checkpoints on the server were tried and were worse (SD1.5 ones are noisy; the SDXL sprite model failed to load). Any model the server lists can be passed with `--model`, but expect to tune steps and CFG.
- **Python with Pillow and numpy** for cutting out and assembling GIFs. Lyra's voice environment has both: `voice/.venv/bin/python` in the app folder. If missing: `uv pip install --python <that python> pillow numpy`.
- Time: a full character is ~15 generated frames plus assembly, about two minutes. Budget a few extra tries for hands.

The script: `scripts/make_character.py` in the app folder (read it with read_file; run it with shell).

## Step 1: draft the portrait (text-to-image)

Style prompt, always the same so all characters match:

```
16-bit SNES pixel art, clean dithering, chunky pixels, flat deep purple background, centered bust portrait, game character portrait, cute chibi proportions
```

Add the character description after it (hair, eyes, clothes, ears, tails, props). Negative prompt: `blurry, photo, realistic, 3d render, text, watermark, extra limbs, deformed`. 768×768, 8 steps, CFG 1, random seed. Make 3 candidates and let the user pick:

```
scripts/make_character.py draft --server http://host:7801 --out /tmp/cast --id fox --desc "a cheerful fox girl with orange fox ears with white tips, long auburn hair, amber eyes, cream scarf" --n 3
```

Lesson learned: the flat purple background is what makes the cut-out easy later. Keep it. If a candidate comes back with a white frame, crop the frame off and resize back to 768.

## Step 2: animation frames by inpainting (never by re-generating)

Regenerating the whole image, even from the portrait with image-to-image, drifts the character (a nose appears, eyes change, ears turn into something else). **Inpainting keeps every pixel outside a mask**, so only the mouth, eyes or a hand changes. Use `initimagecreativity 0.95`, `maskblur 4`, the same style prompt plus a short description of the change.

Masks are rectangles in the 768×768 portrait. Look at the portrait on a 64-px grid to place them. Typical boxes for a bust:

| Frame | Mask (x0, y0, x1, y1) | Prompt addition | Notes |
| --- | --- | --- | --- |
| blink | both eyes, e.g. 262–548 × 388–462 | `both eyes closed, relaxed` | make 2, pick the closed one |
| mouth / mouthwide | mouth, e.g. 330–470 × 455–540 | `small open mouth, speaking` / `wide open mouth, cheerful` | 2 + 1 |
| think | both hands under the face, e.g. 230–600 × 470–700 | `both hands cupping her chin, thinking pose` or `hand stroking the beard, thinking` | make 3 |
| gesture | one side, e.g. 520–740 × 300–690 | `raised hand waving, open palm`, `hand adjusting the tie knot`, `hand tipping the hat brim`, `fluffy tail raised and curled`, `bat wings spread wide` | character-specific; make 2 |
| type | bottom band on a taller canvas | `sitting at a desk typing on a vintage typewriter, both hands on the keys, paper in the typewriter` | see below |

The typewriter is an **outpaint**: paste the portrait on a 768×1024 canvas filled with the background colour and mask `0,600 → 768,1024`. The model draws the desk, the typewriter and the hands in the new space.

The spec file drives it (`masks` and `jobs`, then `pack` for step 3):

```json
{ "style": "16-bit SNES pixel art bust of a fox girl …, flat deep purple background",
  "masks": { "eyes": [[300,370,500,432]], "mouth": [[345,440,445,492]], "chin": [[250,455,560,660]], "gesture": [[95,355,255,605]], "type": [[0,600,768,1024]] },
  "jobs": [ ["blink","eyes","both eyes closed, happy",2], ["mouth","mouth","small open mouth, speaking",2], ["mouthwide","mouth","wide open mouth",1], ["chin","chin","both hands cupping her chin, thinking pose",3], ["gesture","gesture","fluffy fox tail raised and curled, wagging",2], ["type","type","sitting at a desk typing on a vintage typewriter, both hands on the keys",2] ],
  "pack": { "basePath": "/tmp/cast/fox-3.png", "frames": { "base": "/tmp/cast/fox-3.png", "blink": "blink-1.png", "talk_a": "mouth-2.png", "talk_b": "mouthwide-1.png", "talk_c": "mouth-1.png", "chin1": "chin-1.png", "chin2": "chin-2.png", "g1": "gesture-1.png", "g2": "gesture-2.png", "type": "type-1.png" },
    "think": ["chin1","chin2"], "gesture": ["g1","g2"], "speakFx": null, "avatarBox": [100,60,668,628] } }
```

```
scripts/make_character.py frames --server http://host:7801 --spec fox.json --base /tmp/cast/fox-3.png --out /tmp/cast/fox-frames
```

Then look at the frames (look_at_image) and put the good ones into `pack.frames`. Hands fail sometimes; regenerate that job with a wider mask before giving up.

## Step 3: assemble the GIF pack

```
scripts/make_character.py assemble --spec fox.json --frames /tmp/cast/fox-frames --out <state>/organs/renderer/character/fox
```

What assembly does: removes the purple background by flood-filling from the image border (never by colour alone, that punches holes in dark pixels), keeps only the pixels connected to the body (drops specks), crops all frames to one shared box, scales to 256 px wide with nearest-neighbour, adds a 2–4 px bob, and writes:

| File | Content |
| --- | --- |
| idle.gif | bob with two short blinks per 4 s loop |
| idle-2.gif | the gesture frames (wave, tail wag, hat tip…) then rest |
| idle-3.gif | a quiet hum on the mouth frames |
| idle-4.gif | a second gesture set if given (wings, wink…) |
| thinking.gif | the think frames alternating, with thought dots building up |
| speaking.gif | mouth cycle at 9 fps; `speakFx: "hearts"` adds floating hearts; a character without a mouth gets sound arcs |
| writing.gif | the typewriter frame with hands alternating up/down and key-clack sparks |
| avatar.png | 256 px head crop of the base for the header |

Idle variations idle-2 … idle-6 play at random while idle; the app looks for them by name.

## Step 4: make it available in the app

Built-in packs live in the UI organ under `character/<id>/`; the folder name is the id. The picker under Settings › Appearance › GIF pack lists every folder there that has an `idle.gif`. To use one: `configure_app({appearance:{source:"gif", gifFolder:"builtin:<id>"}, persona:{avatar:"builtin:<id>"}})`. A pack outside the app works too: pass the folder path instead of `builtin:<id>`.

## Style rules that kept the cast consistent

- Same style prompt, same 768 canvas, same purple; the character description only.
- Chibi bust, centered, no text, no frame. Reject candidates with a nose drawn as a dot or a white border.
- One base image per character; everything else is inpainted from it, so hair, ears and outfit never change between states.
- Avatars keep the purple background; live characters are transparent.
