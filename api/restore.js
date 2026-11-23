/**
 * restore.js - putting a backup back.
 * ===========================================================================
 *
 * THIS FILE IS PLAIN ASCII, like the rest of the project.
 *
 *     cd api
 *     node restore.js --latest tvl_eas_check --user=postgres
 *     node restore.js --latest tvl_eas --over-live --user=postgres
 *
 * --latest means the newest file in BACKUP_DIR, so there is no name to
 * type. Put a file name or a path in its place to use an older one; a bare
 * name is looked for in BACKUP_DIR.
 *
 *
 * WHY THIS EXISTS AND WHY YOU SHOULD RUN IT TODAY
 *
 * A backup nobody has restored is not a backup. It is a file that is
 * probably a backup, and the day you find out is the day you cannot afford
 * to be wrong. The failures are ordinary and completely silent: pg_dump
 * from the wrong server, a dump taken by a user who could not read one
 * table, a file truncated by a full disk, a major version mismatch. Every
 * one of them leaves a file of plausible size with a plausible name.
 *
 * So the first thing to do with the first backup is restore it into a
 * second database, count the rows, and see them match. That is a five
 * minute job and it is the only thing that turns a guess into a fact.
 *
 *
 * WHAT IT NEEDS THAT THE REST OF THE API DOES NOT
 *
 * Creating a database is not something tvl_api is allowed to do, and that
 * is correct - see db/04-api-user.sql. So this one script needs a
 * PostgreSQL user that can, and --user=postgres is how you say so. It then
 * asks for that user's password and the typing is not echoed.
 *
 * THE PASSWORD IS ASKED FOR RATHER THAN READ FROM THE TERMINAL, and the
 * reason is a real afternoon lost to it. The instructions used to say
 *
 *     set PGUSER=postgres
 *
 * which is cmd.exe syntax. In PowerShell `set` is an alias for
 * Set-Variable, so that line creates a PowerShell variable whose NAME is
 * the whole string "PGUSER=postgres", sets no environment variable, prints
 * no error, and the script then quietly carries on as whoever api/.env
 * said. The PowerShell spelling is $env:PGUSER = "postgres". Two shells,
 * two spellings, one of them silent when it is wrong - so the flag asks
 * instead, and there is nothing to spell.
 *
 * It also keeps the password out of the terminal history and out of the
 * scrollback, which matters on a shared machine.
 *
 * Setting $env:PGUSER and $env:PGPASSWORD by hand still works, for a script
 * that cannot answer a prompt. Leave --user off when you do.
 *
 *
 * NO REAL DATA IS IN THIS FILE.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const db = require('./db');
const backup = require('./backup');


/** A database name this script is willing to touch. */
function validName(name) {
  return /^[a-z_][a-z0-9_]{0,62}$/.test(String(name || ''));
}


/**
 * The value of a --name=value argument, or ''.
 *
 * ONLY THE = FORM. Accepting `--user postgres` as well would mean
 * 'postgres' was both the flag's value and a bare argument, and the bare
 * arguments are how the file and the database are named - so a space there
 * would silently make 'postgres' the database to restore into. The = form
 * cannot be confused with anything.
 *
 * startsWith(name + '=') and not startsWith(name): otherwise --username=x
 * would answer a question about --user.
 */
function optionValue(args, name) {
  const hit = (args || []).find(function (a) {
    return String(a).startsWith(name + '=');
  });
  return hit ? hit.slice(name.length + 1) : '';
}


/** True when exactly this flag is present. Not a prefix match. */
function hasFlag(args, name) {
  return (args || []).indexOf(name) !== -1;
}


/**
 * Removes the escape sequences a terminal sends alongside real keystrokes.
 *
 * WHY A HIDDEN PROMPT NEEDS THIS AND AN ORDINARY ONE DOES NOT. In raw mode
 * everything the terminal sends arrives here, and a terminal sends more
 * than the keys that were pressed:
 *
 *   pasting      modern terminals wrap pasted text in "bracketed paste":
 *                ESC [ 2 0 0 ~ before it and ESC [ 2 0 1 ~ after. The ESC
 *                is a control character and gets dropped, but [200~ is
 *                five perfectly ordinary printable characters, so a pasted
 *                password silently becomes "[200~" + the password +
 *                "[201~" and authentication fails for no visible reason.
 *   arrow keys   ESC [ A and friends, same problem
 *
 * Nothing is echoed, so there is no way to see any of this happening.
 *
 * It cannot damage a real password: every rule here needs a literal ESC
 * first, and ESC is not a character anybody can type into a password
 * field. A password containing [ or ~ comes through untouched.
 */
function stripEscapes(text) {
  return String(text)
    .replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, '')   // CSI: arrows, paste markers
    .replace(/\u001bO[@-~]/g, '')                   // SS3: F1 to F4 on some terminals
    .replace(/\u001b/g, '');                        // a stray ESC on its own
}


/**
 * Asks for a password without echoing it.
 *
 * Raw mode, so every keystroke arrives here instead of being printed. A
 * chunk can hold more than one character - a fast typist, and certainly a
 * paste - so it is walked character by character rather than treated as
 * one key.
 *
 * It prints how many characters it read. Nothing was echoed, so without
 * that there is no way to tell a mistyped password from a prompt that
 * captured nothing, or captured five characters too many.
 */
function askPassword(label) {
  return new Promise(function (resolve, reject) {
    const stdin = process.stdin;

    if (!stdin.isTTY) {
      reject(new Error('there is no terminal to ask in. Set the password ' +
                       'in the environment instead:  $env:PGPASSWORD = "..."' +
                       '  and leave --user off.'));
      return;
    }

    let value = '';
    let done = false;

    process.stdout.write(label);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    function finish(cancelled) {
      done = true;
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stdout.write('\n');
      if (cancelled) process.exit(130);      // what Ctrl+C means
      process.stdout.write('  (' + value.length + ' characters read)\n');
      resolve(value);
    }

    function onData(chunk) {
      for (const ch of stripEscapes(chunk)) {
        if (done) return;
        if (ch === '\r' || ch === '\n' || ch === '\u0004') { finish(false); }
        else if (ch === '\u0003') { finish(true); }
        else if (ch === '\u007f' || ch === '\b') { value = value.slice(0, -1); }
        else if (ch >= ' ') { value += ch; }
      }
    }

    stdin.on('data', onData);
  });
}


/**
 * Prints what is actually in the backup folder.
 *
 * Shown whenever a file cannot be found, because the reason it cannot be
 * found is usually that an example file name from a set of instructions was
 * copied literally. Seeing the real names beside the invented one ends that
 * in a second.
 */
function listBackups() {
  const dir = backup.backupDir();
  let names = [];
  try {
    names = fs.readdirSync(dir).filter(backup.isBackupFile);
  } catch (e) {
    console.error('');
    console.error('  BACKUP_DIR is ' + dir + ' and it cannot be read: ' +
                  e.message);
    return;
  }

  if (!names.length) {
    console.error('');
    console.error('  There are no backups in ' + dir);
    console.error('  Make one with:  node backup.js');
    return;
  }

  names.sort(function (a, b) {
    return backup.parseBackupName(b).at - backup.parseBackupName(a).at;
  });

  console.error('');
  console.error('  What is actually in ' + dir + ', newest first:');
  names.slice(0, 5).forEach(function (n, i) {
    console.error('    ' + (i === 0 ? '--latest ->' : '           ') + ' ' + n);
  });
  if (names.length > 5) {
    console.error('    ... and ' + (names.length - 5) + ' more');
  }
}


/**
 * Connects to the maintenance database.
 *
 * 'postgres' and not the application database: you cannot drop a database
 * while you are connected to it, and the whole point of --over-live is to
 * drop it.
 */
async function adminClient() {
  const cfg = backup.settings();
  const client = new Client({
    host: cfg.host, port: Number(cfg.port), user: cfg.user,
    password: cfg.password, database: 'postgres',
    connectionTimeoutMillis: 5000
  });
  await client.connect();
  return client;
}


/** Row count per table in one database, as {ticket: 26414}. */
async function countsIn(database) {
  const cfg = backup.settings();
  const client = new Client({
    host: cfg.host, port: Number(cfg.port), user: cfg.user,
    password: cfg.password, database: database,
    connectionTimeoutMillis: 5000
  });
  await client.connect();
  try {
    const tables = (await client.query(
      `SELECT table_name AS name
         FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name`)).rows.map(function (r) { return r.name; });

    const sql = backup.countQueryFor(tables);
    if (!sql) return {};

    const counts = {};
    (await client.query(sql)).rows.forEach(function (r) {
      counts[r.t] = Number(r.n);
    });
    return counts;
  } finally {
    await client.end();
  }
}


/**
 * Prints the two sets of counts side by side and says whether they agree.
 *
 * THIS IS THE ACTUAL DELIVERABLE of a test restore. "pg_restore exited 0"
 * means the file was syntactically fine. "ticket 26,414 / 26,414" means the
 * rows are there.
 *
 * @return {{same: boolean, lines: number, differences: string[]}}
 */
function compare(expected, actual) {
  const names = Object.keys(expected).concat(Object.keys(actual))
    .filter(function (n, i, all) { return all.indexOf(n) === i; })
    .sort();

  const differences = [];
  console.log('');
  console.log('  table                         compared with      restored');
  console.log('  ----------------------------------------------------------');
  names.forEach(function (n) {
    const a = expected[n];
    const b = actual[n];
    const same = a === b;
    if (!same) differences.push(n);
    console.log('  ' + n.padEnd(28) +
                String(a === undefined ? '-' : a.toLocaleString('en-US')).padStart(12) +
                String(b === undefined ? '-' : b.toLocaleString('en-US')).padStart(14) +
                (same ? '' : '   <-- DIFFERENT'));
  });
  console.log('');

  return { same: differences.length === 0, lines: names.length,
           differences: differences };
}


async function main() {
  const args = process.argv.slice(2);
  const plain = args.filter(function (a) { return !String(a).startsWith('--'); });
  const overLive = hasFlag(args, '--over-live');
  const latest = hasFlag(args, '--latest');
  const asUser = optionValue(args, '--user');

  // `--user postgres` with a space would make 'postgres' a bare argument,
  // and bare arguments are the file and the database. Caught here rather
  // than left to restore into a database called postgres.
  if (hasFlag(args, '--user') && !asUser) {
    console.error('');
    console.error('  Write it as --user=postgres, with the equals sign and');
    console.error('  no space. With a space, "postgres" would be read as the');
    console.error('  name of the database to restore into.');
    console.error('');
    process.exit(1);
  }

  let file = latest ? '' : plain[0];
  const target = latest ? plain[0] : plain[1];

  if ((!latest && !file) || !target) {
    console.error('');
    console.error('  node restore.js --latest <database> --user=postgres');
    console.error('  node restore.js <file>   <database> --user=postgres');
    console.error('');
    console.error('  Examples:');
    console.error('    node restore.js --latest ' +
                  backup.settings().database + '_check --user=postgres');
    console.error('    node restore.js --latest ' + backup.settings().database +
                  ' --over-live --user=postgres');
    console.error('');
    console.error('  --latest is the newest backup in BACKUP_DIR. Nothing to');
    console.error('  type, nothing to mistype.');
    listBackups();
    console.error('');
    process.exit(1);
  }

  if (latest) {
    const dir = backup.backupDir();
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch (e) {
      console.error('  Could not read ' + dir + ': ' + e.message);
      process.exit(1);
    }
    const newest = backup.newestBackup(names);
    if (!newest) {
      console.error('  There are no backups in ' + dir);
      console.error('  Make one with:  node backup.js');
      process.exit(1);
    }
    file = path.join(dir, newest);
    console.log('');
    console.log('  Newest backup: ' + newest);
  }

  /*
    A bare file name means the one in BACKUP_DIR. Typing the folder as well
    is the other half of what goes wrong - a long path with spaces in it,
    quoted by hand, at a command prompt.
  */
  if (file && !/[\\/]/.test(file) && !fs.existsSync(file)) {
    const inDir = path.join(backup.backupDir(), file);
    if (fs.existsSync(inDir)) file = inDir;
  }

  if (!fs.existsSync(file)) {
    console.error('');
    console.error('  There is no file at ' + path.resolve(file));
    listBackups();
    console.error('');
    process.exit(1);
  }

  if (!validName(target)) {
    console.error('  ' + JSON.stringify(target) + ' is not a database name this' +
                  ' script will use. Lower case letters, digits and' +
                  ' underscores, starting with a letter.');
    process.exit(1);
  }

  if (!backup.isBackupFile(path.basename(file))) {
    console.warn('  Note: ' + path.basename(file) + ' is not a name this system' +
                 ' wrote. Carrying on, but check it is the file you meant.');
  }

  /*
    THE USER OVERRIDE, APPLIED BEFORE ANYTHING READS THE SETTINGS.

    settings() reads process.env every time it is called, so writing to
    process.env here is enough for adminClient(), countsIn() and
    pg_restore. The pool in db.js is NOT affected - it captured its own
    settings when the module loaded - which is what we want: the live
    database carries on being read as tvl_api, and only the create/restore
    work is done as the stronger user.

    It always asks for the password, never reuses the one from api/.env:
    that one belongs to tvl_api and would simply be wrong for postgres,
    and a wrong password here produces an authentication failure that
    looks like a permissions problem.
  */
  if (asUser) {
    process.env.PGUSER = asUser;
    const where = (process.env.PGHOST || '127.0.0.1') + ':' +
                  (process.env.PGPORT || '5432');
    process.env.PGPASSWORD =
      await askPassword('  Password for ' + asUser + ' on ' + where + ': ');
  }

  const cfg = backup.settings();
  const live = cfg.database;

  // ------------------------------------------------------------------
  // The two guards.
  // ------------------------------------------------------------------
  /*
    Restoring over the live database throws away everything that has
    happened since the dump was taken. That is sometimes exactly right and
    it is never something to do by accident, so it takes TWO deliberate
    acts: naming the live database, and passing --over-live. Neither alone
    does anything.
  */
  if (target === live && !overLive) {
    console.error('');
    console.error('  REFUSING. ' + target + ' is the live database.');
    console.error('');
    console.error('  Restore into a second database first and look at it:');
    console.error('    node restore.js ' + (latest ? '--latest' : '"' + file + '"') +
                  ' ' + live + '_check' + (asUser ? ' --user=' + asUser : ''));
    console.error('');
    console.error('  If you really do mean to replace the live database and');
    console.error('  lose everything since that file was written, add');
    console.error('  --over-live.');
    console.error('');
    process.exit(1);
  }

  if (overLive && target !== live) {
    console.error('  --over-live is for ' + live + ', but you named ' + target +
                  '. Drop the flag.');
    process.exit(1);
  }

  let admin;
  try {
    admin = await adminClient();
  } catch (e) {
    console.error('');
    console.error('  Could not connect as ' + cfg.user + ' to create a database:');
    console.error('    ' + e.message);
    console.error('');

    /*
      THREE DIFFERENT FAILURES ARRIVE HERE and they need three different
      answers. The first version printed "add --user=postgres" for all of
      them, including to somebody who had just passed --user=postgres -
      advice that is not merely useless but actively misleading, because
      it suggests the flag did not take.
    */
    const authFailed = /password authentication failed|authentication failed|no password supplied|role .* does not exist/i
      .test(e.message);

    if (authFailed && asUser) {
      console.error('  THE PASSWORD WAS NOT ACCEPTED. Usually one of two things:');
      console.error('');
      console.error('  1. It is not the password you think it is. The ' + asUser);
      console.error('     password is the one set when PostgreSQL was');
      console.error('     INSTALLED. It is not the tvl_api password in');
      console.error('     api/.env, and it is not your Windows password.');
      console.error('     Check the character count printed above against');
      console.error('     the length of what you meant to type.');
      console.error('');
      console.error('  2. Nobody remembers it. You can set a new one WITHOUT');
      console.error('     knowing the old one, because pgAdmin is already');
      console.error('     signed in as ' + asUser + '. In pgAdmin, open the');
      console.error('     Query Tool on any database and run:');
      console.error('');
      console.error("       ALTER USER " + asUser + " WITH PASSWORD 'choose-one';");
      console.error('');
      console.error('     pgAdmin will ask you for it the next time it');
      console.error('     reconnects. Then run this command again.');
    } else if (!asUser) {
      console.error('  This script needs a user that may CREATE DATABASE, and');
      console.error('  tvl_api deliberately may not. Add the flag and it will');
      console.error('  ask for the password:');
      console.error('');
      console.error('    node restore.js ' + (latest ? '--latest' : '<file>') +
                    ' ' + target + ' --user=postgres');
    } else {
      console.error('  That is not a password problem. Check that PostgreSQL');
      console.error('  is running and that PGHOST and PGPORT in api/.env');
      console.error('  match it - this tried ' + cfg.host + ':' + cfg.port + '.');
    }
    console.error('');
    process.exit(1);
  }

  try {
    const exists = (await admin.query(
      'SELECT 1 FROM pg_database WHERE datname = $1', [target])).rows.length > 0;

    if (exists && !overLive) {
      console.error('');
      console.error('  REFUSING. The database ' + target + ' already exists.');
      console.error('  It is not this script\'s business to empty a database');
      console.error('  somebody may be using. Pick another name, or drop it');
      console.error('  yourself first:');
      console.error('    DROP DATABASE ' + target + ';');
      console.error('');
      process.exit(1);
    }

    // ----------------------------------------------------------------
    // Over the live one: back up what is there FIRST.
    // ----------------------------------------------------------------
    /*
      Nothing in Backup.gs did this, because Drive's version history made it
      unnecessary. Here it is the difference between a restore you can
      reverse and one you cannot: the state being replaced is about to stop
      existing anywhere.

      If this fails, the restore does not happen. That is the right way
      round.
    */
    if (overLive) {
      console.log('');
      console.log('  Backing up the CURRENT ' + live + ' before replacing it ...');
      const safety = await backup.backupNow();
      if (!safety.ok) {
        console.error('');
        console.error('  STOPPING. Could not back up the current database:');
        console.error('    ' + safety.message);
        console.error('');
        console.error('  Restoring now would destroy the only copy of what is');
        console.error('  in there. Fix the backup first.');
        console.error('');
        process.exit(1);
      }
      console.log('    saved as ' + safety.name + ' (' +
                  backup.formatBytes(safety.bytes) + ')');

      console.log('  Dropping and recreating ' + target + ' ...');
      // WITH (FORCE) disconnects whatever is still connected. Without it,
      // one forgotten pgAdmin window or a running npm start makes the drop
      // fail - which is a safety feature right up until it is 9pm and the
      // database is wrong.
      await admin.query('DROP DATABASE IF EXISTS ' + target + ' WITH (FORCE)');
    }

    // The name was checked against a strict pattern above, which is why it
    // can be concatenated here. CREATE DATABASE takes an identifier, and an
    // identifier cannot be a $1 parameter.
    if (!exists || overLive) {
      await admin.query('CREATE DATABASE ' + target);
      if (!overLive) console.log('  Created the database ' + target + '.');
    }
  } finally {
    await admin.end();
  }

  // ------------------------------------------------------------------
  // The restore itself.
  // ------------------------------------------------------------------
  console.log('  Restoring ' + path.basename(file) + ' into ' + target + ' ...');

  const r = backup.run(backup.pgTool('pg_restore'),
                       backup.restoreArgs(Object.assign({}, cfg, {
                         database: target, file: file
                       })),
                       cfg.password);

  if (!r.ok) {
    console.error('');
    console.error('  RESTORE FAILED');
    console.error('    ' + (r.err || 'exit ' + r.status));
    console.error('');
    console.error('  Nothing was half-applied: --single-transaction means the');
    console.error('  whole restore was rolled back. ' + target + ' is empty.');
    console.error('');
    process.exit(1);
  }

  // pg_restore writes warnings to stderr and still exits 0. Worth showing -
  // "role does not exist" is normal here and other things are not.
  if (r.err) {
    console.log('');
    console.log('  pg_restore said:');
    r.err.split('\n').slice(0, 10).forEach(function (l) {
      console.log('    ' + l);
    });
  }

  // ------------------------------------------------------------------
  // Did it actually work.
  // ------------------------------------------------------------------
  const actual = await countsIn(target);

  /*
    WHAT TO COMPARE AGAINST, AND WHY IT IS NOT THE OBVIOUS ANSWER.

    The obvious answer is the counts recorded in backup_run when that dump
    was taken. It is wrong for the file you will almost always be restoring:
    the row is written AFTER pg_dump finishes, so a dump never contains its
    own result row. Reading backup_run out of the restored database gets you
    the PREVIOUS backup's counts, which are off by a day and quietly
    plausible. The first version of this did exactly that.

    So, in order:

      1. the live database, when it is still there. This is the case for a
         test restore, which is the reason most people run this, and it is
         the only comparison that is end to end: what came out against what
         is in there now.

      2. the newest backup_run row inside the dump, when the live database
         is gone. Off by one backup and clearly labelled as such - on the
         day you have lost the database, one real number beats none.

    Either way the live figures will be AHEAD of the restored ones, because
    time passed. That is not a fault and it is said on screen, so nobody
    reads a correct restore as a broken one.
  */
  let expected = {};
  let against = '';

  try {
    expected = await backup.rowCounts();
    against = 'the live ' + live + ' as it is right now';
  } catch (e) {
    try {
      const client = new Client({
        host: cfg.host, port: Number(cfg.port), user: cfg.user,
        password: cfg.password, database: target, connectionTimeoutMillis: 5000
      });
      await client.connect();
      try {
        const row = (await client.query(
          `SELECT file_name, counts FROM backup_run
            WHERE ok AND counts <> '{}'::jsonb
            ORDER BY started_at DESC LIMIT 1`)).rows[0];
        if (row) {
          expected = row.counts || {};
          against = 'the counts recorded for ' + row.file_name +
                    ', which is ONE BACKUP OLDER than this file';
        }
      } finally { await client.end(); }
    } catch (e2) {
      // Nothing to compare against. Say so and print what is there.
    }
  }

  if (Object.keys(expected).length) {
    console.log('');
    console.log('  Comparing against ' + against + '.');
    console.log('  The comparison column will be AHEAD where rows were added');
    console.log('  after this file was written. That is expected.');
    const c = compare(expected, actual);
    if (c.same) {
      console.log('  Every table matches exactly.');
    } else {
      console.log('  Different in: ' + c.differences.join(', '));
    }
  } else {
    const total = Object.keys(actual)
      .reduce(function (s, k) { return s + actual[k]; }, 0);
    console.log('');
    console.log('  Nothing to compare against - printing what was restored.');
    console.log('  ' + Object.keys(actual).length + ' tables, ' +
                total.toLocaleString('en-US') + ' rows.');
    Object.keys(actual).forEach(function (n) {
      console.log('    ' + n.padEnd(28) + actual[n].toLocaleString('en-US'));
    });
  }

  console.log('');
  console.log('  ===================================================');
  console.log('  ONE MORE STEP, AND THE API WILL NOT WORK WITHOUT IT');
  console.log('  ===================================================');
  console.log('');
  console.log('  The restore left out roles and grants on purpose, so');
  console.log('  tvl_api currently cannot read a single row of ' + target + '.');
  console.log('  Put them back from the repository:');
  console.log('');
  console.log('    psql -U postgres -d ' + target + ' -f ..\\db\\04-api-user.sql');
  console.log('');
  console.log('  Then set the password it expects:');
  console.log('');
  console.log('    psql -U postgres -d ' + target +
              ' -c "ALTER ROLE tvl_api WITH PASSWORD \'<the one in api\\.env>\'"');
  console.log('');
  if (!overLive) {
    console.log('  When you have finished looking at ' + target + ':');
    console.log('    DROP DATABASE ' + target + ';');
    console.log('');
  }

  /*
    The pool in db.js holds its connections open for 30 seconds after the
    last query, and an open connection keeps Node's event loop alive. Without
    this the script finishes its work, prints everything, and then sits there
    looking broken for half a minute.
  */
  await db.pool.end();
}


if (require.main === module) {
  main().catch(function (e) {
    console.error('');
    console.error('  RESTORE FAILED');
    console.error('    ' + e.message);
    console.error('');
    process.exit(1);
  });
}

module.exports = { validName, optionValue, hasFlag, stripEscapes,
                   countsIn, compare };
