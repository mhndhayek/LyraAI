# Lyra in 3D (VRM)

![Lyra, front and back](../../docs/media/lyra-vrm-turnaround.png)

`lyra.vrm` is Lyra's 3D model, made to be the mascot. It is a VRM 0.x avatar with a full humanoid rig (55 bones), 11 spring-bone groups for hair and clothes, and 15 expressions (blink, the vowels for lip sync, joy, anger, sorrow, fun…), so any VRM app (VSeeFace, VTube Studio, Project AIRI, three-vrm) can animate it.

| | |
| --- | --- |
| Hair | hot pink at the crown into sky blue at the tips, with thin cyan streaks; bangs stay pink |
| Eyes | gold |
| Skin | light |
| Outfit | varsity bomber, crop top, pink pleated skirt, star ribbon bows |
| File | `lyra.vrm`, 15.6 MB, sha256 `c288087cd4e159fd40db80f6e031d2ed540bfd1fd1d1f4521a3d75d380d30ab2` |

The app does not load it yet: the live panel shows the pixel-art packs and Live2D. A VRM renderer is the next step, and this model is what it will show. Until then the file is kept in the repo and not packed into the installers.

## Where she comes from, and the licence

Lyra is a recolour of **AvatarSample_B** by the **VRoid Project** (pixiv). That sample is published under the VRoid Hub conditions embedded in the file:

- anyone may use it as an avatar, and personal and corporate commercial use is allowed
- modification and redistribution are allowed
- credit is not required (we give it anyway)

Those conditions stay embedded in `lyra.vrm`, and they apply to anyone who takes the model from this repo. The licence for the rest of the app (PolyForm Noncommercial) does **not** narrow them: the model is the VRoid Project's work under its own terms, recoloured.

What was changed: the skin was lightened to the tone of AvatarSample_A, and the hair, eyebrows and the painted hair cap were recoloured. The mesh, rig, spring bones and expressions are untouched.

Do not replace this file with a model from BOOTH or other stores without reading its licence first. Most of them are `Redistribution_Prohibited`, and putting one in a public repo breaks that.

## Remaking or tweaking her

`tools/` holds the two scripts that made her. They are re-runnable and take about a minute:

1. In headless Blender with the [VRM add-on](https://extensions.blender.org/add-ons/vrm/), import `AvatarSample_A.vrm` and `AvatarSample_B.vrm` and save every image to `texA/` and `texB/`.
2. `python tools/paint.py pinkblue` (needs numpy and Pillow) paints the new textures into `out_pinkblue/`. The colours are hex codes in the `PAL` table at the top. `goldblue` is the other palette that was tried.
3. `blender -b --python tools/build.py -- AvatarSample_B.vrm out_pinkblue $PWD/lyra` swaps the textures in, renders front, back and bust previews, and exports `lyra.vrm` and `lyra.blend`.

Two details are easy to miss. The skin is copied from AvatarSample_A's own painted skin wherever both models are bare skin, because a plain colour gain leaves the darker tan in the shaded neck. And the short top locks get a separate pink-only material, so the blue tips never land on the bangs at eye level.
