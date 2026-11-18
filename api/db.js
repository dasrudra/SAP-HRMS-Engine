/**
 * db.js - the one place that talks to PostgreSQL.
 * ===========================================================================
 *
 * WHY A "POOL" AND NOT JUST A CONNECTION
 *
 * Opening a connection to PostgreSQL is not free. The server forks a process,
 * authenticates, sets up a session - call it 20 to 50 milliseconds. Do that
 * on every request and you have thrown away most of the speed you came here
 * for, and with 36 people refreshing at once you would also run the database
 * out of connection slots.
 *
 * A pool opens a handful of connections once, keeps them open, and lends one
 * out per query. Borrowing from the pool costs microseconds. This is the
 * single biggest reason an API answers in 40ms when Apps Script takes 2500.
 *
 * WHY THE PASSWORD IS NOT IN THIS FILE
 *
 * This repository is public. Anything written here is readable by anyone on
 * the internet, for ever, including after it is deleted - git keeps history.
 * So the settings are read from the environment, and the actual values live
 * in api/.env, which .gitignore blocks from ever being committed.
 */

const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.PGHOST     || '127.0.0.1',
  port:     Number(process.env.PGPORT || 5432),
  user:     process.env.PGUSER     || 'postgres',
  password: process.env.PGPASSWORD || '',
  database: process.env.PGDATABASE || 'tvl_eas',

  // At most 10 connections open at once. More than enough for 36 people;
  // small enough that a runaway loop cannot exhaust the server.
  max: 10,

  // Hand a connection back to the system after 30s of doing nothing.
  idleTimeoutMillis: 30000,

  // If the database does not answer in 5s, fail rather than hang for ever.
  // A request that hangs is worse than one that fails: the user has no idea
  // whether to wait or reload.
  connectionTimeoutMillis: 5000
});


/*
  A pooled connection can die quietly - the database restarts, the network
  blips. Without this listener Node treats that as an unhandled error event
  and KILLS THE WHOLE PROCESS. The pool is perfectly capable of replacing a
  dead connection; it just needs somebody to acknowledge the error.
*/
pool.on('error', function (err) {
  console.error('[db] idle client error:', err.message);
});


/**
 * Runs one query and returns the rows.
 *
 * ALWAYS PASS VALUES AS params, NEVER BUILD THEM INTO THE STRING.
 *
 *   right:  query('SELECT * FROM team WHERE employee_id = $1', [id])
 *   wrong:  query('SELECT * FROM team WHERE employee_id = ' + id)
 *
 * The wrong version is a SQL injection hole. If id arrives as
 *
 *     ' OR '1'='1
 *
 * the wrong version returns your entire directory to a stranger. With $1 the
 * value is sent to PostgreSQL separately from the SQL text, so there is no
 * way for it to be read as SQL at all - it is data, and it stays data. This
 * is not a style preference. It is the single most exploited bug class on
 * the web, and $1 makes it impossible rather than unlikely.
 */
async function query(text, params) {
  const started = Date.now();
  const result = await pool.query(text, params);
  const ms = Date.now() - started;

  // Worth seeing while you are learning: you will watch these numbers and
  // start to recognise what "slow" looks like. Drop it to a threshold later.
  console.log('[db] ' + ms + 'ms  ' + result.rowCount + ' row(s)  ' +
              text.replace(/\s+/g, ' ').trim().slice(0, 60));

  return result.rows;
}


/** True if the database answers at all. Used by /api/health. */
async function ping() {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch (e) {
    return false;
  }
}


module.exports = { pool, query, ping };
