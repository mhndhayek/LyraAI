# Quality gate

Nothing reaches `main` without passing the same checks twice: once on your machine
with `npm run qa`, and once in CI on macOS, Windows and Linux. The merge button
stays grey until they pass.

## Running the gate locally

```sh
npm ci          # once
npm run qa      # the whole gate, in the order CI runs it
```

Individual steps, when you want a faster loop:

| Command | What it proves |
| --- | --- |
| `npm run check:syntax` | Every shipped JavaScript file parses |
| `npm run lint` | No undefined names, dead variables or unreachable code |
| `npm run test:unit` | The kernel, the organs and the feature wiring behave |
| `npm run selftest` | The app recovers from organs that were broken on purpose |
| `npm run smoke` | The real app starts, renders its window and reports no errors |
| `npm run test:coverage` | The same tests, with a coverage report |

## What CI runs

| Job | Where | What it catches |
| --- | --- | --- |
| **Lint and syntax** | Linux | Code that would not parse or run; a lockfile out of step with `package.json` |
| **Unit tests** | Linux, macOS, Windows, Node 20 and 22 | Behaviour changes in the kernel and the organs, on every platform the app ships to |
| **Kernel self-test** | Linux, macOS, Windows | Verification, rollback, quarantine, guardrails and the write budget, exercised against deliberately broken organs inside the real app |
| **App smoke test** | Linux, macOS, Windows | A window that does not render, a first boot that does not lay out its state folder, an app that falls into safe mode |
| **Build installers** | Linux, macOS, Windows | A build that does not compile, ships an incomplete bundle, or produces an app that cannot start |
| **Dependency audit** | Linux | Known high-severity vulnerabilities in dependencies |
| **QA Gate** | Linux | The single check branch protection requires. It passes only when all of the above did |

Adding a job to `ci.yml` and listing it under `needs:` of the `gate` job is enough
to make it blocking — the branch protection rule never has to change.

## What the tests cover

- **`test/kernel/`** — guardrails (locked settings, forbidden paths, blocked shell
  commands, the daily write budget), settings defaults and migrations, both storage
  backends and the migration between them, the folder layout and the Nova→Lyra
  adoption, log redaction and retention, checkpoints and rollback against a real git
  repository, extension manifests, capability approval and quarantine, and the organ
  loader's verification of broken code.
- **`test/organs/`** — the tool registry and its switches, the approval gate
  (including the phone limit), context compression, the model client against a local
  stand-in for LM Studio, Ollama and llama.cpp, and the workspace helpers.
- **`test/features/`** — the wiring that makes the app whole: every call the UI can
  make has a handler, every organ is documented and loaded, every settings section
  has a page, every theme is complete, and the build config ships what the app needs.

## Merging

`main` is protected. A change gets in by pull request, with:

- the **QA Gate** check green,
- the branch up to date with `main`,
- a review from a code owner,
- and every review conversation resolved.

Run `sh scripts/setup-branch-protection.sh` once (needs repository admin and the
GitHub CLI) to apply that rule.

## Releasing

**Bumping the version is what ships a release.** Change `version` in `package.json`,
merge it to `main`, and the release workflow does the rest:

```sh
npm version patch --no-git-tag-version   # or minor / major
# commit, open a pull request, merge it
```

On that push it reruns the entire QA gate, compiles the installers on all three
operating systems, starts each packaged app once to prove it runs, then tags the
commit `vX.Y.Z` and publishes a GitHub release with everything attached:

| Platform | Artifacts |
| --- | --- |
| macOS | `.dmg` installer and `.zip`, for both Apple silicon and Intel |
| Windows | NSIS `.exe` installer and a portable `.exe` |
| Linux | `.AppImage`, `.deb` and `.tar.gz` |

Pushes to `main` that do not change the version build and test as usual and release
nothing, so ordinary merges never ship. Re-running a release for a version that is
already tagged does nothing either. Release notes are generated from the commits.

Two other ways in, for when you need them: pushing a `vX.Y.Z` tag yourself, or
running the workflow by hand from the Actions tab. A tag that disagrees with
`package.json` is refused rather than shipped under the wrong version.

Every platform is built and checked before anything is published, so a release is
never live with only some of its installers. If one platform fails to build, nothing
is released at all.

Builds are unsigned unless the signing secrets (`CSC_LINK`, `CSC_KEY_PASSWORD`) are
set on the repository. Unsigned is still installable: macOS needs right-click →
Open the first time, Windows shows SmartScreen's "more info → run anyway".

## Adding a test

Tests are plain `node:test` files — no framework, no config:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeKernel, cleanup } = require('../helpers/tmp');

test.after(cleanup);

test('the thing does what it promises', () => {
  const k = fakeKernel();          // a throwaway kernel: paths, settings, store, guard
  assert.equal(k.guard.shellBlocked('killall Electron') !== null, true);
});
```

Put it in `test/kernel/`, `test/organs/` or `test/features/` as `*.test.js` and it
is picked up automatically.
