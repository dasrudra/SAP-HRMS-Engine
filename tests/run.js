// Runs every suite in this directory.
//
//   node tests/run.js
//
// No dependencies, no build step, nothing to install. Each suite exits
// non-zero if anything in it failed, and so does this.
//
// WHY THESE LIVE IN THE REPOSITORY
// They did not, for most of this project's life. The suite ran from a
// scratch directory outside version control - twenty-one files, 1,339
// assertions - and when the machine it lived on was recycled, all of it went
// with it. The source survived because the source was committed. Tests that
// are not committed are not tests; they are a thing somebody remembers once
// having.
const fs = require('fs'), path = require('path');
const { execFileSync } = require('child_process');

const suites = fs.readdirSync(__dirname)
  .filter((f) => /-test\.js$/.test(f))
  .sort();

let failed = 0;
suites.forEach(function (file) {
  let output = '';
  let ok = true;
  try {
    output = execFileSync(process.execPath, [path.join(__dirname, file)],
                          { encoding: 'utf8' });
  } catch (e) {
    ok = false;
    failed++;
    output = String(e.stdout || '') + String(e.stderr || '');
  }
  const tally = (output.match(/\d+\/\d+ passed/g) || []).pop() || '(no result)';

  // A suite that skipped itself must not read as a suite that passed. The
  // browser ones skip on a machine with no Chromium, and "ok 0/0" beside two
  // real results is the kind of line somebody scans straight past.
  const skipped = /^SKIP\b/m.test(output);
  const label = skipped ? 'SKIP  ' : (ok ? 'ok    ' : 'FAIL  ');
  const note = skipped
    ? (output.match(/^SKIP\s+(.*)$/m) || [])[1] || 'skipped'
    : tally;
  console.log(label + file.padEnd(28) + note);
  if (!ok) console.log(output.split('\n').filter((l) => /^FAIL/.test(l))
                             .map((l) => '        ' + l).join('\n'));
});

console.log('\n' + suites.length + ' suite(s), ' +
            (failed ? failed + ' failed' : 'nothing failed'));
process.exit(failed ? 1 : 0);
