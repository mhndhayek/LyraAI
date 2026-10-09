#!/usr/bin/env node
// The review loop between the two agents that work on this repo, Claudia and
// Lucima. Whoever wrote a pull request never reviews it: a branch named
// claudia/... is reviewed by Lucima and lucima/... by Claudia. Anything else
// (Dependabot, a person) goes to Claudia, so every pull request gets a review.
//
// Both agents push as the same GitHub account, and GitHub does not let an
// account approve its own pull request, so a review is a comment plus the
// "agent-review" commit status. The merge itself stays with the owner.
//
//   route   --pr N --branch B          label a pull request for its reviewer (CI runs this)
//   queue   --me NAME [--gate]          pull requests waiting for NAME's review, as JSON
//   mine    --me NAME [--gate]          NAME's own pull requests that need changes
//   verdict --pr N --sha S --me NAME --result pass|fail --body-file F
//                                       post a review, set the status, move the labels
//
// --gate prints {"wakeAgent": false} on an empty result, which tells a Hermes
// cron job to skip the model run entirely.
const fs = require('fs');
const { execFileSync } = require('child_process');

const AGENTS = ['claudia', 'lucima'];
const FALLBACK_REVIEWER = 'claudia';
const STATUS = 'agent-review';
const NAMES = { claudia: 'Claudia', lucima: 'Lucima' };

const authorOf = (branch) => { const p = String(branch || '').split('/')[0]; return AGENTS.includes(p) ? p : null; };
function reviewerFor(branch) { const a = authorOf(branch); return a ? AGENTS.find((x) => x !== a) : FALLBACK_REVIEWER; }

// Every push puts a pull request back in its reviewer's queue: the old verdict
// was about an older commit.
function routeLabels(branch) {
  const r = reviewerFor(branch);
  return { add: [`needs-review:${r}`], remove: [...AGENTS.filter((x) => x !== r).map((x) => `needs-review:${x}`), ...AGENTS.map((x) => `reviewed:${x}`), 'changes-requested'] };
}

const labelNames = (pr) => (pr.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
const reviewedAtHead = (pr) => (pr.statusCheckRollup || []).some((c) => c.context === STATUS);

// Waiting for me: labelled for me, not a draft, not mine, and no verdict on the
// current head commit yet.
function queue(prs, me) {
  return prs.filter((pr) => !pr.isDraft && labelNames(pr).includes(`needs-review:${me}`) && authorOf(pr.headRefName) !== me && !reviewedAtHead(pr))
    .map((pr) => ({ number: pr.number, title: pr.title, branch: pr.headRefName, sha: pr.headRefOid, url: pr.url }));
}

// Mine and sent back: the reviewer asked for changes on my current head.
function mine(prs, me) {
  return prs.filter((pr) => authorOf(pr.headRefName) === me && labelNames(pr).includes('changes-requested'))
    .map((pr) => ({ number: pr.number, title: pr.title, branch: pr.headRefName, sha: pr.headRefOid, url: pr.url }));
}

function verdictPlan({ pr, me, result }) {
  if (!AGENTS.includes(me)) throw new Error(`unknown agent "${me}" (expected ${AGENTS.join(' or ')})`);
  if (result !== 'pass' && result !== 'fail') throw new Error('--result must be pass or fail');
  if (authorOf(pr.headRefName) === me) throw new Error(`${NAMES[me]} wrote #${pr.number}; the other agent reviews it`);
  const pass = result === 'pass';
  return {
    status: { state: pass ? 'success' : 'failure', context: STATUS, description: `${NAMES[me]}: ${pass ? 'ship it' : 'changes requested'}` },
    add: [`reviewed:${me}`, ...(pass ? [] : ['changes-requested'])],
    remove: [`needs-review:${me}`, ...(pass ? ['changes-requested'] : [])],
    header: `### ${pass ? '✅' : '🔁'} Agent review by ${NAMES[me]}: ${pass ? 'ship it' : 'changes requested'}`,
  };
}

// --- command line -----------------------------------------------------------

function args(argv) { const o = {}; for (let i = 0; i < argv.length; i++) { if (!argv[i].startsWith('--')) continue; const k = argv[i].slice(2); const v = argv[i + 1]; if (v === undefined || v.startsWith('--')) o[k] = true; else { o[k] = v; i++; } } return o; }
const gh = (a, opts = {}) => execFileSync('gh', a, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'], ...opts });
const repoOf = (o) => o.repo || process.env.GITHUB_REPOSITORY || gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']).trim();
const listOpen = (repo) => JSON.parse(gh(['pr', 'list', '-R', repo, '--state', 'open', '--limit', '100', '--json', 'number,title,url,headRefName,headRefOid,isDraft,labels,statusCheckRollup']));
function editLabels(repo, n, { add = [], remove = [] }) {
  const a = ['pr', 'edit', String(n), '-R', repo];
  for (const l of add) a.push('--add-label', l);
  for (const l of remove) a.push('--remove-label', l);
  gh(a);
}
function printList(list, gate) { console.log(JSON.stringify(list, null, 2)); if (gate && !list.length) console.log(JSON.stringify({ wakeAgent: false })); }

function main(argv) {
  const [cmd, ...rest] = argv; const o = args(rest);
  if (cmd === 'route') {
    if (!o.pr || !o.branch) throw new Error('route needs --pr and --branch');
    const repo = repoOf(o); const plan = routeLabels(o.branch);
    // Removing a label the pull request does not have is an error in gh, so only remove what is there.
    const have = new Set(JSON.parse(gh(['pr', 'view', String(o.pr), '-R', repo, '--json', 'labels', '-q', '[.labels[].name]'])));
    editLabels(repo, o.pr, { add: plan.add, remove: plan.remove.filter((l) => have.has(l)) });
    console.log(`#${o.pr} (${o.branch}) → ${plan.add.join(', ')}`);
  } else if (cmd === 'queue' || cmd === 'mine') {
    if (!o.me) throw new Error(`${cmd} needs --me`);
    const prs = listOpen(repoOf(o));
    printList(cmd === 'queue' ? queue(prs, o.me) : mine(prs, o.me), o.gate);
  } else if (cmd === 'verdict') {
    for (const k of ['pr', 'sha', 'me', 'result', 'body-file']) if (!o[k]) throw new Error(`verdict needs --${k}`);
    const repo = repoOf(o);
    const pr = JSON.parse(gh(['pr', 'view', String(o.pr), '-R', repo, '--json', 'number,headRefName,headRefOid,labels']));
    // A verdict belongs to the commit that was reviewed. If the author pushed
    // since, this review is stale and the new head goes back in the queue.
    if (pr.headRefOid !== o.sha) throw new Error(`#${o.pr} moved from ${o.sha.slice(0, 7)} to ${pr.headRefOid.slice(0, 7)} during the review; review the new head`);
    const plan = verdictPlan({ pr, me: o.me, result: o.result });
    const body = `${plan.header}\n\nReviewed commit \`${o.sha.slice(0, 7)}\`.\n\n${fs.readFileSync(o['body-file'], 'utf8').trim()}\n`;
    gh(['pr', 'comment', String(o.pr), '-R', repo, '--body-file', '-'], { input: body });
    gh(['api', '-X', 'POST', `repos/${repo}/statuses/${o.sha}`, '-f', `state=${plan.status.state}`, '-f', `context=${plan.status.context}`, '-f', `description=${plan.status.description}`], { stdio: ['pipe', 'ignore', 'inherit'] });
    const have = new Set(labelNames(pr));
    editLabels(repo, o.pr, { add: plan.add, remove: plan.remove.filter((l) => have.has(l)) });
    console.log(`#${o.pr}: ${plan.status.description}`);
  } else {
    console.error('usage: agent-review.js route|queue|mine|verdict (see the top of this file)');
    process.exitCode = 2;
  }
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(`agent-review: ${e.message}`); process.exitCode = 1; }
}
module.exports = { AGENTS, STATUS, authorOf, reviewerFor, routeLabels, queue, mine, verdictPlan };
