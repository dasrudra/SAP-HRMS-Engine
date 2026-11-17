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
  let crash = '';
  let ok = true;
  try {
    /*
      STDERR IS CAPTURED, NOT INHERITED.

      Left to itself, execFileSync pipes stdout and lets stderr through to
      the terminal untouched. A suite that dies on an unhandled rejection
      writes its whole stack there - and for a Playwright launch failure
      that is the entire Chromium command line and every browser log line,
      three hundred of them, once per suite. Ten suites failing the same
      way buried the summary under several thousand lines of the same
      thing, and the one sentence that mattered was in none of them twice.

      Captured, it goes through the same filter as everything else: the
      FAIL lines, and then the first few lines of whatever killed it.
    */
    output = execFileSync(process.execPath, [path.join(__dirname, file)],
                          { encoding: 'utf8',
                            stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    ok = false;
    failed++;
    output = String(e.stdout || '');
    crash = String(e.stderr || '').trim();
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
  if (!ok) {
    const said = output.split('\n').filter((l) => /^FAIL/.test(l));
    if (said.length) console.log(said.map((l) => '        ' + l).join('\n'));

    /*
      AND THE FIRST FEW LINES OF A CRASH, where there was one. A suite that
      died before it could report anything prints "(no result)" above, which
      says that something went wrong and nothing about what.
    */
    if (crash) {
      const head = crash.split('\n')
        .filter((l) => l.trim() && !/^\s*at /.test(l))
        .slice(0, 4);
      console.log(head.map((l) => '        | ' + l.trim()).join('\n'));
      const more = crash.split('\n').length - head.length;
      if (more > 0) {
        console.log('        | ... ' + more + ' more lines - run this suite ' +
                    'on its own to see them: node tests/' + file);
      }
    }
  }
});

console.log('\n' + suites.length + ' suite(s), ' +
            (failed ? failed + ' failed' : 'nothing failed'));
process.exit(failed ? 1 : 0);
