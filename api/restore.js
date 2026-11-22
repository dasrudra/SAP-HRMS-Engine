/**
 * restore.js - putting a backup back.
 * ===========================================================================
 *
 * THIS FILE IS PLAIN ASCII, like the rest of the project.
 *
 *     cd api
 *     node restore.js <file> tvl_eas_check          into a second database
 *     node restore.js <file> tvl_eas --over-live    over the real one
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
 * Creating a database is not something tvl_api is allowed to do, and that is
 * correct - see db/04-api-user.sql. So this one script needs a PostgreSQL
 * user that can. Set the two variables in the terminal before running it,
 * which beats them in api/.env because dotenv does not overwrite what is
 * already in the environment:
 *
 *     Windows:   set PGUSER=postgres
 *                set PGPASSWORD=the-postgres-password
 *
 * They last only as long as that terminal window.
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
  const flags = args.filter(function (a) { return a.startsWith('--'); });
  const plain = args.filter(function (a) { return !a.startsWith('--'); });
  const overLive = flags.indexOf('--over-live') !== -1;

  const file = plain[0];
  const target = plain[1];

  if (!file || !target) {
    console.error('');
    console.error('  node restore.js <file> <database> [--over-live]');
    console.error('');
    console.error('  Examples:');
    console.error('    node restore.js "' +
                  path.join(backup.backupDir(), backup.backupFileName()) +
                  '" tvl_eas_check');
    console.error('    node restore.js <file> ' + backup.settings().database +
                  ' --over-live');
    console.error('');
    process.exit(1);
  }

  if (!fs.existsSync(file)) {
    console.error('  There is no file at ' + path.resolve(file));
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
    console.error('    node restore.js "' + file + '" ' + live + '_check');
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
    console.error('  This script needs a user that may CREATE DATABASE, and');
    console.error('  tvl_api deliberately may not. In this terminal:');
    console.error('    set PGUSER=postgres');
    console.error('    set PGPASSWORD=the-postgres-password');
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

module.exports = { validName, countsIn, compare };
