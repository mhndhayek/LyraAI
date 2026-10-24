// Story 07: the desktop companion's rules that need no window: when she is on
// the desktop, where the mini chat opens, and which window plays a reply's voice.
const test = require('node:test');
const assert = require('node:assert/strict');
const { layout, shouldShow, routeEvent, SIZE, BUBBLE_W } = require('../../main/companion-window');

const work = { x: 0, y: 25, width: 1440, height: 800 };

test('she is on the desktop only while the main window is away and the setting is on', () => {
  const base = { enabled: true, mainVisible: false, dismissed: false, safeMode: null, quitting: false };
  assert.equal(shouldShow(base), true, 'main window hidden, minimised or closed: she shows');
  assert.equal(shouldShow({ ...base, mainVisible: true }), false, 'the main window is back: she hides');
  assert.equal(shouldShow({ ...base, enabled: false }), false, 'Desktop companion off: never');
  assert.equal(shouldShow({ ...base, dismissed: true }), false, '"Hide for now" from her menu keeps her away');
  assert.equal(shouldShow({ ...base, safeMode: 'organs broke' }), false, 'never in safe mode');
  assert.equal(shouldShow({ ...base, quitting: true }), false, 'never while quitting');
});

test('the mini chat opens beside her without moving her', () => {
  const nearLeft = { x: 100, y: 400 };
  const closed = layout(nearLeft, false, work);
  assert.deepEqual(closed, { x: 100, y: 400, width: SIZE.width, height: SIZE.height, side: null });
  const right = layout(nearLeft, true, work);
  assert.equal(right.side, 'right', 'room on the right: the card opens there');
  assert.equal(right.x, 100, 'her stage stays where it was');
  assert.equal(right.width, SIZE.width + BUBBLE_W);
  const nearRight = { x: work.width - SIZE.width, y: 405 };
  const left = layout(nearRight, true, work);
  assert.equal(left.side, 'left', 'at the right edge the card opens to her left');
  assert.equal(left.x + BUBBLE_W, nearRight.x, 'and the window grows leftwards so she does not move');
  assert.ok(left.x >= work.x, 'the card stays on screen');
});

test('a spoken reply plays in one window only: the one that sent it', () => {
  const chunk = { type: 'tts:chunk', id: 'r1', seq: 1, path: '/a.wav' };
  const whole = { type: 'tts', id: 'r1', path: '/r1.wav' };
  assert.equal(routeEvent(chunk, 'companion', 'companion'), chunk, 'the companion plays its own reply');
  assert.equal(routeEvent(chunk, 'main', 'companion'), null, 'the main window does not play it a second time');
  assert.deepEqual(routeEvent(whole, 'main', 'companion'), { ...whole, streamed: true }, 'the main window still gets the play pill, without playing');
  assert.equal(routeEvent(whole, 'main', 'main'), whole);
  assert.equal(routeEvent(chunk, 'companion', 'main'), null);
  const delta = { type: 'delta', id: 'r1', text: 'hi' };
  assert.equal(routeEvent(delta, 'main', 'companion'), delta, 'text streams to both windows');
  assert.equal(routeEvent(delta, 'companion', 'main'), delta);
});
