/**
 * server.js - the TVL-EAS API.
 * ===========================================================================
 *
 * WHAT THIS REPLACES
 *
 * Today your Blogger page asks Apps Script for things through
 * google.script.run, and Apps Script reads the Google Sheet. That round trip
 * is where your four seconds go.
 *
 * This file does the same job over plain HTTP against PostgreSQL. The page
 * will call fetch('.../api/team') instead, and get an answer in about the
 * time it takes to blink.
 *
 * HOW TO RUN IT
 *
 *     cd api
 *     npm install          (once)
 *     npm start
 *
 * Then open http://localhost:3000/api/health in a browser.
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const db = require('./db');
const { hashPassword, verifyPassword, needsRehash } = require('./password');
const { signToken, requireAuth, requireAdmin } = require('./auth');

const app = express();
const PORT = Number(process.env.PORT || 3000);


// ---------------------------------------------------------------------------
// CORS - the thing that will confuse you later if it is not set up now.
// ---------------------------------------------------------------------------
/*
  Your page is served from tvl-eas.blogspot.com. This API answers from a
  different address. Browsers refuse to let a page read a response from
  another origin unless that origin says it is allowed - the Same-Origin
  Policy. The refusal happens in the BROWSER, so your server log shows a
  perfectly normal 200 while the page shows nothing and the console says
  something about Access-Control-Allow-Origin. People lose afternoons to it.

  ALLOWED_ORIGINS is a comma-separated list in .env. It is a list and not '*'
  on purpose: '*' lets any website on the internet read your directory.
*/
const ALLOWED = String(process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(function (s) { return s.trim(); })
  .filter(Boolean);

app.use(cors({
  origin: function (origin, done) {
    // No origin: curl, Postman, or the browser's own address bar. Allowed -
    // these are not cross-site requests and there is no cookie to steal.
    if (!origin) return done(null, true);
    if (ALLOWED.indexOf(origin) !== -1) return done(null, true);
    return done(new Error('Origin not allowed: ' + origin));
  }
}));

app.use(express.json());

/*
  Serves api/public as plain files, so http://localhost:3000/demo.html works.
  Only for the test page - the real portal stays on Blogger.
*/
app.use(express.static(require('path').join(__dirname, 'public')));


// ---------------------------------------------------------------------------
// Timing, so the speed is a number and not an impression.
// ---------------------------------------------------------------------------
app.use(function (req, res, next) {
  const started = Date.now();
  res.on('finish', function () {
    console.log('[api] ' + res.statusCode + '  ' + (Date.now() - started) +
                'ms  ' + req.method + ' ' + req.originalUrl);
  });
  next();
});


// ---------------------------------------------------------------------------
// GET /api/health - is the server up, and can it reach the database?
// ---------------------------------------------------------------------------
/*
  Two separate questions, and the distinction matters when something breaks.
  "The server is up but the database is unreachable" and "nothing is
  listening at all" look identical from a browser and need completely
  different fixes.
*/
app.get('/api/health', async function (req, res) {
  const dbUp = await db.ping();
  res.status(dbUp ? 200 : 503).json({
    ok: dbUp,
    service: 'tvl-eas-api',
    database: dbUp ? 'connected' : 'unreachable',
    time: new Date().toISOString()
  });
});


// ---------------------------------------------------------------------------
// POST /api/login
// ---------------------------------------------------------------------------
/*
  SLOWING DOWN GUESSING.

  This endpoint is reachable by anybody. Without a limit, a script can try
  thousands of passwords a minute against a known employee ID, and employee
  IDs are not secret - they are printed on the badges.

  The counter is per employee ID and lives in memory, which has two honest
  limitations: it resets when the server restarts, and it is not shared if
  the API ever runs as more than one process. For 36 people on one small
  host that is the right amount of machinery. A shared store (Redis) is the
  answer when either of those stops being true, and not before.
*/
const MAX_TRIES   = 8;
const LOCK_MS     = 10 * 60 * 1000;      // ten minutes
const attempts    = new Map();           // employeeId -> { n, until }

function lockedFor(id) {
  const rec = attempts.get(id);
  if (!rec || !rec.until) return 0;
  const left = rec.until - Date.now();
  if (left <= 0) { attempts.delete(id); return 0; }
  return left;
}

function noteFailure(id) {
  const rec = attempts.get(id) || { n: 0, until: 0 };
  rec.n += 1;
  if (rec.n >= MAX_TRIES) { rec.until = Date.now() + LOCK_MS; rec.n = 0; }
  attempts.set(id, rec);
}

/*
  Keeps the Map from growing without limit. Every failed ID would otherwise
  stay for the life of the process, and the IDs are supplied by the caller -
  so a script could add millions of them and exhaust memory. A sweep every
  fifteen minutes drops anything no longer locked.

  unref() lets Node exit even though this timer is pending; without it the
  process would never quit on its own.
*/
setInterval(function () {
  const now = Date.now();
  attempts.forEach(function (rec, id) {
    if (!rec.until || rec.until < now) attempts.delete(id);
  });
}, 15 * 60 * 1000).unref();


app.post('/api/login', async function (req, res) {
  try {
    const employeeId = String((req.body && req.body.employee_id) || '').trim();
    const password   = String((req.body && req.body.password)    || '');

    if (!employeeId || !password) {
      return res.status(400).json({ ok: false,
                                    error: 'employee ID and password are both required' });
    }

    const waitMs = lockedFor(employeeId);
    if (waitMs) {
      return res.status(429).json({
        ok: false,
        error: 'too many attempts - try again in ' +
               Math.ceil(waitMs / 60000) + ' minute(s)' });
    }

    const rows = await db.query(
      `SELECT a.employee_id, a.password_hash, a.role, t.full_name
         FROM account a JOIN team t ON t.employee_id = a.employee_id
        WHERE a.employee_id = $1`, [employeeId]);

    /*
      ONE MESSAGE FOR BOTH FAILURES, and it matters.

      "No such employee" and "wrong password" are different facts, and
      saying which is which hands an attacker a list of valid IDs to
      concentrate on. Both answers are the same sentence and the same
      status code.

      The timing is the other half of that. Returning early when there is
      no account would answer in 2ms, while a real account costs ~200ms
      hashing - and that difference alone tells them the ID is real. So a
      missing account still runs a hash, against a throwaway value, to
      spend about the same time.
    */
    if (!rows.length) {
      verifyPassword(password, hashPassword('not-a-real-account-placeholder'));
      noteFailure(employeeId);
      return res.status(401).json({ ok: false, error: 'wrong employee ID or password' });
    }

    const acct = rows[0];
    if (!verifyPassword(password, acct.password_hash)) {
      noteFailure(employeeId);
      return res.status(401).json({ ok: false, error: 'wrong employee ID or password' });
    }

    attempts.delete(employeeId);   // a good sign-in clears the count

    /*
      The only moment the plain password exists on the server is right
      here, so this is the only moment an old hash can be upgraded to the
      current cost. Done quietly; the person notices nothing.
    */
    if (needsRehash(acct.password_hash)) {
      try {
        await db.query('UPDATE account SET password_hash = $1 WHERE employee_id = $2',
                       [hashPassword(password), employeeId]);
      } catch (e) {
        console.error('[api] rehash failed for ' + employeeId + ': ' + e.message);
      }
    }

    await db.query('UPDATE account SET last_login_at = now() WHERE employee_id = $1',
                   [employeeId]);

    res.json({
      ok: true,
      token: signToken(acct.employee_id, acct.role),
      user: { employee_id: acct.employee_id, full_name: acct.full_name, role: acct.role }
    });

  } catch (err) {
    fail(res, err, 'could not sign you in');
  }
});


// ---------------------------------------------------------------------------
// GET /api/me - who the current token says you are.
// ---------------------------------------------------------------------------
// The page uses this on load to find out whether its stored token is still
// good, without having to ask for the password again.
app.get('/api/me', requireAuth, async function (req, res) {
  try {
    const rows = await db.query(
      `SELECT t.employee_id, t.full_name, t.designation, t.sub_department,
              a.role, a.last_login_at
         FROM team t JOIN account a ON a.employee_id = t.employee_id
        WHERE t.employee_id = $1`, [req.user.employeeId]);

    if (!rows.length) {
      // The token is valid but the account has gone since it was issued.
      return res.status(401).json({ ok: false, error: 'account no longer exists' });
    }
    res.json({ ok: true, user: rows[0] });
  } catch (err) {
    fail(res, err, 'could not read your account');
  }
});


// ---------------------------------------------------------------------------
// GET /api/team - the directory, with role and live presence.
// ---------------------------------------------------------------------------
/*
  THIS IS QUERY 4 FROM 02-queries.sql, UNCHANGED.

  That is the point worth noticing. You wrote it in pgAdmin, saw it work,
  and now it is the endpoint. The join and the staleness rule live here, on
  the server, in one place - not split between the server and the browser
  the way the Apps Script version was. That split is where your grey-dot bug
  came from.

  PRESENCE_WINDOW is minutes of silence before somebody counts as offline.
  It is a setting rather than a number buried in the SQL, because you will
  want to change it once you see it working with real people.
*/
const TEAM_SQL = `
  SELECT t.employee_id,
         t.full_name,
         t.designation,
         t.module,
         t.sub_department,
         t.office,
         t.extension,
         t.is_head,
         COALESCE(a.role, '-') AS role,
         CASE
           WHEN p.seen_at IS NULL                                     THEN 'OFFLINE'
           WHEN p.seen_at > now() - ($1 || ' minutes')::interval      THEN p.state
           ELSE                                                            'OFFLINE'
         END AS presence
  FROM       team     t
  LEFT JOIN  account  a ON a.employee_id = t.employee_id
  LEFT JOIN  presence p ON p.employee_id = t.employee_id
  ORDER BY   t.sub_department, t.full_name
`;

app.get('/api/team', requireAuth, async function (req, res) {
  try {
    const minutes = String(Number(process.env.PRESENCE_WINDOW_MINUTES) || 8);
    const rows = await db.query(TEAM_SQL, [minutes]);
    res.json({ ok: true, count: rows.length, team: rows });
  } catch (err) {
    fail(res, err, 'could not read the directory');
  }
});


// ---------------------------------------------------------------------------
// GET /api/team/:id - one person.
// ---------------------------------------------------------------------------
app.get('/api/team/:id', requireAuth, async function (req, res) {
  try {
    // req.params.id came from the URL, which means it came from a stranger.
    // It goes in as $1 and never into the SQL text. See the note in db.js.
    const rows = await db.query(
      'SELECT * FROM team WHERE employee_id = $1', [req.params.id]);

    if (!rows.length) {
      return res.status(404).json({ ok: false, error: 'no such employee' });
    }
    res.json({ ok: true, person: rows[0] });
  } catch (err) {
    fail(res, err, 'could not read that person');
  }
});


// ---------------------------------------------------------------------------
// GET /api/sections - the counting query.
// ---------------------------------------------------------------------------
app.get('/api/sections', requireAuth, async function (req, res) {
  try {
    /*
      THE ::int CASTS ARE NOT DECORATION. Read this one.

      COUNT() in PostgreSQL returns bigint - a 64-bit integer. JavaScript
      numbers cannot hold every 64-bit integer exactly, so node-postgres
      refuses to guess and hands bigint back as a STRING. Without the casts
      this endpoint returns

          { "people": "2", "heads": "1" }

      and the first thing anybody writes - people + 1 - produces "21".
      Worse, it sorts wrongly: "10" < "9" as text. The bug appears weeks
      later in a chart nobody can explain.

      ::int tells PostgreSQL to send a 32-bit integer instead, which fits in
      a JavaScript number exactly, so it arrives as 2. Safe here - these are
      counts of people, not of rows in a billion-row table.
    */
    const rows = await db.query(`
      SELECT t.sub_department                          AS section,
             COUNT(*)::int                             AS people,
             COUNT(a.employee_id)::int                 AS with_login,
             (COUNT(*) FILTER (WHERE t.is_head))::int  AS heads
      FROM       team    t
      LEFT JOIN  account a ON a.employee_id = t.employee_id
      GROUP BY   t.sub_department
      ORDER BY   people DESC
    `);
    res.json({ ok: true, sections: rows });
  } catch (err) {
    fail(res, err, 'could not count the sections');
  }
});


// ---------------------------------------------------------------------------
// GET /api/accounts - who has a login. ADMINS ONLY.
// ---------------------------------------------------------------------------
/*
  requireAuth FIRST, then requireAdmin. Express runs middleware in the order
  written, and requireAdmin reads req.user, which requireAuth is what puts
  there. Written the other way round it would read undefined and refuse
  everybody - which at least fails safe, but for the wrong reason.

  Note what is NOT selected: password_hash. There is no reason for a hash
  to travel to a browser, so it does not, not even for an admin.
*/
app.get('/api/accounts', requireAuth, requireAdmin, async function (req, res) {
  try {
    const rows = await db.query(`
      SELECT t.employee_id, t.full_name, a.role, a.must_change, a.last_login_at
        FROM team t
        JOIN account a ON a.employee_id = t.employee_id
       ORDER BY a.role DESC, t.full_name
    `);
    res.json({ ok: true, count: rows.length, accounts: rows });
  } catch (err) {
    fail(res, err, 'could not list accounts');
  }
});


// ---------------------------------------------------------------------------
// Anything else.
// ---------------------------------------------------------------------------
app.use(function (req, res) {
  res.status(404).json({ ok: false, error: 'no such endpoint: ' + req.path });
});


/**
 * One place that turns an exception into a response.
 *
 * NOTE WHAT IT DOES NOT DO: it does not send err.message to the browser.
 * A PostgreSQL error names tables, columns and constraints, and handing that
 * to a stranger is free reconnaissance for them. The detail goes to your
 * console, where you need it; the caller gets a sentence.
 */
function fail(res, err, sentence) {
  console.error('[api] ' + sentence + ':', err.message);
  res.status(500).json({ ok: false, error: sentence });
}


app.listen(PORT, function () {
  console.log('');
  console.log('  TVL-EAS API listening on http://localhost:' + PORT);
  console.log('');
  console.log('  try:  http://localhost:' + PORT + '/api/health');
  console.log('        http://localhost:' + PORT + '/api/team');
  console.log('        http://localhost:' + PORT + '/api/sections');
  console.log('');
});
