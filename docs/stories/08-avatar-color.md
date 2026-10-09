# 08 · Avatar color pass: 10% darker skin, readable face · S · ✅ approved

*As a user, I can see Lyra's expressions at a glance, because her face has real colour and contrast instead of looking washed-out and pale.*

## Decisions (Hanood, Oct 8)
- Skin **10% darker** than today, staying warm. No 3-variant sheet; the colour is measured, below.
- Blush: **subtle base, stronger on `happy`**.

## The colour (measured from `lyra.vrm` at `ef831aa`, Oct 8)
| | Face skin median | Notes |
|---|---|---|
| Now | **`#fad5b9`** | measured over ~720k skin pixels of `F00_000_00_Face_00` (body texture is a touch lighter at `#ffe7cb`) |
| Target | **`#e1bda2`** | HSV value × 0.90, saturation × 1.08, hue unchanged, so it's 10% darker and keeps the warmth (a plain RGB multiply came out greyish) |

Preview: `skin-10pct-preview.png` in this folder shows the face texture now vs. target, with no seams. Rules for the build:
- Apply the same transform to the **face and body** skin textures so face and neck match.
- Use a soft (feathered) hue/sat/value skin mask. Don't use rectangles, since an earlier rectangle mask left visible seams.
- **Protect the blush**: build the mask so the cheek blush isn't darkened. The darkening made the existing blush less visible in the preview, so the new blush (below) is applied *after* the skin shift.

## Why she looks pale today, and what changes
1. **Skin was deliberately lightened** (VRM README: *"lightened to the tone of AvatarSample_A"*). → `paint.py` gets a `SKIN_DARKEN = 0.90` / `SKIN_SAT = 1.08` step after the A→B skin copy, using the feathered mask.
2. **Flat lighting** (`character.js:73`, a frontal `DirectionalLight(0xffffff, Math.PI)` + ambient). → key light about 45° to the side (≈ 2.2), a weak fill from the other side, a soft rim from behind, and ambient lowered. Set the skin MToon `_ShadeColor` to a warm tone (about `#c99a86`) instead of today's pure white `[1,1,1]`, so shadows read as skin and not grey.
3. **No face colour.**
   - **Blush base**: a soft radial multiply on the cheeks in the face texture, subtle and always on.
   - **Blush on `happy`**: a blush overlay (a cheek decal mesh or a second face material) whose opacity follows `expressionManager.getValue('happy')` at runtime, reaching about 3× the base at full happy. Done in `character.js` (lights + blush only).
   - **Lips** a little deeper rose, **brows/lashes/eyeliner** darker (deepen `PAL.brow`), **mouth interior** darker so `aa`/`oh` lip-sync shows.
4. **Rebuild** with `tools/paint.py` → `tools/build.py`, re-render `docs/media/lyra-vrm.png` + `lyra-vrm-turnaround.png`, and update the README sha256 and "what was changed". The licence conditions stay embedded.

**Owns:** `renderer/character/vrm/tools/paint.py`, `renderer/character/vrm/lyra.vrm`, `renderer/character/vrm/README.md`, `docs/media/lyra-vrm*.png`, the light + blush lines in `renderer/character.js`. **Merge before 09.**

**Prereq:** AvatarSample_A/B exported to `texA/`/`texB/` (README step 1: headless Blender + VRM add-on, models from VRoid Hub). Neither is in the repo. If that pipeline isn't available, the fallback is to edit the textures **inside** `lyra.vrm` directly (decode the GLB images → apply the same transform → re-pack). The measurement and the preview were done exactly that way, so it's proven to work.

## QA
1. **Failing-first** `test/features/packaging.test.js`: the sha256 of `lyra.vrm` matches the one in `README.md`.
2. **Colour check script** (`renderer/character/vrm/tools/measure.py`, committed): it prints the median face-skin colour of the shipped `lyra.vrm`, and must report `#e1bda2 ± 3` per channel. Run it in the PR.
3. The rebuilt VRM still loads in the smoke test with 15 expressions and 55 humanoid bones.
4. Blush: a unit/smoke check that blush opacity at `happy = 1` is greater than at `happy = 0`.
5. **Mac demo**: screenshots of the live panel before and after, neutral and happy, in the same camera.
