// Story 07, QA 5: the walk rules on a fake 1440×900 screen with a menu bar and
// a Dock, so the work area is smaller than the screen.
const test = require('node:test');
const assert = require('node:assert/strict');
const walk = require('../../main/companion-walk');

const work = { x: 0, y: 25, width: 1440, height: 800 }; // 25 pt menu bar, 75 pt Dock
const size = { width: 260, height: 420 };
const floor = work.y + work.height - size.height;
const maxX = work.x + work.width - size.width;
// A seeded generator so a failure can be replayed.
const seeded = (seed) => () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };

test('she never leaves the work area, wherever she starts and however long she walks', () => {
  for (const seed of [1, 7, 42, 1234, 99999]) {
    const rng = seeded(seed);
    let s = walk.start({ x: -500, y: 5000 }, work, size, rng);
    for (let i = 0; i < 30 * 60 * 10; i++) { // ten minutes at 30 fps
      s = walk.step(s, 1 / 30, { work, size, blocked: false }, rng).state;
      assert.ok(s.x >= work.x && s.x + size.width <= work.x + work.width, `seed ${seed}: x ${s.x} left the work area`);
      assert.ok(s.y >= work.y && s.y + size.height <= work.y + work.height, `seed ${seed}: y ${s.y} covers the menu bar or the Dock`);
    }
  }
});

test('while walking she keeps to the bottom of the work area, above the Dock', () => {
  const rng = seeded(3);
  let s = { x: 600, y: 100, dir: 1, mode: 'idle', timer: 0 };
  s = walk.step(s, 1 / 30, { work, size, blocked: false }, rng).state;
  assert.equal(s.mode, 'walking');
  const ys = [];
  for (let i = 0; i < 30; i++) { s = walk.step(s, 1 / 30, { work, size, blocked: false }, rng).state; ys.push(s.y); }
  assert.ok(ys[0] > 100 && ys[0] < floor, 'left high up, she glides down rather than jumping');
  assert.equal(s.y, floor, 'and within a second she walks on the floor, just above the Dock');
});

test('bumping the right edge turns her round, and so does the left', () => {
  const rng = seeded(5);
  let s = { x: maxX - 3, y: floor, dir: 1, mode: 'walking', timer: 5 };
  const r = walk.step(s, 0.2, { work, size, blocked: false }, rng);
  assert.equal(r.state.x, maxX, 'she stops at the edge');
  assert.equal(r.state.dir, -1, 'and faces the other way');
  assert.deepEqual(r.events.map((e) => e.type), ['turned']);
  s = { x: work.x + 2, y: floor, dir: -1, mode: 'walking', timer: 5 };
  const l = walk.step(s, 0.2, { work, size, blocked: false }, rng);
  assert.equal(l.state.x, work.x);
  assert.equal(l.state.dir, 1);
});

test('she stops when the chat opens or she is speaking, and stays put while blocked', () => {
  const rng = seeded(9);
  for (const why of ['chatOpen', 'speaking', 'dragging', 'hover']) {
    let s = { x: 700, y: floor, dir: 1, mode: 'walking', timer: 4 };
    const r = walk.step(s, 1 / 30, { work, size, blocked: true }, rng);
    assert.equal(r.state.mode, 'idle', `${why}: she stops walking`);
    assert.deepEqual(r.events, [{ type: 'stopped', why: 'blocked' }]);
    s = r.state;
    for (let i = 0; i < 30 * 60; i++) s = walk.step(s, 1 / 30, { work, size, blocked: true }, rng).state;
    assert.equal(s.x, 700, `${why}: a minute later she has not moved`);
    assert.equal(s.mode, 'idle');
  }
});

test('she alternates between walking a few seconds and resting a while', () => {
  const rng = seeded(11);
  let s = walk.start(null, work, size, rng); let walking = 0, idle = 0;
  for (let i = 0; i < 30 * 600; i++) { s = walk.step(s, 1 / 30, { work, size, blocked: false }, rng).state; if (s.mode === 'walking') walking++; else idle++; }
  assert.ok(walking > 0 && idle > 0, 'both modes happen');
  assert.ok(idle > walking, 'she rests more than she walks (2-6 s walks, 5-20 s rests)');
});

test('she starts at the saved spot, kept on screen, or in the bottom-right corner', () => {
  const a = walk.start(null, work, size, seeded(1));
  assert.equal(a.y, floor); assert.ok(a.x > work.width / 2, 'bottom right by default');
  const b = walk.start({ x: 300, y: 200 }, work, size, seeded(1));
  assert.deepEqual([b.x, b.y], [300, 200], 'a dragged position is kept');
  const c = walk.start({ x: 5000, y: -40 }, work, size, seeded(1));
  assert.deepEqual([c.x, c.y], [maxX, work.y], 'a position from a bigger display is pulled back on screen');
});

test('a walk starting near an edge heads away from it', () => {
  assert.equal(walk.pickDir(work.x + 10, work, size, () => 0.99), 1);
  assert.equal(walk.pickDir(maxX - 10, work, size, () => 0.01), -1);
});
