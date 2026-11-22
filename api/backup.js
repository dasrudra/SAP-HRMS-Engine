/**
 * backup.js - the copy of the database that is not the database.
 * ===========================================================================
 *
 * THIS FILE IS PLAIN ASCII, like the rest of the project.
 *
 *     cd api
 *     node backup.js              make one backup now
 *     node backup.js --health     what the Summary screen would say
 *     node backup.js --guide      what to do when something has gone wrong
 *
 *
 * WHAT THIS IS A PORT OF
 *
 * src/Backup.gs. Same constants, same shape, same decisions - including the
 * ones about ordering, which are the easy ones to get wrong. Read that file
 * beside this one; where the two differ it is because Drive gave the old
 * system something PostgreSQL does not, and each of those is called out.
 *
 *
 * WHAT CAN ACTUALLY GO WRONG, AND WHAT COVERS IT
 *
 * Backup.gs opens with this list, and the honest answer for PostgreSQL is
 * different in a way that matters. Google gave the spreadsheet three safety
 * nets for free. PostgreSQL gives none of them.
 *
 *   somebody deletes rows, or a whole table
 *       Sheets: File > Version history, pick a time before the damage,
 *       Restore. Costs nothing, loses nothing else.
 *       PostgreSQL: THERE IS NO VERSION HISTORY. A DELETE is final the
 *       moment it commits. The only way back is a dump taken before it.
 *       This is the gap this file exists to close.
 *
 *   somebody deletes the whole database
 *       Sheets: Drive's Trash, restorable for 30 days.
 *       PostgreSQL: DROP DATABASE has no trash. It is gone.
 *
 *   a bad upload puts wrong figures in
 *       The same answer in both systems, and still the best one: the
 *       Uploads screen deletes exactly that upload's rows. A backup is the
 *       wrong tool for a bad upload.
 *
 *   the disk fails, the machine is stolen, the office floods
 *       Sheets: Google's problem, and they are better at it than we are.
 *       PostgreSQL: OUR PROBLEM. A dump sitting on the same disk as the
 *       database it came from is not a backup. It is a second copy of the
 *       thing that is about to be destroyed.
 *
 * So: this file makes the dump and looks after how many are kept. Getting
 * the file somewhere that is not this machine is the other half, it is
 * configuration rather than code, and BACKUP_DIR below is where that
 * decision gets made. A dump that never leaves the machine closes one
 * failure out of four.
 *
 *
 * WHAT IT DOES
 *
 * Once a day it writes the whole database to one compressed file named with
 * the date, checks that the file can be read back, and deletes files past
 * the newest BACKUP_KEEP. The file is a complete database - every table,
 * every row, the accounts included - so restoring is one pg_restore and
 * carrying on.
 *
 *
 * NO REAL DATA IS IN THIS FILE. It reads the database and writes a .dump,
 * which .gitignore keeps out of the repository.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const db = require('./db');

const TZ = 'Asia/Dhaka';                       // appsscript.json

/**
 * How many daily copies to keep. BACKUP_KEEP in Backup.gs, same number: "a
 * month is enough to notice and act".
 *
 * It is also the answer to "how far back can we go", and that is the number
 * to argue about. Thirty days of a few megabytes is nothing. Thirty days is
 * not enough if a wrong figure went in six weeks ago and nobody noticed.
 */
const BACKUP_KEEP = 30;

/** Past this, the Summary screen stops saying "fine" and starts saying so. */
const BACKUP_STALE_HOURS = 36;

/**
 * The start of every backup file name.
 *
 * Backup.gs built its name from CONFIG.APP_NAME - 'TVL-EAS Database backup
 * 2026-11-22 0200' - so that renaming the system renamed the copies with
 * it. That reasoning does not survive the move to a filesystem: this name
 * gets typed at a command prompt, pasted into a scheduled task, and quoted
 * in a shell, and spaces in it turn every one of those into a small trap.
 *
 * So: lower case, hyphens, no spaces. The date format is the same one.
 */
const BACKUP_PREFIX = 'tvl-eas-backup-';
const BACKUP_SUFFIX = '.dump';


// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * 'yyyy-MM-dd-HHmm' in the dashboard's own timezone, as
 * Utilities.formatDate(new Date(), CONFIG_TZ(), 'yyyy-MM-dd HHmm').
 *
 * THE TIMEZONE IS NOT DECORATION. A backup that runs at 2am in Dhaka is at
 * 20:00 the previous day in UTC. Name the file in UTC and every file is
 * stamped with the wrong date, the day after an incident somebody restores
 * the wrong one, and the mistake is invisible because the names look
 * perfectly reasonable.
 */
function stamp(when) {
  const d = when || new Date();
  const p = {};
  new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(d).forEach(function (part) { p[part.type] = part.value; });

  // hour12:false gives '24' for midnight in some runtimes; Apps Script gives
  // '00'. Left alone, the 00:xx backup would sort after every other file of
  // its own day - see the same correction in messenger-write.js.
  const hh = p.hour === '24' ? '00' : p.hour;
  return p.year + '-' + p.month + '-' + p.day + '-' + hh + p.minute;
}


/** tvl-eas-backup-2026-11-22-0200.dump */
function backupFileName(when) {
  return BACKUP_PREFIX + stamp(when) + BACKUP_SUFFIX;
}


/**
 * Reads a file name back, or returns null.
 *
 * STRICT ON PURPOSE, AND THIS IS THE SAFETY PROPERTY OF THE WHOLE FILE.
 * toPrune() below deletes files, there is no Recycle Bin for a file deleted
 * by a script, and the only thing standing between "delete the oldest" and
 * "delete somebody's documents" is that this function refuses to recognise
 * anything it did not write. A name is a backup only if every single part
 * of it is exactly right: the prefix, four digits of year, a month that is
 * a month, a day that is a day, an hour that is an hour, and the extension.
 *
 * Backup.gs sorted by f.getDateCreated(). This sorts by the stamp in the
 * name instead, because a file's creation date is a fact about the
 * filesystem it is on - copy the folder to a USB stick and back and every
 * date is today. The name travels with the file.
 *
 * @return {{stamp: string, at: number}|null} at is yyyyMMddHHmm as a number,
 *     which sorts chronologically without constructing a Date and therefore
 *     without any opinion about timezones.
 */
function parseBackupName(name) {
  const m = /^tvl-eas-backup-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})\.dump$/
    .exec(String(name || ''));
  if (!m) return null;

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);

  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  if (hour > 23) return null;
  if (minute > 59) return null;

  return {
    stamp: m[1] + '-' + m[2] + '-' + m[3] + '-' + m[4] + m[5],
    at: (((year * 100 + month) * 100 + day) * 100 + hour) * 100 + minute
  };
}


/** True for a name this file wrote, false for everything else. */
function isBackupFile(name) {
  return parseBackupName(name) !== null;
}


/**
 * Which files to delete, newest kept.
 *
 * pruneBackups() in Backup.gs, with two differences, both deliberate:
 *
 *   it trashed, this deletes
 *       Drive gave "setTrashed(true)" and thirty days of grace. There is no
 *       equivalent, so the care goes into never choosing the wrong file
 *       rather than into undoing it afterwards. Anything parseBackupName()
 *       does not recognise is not in the list at all.
 *
 *   keep below 1 throws
 *       Backup.gs would have accepted BACKUP_KEEP = 0 and quietly deleted
 *       every copy it had just taken. A typo in a config value must not be
 *       able to do that.
 *
 * @param {string[]} names everything in the folder, backups or not
 * @param {number} keep how many of the newest to leave alone
 * @return {string[]} the names to delete, oldest first
 */
function toPrune(names, keep) {
  const n = Number(keep);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error('refusing to prune with keep=' + keep +
                    ' - keep must be a whole number of at least 1');
  }

  const mine = (names || [])
    .filter(isBackupFile)
    .map(function (name) { return { name: name, at: parseBackupName(name).at }; });

  mine.sort(function (a, b) { return b.at - a.at; });   // newest first

  return mine.slice(n)
             .map(function (f) { return f.name; })
             .reverse();                                // oldest first
}


// ---------------------------------------------------------------------------
// Where the files go
// ---------------------------------------------------------------------------

/** The repository root - this file lives in api/. */
function repoRoot() {
  return path.resolve(__dirname, '..');
}


/**
 * The backup folder.
 *
 * BACKUP_DIR in api/.env, and SET IT. The default is a folder inside the
 * repository, which is the right default for trying this out on day one and
 * the wrong place for it to stay: a dump on the same disk as the database
 * survives a dropped table and nothing else.
 *
 * What to point it at, roughly best first:
 *
 *     BACKUP_DIR=G:\My Drive\TVL-EAS Backups     a synced cloud folder
 *     BACKUP_DIR=\\fileserver\eas\db-backups     a company file server
 *     BACKUP_DIR=E:\tvl-eas-backups              a second physical disk
 *     BACKUP_DIR=D:\tvl-eas-backups              a second partition - and
 *                                                a second partition is the
 *                                                same disk, so this one
 *                                                only survives mistakes,
 *                                                not hardware
 */
function backupDir() {
  const set = String(process.env.BACKUP_DIR || '').trim();
  return set ? path.resolve(set) : path.join(repoRoot(), 'backups');
}


/**
 * True when the folder is inside this git repository.
 *
 * Worth a warning every single run. The dump contains every employee name,
 * every employee ID, every ticket body and every password hash in the
 * system, and this repository is public. .gitignore blocks *.dump and
 * backups/, so it takes a deliberate `git add -f` to get one committed -
 * but the cost of being wrong about that is "the whole database is on the
 * internet, permanently, because git keeps history", and that is cheap to
 * warn about and impossible to take back.
 */
function insideRepo(dir) {
  const root = repoRoot();
  const resolved = path.resolve(dir);
  return resolved === root || resolved.startsWith(root + path.sep);
}


/**
 * Why a folder could not be created, in words that name the cause.
 *
 * WRITTEN AFTER WATCHING IT WASTE SOMEBODY'S TIME. mkdirSync with
 * recursive:true creates every missing folder in the path, so the ONLY
 * ordinary way it can fail with ENOENT is that the thing at the start of
 * the path - the drive letter, or the server in a \\server\share - is not
 * there at all. The raw message for that reads
 *
 *     ENOENT: no such file or directory, mkdir 'G:\My Drive\Backups'
 *
 * which looks exactly like a folder name typed wrongly, so the natural
 * response is to try a different folder name, and that fails identically.
 * The folder name was never the problem: there was no G: drive. A Google
 * Drive or OneDrive folder only HAS a drive letter once the desktop app is
 * installed and signed in - the website alone gives you nothing a program
 * on this machine can write to.
 *
 * @param {string} dir the folder that could not be made
 * @param {string} reason err.message
 * @param {boolean} rootExists whether the drive or share the path starts
 *     with exists. Passed in rather than looked up so this can be tested on
 *     a machine that has no drive letters at all.
 */
function mkdirProblem(dir, reason, rootExists) {
  const root = path.parse(path.resolve(dir)).root;

  if (!rootExists) {
    return 'could not create ' + dir + ' because there is no ' + root +
           ' on this machine - so it is the drive, not the folder name, ' +
           'that is wrong. A Google Drive or OneDrive letter exists only ' +
           'while the desktop app is installed and signed in. See what ' +
           'this machine actually has with:  Get-PSDrive -PSProvider ' +
           'FileSystem';
  }

  return 'could not create ' + dir + ': ' + reason;
}


// ---------------------------------------------------------------------------
// Talking to pg_dump
// ---------------------------------------------------------------------------

/**
 * The full path to a PostgreSQL command line tool.
 *
 * PG_BIN in api/.env, and on Windows YOU WILL NEED IT. The installer does
 * not put PostgreSQL's bin folder on PATH, so `pg_dump` at a command prompt
 * says it is not recognised even though it is sitting right there:
 *
 *     PG_BIN=C:\Program Files\PostgreSQL\18\bin
 *
 * THE VERSION MATTERS. pg_dump refuses to dump a server newer than itself.
 * Use the pg_dump that came with the server being dumped - that is what the
 * path above does, and it is why this is a path to a specific installation
 * and not a hopeful `pg_dump`.
 *
 * The .exe is added by hand because Node does not add it. Given a full path
 * with no extension, spawn on Windows looks for a file with no extension,
 * does not find one, and reports ENOENT - which reads exactly like "you
 * typed the path wrong".
 */
function pgTool(name) {
  const exe = process.platform === 'win32' ? name + '.exe' : name;
  const dir = String(process.env.PG_BIN || '').trim();
  return dir ? path.join(dir, exe) : exe;
}


/** Connection settings, read the same way db.js reads them. */
function settings() {
  return {
    host:     process.env.PGHOST     || '127.0.0.1',
    port:     String(process.env.PGPORT || 5432),
    user:     process.env.PGUSER     || 'postgres',
    database: process.env.PGDATABASE || 'tvl_eas',
    password: process.env.PGPASSWORD || ''
  };
}


/**
 * The pg_dump arguments.
 *
 * --format=custom
 *     Compressed, and restorable one table at a time. The alternative is a
 *     plain .sql file, which is readable in Notepad and four times the
 *     size, and which can only be restored by running all of it.
 *
 * --no-password
 *     NEVER REMOVE THIS. Without it, a wrong or missing password makes
 *     pg_dump print "Password:" and wait. At 2am, inside a scheduled task,
 *     with no keyboard attached, it waits for ever: the task never
 *     finishes, the next night's task does not start, and the Summary
 *     screen is the only thing that ever notices. With it, pg_dump fails in
 *     a second and says why.
 *
 * The password is NOT here. It goes in the child process's environment as
 * PGPASSWORD - see dumpTo(). Anything on a command line is visible to
 * everyone on the machine in Task Manager and the process list.
 */
function dumpArgs(o) {
  return [
    '--host', o.host,
    '--port', String(o.port),
    '--username', o.user,
    '--dbname', o.database,
    '--format', 'custom',
    '--no-password',
    '--file', o.file
  ];
}


/**
 * The pg_restore arguments.
 *
 * --no-owner, --no-privileges
 *     Restore the tables and the rows, not who owned them or who was
 *     granted what. On a brand new machine the role tvl_api does not exist
 *     yet, and a restore that tries to GRANT to a role that is not there
 *     fails halfway through. Ownership and grants are not data: they are in
 *     db/04-api-user.sql, which gets run after the restore. The repository
 *     is the source of truth for them, and it survives the disk.
 *
 * --single-transaction
 *     All of it or none of it. Without this pg_restore carries on past
 *     errors and reports a count at the end, which leaves a database that
 *     is half restored and looks fine. It also implies --exit-on-error.
 */
function restoreArgs(o) {
  return [
    '--host', o.host,
    '--port', String(o.port),
    '--username', o.user,
    '--dbname', o.database,
    '--no-owner',
    '--no-privileges',
    '--single-transaction',
    '--no-password',
    o.file
  ];
}


/**
 * Runs a PostgreSQL tool and returns what happened.
 *
 * @return {{ok: boolean, out: string, err: string, status: number}}
 */
function run(tool, args, password) {
  // A COPY of the environment with the password added, not process.env
  // itself. Mutating process.env would leave PGPASSWORD set for everything
  // else this process goes on to do.
  const env = Object.assign({}, process.env, { PGPASSWORD: password || '' });

  const r = spawnSync(tool, args, { encoding: 'utf8', env: env });

  if (r.error) {
    const hint = r.error.code === 'ENOENT'
      ? '  - not found. Set PG_BIN in api/.env to the folder that holds it,' +
        ' e.g. C:\\Program Files\\PostgreSQL\\18\\bin'
      : '';
    return { ok: false, out: '', err: tool + ': ' + r.error.message + hint,
             status: -1 };
  }

  return {
    ok: r.status === 0,
    out: String(r.stdout || ''),
    err: String(r.stderr || '').trim(),
    status: r.status
  };
}


// ---------------------------------------------------------------------------
// Counting what should be in the file
// ---------------------------------------------------------------------------

/**
 * One query that counts every row in every table.
 *
 * WHY NOT reltuples FROM pg_class - it is an estimate maintained by
 * ANALYZE, it is wrong by design, and it reads 0 for a table that has never
 * been analysed. A backup check that says "0 rows" when there are 26,000 is
 * worse than no check.
 *
 * The table names come from the catalog, so they cannot be attacker
 * controlled, and they are checked anyway: this function builds SQL out of
 * them by concatenation, which is the one thing db.js tells you never to
 * do. The names are checked against [a-z_][a-z0-9_]* and anything else
 * throws rather than being quoted and hoped about.
 *
 * @param {string[]} names table names
 * @return {string} SQL returning one row per table: t, n
 */
function countQueryFor(names) {
  const list = names || [];
  if (!list.length) return '';

  return list.map(function (name) {
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
      throw new Error('refusing to count a table named ' + JSON.stringify(name) +
                      ' - unexpected characters in a name from the catalog');
    }
    return "SELECT '" + name + "' AS t, count(*)::bigint AS n FROM " + name;
  }).join(' UNION ALL ');
}


/**
 * Row count per table, as {ticket: 26414}.
 *
 * Read BEFORE the dump starts, so it describes what is about to go into the
 * file rather than what was in the database by the time it finished.
 */
async function rowCounts() {
  const tables = (await db.query(
    `SELECT table_name AS name
       FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`
  )).map(function (r) { return r.name; });

  const sql = countQueryFor(tables);
  if (!sql) return {};

  const counts = {};
  (await db.query(sql)).forEach(function (r) { counts[r.t] = Number(r.n); });
  return counts;
}


/**
 * '' when the file holds what it should, a sentence when it does not.
 *
 * A FUNCTION OF ITS OWN, RATHER THAN AN `if` INSIDE backupNow(), so that it
 * can be tested on any machine. Testing it in place would mean a fake
 * pg_restore that reports the wrong number of tables, which means a shell
 * script on the PATH, which does not work on Windows - and a check that is
 * only exercised on the machine it was written on is not a check.
 *
 * `expected` of 0 means the count could not be taken, which is already
 * reported separately; there is nothing to compare against, so this says
 * nothing rather than crying wolf.
 */
function tableCountProblem(found, expected) {
  if (!expected) return '';
  if (found === expected) return '';
  return 'the dump holds ' + found + ' tables but the database has ' +
         expected + ' - do not trust this file';
}


/** How many tables pg_restore can see in a finished file. */
function tablesInDump(file) {
  const r = run(pgTool('pg_restore'), ['--list', file], '');
  if (!r.ok) {
    return { ok: false, tables: 0,
             err: r.err || 'pg_restore --list would not read the file' };
  }

  // 'TABLE DATA' and not 'TABLE': the second counts the CREATE TABLE
  // statements, which are in the file even when the rows are not.
  const lines = r.out.split('\n')
    .filter(function (l) { return / TABLE DATA /.test(l); });

  return { ok: true, tables: lines.length, err: '' };
}


// ---------------------------------------------------------------------------
// Sizes and staleness
// ---------------------------------------------------------------------------

/** '3.4 MB'. For people, so 1024 and one decimal place. */
function formatBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return b + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = b / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v = v / 1024; i++; }
  return (Math.round(v * 10) / 10) + ' ' + units[i];
}


/**
 * True when the last backup is too old, or there has never been one.
 *
 * Never having run counts as stale. Backup.gs used Infinity for the same
 * reason: a system that has never been backed up is not in a better state
 * than one whose last backup is two days old.
 */
function isStale(lastIso, now, hours) {
  if (!lastIso) return true;
  const then = new Date(lastIso).getTime();
  if (!Number.isFinite(then)) return true;
  const limit = Number(hours === undefined ? BACKUP_STALE_HOURS : hours);
  return ((now || Date.now()) - then) / 3600000 > limit;
}


// ---------------------------------------------------------------------------
// Making one
// ---------------------------------------------------------------------------

/**
 * Makes one backup now. Safe to run by hand at any time.
 *
 * Also what the scheduled task calls. Returns a plain object rather than
 * only printing, so the Summary screen can show the result of the last one -
 * same five keys as backupNow() in Backup.gs, plus the sizes, which Drive
 * never made us think about.
 *
 * @param {{dir: string, keep: number, now: Date,
 *          inspect: function(string): {ok: boolean, tables: number,
 *                                     err: string}}} [opts]
 *     inspect is how the finished file is read back, and it exists ONLY so
 *     that the test can hand over a corrupt archive. Mutation testing found
 *     the gap: replacing the read-back with "assume it is fine" passed the
 *     whole suite, because every test here dumps a healthy database and
 *     pg_dump cannot be persuaded to write a broken file on demand. One
 *     optional argument buys a real test of the one check that stands
 *     between a file and a backup.
 * @return {Promise<{ok: boolean, name: string, when: string, kept: number,
 *                   message: string, bytes: number, tables: number,
 *                   rowsTotal: number, path: string}>}
 */
async function backupNow(opts) {
  const o = opts || {};
  const dir = o.dir ? path.resolve(o.dir) : backupDir();
  const keep = o.keep === undefined ? BACKUP_KEEP : o.keep;
  const started = o.now || new Date();
  const inspect = o.inspect || tablesInDump;

  const name = backupFileName(started);
  const file = path.join(dir, name);
  const cfg = settings();

  const result = {
    ok: false, name: name, when: '', kept: 0, message: '',
    bytes: 0, tables: 0, rowsTotal: 0, path: file
  };

  // Written whatever happens, success or failure. A failed backup that
  // leaves no trace is the worst of the three outcomes: nobody can tell it
  // apart from a backup that was never scheduled.
  async function record(counts) {
    try {
      await db.query(
        `INSERT INTO backup_run (started_at, finished_at, file_name, bytes,
                                 tables, rows_total, counts, kept, ok, message)
         VALUES ($1, now(), $2, $3, $4, $5, $6, $7, $8, $9)`,
        [started, result.name, result.bytes, result.tables, result.rowsTotal,
         JSON.stringify(counts || {}), result.kept, result.ok, result.message]);
    } catch (e) {
      // The dump itself may well have worked. Say so rather than throwing
      // away a good backup over the bookkeeping.
      console.error('[backup] could not write the backup_run row: ' + e.message);
    }
  }

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    let rootExists = false;
    try {
      rootExists = fs.existsSync(path.parse(path.resolve(dir)).root);
    } catch (x) { rootExists = false; }
    result.message = mkdirProblem(dir, e.message, rootExists);
    await record({});
    return result;
  }

  if (insideRepo(dir)) {
    console.warn('');
    console.warn('  WARNING: the backups are going inside the git repository.');
    console.warn('    ' + dir);
    console.warn('  They are on the same disk as the database, so they do not');
    console.warn('  survive the disk, and they are one `git add -f` away from');
    console.warn('  a public repository. Set BACKUP_DIR in api/.env.');
    console.warn('');
  }

  // Counted first, so the numbers describe the file and not the aftermath.
  let counts = {};
  try {
    counts = await rowCounts();
  } catch (e) {
    result.message = 'could not count the rows: ' + e.message;
    await record({});
    return result;
  }
  const expected = Object.keys(counts).length;
  result.rowsTotal = Object.keys(counts)
    .reduce(function (sum, k) { return sum + counts[k]; }, 0);

  const dumped = run(pgTool('pg_dump'),
                     dumpArgs(Object.assign({}, cfg, { file: file })),
                     cfg.password);
  if (!dumped.ok) {
    result.message = 'pg_dump failed: ' + (dumped.err || 'exit ' + dumped.status);
    // A failed dump can still have created a short or empty file, and a
    // short file in the folder is the one that gets restored in a panic.
    try { fs.unlinkSync(file); } catch (e) { /* it may not exist */ }
    await record(counts);
    return result;
  }

  try {
    result.bytes = fs.statSync(file).size;
  } catch (e) {
    result.message = 'pg_dump reported success but there is no file at ' + file;
    await record(counts);
    return result;
  }

  // THE POINT OF THIS STEP. pg_dump exiting 0 means it finished writing;
  // it does not mean the file on the disk is readable. A disk that filled
  // up, a network share that dropped, a USB stick pulled out - all of them
  // leave a file that looks like a backup and is not one. Reading the
  // table of contents back costs milliseconds and is the difference
  // between having a backup and believing you have one.
  /**
   * Takes a bad file out of circulation without throwing it away.
   *
   * A FILE THAT FAILED THE READ-BACK MUST NOT KEEP A BACKUP'S NAME. It is
   * the newest file in the folder, it is the right sort of size, and it is
   * therefore exactly the one somebody restores at 9pm on the day the
   * database is wrong. Deleting it would be safe and would also destroy the
   * evidence of what went wrong, so it is renamed instead: '.bad' on the
   * end, which parseBackupName() does not recognise, so it can never be
   * chosen as a backup and never counted as a kept copy.
   */
  function setAside(why) {
    const bad = file + '.bad';
    try {
      fs.renameSync(file, bad);
      return why + ' - the file has been renamed to ' + path.basename(bad);
    } catch (e) {
      // Could not rename it, so it still has a backup's name. Say so: that
      // is worse than the original problem and must not be swallowed.
      return why + ' - AND it could not be renamed out of the way (' +
             e.message + '), so delete ' + path.basename(file) + ' by hand';
    }
  }

  const toc = inspect(file);
  if (!toc.ok) {
    result.message = setAside('the dump was written but cannot be read back: ' +
                              toc.err);
    await record(counts);
    return result;
  }
  result.tables = toc.tables;

  const short = tableCountProblem(toc.tables, expected);
  if (short) {
    result.message = setAside(short);
    await record(counts);
    return result;
  }

  // AFTER the dump, never before - the ordering note in Backup.gs, and it
  // still holds. Pruning first would throw away the oldest copy and then
  // find out the new one could not be written.
  //
  // THE SIGN-IN LOG IS NOT PRUNED HERE YET. Backup.gs called pruneAuthLog()
  // at this point, deliberately after the copy, so that the copy still held
  // the rows about to be dropped. There is no auth_log table in this
  // database yet - it is part of Accounts, which is outstanding in
  // PORT-INVENTORY.md. When it arrives, the call goes HERE, between the
  // dump and the prune, and for that reason.

  let kept = 0;
  try {
    const names = fs.readdirSync(dir);
    const old = toPrune(names, keep);
    old.forEach(function (f) { fs.unlinkSync(path.join(dir, f)); });
    kept = names.filter(isBackupFile).length - old.length;
  } catch (e) {
    // A backup that worked must not be reported as failed over the tidying
    // afterwards - the same decision, and the same wording, as Backup.gs.
    console.error('[backup] old copies not pruned: ' + e.message);
    kept = 0;
  }
  result.kept = kept;

  result.ok = true;
  result.when = new Date().toISOString();
  await record(counts);
  return result;
}


// ---------------------------------------------------------------------------
// How the backups are doing
// ---------------------------------------------------------------------------

/**
 * For the Summary screen. backupHealth() in Backup.gs, same keys.
 *
 * Deliberately NOT guarded by a token, for the reason Backup.gs gives: it
 * says when the last copy was made and nothing whatsoever about what is in
 * it, and somebody being able to see that the database is looked after is a
 * good thing rather than a leak.
 *
 * `on` IS NOT DETECTED, IT IS DECLARED. Apps Script could ask
 * ScriptApp.getProjectTriggers() whether the daily trigger existed. Nothing
 * here can ask Windows Task Scheduler the same question without shelling
 * out to schtasks and parsing it, so BACKUP_SCHEDULED in api/.env is set by
 * hand once the task has been created.
 *
 * That sounds like a weaker answer and is a stronger one: `on` without
 * `stale` is worthless, and `stale` is measured from the rows this file
 * writes. Claiming a nightly backup that is not happening is exactly what
 * the Summary screen then complains about, loudly, every day.
 */
async function backupHealth(opts) {
  const o = opts || {};
  const dir = o.dir ? path.resolve(o.dir) : backupDir();

  const flag = String(process.env.BACKUP_SCHEDULED || '').trim().toLowerCase();
  const on = flag === 'yes' || flag === 'true' || flag === '1';

  let last = '';
  let name = '';
  let bytes = 0;
  let ok = false;
  let message = '';
  try {
    const rows = await db.query(
      `SELECT finished_at, file_name, bytes, ok, message
         FROM backup_run
        ORDER BY started_at DESC
        LIMIT 1`);
    if (rows.length) {
      last = rows[0].finished_at ? new Date(rows[0].finished_at).toISOString() : '';
      name = rows[0].file_name || '';
      bytes = Number(rows[0].bytes) || 0;
      ok = Boolean(rows[0].ok);
      message = rows[0].message || '';
    }
  } catch (e) {
    // Same shape as Backup.gs: the screen gets an answer, the console gets
    // the reason. A Summary screen that will not load because the backup
    // table is missing is a worse outcome than one that says "never".
    console.error('[backup] could not read backup_run: ' + e.message);
  }

  let count = 0;
  try {
    count = fs.readdirSync(dir).filter(isBackupFile).length;
  } catch (e) { count = 0; }

  return {
    on: on,
    last: last,
    name: name,
    count: count,
    stale: isStale(last, Date.now(), BACKUP_STALE_HOURS),
    folder: dir,
    keep: BACKUP_KEEP,
    bytes: bytes,
    lastOk: ok,
    message: message
  };
}


// ---------------------------------------------------------------------------
// What to do when something has actually gone wrong
// ---------------------------------------------------------------------------

/**
 * Prints the steps. restoreGuide() in Backup.gs, rewritten for PostgreSQL -
 * which is most of it, because the first two steps there were Drive
 * features that do not exist here.
 *
 * Here rather than in a document because a document is somewhere else on
 * the day you need it, and because the steps change when the code does.
 */
function restoreGuide() {
  const dir = backupDir();
  const cfg = settings();

  console.log('');
  console.log('=========================================================');
  console.log(' SOMETHING WENT WRONG. IN ORDER OF WHAT TO TRY.');
  console.log('=========================================================');
  console.log('');
  console.log('0. FIRST, DO NOT WRITE ANYTHING ELSE TO THE DATABASE.');
  console.log('   Stop the API (Ctrl+C in the terminal running npm start).');
  console.log('   PostgreSQL has no version history. Every write from here');
  console.log('   on is one more thing a restore will undo.');
  console.log('');
  console.log('1. A BAD UPLOAD WENT IN');
  console.log('   Not a disaster, and not a job for a backup. Data Uploads');
  console.log('   > find the row > Delete. That removes exactly that');
  console.log('   upload and nothing else.');
  console.log('');
  console.log('2. ROWS OR A TABLE WERE DELETED, OR THE FIGURES LOOK WRONG');
  console.log('   There is no Version history here. Find the newest backup');
  console.log('   from before the damage:');
  console.log('     ' + dir);
  console.log('   and restore it into a SECOND database first, so you can');
  console.log('   look at it without touching the live one:');
  console.log('');
  console.log('     cd api');
  console.log('     node restore.js <file> tvl_eas_check');
  console.log('');
  console.log('   Compare, then decide. Restoring over the live database is');
  console.log('   the same command with --over-live, and it replaces');
  console.log('   everything that happened since that file was written.');
  console.log('');
  console.log('3. THE WHOLE DATABASE IS GONE, OR THE MACHINE IS GONE');
  console.log('   On the machine that will run it next:');
  console.log('     - install the same major version of PostgreSQL');
  console.log('     - git clone the repository');
  console.log('     - createdb ' + cfg.database);
  console.log('     - node restore.js <newest .dump> ' + cfg.database);
  console.log('     - psql -d ' + cfg.database + ' -f db/04-api-user.sql');
  console.log('       (the restore leaves out roles and grants on purpose -');
  console.log('        that file is where they come from)');
  console.log('     - copy api/.env across, or write it again from');
  console.log('       api/.env.example, and set the password to match');
  console.log('   Everything uploaded since that backup has to be uploaded');
  console.log('   again - the exports are still in the ITSM.');
  console.log('');
  console.log('4. THE CODE IS GONE');
  console.log('   It is on GitHub, on branch');
  console.log('   claude/sap-user-id-distribution-5ntc08. No data is');
  console.log('   involved - the database is the data. The two things that');
  console.log('   are NOT on GitHub, deliberately, are api/.env and the');
  console.log('   .dump files.');
  console.log('');
  console.log('5. THE BACKUPS ARE GONE TOO');
  console.log('   This is the one nothing above covers. It happens when the');
  console.log('   dumps were on the same disk as the database. Check now,');
  console.log('   not later:');
  console.log('     BACKUP_DIR is ' + dir);
  console.log('   If that is on the same disk as PostgreSQL, change it');
  console.log('   today. The Apps Script system had the same gap and said');
  console.log('   the same thing: keep one copy somewhere that is not this');
  console.log('   machine.');
  console.log('');
}


// ---------------------------------------------------------------------------
// Run from the command line
// ---------------------------------------------------------------------------

/*
  require.main === module is "was this file run, or required?".

  Every other command line file here - import-tickets.js, set-password.js -
  just runs when loaded, because nothing requires them. This one is also a
  module: server.js requires it for GET /api/backup/health. Without the
  guard, starting the API would take a backup.
*/
async function main() {
  const args = process.argv.slice(2);
  const flag = function (name) { return args.indexOf(name) !== -1; };
  const value = function (name) {
    const hit = args.find(function (a) { return a.startsWith(name + '='); });
    return hit ? hit.slice(name.length + 1) : '';
  };

  if (flag('--guide')) {
    restoreGuide();
    process.exit(0);
  }

  /*
    installBackupTrigger() in Backup.gs, which could do the job itself -
    ScriptApp.newTrigger('backupNow').atHour(2).everyDays(1).create() and it
    was done. Nothing here can create a Windows scheduled task without
    shelling out to schtasks as an administrator, and a script that quietly
    installs a nightly job on somebody's machine is not a thing this should
    do by itself. So it prints exactly what to run, with the real paths
    filled in.
  */
  if (flag('--install')) {
    const node = process.execPath;
    const here = __dirname;
    const cmd = path.join(here, 'nightly-backup.cmd');

    console.log('');
    console.log('  =========================================================');
    console.log('   TURNING ON THE NIGHTLY BACKUP - TWO STEPS');
    console.log('  =========================================================');
    console.log('');
    console.log('  1. Save these three lines as');
    console.log('       ' + cmd);
    console.log('');
    console.log('     @echo off');
    console.log('     cd /d "' + here + '"');
    console.log('     "' + node + '" backup.js >> "' +
                path.join(here, 'backup.log') + '" 2>&1');
    console.log('');
    console.log('     The cd matters: a scheduled task starts in');
    console.log('     C:\\Windows\\System32, where there is no .env to read.');
    console.log('');
    console.log('  2. Create the task, in a Command Prompt opened as');
    console.log('     Administrator:');
    console.log('');
    console.log('     schtasks /create /tn "TVL-EAS backup" /sc daily' +
                ' /st 02:00 /tr "' + cmd + '" /rl highest /f');
    console.log('');
    console.log('     02:00 local time, every day, the same hour the Apps');
    console.log('     Script trigger used - nobody is uploading at 2am.');
    console.log('');
    console.log('  Then, so the Summary screen knows it is meant to be');
    console.log('  running, add this line to api\\.env:');
    console.log('');
    console.log('     BACKUP_SCHEDULED=yes');
    console.log('');
    console.log('  To check it, to run it once by hand, and to remove it:');
    console.log('');
    console.log('     schtasks /query /tn "TVL-EAS backup" /v /fo list');
    console.log('     schtasks /run   /tn "TVL-EAS backup"');
    console.log('     schtasks /delete /tn "TVL-EAS backup" /f');
    console.log('');
    console.log('  THE TASK ONLY RUNS WHILE THE MACHINE IS ON. A desktop');
    console.log('  that is switched off at 2am never backs up and never');
    console.log('  says so - which is what BACKUP_STALE_HOURS is for. If');
    console.log('  the machine is off overnight, add /sc onlogon as a');
    console.log('  second task, or move the time to the working day.');
    console.log('');
    process.exit(0);
  }

  const dir = value('--dir');

  if (flag('--health')) {
    const h = await backupHealth({ dir: dir || undefined });
    console.log('');
    console.log('  scheduled      ' + (h.on ? 'yes (BACKUP_SCHEDULED is set)'
                                            : 'NOT DECLARED - set BACKUP_SCHEDULED=yes once the task exists'));
    console.log('  last backup    ' + (h.last || 'never'));
    console.log('  file           ' + (h.name || '-') +
                (h.bytes ? '  (' + formatBytes(h.bytes) + ')' : ''));
    console.log('  last run       ' + (h.last ? (h.lastOk ? 'ok' : 'FAILED: ' + h.message)
                                              : '-'));
    console.log('  copies kept    ' + h.count + ' of ' + h.keep);
    console.log('  folder         ' + h.folder);
    console.log('  stale          ' + (h.stale ? 'YES - older than ' +
                                       BACKUP_STALE_HOURS + ' hours' : 'no'));
    console.log('');
    process.exit(h.stale ? 1 : 0);
  }

  console.log('');
  console.log('  Backing up ' + settings().database + ' ...');

  const r = await backupNow({ dir: dir || undefined });

  if (!r.ok) {
    console.error('');
    console.error('  BACKUP FAILED');
    console.error('    ' + r.message);
    console.error('');
    process.exit(1);
  }

  console.log('    ' + r.name);
  console.log('    ' + formatBytes(r.bytes) + ', ' + r.tables + ' tables, ' +
              r.rowsTotal.toLocaleString('en-US') + ' rows');
  console.log('    ' + r.kept + ' of ' + BACKUP_KEEP + ' copies kept in ' +
              path.dirname(r.path));
  console.log('');

  if (insideRepo(path.dirname(r.path))) process.exit(2);
  process.exit(0);
}


module.exports = {
  BACKUP_KEEP, BACKUP_STALE_HOURS, BACKUP_PREFIX, BACKUP_SUFFIX,
  stamp, backupFileName, parseBackupName, isBackupFile, toPrune,
  repoRoot, backupDir, insideRepo, mkdirProblem,
  pgTool, settings, dumpArgs, restoreArgs, run,
  countQueryFor, rowCounts, tablesInDump, tableCountProblem,
  formatBytes, isStale,
  backupNow, backupHealth, restoreGuide
};


if (require.main === module) {
  main().catch(function (e) {
    console.error('');
    console.error('  BACKUP FAILED');
    console.error('    ' + e.message);
    console.error('');
    process.exit(1);
  });
}
