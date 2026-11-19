/**
 * set-password.js - gives somebody a login, from the command line.
 * ===========================================================================
 *
 *     cd api
 *     node set-password.js 20990001
 *     node set-password.js 20990001 --admin
 *
 * It asks for the password twice, hashes it, and writes the hash to the
 * account table. Creates the account if there is none, updates it if there
 * is.
 *
 * WHY A COMMAND-LINE SCRIPT AND NOT A WEB PAGE
 *
 * Somebody has to create the FIRST admin, and that cannot be done through
 * an admin-only screen - there is no admin yet. Every system has this
 * problem and the usual wrong answers are a default password baked into
 * the code, or an open "create admin" page somebody forgets to remove.
 *
 * A script that only runs on a machine with the database password is the
 * safe version: having that is already proof of being an administrator.
 *
 * THE PASSWORD IS NEVER PASSED AS AN ARGUMENT, on purpose. A command line
 * is saved in your shell history and is visible to anybody who can list
 * processes. It is typed at a prompt instead, and the typing is hidden.
 */

require('dotenv').config();

const readline = require('readline');
const db = require('./db');
const { hashPassword } = require('./password');

const MIN_LENGTH = 10;


/*
  Reads piped stdin ONCE and hands the lines out one at a time.

  Shared between every askHidden() call in the run, which is the point:
  stdin can only be drained once, so draining it twice gets nothing the
  second time.
*/
let pipedPromise = null;
function pipedLines() {
  if (pipedPromise) return pipedPromise;
  pipedPromise = new Promise(function (resolve) {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', function (d) { buf += d; });
    process.stdin.on('end', function () {
      resolve(buf.split(/\r?\n/));
    });
    process.stdin.resume();
  });
  return pipedPromise;
}


/**
 * Asks a question with the typing hidden, showing one * per character.
 *
 * WHY RAW MODE, AND WHY THE OBVIOUS VERSION DOES NOT WORK
 *
 * The tempting approach is readline's question(), plus a handler that
 * clears the line after each keystroke. It was written that way first and
 * it is wrong: the terminal echoes the character ITSELF, before any
 * JavaScript runs, so each letter appears and is then wiped. It flickers,
 * and a pasted password lands on screen whole. Driving it through a real
 * terminal to check showed exactly that - the password was plainly
 * readable in the output.
 *
 * setRawMode(true) turns the terminal's own echo off and hands over every
 * keystroke. Nothing appears unless this code prints it, so it prints a
 * star. That is the only version that actually hides anything.
 */
function askHidden(question) {
  return new Promise(function (resolve) {
    const stdin = process.stdin;

    // No terminal - input is piped or redirected. There is no screen to
    // hide the password from, and raw mode is not available, so read plain
    // lines. This is what makes the script usable from automation.
    //
    // ONE READER FOR THE WHOLE RUN, and that is the bug this replaced.
    // The first version made a fresh readline interface per question and
    // closed it after answering. Closing it ends the shared stdin, so the
    // SECOND question got a reader attached to a stream that was already
    // finished and simply waited for ever - the script hung at "Type it
    // again:" and wrote nothing, silently. It looked like it had worked.
    if (!stdin.isTTY) {
      process.stdout.write(question);
      pipedLines().then(function (lines) {
        resolve(lines.length ? lines.shift() : '');
      });
      return;
    }

    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let buffer = '';

    const finish = function (value, code) {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stdout.write('\n');
      if (code !== undefined) process.exit(code);
      resolve(value);
    };

    // A chunk can hold MORE THAN ONE character - a paste arrives all at
    // once - so every character is handled, not just the first.
    const onData = function (chunk) {
      for (const ch of String(chunk)) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return finish(buffer);
        if (ch === '\u0003') return finish('', 130);          // Ctrl+C
        if (ch === '\u007f' || ch === '\b') {                 // backspace
          if (buffer.length) {
            buffer = buffer.slice(0, -1);
            process.stdout.write('\b \b');                    // rub out one star
          }
          continue;
        }
        if (ch < ' ') continue;                               // other control keys
        buffer += ch;
        process.stdout.write('*');
      }
    };

    stdin.on('data', onData);
  });
}


async function main() {
  const employeeId = String(process.argv[2] || '').trim();
  const makeAdmin  = process.argv.indexOf('--admin') !== -1;

  if (!employeeId) {
    console.error('');
    console.error('  Usage:  node set-password.js <employee_id> [--admin]');
    console.error('  Example: node set-password.js 20990001 --admin');
    console.error('');
    process.exit(1);
  }

  // The person must already be in the directory. The foreign key would
  // refuse the insert anyway, but "that employee ID is not in the TEAM
  // table" is a better message than a constraint violation.
  const who = await db.query(
    'SELECT employee_id, full_name FROM team WHERE employee_id = $1',
    [employeeId]);

  if (!who.length) {
    console.error('');
    console.error('  No employee ' + employeeId + ' in the team table.');
    console.error('  Check the ID, or import the directory first.');
    console.error('');
    process.exit(1);
  }

  const existing = await db.query(
    'SELECT role FROM account WHERE employee_id = $1', [employeeId]);

  console.log('');
  console.log('  Setting a password for: ' + who[0].full_name +
              '  (' + employeeId + ')');
  console.log('  Role:                   ' + (makeAdmin ? 'ADMIN' : 'USER'));
  console.log('  Account:                ' +
              (existing.length ? 'exists - will be UPDATED' : 'will be created'));
  console.log('');

  const first  = await askHidden('  New password:     ');
  const second = await askHidden('  Type it again:    ');

  if (first !== second) {
    console.error('\n  They do not match. Nothing was changed.\n');
    process.exit(1);
  }
  if (first.length < MIN_LENGTH) {
    console.error('\n  Too short - at least ' + MIN_LENGTH +
                  ' characters. Nothing was changed.\n');
    process.exit(1);
  }

  const hash = hashPassword(first);
  const role = makeAdmin ? 'ADMIN' : 'USER';

  /*
    ON CONFLICT DO UPDATE - one statement that inserts or updates, often
    called an upsert. The alternative is SELECT, decide, then INSERT or
    UPDATE, which is three round trips and has a gap in the middle where
    somebody else can insert the same row.
  */
  await db.query(
    `INSERT INTO account (employee_id, password_hash, role, must_change)
     VALUES ($1, $2, $3, false)
     ON CONFLICT (employee_id) DO UPDATE
       SET password_hash = EXCLUDED.password_hash,
           role          = EXCLUDED.role,
           must_change   = false`,
    [employeeId, hash, role]);

  console.log('');
  console.log('  Done. ' + who[0].full_name + ' can now sign in as ' +
              employeeId + '.');
  console.log('');

  await db.pool.end();
}


main().catch(function (err) {
  console.error('\n  Failed: ' + err.message + '\n');
  process.exit(1);
});
