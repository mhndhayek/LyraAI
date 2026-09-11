#!/usr/bin/env node
// Runs the kernel self-test inside the real app: it breaks organs on purpose and
// checks that verification, rollback, quarantine, the guardrails and the budget
// all behave. Prints the report and fails the build if any check did not pass.
const { run } = require('./electron-run');

run(['--kernel-test'], { timeoutMs: 240000 })
  .then(({ code, stdout }) => {
    const start = stdout.indexOf('[selftest] ');
    if (start === -1) {
      console.error('✗ the kernel self-test never reported; the app failed to start');
      process.exit(1);
    }
    let report;
    try { report = JSON.parse(stdout.slice(start + '[selftest] '.length)); }
    catch (e) { console.error('✗ the self-test report could not be read:', e.message); process.exit(1); }

    const failed = report.results.filter((r) => !r.pass);
    for (const r of report.results) console.log(`${r.pass ? '✓' : '✗'} ${r.name}`);
    if (failed.length || !report.pass || code !== 0) {
      console.error(`\n✗ kernel self-test failed (${failed.length} of ${report.results.length} checks, exit ${code})`);
      for (const r of failed) console.error(`  ${r.name}: ${JSON.stringify(r.detail)}`);
      process.exit(1);
    }
    console.log(`\n✓ kernel self-test passed (${report.results.length} checks)`);
  })
  .catch((e) => { console.error('✗', e.message); process.exit(1); });
