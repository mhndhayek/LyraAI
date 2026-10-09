# 01 · 3D-first identity: welcome, look, retire 2D · S

*As a new user, the first thing I see is Lyra in 3D, a one-line hello, and what she can do. There are no pixel-art characters anywhere.*

## What's wrong today (0.9.12)
- `renderer/setup.js:37`: the welcome hero is `character/${packOf(s) || 'catgirl'}/avatar.png`, the 2D pixel cat girl. The copy is a long paragraph plus a 6-item numbered plan.
- The default is `appearance.source: 'gif'`, `gifFolder: 'builtin:catgirl'`, `persona.avatar: 'builtin:catgirl'` (`main/kernel/settings.js:16-17`).
- The "Name and look" step shows a grid of GIF packs. The live panel has a 2D/3D toggle (`renderer/app.js:46-55`).
- `main/organs/companion.js:241` and the mobile app fall back to `character/catgirl/avatar.png`.

## Change
1. **Welcome page**: a live 3D Lyra in the hero (reuse `Character` with `source: 'vrm'`, idle loop), the title **"Hi, I'm {name}."** and one line: **"Chat, build and grow."** Remove the numbered plan. Keep Skip and Next.
2. **Defaults**: `appearance.source: 'vrm'`, `vrmModel: 'builtin:lyra'`. `persona.avatar: 'builtin:lyra'`, which is a new static bust render: `renderer/character/vrm/avatar.png`, rendered from `lyra.vrm` by `tools/build.py` (it already renders a bust preview).
3. **Look step**: one card shows **Lyra (3D)** as selected, next to a greyed **"More characters — coming soon"** card with a logo/badge. Name and theme controls stay as they are.
4. **Retire 2D**:
   - delete `renderer/character/catgirl/`, `renderer/character/succubus/` and `assets/character/base/succubus*` + `specs/succubus.spec.json`
   - remove the 2D/3D toggle from the live panel
   - `Character` keeps one source (`vrm`), and the GIF code path is removed
   - add `catgirl`/`succubus` to `RETIRED_PACKS` so the existing migration (`settings.js:164-171`) moves old profiles to `source: 'vrm'` / `builtin:lyra`
   - `packs:list` IPC returns `[]` or gets removed together with its preload entry (the wiring test enforces that they match)
5. **Docs**: update `docs/GUIDE.md`, `docs/AVATARS.md` and `README.md` screenshots/sections that mention GIF packs. `scripts/make_character.py` (the pixel pipeline) moves to `lyra-archive` or gets deleted. Ask Hanood which in the PR.

**Owns:** `renderer/setup.js` (`welcome`, `look` only), `main/kernel/settings.js` (appearance/persona defaults + migration), `renderer/character.js` (removing the GIF path only), `renderer/app.js` (removing the dim toggle only), `renderer/index.html`, `renderer/styles.css` (setup hero), `main/organs/companion.js`, `renderer/mobile/*`, the `renderer/character/*` packs, docs.

## QA
1. **Failing-first test** in `test/kernel/settings.test.js`: a profile with `appearance: { source: 'gif', gifFolder: 'builtin:catgirl' }` migrates to `source: 'vrm'`, `vrmModel: 'builtin:lyra'`, `persona.avatar: 'builtin:lyra'`.
2. A fresh-install defaults test: `source === 'vrm'`.
3. `git ls-files renderer/character | grep -E 'catgirl|succubus'` returns nothing. A new `test/features/packaging.test.js` assertion checks this.
4. `grep -rn "catgirl\|succubus" main renderer preload.js docs README.md` returns only the migration list.
5. **Mac demo:** quit Lyra, move `~/Library/Application Support/Lyra` aside, launch the build, and screenshot the welcome page. It should show 3D Lyra moving, "Hi, I'm Lyra." and "Chat, build and grow.", and no pixel art. A second screenshot shows the Look step with the coming-soon card. Restore the data folder afterwards.
6. Upgrade path: launch with the old 0.9.12 data folder. Lyra shows in 3D, the health log has no errors and there's no broken image icon anywhere (including the chat avatars and the phone page).
