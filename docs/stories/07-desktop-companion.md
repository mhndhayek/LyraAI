# 07 · Desktop companion: Lyra on the desktop + mini chat · L · ✅ approved

*As a user, the main Lyra window stays exactly as it is today. When I hide it, Lyra stays on my desktop as a 3D character with a small chat bubble in the same theme, and she can walk around if I turn that on.*

## Decisions (Hanood, Oct 8)
- **The main window doesn't change.** Today's full chat layout is "Full" and it's good. No dimming, no new stage layout inside the window.
- **New: desktop companion mode.** When the main window is hidden or minimised, Lyra (the 3D character) stays on the desktop, always on top, with a **small chat window that matches the main window's theme**.
- **Walking is a toggle** (Settings › Appearance › "Let Lyra walk around", plus a quick toggle on her right-click menu).

## Today
- One opaque `BrowserWindow` (`main/main.js:48`). The character lives in the side live panel or a 180 px in-window float (`placement: 'floating'`). Nothing exists outside the app window.

## Change
1. **Companion window** (`main/companion-window.js`, new):
   - `BrowserWindow` options: `transparent: true, frame: false, hasShadow: false, alwaysOnTop: true ('floating' level), skipTaskbar: true, resizable: false, focusable: true`
   - `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`
   - about 260×420, loads `renderer/companion.html`
   - click-through outside her body: `setIgnoreMouseEvents(true, { forward: true })` by default, and the renderer flips it off while the cursor is over her silhouette (alpha hit-test on the canvas) or over the mini chat
2. **When it shows**: when the main window is hidden/minimised/closed-to-tray, *if* "Desktop companion" is on (default **on**). It hides again when the main window comes back. Menu-bar/tray item: Show Lyra · Open chat · Walk on/off · Quit.
3. **Character**: reuses `Character` (`source: 'vrm'`) on a transparent canvas (`alpha: true`, already set), **full-body**, idle animation (story 09 provides clips, procedural until then).
   - Hover → she looks at the cursor. Click → a small reaction (`happy`). Drag her → move her (position saved). Right-click → menu.
4. **Mini chat** (`renderer/companion.html` + `companion.js`):
   - Click Lyra → a speech-bubble card opens beside her, about 320 px wide, showing her last reply, a one-line composer, a mic button and an "Open full chat" button.
   - It uses the **same theme CSS variables** as the main window (loads the active `themes/<id>/theme.css`), so it follows dark/light/pixel automatically.
   - Messages go to the **same chat** as the main window (shared IPC, `chatId` = the current chat). Replies stream, and voice and lip-sync work the same way (story 05).
   - While she's working, the bubble shows `thinking…`/`writing…`. A new reply while the bubble is closed pops a short line bubble above her head for 6 s.
5. **Walking (toggle, default off)**:
   - She walks along the bottom of the current screen's work area (`screen.getDisplayNearestPoint(...).workArea`). The window moves with `setBounds` at 30 fps, and she turns to face the walking direction.
   - Random wander: walk 2–6 s, idle 5–20 s, occasionally sit/stretch (clips from story 09, simple procedural walk cycle until then).
   - She stops walking while the mini chat is open, while she's speaking or being dragged, and when the mouse is over her.
   - She stays on one display, never covers the Dock/taskbar, and bumping the screen edge turns her around.
6. **Performance**: ≤ 30 fps while visible, ≤ 10 fps when idle and not walking, and paused while the main window is in front.

**Owns:** new `main/companion-window.js`, new `renderer/companion.html`/`companion.js`/`companion.css`, `main/main.js` (window lifecycle + tray only), `main/kernel/settings.js` (`appearance.desktopCompanion: true`, `appearance.walk: false`, `appearance.companionPos`), `renderer/settings.js` (Appearance section only), `preload.js`. **Doesn't touch the main chat layout.** `renderer/character.js` gets a full-body camera framing option only, and motion belongs to story 09. **Merge after 01.**

## QA
1. **Failing-first** `test/kernel/settings.test.js`: defaults `desktopCompanion: true`, `walk: false`, and an old profile gains both without other changes.
2. Smoke (`scripts/smoke.js`, extended): hide the main window → the companion window exists, is transparent and always-on-top, and its canvas renders a frame (non-empty pixels). Show the main window → the companion hides.
3. Mini chat sends to the same `chatId` (assert the message lands in the store for the current chat).
4. Theme: switch to light → the mini chat's computed `--bg` matches the main window's.
5. Walk logic unit test (`test/features/walk.test.js`, fake screen 1440×900): she never leaves the work area, turns at edges, and stops when `chatOpen` or `speaking`.
6. Click-through: with the cursor over empty transparent space, clicks reach the app behind (manual check on the Mac, noted in the PR).
7. CPU: idle visible for 60 s stays under 10% of one core, walking under 20%. Numbers go in the PR.
8. **Mac demo** (screen recording): hide Lyra's window → she appears on the desktop → click → mini chat → ask something → she answers with voice → turn on Walk → she walks along the bottom → click → she stops and the bubble opens → open the full chat → the companion hides.
