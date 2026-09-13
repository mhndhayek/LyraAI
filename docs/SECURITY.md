# Security gate

**Status: planned, not yet built.** This page is the plan for the security checks
that will join the [quality gate](QA.md), and the record of what each one proves.
The work happens in phases on this branch; the checklist at the bottom tracks it.
Once phase 1 lands, this page describes the gate the way QA.md describes the
quality gate.

## What "free of malware" can and cannot mean

No scanner proves the absence of malware, and a page claiming one does would be
wrong. What CI *can* establish, and publish the evidence for, is:

1. **The source was analysed** for the vulnerability classes that turn an app into
   an attack surface: command and path injection, unsafe Electron settings, XSS in
   the renderer, secrets in the tree. *(CodeQL, SonarCloud, Electronegativity)*
2. **Every dependency is what it says it is**: pinned in the lockfile, fetched only
   from `registry.npmjs.org` over HTTPS with an integrity hash, and free of known
   advisories, including npm's malware advisories. *(npm audit, dependency review,
   lockfile-lint)*
3. **The installers people download are the ones CI built** from the reviewed
   commit, not something swapped in afterwards. *(build provenance attestation,
   SHA-256 checksums)*
4. **Those installers pass an antivirus engine** before they are published, and
   optionally seventy of them. *(ClamAV, VirusTotal)*

Together, someone downloading Lyra can check for themselves that the binary matches
the source that was reviewed and scanned. The gap that remains is OS-level code
signing (Apple notarization, Windows Authenticode). The release workflow already
supports it through `CSC_LINK`; it needs a certificate, not CI work, and it is what
makes the SmartScreen and Gatekeeper warnings go away.

## The options

| Check | Tool | What it catches | Needs from the owner |
| --- | --- | --- | --- |
| Static analysis | **CodeQL** (`github/codeql-action`) | injection, path traversal, XSS in the renderer, insecure Electron options; JavaScript and Python | nothing: free on public repos, results in the Security tab |
| Static analysis with a quality gate | **SonarCloud** (`sonarsource/sonarqube-scan-action`) | vulnerabilities, security hotspots, bugs, duplication, coverage; a public dashboard and a badge | a SonarCloud organisation bound to the GitHub account, a project for this repo, a `SONAR_TOKEN` secret |
| Electron hardening | **Electronegativity** (`@doyensec/electronegativity`) | `nodeIntegration`, `contextIsolation`, `sandbox`, `webSecurity`, missing CSP, `openExternal` with untrusted input | nothing |
| New dependencies on pull requests | **dependency-review-action** | a PR that adds a package with a known vulnerability or a malware advisory, or an unacceptable licence | nothing |
| Lockfile integrity | **lockfile-lint** | a lockfile entry that resolves anywhere but `registry.npmjs.org`, over plain HTTP, or without its integrity hash | nothing |
| Known vulnerabilities | **npm audit** | already in CI | nothing |
| Secrets in the tree | **gitleaks**, or GitHub secret scanning | committed tokens and keys, across the whole history | gitleaks: nothing on a personal account. GitHub secret scanning and push protection: a settings toggle |
| The installers | **ClamAV** (`clamscan`) | known malware signatures inside the `.dmg`, `.zip`, `.exe`, `.AppImage`, `.deb` and `.tar.gz` | nothing |
| Public multi-engine verdict | **VirusTotal** (`crazy-max/ghaction-virustotal`) | the same installers checked by 70+ engines, with a permanent public report linked from the release | a `VT_API_KEY` secret (free tier: 4 requests a minute, 500 a day) |
| Provenance | **`actions/attest-build-provenance`** and `SHA256SUMS.txt` | a binary that was not built by this workflow from this commit; a download that was modified in transit | nothing |
| Repository posture | **OpenSSF Scorecard** | unpinned actions, missing branch protection, tokens with too many permissions; a public score and a badge | nothing |

Semgrep is the usual alternative to SonarCloud when no external account is wanted.
It is not in the plan because CodeQL already covers that role for free, and
SonarCloud is the tool that was asked for.

## The decision

Three phases. Phase 1 needs no accounts or secrets and can merge as soon as it is
green. Phase 2 is SonarCloud, the tool that was asked for; it needs about fifteen
minutes of owner setup first. Phase 3 is the optional extras, one pull request each.

### Phase 1: no secrets, blocking through the QA Gate

Every new job goes in `ci.yml` and is listed under `needs:` of `gate`, so it blocks
merges without touching branch protection ([QA.md](QA.md) explains why). Release
reuses `ci.yml`, so every release is held to the same checks.

| Job | Runs on | What it does |
| --- | --- | --- |
| `codeql` | Linux | `github/codeql-action` init, autobuild and analyze for `javascript-typescript` and `python`, with the `security-extended` query pack. A config file at `.github/codeql/codeql-config.yml` ignores `renderer/vendor/**`, `renderer/character/**`, `docs/examples/**` and `assets/**`. Results land in the Security tab and as annotations on the pull request. |
| `dependencies` | Linux | `actions/dependency-review-action` with `fail-on-severity: high` and a licence allow-list. The action only works on `pull_request` events, so the **step** is conditional, never the job: the gate counts a skipped job as a failure. On a push the job passes with a notice. |
| `scan-installers` | Linux, `needs: build` | Downloads the three `installers-*` artifacts and runs ClamAV over all of them with `--alert-exceeds-max`, so a file too large to scan fails the job instead of silently passing. `--max-filesize` and `--max-scansize` are raised above the defaults, because an Electron installer is bigger than them. The report is kept as an artifact; any infected file fails the job. |

Also in phase 1:

- A `lockfile-lint` step in the existing `static` job:
  `lockfile-lint --path package-lock.json --type npm --allowed-hosts npm --validate-https --validate-integrity`.
  `lockfile-lint` becomes a devDependency so the check itself is pinned by the lockfile.
- In `release.yml`, after each platform builds, `actions/attest-build-provenance`
  signs a provenance attestation for every installer (job permissions `id-token: write`
  and `attestations: write`). The publish job writes `SHA256SUMS.txt` over the
  collected installers, runs the ClamAV scan once more on the exact files about to go
  public, and attaches the checksums to the release. Anyone can then run
  `gh attestation verify <file> --owner mhndhayek`.
- `docs/QA.md` gains the new rows in "What CI runs"; the README gains a **Security**
  line that points here; the pull request template gains a checkbox for changes that
  touch the shell, the loader or the renderer's HTML.
- `npm run security` (`scripts/security.sh`): the local equivalent, in the spirit of
  `npm run qa`. Runs lockfile-lint, `npm audit --audit-level=high`, and a ClamAV scan
  of `dist/` when `clamscan` is installed. CodeQL and SonarCloud have no local run;
  SonarLint in the editor covers the second.

Permissions are granted per job, never at the top of the workflow: `codeql` needs
`security-events: write`; `dependencies` needs `pull-requests: write` for its summary
comment; everything else keeps the workflow default of `contents: read`.

**CodeQL starts as report-only.** The job passes when analysis completes, and the
initial alerts are triaged (see below). Once the backlog is clean, a final step asks
the code-scanning API for open `error`-severity alerts on the head commit and fails
the job on any. That makes CodeQL blocking through the gate without adding a second
required check to branch protection.

### Phase 2: SonarCloud

Owner setup, once:

1. Sign in at [sonarcloud.io](https://sonarcloud.io) with GitHub, create an
   organisation for `mhndhayek` and import `LyraAI`. Public repos are on the free plan.
2. In the project's **Administration → Analysis Method**, turn **Automatic Analysis
   off**. It conflicts with CI-based analysis.
3. Generate a token under **My Account → Security** and add it to the repository as
   the secret `SONAR_TOKEN`.
4. Copy the organisation key and the project key into `sonar-project.properties`.

In the repository:

- `sonar-project.properties`: sources `main,renderer,preload.js,scripts,voice`; tests
  `test`; exclusions `renderer/vendor/**,renderer/character/**,docs/**,assets/**`;
  `sonar.javascript.lcov.reportPaths=coverage/lcov.info`.
- A `sonar` job in `ci.yml`. It checks out with `fetch-depth: 0` (Sonar needs the
  history to tell new code from old), runs the test suite with Node's `lcov` reporter
  written to `coverage/lcov.info`, then `sonarsource/sonarqube-scan-action` and
  `sonarsource/sonarqube-quality-gate-action`, so the job fails when the quality gate
  fails.
- A pull request from a fork cannot see `SONAR_TOKEN`, and a job cannot test a secret
  in its `if:`. So the job exports the secret into its `env` and every step carries
  `if: env.SONAR_TOKEN != ''`, with a last step that prints a notice when the scan was
  skipped. The job passes on forks and is blocking everywhere else.
- Badge in the README:
  `https://sonarcloud.io/api/project_badges/measure?project=<project key>&metric=alert_status`.

Start with Sonar's default "Sonar way" quality gate. It wants 80% coverage on new
code, which may block unrelated work; if it does, lower that one condition on the
project's Quality Gates page rather than skipping the check.

### Phase 3: optional extras, one pull request each

- **VirusTotal** in `release.yml`, after publish: uploads the installers, waits for
  the analysis and appends the report links to the release notes. Needs `VT_API_KEY`.
  The installers are larger than the 32 MB simple-upload limit; the action switches to
  the large-file upload URL (up to 650 MB) on its own.
- **OpenSSF Scorecard** in its own `scorecard.yml`, on push to `main` and weekly,
  publishing to the Scorecard API for the badge. Its first report will ask for the
  housekeeping listed below.
- **gitleaks** as a job that scans the full history on every push. Free for personal
  accounts; organisations need `GITLEAKS_LICENSE`. The no-CI alternative is
  **Settings → Code security → Secret scanning** and **Push protection**, both free on
  public repos.
- **Electronegativity** as a job that writes SARIF, uploaded through
  `github/codeql-action/upload-sarif` so its findings sit next to CodeQL's in the
  Security tab.

## What the scanners will find first

Lyra runs shell commands, rewrites its own organs, loads extension code and renders
model output as HTML. That is the product, and every static analyser will flag it.
The rule is to triage each alert, never to exclude the files.

| Where | Why it is flagged | What covers it today |
| --- | --- | --- |
| `main/organs/shell.js` | `execFile('/bin/zsh', ['-lc', command])` with a command the agent chose | `guard.shellBlocked`, the approval gate and the write budget, with tests in `test/kernel` and `test/organs` |
| `main/kernel/loader.js`, `main/kernel/extensions.js`, `main/kernel/verify-child.js` | loading and running code the agent wrote | verification in a child process, quarantine and rollback, exercised by `npm run selftest` |
| `main/kernel/checkpoints.js`, `main/organs/workspace.js` | `git` through `child_process` | `execFileSync` with a fixed argument list and no shell |
| `renderer/app.js`, `renderer/mobile/app.js`, `renderer/settings.js` | `innerHTML` with markdown from the model | the text is HTML-escaped before `marked` parses it, so raw HTML from the model is inert. Confirm the mobile page and the settings page do the same; that is the one place a real fix may be needed |
| `main/main.js` | the main window runs with `sandbox: false`; `setWindowOpenHandler` passes any URL to `shell.openExternal` | `contextIsolation: true` and `nodeIntegration: false` are set. Restricting `openExternal` to `http`, `https` and `mailto` is a real fix worth making in phase 1 |
| `main/organs/browser.js` | an in-app browser | its views run with `sandbox: true`, `contextIsolation: true` and their own partition |

Triage rules:

- A finding is fixed, or dismissed in the Security tab (or marked reviewed in Sonar)
  with a reason that names the guardrail or the test that covers it. No dismissal
  without a reason.
- Config exclusions are only for code we did not write (`renderer/vendor/**`), images
  (`renderer/character/**`, `assets/**`) and the sample extension in `docs/examples/`.
- A finding in the kernel gets the same treatment as a kernel change in
  [CONTRIBUTING.md](../CONTRIBUTING.md): a test that shows the boundary still holds.

## Housekeeping the scanners will ask for

- **Pin every third-party action to a commit SHA** with the version in a comment.
  Scorecard and Sonar both flag `@v7`-style tags. Dependabot already updates actions
  monthly and keeps SHA pins current. Do it in phase 1, while the workflows are open
  anyway.
- **Permissions per job**, as above.
- **In Settings → Code security and analysis**, turn on Dependabot alerts, Secret
  scanning, Push protection and Private vulnerability reporting. Leave code scanning's
  **default setup off**: the `codeql` job in `ci.yml` is the advanced setup, and the
  two conflict.

## Acceptance

Phase 1 is done when:

- a pull request that adds a package with a known high-severity advisory is blocked
  by the gate;
- a one-off run with the EICAR test file (the harmless standard antivirus test string)
  dropped into an installer artifact fails `scan-installers`, proving the scanner reads
  the files;
- `gh attestation verify` passes for every file attached to a release, and
  `sha256sum -c SHA256SUMS.txt` passes over them;
- the QA Gate lists the new jobs, and the README shows the Security line.

Phase 2 is done when the Sonar badge on the README reads "passed", a pull request
that introduces a security hotspot fails the gate, and a pull request from a fork
still passes it.

## Checklist

Phase 1

- [ ] `codeql` job and `.github/codeql/codeql-config.yml`
- [ ] `dependencies` job with the step-level `pull_request` condition
- [ ] `scan-installers` job, with `--alert-exceeds-max`, and the EICAR proof run
- [ ] `lockfile-lint` step and devDependency
- [ ] Attestation and `SHA256SUMS.txt` in `release.yml`
- [ ] `openExternal` restricted to `http`, `https` and `mailto`
- [ ] Actions pinned to SHAs, permissions per job
- [ ] `scripts/security.sh` and `npm run security`
- [ ] `docs/QA.md` table, README Security line, pull request template checkbox
- [ ] Initial CodeQL alerts triaged, then the blocking step turned on

Phase 2

- [ ] Owner: SonarCloud organisation and project, Automatic Analysis off, `SONAR_TOKEN`
- [ ] `sonar-project.properties`
- [ ] `sonar` job with the coverage report and the quality-gate step
- [ ] Sonar badge in the README

Phase 3

- [ ] Owner: `VT_API_KEY`, then VirusTotal on release
- [ ] OpenSSF Scorecard and badge
- [ ] gitleaks, or the secret-scanning settings
- [ ] Electronegativity

Owner, any time

- [ ] Settings → Code security: Dependabot alerts, Secret scanning, Push protection,
      Private vulnerability reporting on; code scanning default setup off

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: the repository's **Security** tab, then
**Report a vulnerability**. Please do not open a public issue for something that can
be exploited. The maintainer answers there.
