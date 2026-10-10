# 3D animation assets (story 09)

Ten `.vrma` clips that drive Lyra's body through the state machine in
[`../anim.js`](../anim.js). Each clip is a glTF binary carrying the
`VRMC_vrm_animation` extension; `@pixiv/three-vrm-animation` retargets it onto
Lyra's humanoid rig at runtime. The `anims.json` manifest maps every character
state to a clip and records provenance + licence for each.

| clip         | state      | source                          | licence  | loop |
|--------------|------------|---------------------------------|----------|------|
| `idle_breathe` | idle     | [tk256ailab/vrm-viewer](https://github.com/tk256ailab/vrm-viewer) (Relax) | MIT | yes |
| `idle_shift`   | idle     | [tk256ailab/vrm-viewer](https://github.com/tk256ailab/vrm-viewer) (LookAround) | MIT | yes |
| `think_chin`   | thinking | [tk256ailab/vrm-viewer](https://github.com/tk256ailab/vrm-viewer) (Thinking) | MIT | yes |
| `lean_type`    | writing  | authored in Blender 5.2 (VRM add-on 4.7) | LyraAI | yes |
| `talk_idle`    | speaking | authored in Blender 5.2 (VRM add-on 4.7) | LyraAI | yes |
| `wave`         | one-shot | [tk256ailab/vrm-viewer](https://github.com/tk256ailab/vrm-viewer) (Goodbye) | MIT | no |
| `nod`          | one-shot | authored in Blender 5.2 (VRM add-on 4.7) | LyraAI | no |
| `happy_bounce` | one-shot | [tk256ailab/vrm-viewer](https://github.com/tk256ailab/vrm-viewer) (Jump) | MIT | no |
| `walk`         | reserved | authored in Blender 5.2 (VRM add-on 4.7) | LyraAI | yes |
| `turn`         | reserved | authored in Blender 5.2 (VRM add-on 4.7) | LyraAI | no |

## How the state machine uses them

`anim.js` builds one `THREE.AnimationMixer` over the live VRM. On a state change it
crossfades (0.35 s) from the currently playing clip to the one mapped for the new
state; `idle` alternates between `idle_breathe` and `idle_shift` so the loop never
reads as a metronome. One-shots (`nod`, `wave`, `happy_bounce`) play once and ease
back to the return clip. The procedural layer in `character.js` (breathing, blink,
glance, blush, lip-sync) stays as an **additive** overlay on top of the mixer, so
the model still feels alive without fighting the clip.

## Why an arms-down correction is applied at runtime

The clips are authored/retargeted in a **T-pose** (arms up). `character.js` applies
a local-frame arms-down rotation (left +1.22 / right −1.22 rad) as a *multiply* on
top of the mixer pose each frame, so the correction never clobbers a clip's own arm
motion.

## Provenance & licence notes

* **MIT clips** come from the `vrm-viewer` repo, which ships the raw `.vrma` files in
  its tree; the file names above are the original clip names re-labelled to match
  the state they drive.
* **LyraAI clips** were authored directly against Lyra's armature in Blender 5.2
  (VRM add-on 4.7) and exported with `export_scene.vrma`; they are part of this repo
  and free to use with it.
* Every clip is under 1 MB (the story's gate) — the largest is 116 KB.
