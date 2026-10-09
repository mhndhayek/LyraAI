# 09 · 3D animation library + state machine · L · ✅ approved

*As a user, Lyra moves like a character, not a statue: she idles with life, gestures while talking, thinks with her hand on her chin, waves hello, and reacts when I click her. The motions come from clips, so we can keep adding more.*

## Decisions (Hanood, Oct 8)
- Sources in this order: **pixiv VRMA samples → our own Blender clips → lucix text-to-motion as the last option** (it's slow, but try it once).
- No Mixamo, no store packs.
- First clip set: 8 clips (idle ×2, think, type, talk, wave, nod, happy_bounce) **plus `walk` and `turn`** for story 07's walking toggle.

## Today
`character.js` animates everything **procedurally**: sine-wave breathing, arm rotation, lean/tilt/nod, blink, a `happy` value and an `aa` mouth. There are no clips and no blending, so every state looks like the same pose nudged slightly.

## Design
1. **Clip format: VRMA** (the VRM Animation spec, `.vrma`). It's humanoid-bone based, so a clip plays on *any* VRM, including future characters. Add `@pixiv/three-vrm-animation` (same major as three-vrm 3.5.x) to `renderer/vendor/three-vrm.entry.js` and rebuild the bundle with the esbuild command in the VRM README.
2. **Layers** (all three run together):
   - **Base clip layer**: `THREE.AnimationMixer` with crossfades (0.3–0.5 s) between state clips
   - **Additive procedural layer**, kept from today: breathing, blink, look-at, lip-sync `aa`, spring bones
   - **One-shot gestures**: wave, nod, shrug and so on, played over the base and returning to it
3. **State machine** (`renderer/character/anim.js`):

   | App state | Base loop | Random one-shots |
   |---|---|---|
   | idle | idle_breathe / idle_shift (pick one every 8–20 s) | stretch, look_around, hair_touch |
   | thinking | think_chin | tilt_head |
   | writing | lean_type | — |
   | speaking | talk_idle | hand gestures every 2–4 s, timed to sentence starts from story 05 |
   | greet (on open) | — | wave |
   | clicked head / body (story 07) | — | happy_bounce / shy |
   | walking (story 07 toggle) | walk (in place; the window moves) | turn at edges |

4. **Manifest**: `renderer/character/anims/anims.json` maps `{ id, file, loop, states[], weight, source, licence, url }`. Every clip carries its licence and source **in the manifest**, and a test enforces it.
5. **Fallback**: if a clip fails to load, that state uses today's procedural pose, so a missing file never breaks the character.

## Where clips come from (ranked)

| Source | What | Licence notes | Plan |
|---|---|---|---|
| **pixiv / VRoid official VRMA samples** | A small set of free `.vrma` motions published with the VRMA spec | Free to use per pixiv's terms. **Verify** redistribution in a public repo before bundling | Use first: zero conversion |
| **Our own, made in Blender** | Keyframe or retarget in Blender with the VRM add-on, export `.vrma` | Ours, no restriction | For the signature motions (wave, think_chin) |
| **Text-to-motion / video mocap on lucix** (last option) | Open models such as MoMask/T2M-style text-to-motion, or monocular video → BVH, retargeted in Blender | Check each model's licence for its *outputs* | Only for clips the first two sources can't cover. Timebox a half-day spike; it's slow, so batch the jobs and don't block the story on it |
| ~~Mixamo~~ | Large FBX library | Adobe's terms restrict redistributing the animation files, and a public repo is redistribution | **Not used** |
| BOOTH / store packs | Lots of VRMA/VMD | Usually `Redistribution_Prohibited` (same warning as the VRM README) | **Don't use** in the repo |

Pipeline doc: `renderer/character/anims/README.md` records how each clip was made and its licence, the same as the VRM README.

**Owns:** `renderer/character.js` (animation code), new `renderer/character/anim.js`, `renderer/character/anims/*`, `renderer/vendor/three-vrm.entry.js` + `.min.js`, `THIRD_PARTY.md`. **Builds on 08's `lyra.vrm`. Coordinate with 07**: 07 owns the companion window and only calls `anim.play('happy_bounce')`, `anim.setState('walking')` etc.; 09 owns all motion.

## QA
1. **Failing-first** `test/features/anims.test.js`: every entry in `anims.json` has `source`, `licence` and `url`, the file exists and is under 1 MB, and every app state maps to at least one clip.
2. A state-machine unit test with a fake clock: idle → thinking crossfades, a one-shot returns to the base loop, and a missing clip falls back to procedural without throwing.
3. Smoke: boot in 3D and assert the mixer has an active action within 2 s, plus no console errors.
4. Bundle size: `three-vrm.min.js` grows by less than 150 KB. Put the number in the PR.
5. Performance: same budget as story 07 (idle under 10% of one core, walking under 20%).
6. **Mac demo** (screen recording): open the app (she waves), ask a question (think_chin → talking gestures in time with the voice), go idle 30 s (she shifts and looks around), click her head (a reaction), and in companion mode with Walk on she walks and turns at the screen edge.
7. The PR lists where each clip came from (pixiv / ours / lucix) and the licence, matching `anims.json`.

