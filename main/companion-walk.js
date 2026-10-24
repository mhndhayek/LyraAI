// Story 07: how Lyra wanders along the bottom of the screen when "Let Lyra walk
// around" is on. Pure functions, so the rules are tested without a screen:
// she stays inside the display's work area (so she never covers the Dock or the
// taskbar), turns round at the edges, and stands still while she is busy, while
// the mini chat is open, while she is speaking, dragged or hovered.
//
// A walker state is { x, y, dir, mode, timer }:
//   x, y   top-left of the companion window, in screen points
//   dir    1 = walking right, -1 = walking left
//   mode   'idle' or 'walking'
//   timer  seconds left in the current mode

const WALK = {
  speed: 55,             // points per second, an unhurried stroll
  drop: 420,             // points per second she glides down to the floor from where she was left
  walkMin: 2, walkMax: 6, // seconds of walking at a time
  idleMin: 5, idleMax: 20, // seconds of standing about in between
  gestureChance: 0.35,   // after a walk she sometimes waves or nods
  gestures: ['wave', 'nod'],
};

const between = (rng, a, b) => a + (b - a) * rng();

// The x range that keeps the whole window on this display.
function span(work, size) {
  const min = work.x;
  const max = Math.max(min, work.x + work.width - size.width);
  return { min, max };
}
// Standing on the bottom edge of the work area: the top of the Dock/taskbar.
function floorY(work, size) { return work.y + Math.max(0, work.height - size.height); }
const clampX = (x, work, size) => { const s = span(work, size); return Math.min(s.max, Math.max(s.min, x)); };

// Where she starts: the position she was left at (kept on screen), or the
// bottom-right corner of the display.
function start(pos, work, size, rng = Math.random) {
  const s = span(work, size);
  const x = pos && Number.isFinite(pos.x) ? clampX(pos.x, work, size) : s.max - Math.min(40, s.max - s.min);
  const yMax = floorY(work, size);
  const y = pos && Number.isFinite(pos.y) ? Math.min(yMax, Math.max(work.y, pos.y)) : yMax;
  return { x, y, dir: -1, mode: 'idle', timer: between(rng, WALK.idleMin, WALK.idleMax) };
}

// Pick a direction for a new walk: away from an edge she is close to, else at random.
function pickDir(x, work, size, rng) {
  const s = span(work, size); const w = s.max - s.min;
  if (w <= 0) return 1;
  if (x - s.min < w * 0.2) return 1;
  if (s.max - x < w * 0.2) return -1;
  return rng() < 0.5 ? -1 : 1;
}

// Advance one tick. env = { work, size, blocked }. Returns { state, events },
// where events is a list of { type: 'started'|'stopped'|'turned'|'gesture', ... }
// for the window to act on (play the walk clip, face the other way...).
function step(prev, dt, env, rng = Math.random) {
  const { work, size, blocked } = env;
  const s = { ...prev }; const events = [];
  const lim = span(work, size);
  // Whatever happened to the display, she stays on it.
  s.x = clampX(s.x, work, size);
  s.y = Math.min(floorY(work, size), Math.max(work.y, s.y));

  if (blocked) {
    if (s.mode === 'walking') { s.mode = 'idle'; events.push({ type: 'stopped', why: 'blocked' }); }
    // A short pause after whatever stopped her, rather than walking off mid-sentence.
    s.timer = Math.max(s.timer, WALK.idleMin / 2);
    return { state: s, events };
  }

  s.timer -= dt;
  if (s.mode === 'walking') {
    // Left higher up the screen, she glides down to the floor rather than jumping.
    s.y = Math.min(floorY(work, size), s.y + WALK.drop * dt);
    s.x += s.dir * WALK.speed * dt;
    if (s.x <= lim.min) { s.x = lim.min; if (s.dir !== 1) { s.dir = 1; events.push({ type: 'turned', dir: 1 }); } }
    else if (s.x >= lim.max) { s.x = lim.max; if (s.dir !== -1) { s.dir = -1; events.push({ type: 'turned', dir: -1 }); } }
    if (s.timer <= 0) {
      s.mode = 'idle'; s.timer = between(rng, WALK.idleMin, WALK.idleMax);
      events.push({ type: 'stopped', why: 'rest' });
      if (rng() < WALK.gestureChance) events.push({ type: 'gesture', name: WALK.gestures[Math.floor(rng() * WALK.gestures.length) % WALK.gestures.length] });
    }
  } else if (s.timer <= 0) {
    s.mode = 'walking'; s.timer = between(rng, WALK.walkMin, WALK.walkMax);
    const dir = pickDir(s.x, work, size, rng);
    if (dir !== s.dir) { s.dir = dir; }
    events.push({ type: 'started', dir: s.dir });
  }
  return { state: s, events };
}

module.exports = { WALK, start, step, span, floorY, clampX, pickDir };
