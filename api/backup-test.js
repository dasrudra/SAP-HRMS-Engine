/**
 * backup-test.js - the backup, and the one thing it must never do.
 * ===========================================================================
 *
 *     cd api
 *     node backup-test.js
 *
 * NEEDS THE DATABASE AND pg_dump, NOT THE SERVER. It writes its dumps into
 * a temporary folder and deletes them, and it never touches BACKUP_DIR.
 *
 *
 * WHY THIS FILE IS MOSTLY ABOUT PRUNING
 *
 * There are two kinds of bug in a backup system. The first kind means you
 * do not have a backup, and you find out on a bad day. The second kind
 * means the backup deleted something, and that one you cause yourself.
 *
 * toPrune() deletes files. There is no Recycle Bin for a file deleted by a
 * script. The only thing between "delete everything past the newest thirty"
 * and "delete the quarterly report somebody left in that folder" is that
 * parseBackupName() refuses to recognise anything this system did not
 * write, so most of what is below is pointed at that one function from
 * every angle a wrong name can come from.
 *
 * The second half takes a real dump of the real database, reads it back,
 * prunes it, and checks the row that gets written to backup_run.
 *
 *
 * EVERY DUMP IT TAKES IS NAMED IN 2099, and backup_run rows for 2099 are
 * deleted at the start of a run as well as at the end - so a run that dies
 * halfway does not leave a row that the Summary screen would then report as
 * the last backup. Same reserved-namespace rule as the 2099xxxx employee
 * IDs and the 2019 and 2099 KPI months.
 */

require('dotenv').config();

const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('./db');
const backup = require('./backup');

let pass = 0, fail = 0, notes = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '   ' + detail : '')); }
}
function note(text) { notes++; console.log('  --   ' + text); }

function threw(fn) {
  try { fn(); return false; } catch (e) { return true; }
}

/** A valid backup file name for a given 2099 stamp. */
function nm(s) { return 'tvl-eas-backup-' + s + '.dump'; }


async function main() {
  console.log('');

  // =======================================================================
  console.log('  stamp() - and the timezone that is not decoration');
  // =======================================================================
  /*
    Dhaka is UTC+6 and does not observe daylight saving. A backup that runs
    at 02:30 local time is 20:30 the previous day in UTC, so a file named
    from UTC carries yesterday's date - and the day somebody restores "the
    one from the 22nd" they get the wrong file, with nothing on screen to
    suggest it.
  */
  check('20:30Z becomes 02:30 the next day',
        backup.stamp(new Date('2026-11-21T20:30:00Z')) === '2026-11-22-0230',
        backup.stamp(new Date('2026-11-21T20:30:00Z')));

  check('18:00Z becomes midnight, written 0000 and not 2400',
        backup.stamp(new Date('2026-11-21T18:00:00Z')) === '2026-11-22-0000',
        backup.stamp(new Date('2026-11-21T18:00:00Z')));

  check('02:00 Dhaka, the hour the task runs',
        backup.stamp(new Date('2026-11-21T20:00:00Z')) === '2026-11-22-0200');

  check('a single digit day and month are padded',
        backup.stamp(new Date('2026-01-02T03:04:00Z')) === '2026-01-02-0904');

  check('backupFileName wraps the stamp in the prefix and extension',
        backup.backupFileName(new Date('2026-11-21T20:00:00Z')) ===
        'tvl-eas-backup-2026-11-22-0200.dump');

  check('a name has no spaces in it',
        !/\s/.test(backup.backupFileName(new Date())));


  // =======================================================================
  console.log('');
  console.log('  parseBackupName() - the guard in front of a delete');
  // =======================================================================
  const good = backup.parseBackupName('tvl-eas-backup-2026-11-22-0200.dump');
  check('a name this system wrote is recognised', good !== null);
  check('the stamp comes back', good && good.stamp === '2026-11-22-0200');
  check('at sorts chronologically without a Date',
        good && good.at === 202611220200);

  check('a later file sorts above an earlier one',
        backup.parseBackupName(nm('2026-11-22-0200')).at >
        backup.parseBackupName(nm('2026-11-21-2359')).at);

  // Every one of these is a file that could plausibly sit in that folder.
  [
    ['the CSV export',               'TICKETS.csv'],
    ['a Word document',              'Quarterly review.docx'],
    ['a plain SQL dump',             'tvl-eas-backup-2026-11-22-0200.sql'],
    ['no extension',                 'tvl-eas-backup-2026-11-22-0200'],
    ['a different system',           'hrms-backup-2026-11-22-0200.dump'],
    ['upper case',                   'TVL-EAS-BACKUP-2026-11-22-0200.DUMP'],
    ['a trailing copy marker',       'tvl-eas-backup-2026-11-22-0200.dump.bak'],
    ['Windows duplicate',            'tvl-eas-backup-2026-11-22-0200 (1).dump'],
    ['a two digit year',             'tvl-eas-backup-26-11-22-0200.dump'],
    ['a thirteenth month',           'tvl-eas-backup-2026-13-22-0200.dump'],
    ['a thirty second day',          'tvl-eas-backup-2026-11-32-0200.dump'],
    ['hour 24',                      'tvl-eas-backup-2026-11-22-2400.dump'],
    ['minute 60',                    'tvl-eas-backup-2026-11-22-0260.dump'],
    ['month 00',                     'tvl-eas-backup-2026-00-22-0200.dump'],
    ['day 00',                       'tvl-eas-backup-2026-11-00-0200.dump'],
    ['a path, not a name',           '../tvl-eas-backup-2026-11-22-0200.dump'],
    ['the empty string',             ''],
    ['something with the right shape and the wrong separators',
                                     'tvl-eas-backup-2026_11_22_0200.dump']
  ].forEach(function (pair) {
    check('not a backup: ' + pair[0], backup.isBackupFile(pair[1]) === false,
          pair[1]);
  });

  check('null and undefined are not backups',
        backup.isBackupFile(null) === false &&
        backup.isBackupFile(undefined) === false);


  // =======================================================================
  console.log('');
  console.log('  toPrune() - what gets deleted, and what never does');
  // =======================================================================
  const five = [nm('2026-11-18-0200'), nm('2026-11-19-0200'),
                nm('2026-11-20-0200'), nm('2026-11-21-0200'),
                nm('2026-11-22-0200')];

  check('keeping 2 of 5 deletes the oldest 3',
        JSON.stringify(backup.toPrune(five, 2)) ===
        JSON.stringify([nm('2026-11-18-0200'), nm('2026-11-19-0200'),
                        nm('2026-11-20-0200')]));

  check('the list comes back oldest first',
        backup.toPrune(five, 1)[0] === nm('2026-11-18-0200'));

  check('keeping 5 of 5 deletes nothing',
        backup.toPrune(five, 5).length === 0);

  check('keeping 30 of 5 deletes nothing',
        backup.toPrune(five, 30).length === 0);

  check('keeping 1 leaves the newest',
        backup.toPrune(five, 1).indexOf(nm('2026-11-22-0200')) === -1);

  /*
    THE ONE THAT MATTERS. The folder is a folder: a synced cloud folder has
    a desktop.ini in it, somebody will save a spreadsheet there, and an
    interrupted copy leaves a .part file. None of them may ever be returned
    by a function whose output goes straight into unlinkSync.
  */
  const messy = five.concat([
    'TICKETS.csv', 'desktop.ini', 'Thumbs.db', 'notes.txt',
    'Quarterly review.docx', 'tvl-eas-backup-2026-13-01-0200.dump',
    'tvl-eas-backup-2026-11-17-0200.dump.part', '.gitignore'
  ]);
  const pruned = backup.toPrune(messy, 1);
  check('a messy folder still only yields backups',
        pruned.every(backup.isBackupFile), pruned.join(' '));
  check('nothing that is not a backup is ever returned',
        pruned.length === 4 &&
        ['TICKETS.csv', 'desktop.ini', 'Thumbs.db', 'notes.txt',
         'Quarterly review.docx', 'tvl-eas-backup-2026-13-01-0200.dump',
         'tvl-eas-backup-2026-11-17-0200.dump.part', '.gitignore']
          .every(function (f) { return pruned.indexOf(f) === -1; }),
        pruned.join(' '));

  check('the order files arrive in does not matter',
        JSON.stringify(backup.toPrune(five.slice().reverse(), 2)) ===
        JSON.stringify(backup.toPrune(five, 2)));

  check('an empty folder prunes nothing', backup.toPrune([], 30).length === 0);

  // A typo in a config value must not be able to delete every copy.
  check('keep 0 throws rather than deleting everything',
        threw(function () { backup.toPrune(five, 0); }));
  check('keep -1 throws', threw(function () { backup.toPrune(five, -1); }));
  check('keep 1.5 throws', threw(function () { backup.toPrune(five, 1.5); }));
  check('keep "two" throws', threw(function () { backup.toPrune(five, 'two'); }));
  check('keep undefined throws',
        threw(function () { backup.toPrune(five, undefined); }));
  check('BACKUP_KEEP itself is accepted',
        !threw(function () { backup.toPrune(five, backup.BACKUP_KEEP); }));


  // =======================================================================
  console.log('');
  console.log('  The command lines');
  // =======================================================================
  const args = backup.dumpArgs({ host: 'h', port: 5433, user: 'u',
                                 database: 'd', file: 'f.dump' });

  check('pg_dump is told not to ask for a password',
        args.indexOf('--no-password') !== -1);
  check('the format is custom',
        args[args.indexOf('--format') + 1] === 'custom');
  check('the file is passed with --file',
        args[args.indexOf('--file') + 1] === 'f.dump');
  check('the port is a string, as spawn requires',
        typeof args[args.indexOf('--port') + 1] === 'string');

  /*
    A password on a command line is readable by every user on the machine,
    in Task Manager and in `wmic process`. It goes in the child process's
    environment instead.
  */
  const withSecret = backup.dumpArgs({ host: 'h', port: 1, user: 'u',
                                       database: 'd', file: 'f',
                                       password: 'hunter2' });
  check('the password is nowhere on the command line',
        withSecret.join(' ').indexOf('hunter2') === -1);

  const rargs = backup.restoreArgs({ host: 'h', port: 1, user: 'u',
                                     database: 'target', file: 'f.dump' });
  check('restore leaves owners out', rargs.indexOf('--no-owner') !== -1);
  check('restore leaves grants out', rargs.indexOf('--no-privileges') !== -1);
  check('restore is all or nothing',
        rargs.indexOf('--single-transaction') !== -1);
  check('the file is the last argument', rargs[rargs.length - 1] === 'f.dump');
  check('restore goes to the named database, not PGDATABASE',
        rargs[rargs.indexOf('--dbname') + 1] === 'target');


  // =======================================================================
  console.log('');
  console.log('  countQueryFor() - SQL built by concatenation, on purpose');
  // =======================================================================
  check('one table, one SELECT',
        backup.countQueryFor(['team']) ===
        "SELECT 'team' AS t, count(*)::bigint AS n FROM team");
  check('three tables are joined with UNION ALL',
        backup.countQueryFor(['a', 'b', 'c']).split('UNION ALL').length === 3);
  check('no tables gives no query', backup.countQueryFor([]) === '');
  check('undefined gives no query', backup.countQueryFor(undefined) === '');

  [
    'team; DROP TABLE team',
    'team"',
    "team'",
    'Team',
    'public.team',
    '1team',
    'team-import',
    'team table',
    ''
  ].forEach(function (bad) {
    check('refuses a table named ' + JSON.stringify(bad),
          threw(function () { backup.countQueryFor([bad]); }));
  });

  check('a legitimate underscore name is accepted',
        backup.countQueryFor(['msg_thread']).indexOf('msg_thread') !== -1);


  // =======================================================================
  console.log('');
  console.log('  formatBytes() and isStale()');
  // =======================================================================
  check('0 B', backup.formatBytes(0) === '0 B');
  check('1023 B', backup.formatBytes(1023) === '1023 B');
  check('1024 is 1 KB', backup.formatBytes(1024) === '1 KB');
  check('1536 is 1.5 KB', backup.formatBytes(1536) === '1.5 KB');
  check('a megabyte', backup.formatBytes(1048576) === '1 MB');
  check('four and a bit megabytes',
        backup.formatBytes(4509715) === '4.3 MB', backup.formatBytes(4509715));
  check('a gigabyte', backup.formatBytes(1073741824) === '1 GB');
  check('nonsense is 0 B', backup.formatBytes('x') === '0 B');

  const now = new Date('2026-11-22T06:00:00Z').getTime();
  check('never backed up counts as stale', backup.isStale('', now) === true);
  check('an hour ago is fine',
        backup.isStale('2026-11-22T05:00:00Z', now) === false);
  check('exactly 36 hours is not yet stale',
        backup.isStale('2026-11-20T18:00:00Z', now) === false);
  check('36 hours and a minute is stale',
        backup.isStale('2026-11-20T17:59:00Z', now) === true);
  check('a week ago is stale',
        backup.isStale('2026-11-15T06:00:00Z', now) === true);
  check('an unreadable date counts as stale',
        backup.isStale('not a date', now) === true);
  check('the limit can be overridden',
        backup.isStale('2026-11-22T00:00:00Z', now, 3) === true &&
        backup.isStale('2026-11-22T00:00:00Z', now, 12) === false);


  // =======================================================================
  console.log('');
  console.log('  insideRepo() and pgTool()');
  // =======================================================================
  const root = backup.repoRoot();
  check('the repository root is inside the repository',
        backup.insideRepo(root) === true);
  check('api/ is inside the repository',
        backup.insideRepo(path.join(root, 'api')) === true);
  check('the default backups folder is inside, which is why it warns',
        backup.insideRepo(path.join(root, 'backups')) === true);
  check('a temporary folder is not',
        backup.insideRepo(os.tmpdir()) === false);
  /*
    startsWith(root) alone would call this one inside the repository, and
    then warn about a folder that is correctly placed - a false alarm that
    teaches people to ignore the real one.
  */
  check('a sibling folder whose name starts the same is not inside',
        backup.insideRepo(root + '-backups') === false);


  // =======================================================================
  console.log('');
  console.log('  mkdirProblem() - the message that stops the wrong fix');
  // =======================================================================
  /*
    The raw ENOENT from mkdir reads like a mistyped folder name, so the
    natural response is to try a different folder name - which fails in
    exactly the same way, because the drive was never there. The message
    has to say which of the two it is.
  */
  const noDrive = backup.mkdirProblem(
    path.join('G:', 'My Drive', 'TVL-EAS Backups'),
    'ENOENT: no such file or directory, mkdir', false);

  /*
    The raw text is REPLACED, not appended to. "no such file or directory,
    mkdir 'G:\\My Drive\\Backups'" is the sentence that sends people off to
    rename the folder, and leaving it in the message leaves the wrong fix
    on screen next to the right one.
  */
  check('the misleading raw ENOENT text is not repeated',
        noDrive.indexOf('no such file or directory') === -1, noDrive);
  check('and it says the folder name is not the problem',
        /not the folder/.test(noDrive));
  check('and it names the folder that was wanted',
        noDrive.indexOf('TVL-EAS Backups') !== -1);
  /*
    THE WHOLE COMMAND, not just its first word. `Get-PSDrive -PSProvider`
    with the provider missing is a syntax error, so a message carrying half
    of it hands somebody a command that fails - which is worse than giving
    them no command at all. Mutation testing found this: deleting
    'FileSystem' left a broken line and every assertion still passed.
  */
  check('and it says how to find out what drives exist, in full',
        noDrive.indexOf('Get-PSDrive -PSProvider FileSystem') !== -1, noDrive);
  check('and it explains why a cloud folder may have no letter',
        /desktop app/.test(noDrive));

  const otherFault = backup.mkdirProblem(
    path.join(os.tmpdir(), 'somewhere'), 'EACCES: permission denied', true);
  check('any other failure keeps its own reason',
        /EACCES: permission denied/.test(otherFault), otherFault);
  check('and does not blame the drive',
        /not the folder/.test(otherFault) === false);
  check('and still names the folder',
        otherFault.indexOf('somewhere') !== -1);

  const hadBin = process.env.PG_BIN;
  delete process.env.PG_BIN;
  check('with no PG_BIN the tool is looked up on PATH',
        backup.pgTool('pg_dump') === (process.platform === 'win32'
                                      ? 'pg_dump.exe' : 'pg_dump'));
  process.env.PG_BIN = path.join('C:', 'PostgreSQL', 'bin');
  check('with PG_BIN the tool is a full path',
        backup.pgTool('pg_dump') ===
        path.join('C:', 'PostgreSQL', 'bin',
                  process.platform === 'win32' ? 'pg_dump.exe' : 'pg_dump'));

  // A missing tool must say what to do about it, not just ENOENT.
  process.env.PG_BIN = path.join(os.tmpdir(), 'no-such-postgres-bin');
  const missing = backup.run(backup.pgTool('pg_dump'), ['--version'], '');
  check('a missing pg_dump names PG_BIN in the error',
        missing.ok === false && /PG_BIN/.test(missing.err), missing.err);
  if (hadBin === undefined) delete process.env.PG_BIN;
  else process.env.PG_BIN = hadBin;


  // =======================================================================
  console.log('');
  console.log('  tablesInDump() - reading the file back');
  // =======================================================================
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tvl-backup-'));

  const notADump = path.join(tmp, 'notes.txt');
  fs.writeFileSync(notADump, 'this is not a dump\n');
  const bad = backup.tablesInDump(notADump);
  check('a text file is not a readable archive', bad.ok === false);
  check('and it says why', bad.err.length > 0);

  const truncated = path.join(tmp, 'short.dump');
  fs.writeFileSync(truncated, 'PGDMP');     // the magic, and nothing after it
  check('a truncated archive is rejected',
        backup.tablesInDump(truncated).ok === false);

  /*
    A dump that is readable and INCOMPLETE. This is the failure that looks
    most like success: pg_dump exits 0, the file opens, and one table is
    missing because the user running it could not read it.
  */
  check('15 of 15 tables is fine',
        backup.tableCountProblem(15, 15) === '');
  check('14 of 15 tables is not',
        backup.tableCountProblem(14, 15).length > 0);
  check('and it says both numbers',
        /14/.test(backup.tableCountProblem(14, 15)) &&
        /15/.test(backup.tableCountProblem(14, 15)),
        backup.tableCountProblem(14, 15));
  check('MORE tables than the database is also wrong',
        backup.tableCountProblem(16, 15).length > 0);
  check('0 tables out of 15 is wrong',
        backup.tableCountProblem(0, 15).length > 0);
  check('nothing to compare against says nothing',
        backup.tableCountProblem(0, 0) === '');
  /*
    found 5, expected 0 is the case the "no count" guard is actually for,
    and the first version of this section did not have it: every other
    combination of zeroes is already handled by the equality below it, so
    without this line the guard was dead code that no assertion could tell
    apart from nothing at all.
  */
  check('a dump with tables and no count to compare says nothing',
        backup.tableCountProblem(5, 0) === '');


  // =======================================================================
  console.log('');
  console.log('  A real backup of the real database');
  // =======================================================================
  /*
    2099 names, so the backup_run rows this leaves can be swept by name
    whether the run finishes or not. Sweeping first as well as last: a run
    that died halfway would otherwise leave a row dated 2099 that
    backupHealth() reports for ever as the most recent backup.
  */
  async function sweep() {
    await db.query("DELETE FROM backup_run WHERE file_name LIKE 'tvl-eas-backup-2099-%'");
  }
  await sweep();

  const liveCounts = await backup.rowCounts();
  const liveTables = Object.keys(liveCounts).length;
  check('rowCounts() sees the tables in the database', liveTables > 0,
        liveTables + ' tables');
  check('it counts rows exactly, not an estimate',
        Object.keys(liveCounts).every(function (k) {
          return Number.isInteger(liveCounts[k]);
        }));

  const first = await backup.backupNow({
    dir: tmp, keep: 30, now: new Date('2099-01-01T20:00:00Z')
  });

  check('the backup reports success', first.ok === true, first.message);
  check('it is named for 02:00 Dhaka on the 2nd',
        first.name === 'tvl-eas-backup-2099-01-02-0200.dump', first.name);
  check('the file is on the disk', fs.existsSync(first.path) === true);
  check('and is not empty', first.bytes > 0, first.bytes + ' bytes');
  check('every table in the database is in the file',
        first.tables === liveTables, first.tables + ' vs ' + liveTables);
  check('the row total matches what was counted',
        first.rowsTotal === Object.keys(liveCounts)
          .reduce(function (s, k) { return s + liveCounts[k]; }, 0));
  check('pg_restore can read the finished file back',
        backup.tablesInDump(first.path).tables === liveTables);
  check('when is an ISO timestamp', /^\d{4}-\d{2}-\d{2}T/.test(first.when));
  check('one copy is kept', first.kept === 1, String(first.kept));

  const row = (await db.query(
    `SELECT * FROM backup_run WHERE file_name = $1`, [first.name]))[0];
  check('a backup_run row was written', Boolean(row));
  check('it says the run succeeded', row && row.ok === true);
  check('with no message', row && row.message === '');
  check('it records the size', row && Number(row.bytes) === first.bytes);
  check('it records the table count', row && row.tables === liveTables);
  check('it records a count per table',
        row && Object.keys(row.counts).length === liveTables);
  /*
    COMPARED AS SORTED ENTRIES, NOT AS JSON TEXT. jsonb does not keep the
    order the keys were written in - it stores them shortest first and then
    bytewise - so JSON.stringify of what comes back is a different string
    from JSON.stringify of what went in, with identical contents. The first
    version of this check compared the two strings and failed on a row that
    was perfectly correct.
  */
  const entries = function (o) {
    return Object.keys(o).sort().map(function (k) { return k + '=' + o[k]; })
      .join(',');
  };
  check('the counts match what was in the database',
        row && entries(row.counts) === entries(liveCounts),
        row ? entries(row.counts) : '');
  check('finished_at is set', row && Boolean(row.finished_at));
  check('started_at is the time that was passed in',
        row && new Date(row.started_at).toISOString() ===
               new Date('2099-01-01T20:00:00Z').toISOString());


  // =======================================================================
  console.log('');
  console.log('  Pruning a real folder');
  // =======================================================================
  // A file that must survive, sitting in the folder like one would.
  const bystander = path.join(tmp, 'Quarterly review.docx');
  fs.writeFileSync(bystander, 'not a backup');

  const second = await backup.backupNow({
    dir: tmp, keep: 1, now: new Date('2099-01-02T20:00:00Z')
  });
  check('a second backup succeeds', second.ok === true, second.message);
  check('it has a different name', second.name !== first.name);
  check('the older copy was deleted', fs.existsSync(first.path) === false);
  check('the newer copy is still there', fs.existsSync(second.path) === true);
  check('kept reports 1', second.kept === 1, String(second.kept));
  check('THE BYSTANDER FILE WAS NOT TOUCHED', fs.existsSync(bystander) === true);

  const third = await backup.backupNow({
    dir: tmp, keep: 30, now: new Date('2099-01-03T20:00:00Z')
  });
  check('with keep 30 nothing is pruned', third.ok === true &&
        fs.existsSync(second.path) === true);
  check('kept counts both copies', third.kept === 2, String(third.kept));


  // =======================================================================
  console.log('');
  console.log('  backupHealth()');
  // =======================================================================
  const hadFlag = process.env.BACKUP_SCHEDULED;

  process.env.BACKUP_SCHEDULED = 'yes';
  let health = await backup.backupHealth({ dir: tmp });
  check('on is true when BACKUP_SCHEDULED=yes', health.on === true);
  check('it names the most recent backup', health.name === third.name,
        health.name);
  check('the last run is reported as ok', health.lastOk === true);
  check('it counts the copies in the folder', health.count === 2,
        String(health.count));
  check('the bystander is not counted as a copy', health.count === 2);
  check('it reports the folder it looked in', health.folder === tmp);
  check('keep comes from BACKUP_KEEP', health.keep === backup.BACKUP_KEEP);
  check('the size of the last one is reported', health.bytes === third.bytes);

  /*
    The 2099 row is dated far in the future, so "now minus last" is a large
    negative number and nothing is stale. That is the right answer for the
    arithmetic and a reminder of why the reserved year is swept: left
    behind, it would report a healthy backup for the next seventy years.
  */
  check('a future-dated run is not stale', health.stale === false);

  process.env.BACKUP_SCHEDULED = 'no';
  check('on is false when BACKUP_SCHEDULED=no',
        (await backup.backupHealth({ dir: tmp })).on === false);
  delete process.env.BACKUP_SCHEDULED;
  check('on is false when it is not set at all',
        (await backup.backupHealth({ dir: tmp })).on === false);
  process.env.BACKUP_SCHEDULED = '1';
  check('1 also means yes',
        (await backup.backupHealth({ dir: tmp })).on === true);

  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvl-empty-'));
  check('an empty folder reports no copies',
        (await backup.backupHealth({ dir: emptyDir })).count === 0);
  check('a folder that does not exist reports no copies rather than throwing',
        (await backup.backupHealth({ dir: path.join(emptyDir, 'nope') })).count === 0);
  fs.rmSync(emptyDir, { recursive: true, force: true });

  if (hadFlag === undefined) delete process.env.BACKUP_SCHEDULED;
  else process.env.BACKUP_SCHEDULED = hadFlag;


  // =======================================================================
  console.log('');
  console.log('  When it goes wrong');
  // =======================================================================
  /*
    A backup system is judged on its failures, not its successes. The three
    that matter: it must not report success, it must not leave a short file
    where a good one would be, and it must write down that it failed.
  */
  const hadPw = process.env.PGPASSWORD;
  process.env.PGPASSWORD = 'definitely-not-the-password';

  const failed = await backup.backupNow({
    dir: tmp, keep: 30, now: new Date('2099-01-04T20:00:00Z')
  });
  process.env.PGPASSWORD = hadPw;

  check('a wrong password fails', failed.ok === false);
  check('and says it was pg_dump', /pg_dump/.test(failed.message),
        failed.message);
  check('NO FILE IS LEFT WHERE A BACKUP WOULD BE',
        fs.existsSync(failed.path) === false);
  check('the earlier good copies were not pruned',
        fs.existsSync(third.path) === true);

  const failRow = (await db.query(
    'SELECT * FROM backup_run WHERE file_name = $1', [failed.name]))[0];
  check('the failure is written down', Boolean(failRow));
  check('the row says it failed', failRow && failRow.ok === false);
  check('with the reason', failRow && failRow.message.length > 0);
  check('and zero bytes', failRow && Number(failRow.bytes) === 0);

  const sick = await backup.backupHealth({ dir: tmp });
  check('health reports the failed run, not the last good one',
        sick.name === failed.name && sick.lastOk === false, sick.name);
  check('and carries its message', sick.message.length > 0);

  /*
    A DUMP THAT pg_dump WAS HAPPY WITH AND IS NOT A BACKUP. This is the
    failure that matters most and the hardest one to stage: pg_dump exits 0,
    the file is the right sort of size, and it cannot be restored. A full
    disk, a network share that dropped halfway, a USB stick pulled out.
    pg_dump cannot be asked to produce one, so the read-back is handed over
    instead - see the inspect option on backupNow().

    Without these two checks, replacing the read-back with "assume it is
    fine" passed all 153 of the others.
  */
  const corrupt = await backup.backupNow({
    dir: tmp, keep: 30, now: new Date('2099-01-05T20:00:00Z'),
    inspect: function () {
      return { ok: false, tables: 0, err: 'could not read block 7 of archive' };
    }
  });
  check('an unreadable archive is not reported as a backup',
        corrupt.ok === false);
  check('and the reason reaches the message',
        /cannot be read back/.test(corrupt.message) &&
        /block 7/.test(corrupt.message), corrupt.message);
  check('the bad file loses its backup name',
        fs.existsSync(corrupt.path) === false);
  check('it is kept for inspection as .bad rather than deleted',
        fs.existsSync(corrupt.path + '.bad') === true);
  check('and a .bad file can never be chosen as a backup',
        backup.isBackupFile(path.basename(corrupt.path) + '.bad') === false);
  check('nor counted as a kept copy',
        (await backup.backupHealth({ dir: tmp })).count === 2,
        String((await backup.backupHealth({ dir: tmp })).count));
  check('the rename is mentioned in the message',
        /renamed/.test(corrupt.message), corrupt.message);
  const corruptRow = (await db.query(
    'SELECT ok, message FROM backup_run WHERE file_name = $1',
    [corrupt.name]))[0];
  check('an unreadable archive is written down as a failure',
        corruptRow && corruptRow.ok === false);

  const shortDump = await backup.backupNow({
    dir: tmp, keep: 30, now: new Date('2099-01-06T20:00:00Z'),
    inspect: function () {
      return { ok: true, tables: liveTables - 1, err: '' };
    }
  });
  check('a dump missing one table is not reported as a backup',
        shortDump.ok === false);
  check('and it names both counts',
        shortDump.message.indexOf(String(liveTables - 1)) !== -1 &&
        shortDump.message.indexOf(String(liveTables)) !== -1, shortDump.message);
  check('a short dump does not count as a kept copy', shortDump.kept === 0);
  check('and it is set aside as well',
        fs.existsSync(shortDump.path) === false &&
        fs.existsSync(shortDump.path + '.bad') === true);


  // =======================================================================
  console.log('');
  console.log('  The restore, which is the only thing that proves any of it');
  // =======================================================================
  /*
    Restoring needs a user that may CREATE DATABASE, and tvl_api
    deliberately may not - see db/04-api-user.sql. So this section runs
    only when the test is given one, and says so loudly when it is not,
    because "the test suite passed" must never be mistaken for "the backup
    has been restored".

        set PGUSER=postgres
        set PGPASSWORD=the-postgres-password
        node backup-test.js
  */
  const { Client } = require('pg');
  const cfg = backup.settings();
  const scratch = 'tvl_eas_restore_check';
  let admin = null;
  try {
    admin = new Client({ host: cfg.host, port: Number(cfg.port), user: cfg.user,
                         password: cfg.password, database: 'postgres',
                         connectionTimeoutMillis: 5000 });
    await admin.connect();
    await admin.query('DROP DATABASE IF EXISTS ' + scratch + ' WITH (FORCE)');
    await admin.query('CREATE DATABASE ' + scratch);
  } catch (e) {
    if (admin) { try { await admin.end(); } catch (x) { /* already gone */ } }
    admin = null;
    note('RESTORE NOT TESTED: ' + cfg.user + ' cannot create a database.');
    note('   This is correct for tvl_api. To test the restore, run this');
    note('   file again with PGUSER=postgres and PGPASSWORD set, or do it');
    note('   by hand:  node restore.js <file> ' + scratch);
  }

  if (admin) {
    const restored = backup.run(backup.pgTool('pg_restore'),
      backup.restoreArgs(Object.assign({}, cfg,
        { database: scratch, file: third.path })), cfg.password);

    check('pg_restore restored the dump', restored.ok === true, restored.err);

    const client = new Client({ host: cfg.host, port: Number(cfg.port),
                                user: cfg.user, password: cfg.password,
                                database: scratch, connectionTimeoutMillis: 5000 });
    await client.connect();
    const names = (await client.query(
      `SELECT table_name AS name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name`)).rows.map(function (r) { return r.name; });

    const after = {};
    if (names.length) {
      (await client.query(backup.countQueryFor(names))).rows
        .forEach(function (r) { after[r.t] = Number(r.n); });
    }
    await client.end();

    check('the restored database has the same tables',
          names.length === liveTables, names.length + ' vs ' + liveTables);

    // The 2099 backup_run rows this test wrote are inside the dump, so
    // that one table is expected to differ. Everything else must not.
    const differ = Object.keys(liveCounts).filter(function (t) {
      return after[t] !== liveCounts[t];
    });
    check('EVERY TABLE HAS THE SAME NUMBER OF ROWS, backup_run aside',
          differ.filter(function (t) { return t !== 'backup_run'; }).length === 0,
          differ.join(', '));

    note('restored ' + names.length + ' tables, ' +
         Object.keys(after).reduce(function (s, k) { return s + after[k]; }, 0)
           .toLocaleString('en-US') + ' rows into ' + scratch);

    const a2 = new Client({ host: cfg.host, port: Number(cfg.port),
                            user: cfg.user, password: cfg.password,
                            database: 'postgres', connectionTimeoutMillis: 5000 });
    await a2.connect();
    await a2.query('DROP DATABASE IF EXISTS ' + scratch + ' WITH (FORCE)');
    await a2.end();
    await admin.end();
  }


  // =======================================================================
  // Tidy up.
  // =======================================================================
  await sweep();
  fs.rmSync(tmp, { recursive: true, force: true });

  const left = await db.query(
    "SELECT count(*)::int AS n FROM backup_run WHERE file_name LIKE 'tvl-eas-backup-2099-%'");
  check('no test rows are left in backup_run', left[0].n === 0);

  console.log('');
  console.log('  ' + pass + ' passed, ' + fail + ' failed' +
              (notes ? ', ' + notes + ' notes' : ''));
  console.log('');
  process.exit(fail ? 1 : 0);
}


main().catch(function (e) {
  console.error(e);
  process.exit(1);
});
