// The review loop between the two agents: the author of a pull request never
// reviews it, every pull request lands in exactly one queue, and a verdict
// moves it out of that queue.
const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewerFor, routeLabels, queue, mine, verdictPlan, STATUS } = require('../../scripts/agent-review');

const pr = (over = {}) => ({ number: 7, title: 't', url: 'u', headRefName: 'claudia/lyr-01-x', headRefOid: 'abc1234', isDraft: false, labels: [], statusCheckRollup: [], ...over });
const labels = (...names) => names.map((name) => ({ name }));

test('the other agent reviews; branches from anyone else go to Claudia', () => {
  assert.equal(reviewerFor('claudia/lyr-02-x'), 'lucima');
  assert.equal(reviewerFor('lucima/lyr-08-x'), 'claudia');
  assert.equal(reviewerFor('dependabot/npm_and_yarn/marked-18.1.0'), 'claudia');
  assert.equal(reviewerFor('claudiax/whatever'), 'claudia', 'only an exact prefix counts as an agent branch');
});

test('a push routes the pull request back to its reviewer and clears old verdicts', () => {
  const r = routeLabels('claudia/lyr-01-x');
  assert.deepEqual(r.add, ['needs-review:lucima']);
  for (const l of ['needs-review:claudia', 'reviewed:claudia', 'reviewed:lucima', 'changes-requested']) assert.ok(r.remove.includes(l), l);
  assert.ok(!r.remove.includes('needs-review:lucima'));
});

test('the queue holds only what is labelled for me, not mine, not a draft, and not yet reviewed at its head', () => {
  const prs = [
    pr({ number: 1, labels: labels('needs-review:lucima') }),
    pr({ number: 2, headRefName: 'lucima/lyr-08-y', labels: labels('needs-review:claudia') }),
    pr({ number: 3, labels: labels('needs-review:lucima'), isDraft: true }),
    pr({ number: 4, labels: labels('needs-review:lucima'), statusCheckRollup: [{ context: STATUS, state: 'SUCCESS' }] }),
    pr({ number: 5, headRefName: 'lucima/lyr-08-x', labels: labels('needs-review:lucima') }),
    pr({ number: 6, labels: labels('needs-review:lucima'), statusCheckRollup: [{ name: 'QA Gate', conclusion: 'SUCCESS' }] }),
  ];
  assert.deepEqual(queue(prs, 'lucima').map((p) => p.number), [1, 6]);
  assert.deepEqual(queue(prs, 'claudia').map((p) => p.number), [2]);
  assert.deepEqual(queue([pr({ labels: labels('needs-review:claudia') })], 'claudia'), [], 'a mislabelled pull request of my own is still not mine to review');
});

test('an author sees only their own pull requests that were sent back', () => {
  const prs = [
    pr({ number: 1, labels: labels('changes-requested') }),
    pr({ number: 2, labels: labels('reviewed:lucima') }),
    pr({ number: 3, headRefName: 'lucima/x', labels: labels('changes-requested') }),
  ];
  assert.deepEqual(mine(prs, 'claudia').map((p) => p.number), [1]);
  assert.deepEqual(mine(prs, 'lucima').map((p) => p.number), [3]);
});

test('a pass sets a green status and leaves the queue; a fail sends it back to the author', () => {
  const pass = verdictPlan({ pr: pr(), me: 'lucima', result: 'pass' });
  assert.deepEqual(pass.status, { state: 'success', context: STATUS, description: 'Lucima: ship it' });
  assert.ok(pass.remove.includes('needs-review:lucima') && pass.add.includes('reviewed:lucima') && !pass.add.includes('changes-requested'));
  const fail = verdictPlan({ pr: pr(), me: 'lucima', result: 'fail' });
  assert.equal(fail.status.state, 'failure');
  assert.ok(fail.add.includes('changes-requested'));
});

test('nobody can review their own pull request', () => {
  assert.throws(() => verdictPlan({ pr: pr(), me: 'claudia', result: 'pass' }), /the other agent reviews it/);
  assert.throws(() => verdictPlan({ pr: pr(), me: 'mallory', result: 'pass' }), /unknown agent/);
  assert.throws(() => verdictPlan({ pr: pr(), me: 'lucima', result: 'maybe' }), /pass or fail/);
});
