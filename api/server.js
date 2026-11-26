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
const { signToken, requireAuth, requireAdmin, requireMaster,
        rankOf, ROLE_RANK } = require('./auth');
const obj = require('./objectives');
const objRead = require('./objectives-read');
const objWrite = require('./objectives-write');
const msgRead = require('./messenger-read');
const msgWrite = require('./messenger-write');
const content = require('./content');
const kpiRead = require('./kpi-read');
const backup = require('./backup');
const uploads = require('./uploads');
const kpi2Read = require('./kpi2-read');
// For /api/uploads/boot, which hands the browser the column lists and the
// patterns it parses a dropped .xlsx with. Taken from the modules the insert
// statements are built from, so client and server cannot disagree.
const merge = require('./ticket-merge');
const kpi = require('./kpi');
const kpi2 = require('./kpi2');
const roster = require('./roster');
const accounts = require('./accounts');
const kpiConfig = require('./kpi-config');

const app = express();
const PORT = Number(process.env.PORT || 3000);

/*
  WHAT THE SHELL'S BRAND BLOCK SAYS, from CONFIG.APP_NAME and
  CONFIG.APP_VERSION in Config.gs, where the comment reads "Bump
  APP_VERSION when you deploy something meaningful."

  In .env rather than in a file here, because that is the Node equivalent of
  the same instruction: the deployment sets it, so bumping it is part of
  deploying rather than part of editing the source. The defaults are the
  values Config.gs carries today, so forgetting to set them says something
  true rather than nothing.
*/
const APP_NAME = process.env.APP_NAME || 'TVL-EAS Database';
const APP_VERSION = process.env.APP_VERSION || 'v0.1';


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

/*
  ONE ROUTE GETS A BIGGER BODY, AND IT HAS TO BE SET UP BEFORE THE REST.

  express.json() below defaults to 100KB, which is right for everything in
  this API: a sign-in, a message, a tick on an objective. A batch of ticket
  rows is a different kind of object - 500 rows of 29 cells, some of them
  ticket bodies - and runs to a few megabytes.

  WHY IT IS HERE AND NOT ON THE ROUTE. Middleware runs in the order it is
  registered, so the 100KB parser below would reach a ticket batch first and
  reject it with 413 before a bigger parser on the route ever ran. Declared
  first, this one consumes the body, and body-parser skips a request whose
  body is already parsed - so the general rule below applies to everything
  except this one path, which is what was wanted.

  WHY requireAuth IS IN FRONT OF THE PARSER. Otherwise a stranger could post
  8MB to this path and have the server parse all of it before finding out
  they are not allowed to. The token is in a header, so it can be checked
  without reading the body at all. The route repeats both guards: a route
  that looks unguarded while its protection lives forty lines away in a
  use() is how an endpoint quietly loses it.

  8MB is roughly 2,000 rows. The browser sends smaller batches than that -
  the point of batching is progress on screen, not filling a request - so
  this is headroom, not a target.
*/
['/api/uploads/tickets', '/api/uploads/feedback'].forEach(function (path) {
  app.use(path,
          function (req, res, next) { requireAuth(req, res, next); },
          function (req, res, next) { requireAdmin(req, res, next); },
          express.json({ limit: '8mb' }));
});

app.use(express.json());

/*
  WHERE THE ROOT GOES.

  Every screen is a file of its own now, which leaves the question the
  single-page original never had to answer: what is at `/`? App.html answers
  it already, in homeView():

      return document.getElementById('view-home') ? 'home' : 'kpi1';

  The portal is where Home lives, and the portal is not ported yet - so the
  dashboard is where you land, which is exactly what that line says to do
  when there is no portal. 302 rather than serving the file at `/`, so the
  address bar tells the truth about which screen is open and a reload or a
  bookmark comes back to it.
*/
app.get('/', function (req, res) { res.redirect(302, '/kpi1.html'); });

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
      `SELECT a.employee_id, a.password_hash, a.role, a.must_change,
              COALESCE(NULLIF(a.full_name, ''), t.full_name, '') AS full_name
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

    /*
      THE CLOCK, THE COUNTER AND THE LOG ROW, in one place.

      This used to be a bare UPDATE of last_login_at. last_login_at alone
      says WHEN somebody signed in and never HOW OFTEN, so an account used
      once out of curiosity in March looked exactly like one used daily -
      and the Accounts screen is where somebody decides whether a login is
      still needed. The log row is the other half: without it the sign-in
      log has nothing in it but the events a master causes.
    */
    await accounts.noteSignIn(acct.employee_id, acct.role);

    res.json({
      ok: true,
      token: signToken(acct.employee_id, acct.role),
      /*
        must_change TRAVELS WITH THE SIGN-IN, because the screen has to know
        before it shows anything else. It is set by a reset and by an
        invitation, and it means the password they just used is one somebody
        else chose and handed to them. Auth.gs takes them straight to the
        card that sets their own; so does this.
      */
      mustChange: Boolean(acct.must_change),
      user: { employee_id: acct.employee_id, full_name: acct.full_name,
              role: acct.role, must_change: Boolean(acct.must_change) }
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


// ===========================================================================
// PRESENCE - who is at their desk right now.
// ===========================================================================
/*
  A FAITHFUL PORT OF src/Presence.gs. The three decisions below were made on
  purpose over there and are repeated here deliberately, because each one is
  easy to lose by accident when the storage changes.

  1. THREE STATES, TWO OF THEM STORED.
       ACTIVE   signed in, page open, has not said otherwise
       AWAY     signed in, but said "not at my desk"
       OFFLINE  never written down - it is what a stale row looks like

     A shut laptop sends nothing. There is no event for it. The only honest
     way to show somebody as gone is for the thing that said they were here
     to stop being true on its own.

  2. EIGHT MINUTES, BECAUSE THE PAGE BEATS EVERY THREE.
     Two missed beats of slack: bad wifi does not blink somebody off the
     page, but a closed laptop is gone inside ten minutes.

  3. NO HISTORY. THIS ONE MATTERS MOST.
     Presence.gs chose CacheService partly so that nothing accumulates:

       "A spreadsheet tab would quietly become a record of when each of
        thirty-seven people was at their desk, day after day, and that is a
        different product from the one that was asked for - one nobody
        consented to and somebody would eventually read."

     A database table does NOT forget by itself, so the forgetting has to be
     written in. presenceSweep() below deletes anything past the old
     CacheService TTL, which is what keeps this a live view and not an
     attendance log. Do not remove it, and do not add an INSERT-per-beat
     "history" table - that would be the product nobody agreed to.
*/
const PRESENCE_WINDOW_MIN = Number(process.env.PRESENCE_WINDOW_MINUTES) || 8;

// Presence.gs: PRESENCE_ENTRY_TTL = 1800. The row outlives the freshness
// window on purpose - the window decides what a row MEANS, the TTL decides
// how long it exists at all. Keeping both means a slow poll degrades into
// "stale, so offline" rather than into a row that vanished mid-read.
const PRESENCE_ROW_TTL_MIN = 30;

/*
  Deletes rows nothing can read any more. Called on each beat, which is a
  write already, so it costs one extra statement every three minutes per
  person rather than one per page poll.
*/
async function presenceSweep() {
  try {
    await db.query(
      "DELETE FROM presence WHERE seen_at < now() - ($1 || ' minutes')::interval",
      [String(PRESENCE_ROW_TTL_MIN)]);
  } catch (e) {
    console.error('[api] presence sweep failed: ' + e.message);
  }
}


// ---------------------------------------------------------------------------
// POST /api/presence/tick - the heartbeat.
// ---------------------------------------------------------------------------
/*
  WHOSE STATE THIS SETS IS NOT A PARAMETER, and that is the whole security
  of it. It comes from the token and nowhere else. Presence.gs says it
  plainly: an endpoint that took an employee ID would be a button for
  marking a colleague away from the other side of the building.

  The only thing the caller may say about themselves is the away flag.

  It returns the caller's own state and NOTHING ELSE. Painting the other
  thirty-five dots is a separate call, made only by the page that draws
  them - most of the time this beats from a screen with no dots on it.
*/
app.post('/api/presence/tick', requireAuth, async function (req, res) {
  try {
    const away = Boolean(req.body && req.body.away);
    const state = away ? 'AWAY' : 'ACTIVE';

    await db.query(
      `INSERT INTO presence (employee_id, state, seen_at)
       VALUES ($1, $2, now())
       ON CONFLICT (employee_id) DO UPDATE
         SET state = EXCLUDED.state, seen_at = EXCLUDED.seen_at`,
      [req.user.employeeId, state]);

    await presenceSweep();

    res.json({ ok: true, me: state });
  } catch (err) {
    fail(res, err, 'could not record your presence');
  }
});


// ---------------------------------------------------------------------------
// POST /api/presence/clear - signing out takes the dot off now.
// ---------------------------------------------------------------------------
/*
  Without this, the one person who tidies up after themselves looks exactly
  like the one who walked away mid-session - which is the distinction the
  whole feature exists to draw.
*/
app.post('/api/presence/clear', requireAuth, async function (req, res) {
  try {
    await db.query('DELETE FROM presence WHERE employee_id = $1',
                   [req.user.employeeId]);
    res.json({ ok: true, me: 'OFFLINE' });
  } catch (err) {
    fail(res, err, 'could not clear your presence');
  }
});


// ---------------------------------------------------------------------------
// GET /api/presence - everybody's state, keyed the way the cards ask.
// ---------------------------------------------------------------------------
/*
  Returns { "20536723": "ACTIVE", "Someone With No ID": "OFFLINE", ... }

  THE KEY IS THE EMPLOYEE ID, OR THE NAME WHEN THERE IS NO ID. That is
  presenceIdOf() in Presence.gs, and both sides take it from the same query
  so there is nothing to normalise - the string the server emits is
  character-for-character the string the card looks up.

  Everybody in the directory appears, including the offline ones. A card
  with no entry would have to guess, and guessing is how a dot ends up grey
  beside somebody sitting at their desk.

  Guarded, though it discloses little next to the directory itself: nothing
  about the team is public, and "mild" is not a category this project has.
*/
app.get('/api/presence', requireAuth, async function (req, res) {
  try {
    const rows = await db.query(`
      SELECT COALESCE(t.employee_id, t.full_name) AS id,
             CASE
               WHEN p.seen_at IS NULL                                THEN 'OFFLINE'
               WHEN p.seen_at > now() - ($1 || ' minutes')::interval THEN p.state
               ELSE                                                       'OFFLINE'
             END AS state
        FROM      team     t
        LEFT JOIN presence p ON p.employee_id = t.employee_id
    `, [String(PRESENCE_WINDOW_MIN)]);

    const map = {};
    rows.forEach(function (r) { if (r.id) map[r.id] = r.state; });

    res.json({ ok: true, window_minutes: PRESENCE_WINDOW_MIN, presence: map });
  } catch (err) {
    fail(res, err, 'could not read presence');
  }
});


// ===========================================================================
// GET /api/objectives - the objectives page.
// ===========================================================================
/*
  Serves what Objective.gs getObjectives() serves, computed by the ported
  arithmetic in objectives.js - the same functions, proved identical to the
  originals over 23,000 comparisons.

  ?period=2026-11  which month the "this month" card is about.
                   Defaults to the current month, clamped into the
                   objective period, because asking for a month outside
                   October-to-March is a question with no answer rather
                   than an error worth a 400.
*/
app.get('/api/objectives', requireAuth, async function (req, res) {
  try {
    const periods = obj.objPeriods();
    const now = new Date();

    let want = String(req.query.period || '').trim();
    if (periods.indexOf(want) === -1) {
      const current = obj.objPeriodOf(now);
      want = periods.indexOf(current) !== -1
        ? current
        : periods[periods.length - 1];   // past the end: show the last month
    }

    const [plan, tasks, log] = await Promise.all([
      objRead.readObjPlan(), objRead.readObjTasks(), objRead.readObjLog()
    ]);

    const autoAll = obj.objAutoAll(tasks.tasks, log, periods, now);

    const progress = obj.objProgressAll(plan, tasks.tasks, log, periods,
                                        want, now, autoAll);

    res.json({
      ok: true,
      period: want,
      periods: periods,
      /*
        THE TWO SUMMARY CARDS.

        plan  = the 29 SMART milestones
        tasks = the 86 EAS objectives, KPIs excluded

        Each carries `month` and `overall`, and each of those is an
        objTallyShare: onTime / late / notDone as whole percents adding to
        exactly 100, `done` as the headline figure, and ticked/total as the
        fraction printed beside it so a reader can check the number against
        the squares rather than take it on trust.
      */
      progress: progress,
      // What the ninety are doing this month, which is also what the
      // UNIQUE_ROLES milestone is scored from.
      unique: (autoAll[want] || {}).UNIQUE_ROLES || null,
      counts: {
        milestones: progress.plan.base,
        objectives: tasks.count,
        eas: progress.tasks.base,
        kpis: tasks.count - progress.tasks.base,
        logRows: log.count
      }
    });
  } catch (err) {
    fail(res, err, 'could not read the objectives');
  }
});


// ---------------------------------------------------------------------------
// POST /api/objectives/tick-task - tick or clear one square of one objective.
// ---------------------------------------------------------------------------
/*
  Ported from tickObjTask [Objective.gs:2083]. Body:

      { task_id: 'OJT-007', period: '2026-11', slot: 0, mark: 'Y' }

  mark is 'Y' done, 'N' missed, anything else clears it to pending -
  objMarksSet decides that, not this endpoint.

  FOUR REFUSALS, IN THE ORIGINAL'S ORDER, because each produces a different
  sentence and the page shows it:

    1. a month outside the objective period
    2. no objective with that id
    3. it is a KPI - nobody ticks those, an admin included
    4. it is not your module

  The reply carries everything needed to redraw THAT ONE ROW and nothing
  else. Objective.gs explains why: a tick used to be followed by a full
  getObjectives - six tab reads and the whole ninety scored again - to show
  one square change colour, which is why pressing two buttons in a row
  looked like the second did nothing.
*/
app.post('/api/objectives/tick-task', requireAuth, async function (req, res) {
  try {
    const body = req.body || {};
    const taskId = String(body.task_id || '').trim();
    const period = String(body.period || '').trim();
    const slot = Number(body.slot);
    const mark = String(body.mark === undefined ? '' : body.mark);

    const periods = obj.objPeriods();
    if (periods.indexOf(period) === -1) {
      return res.status(400).json({ ok: false,
        error: 'That month is outside the objective period (' +
               periods[0] + ' to ' + periods[periods.length - 1] + ').' });
    }

    const all = await objRead.readObjTasks();
    let task = null;
    all.tasks.forEach(function (t) { if (t.id === taskId) task = t; });
    if (!task) {
      return res.status(404).json({ ok: false,
        error: 'There is no objective with that id.' });
    }

    if (task.kpi) {
      return res.status(403).json({ ok: false,
        error: 'That one is a KPI. Its figure comes from the KPI engine ' +
               'and is not ticked by hand.' });
    }

    const me = await objWrite.objWhoAmI(req.user.employeeId, req.user.role);
    if (!objWrite.objMayTick(me, task)) {
      return res.status(403).json({ ok: false,
        error: me.reason ||
          ('That objective belongs to the ' + task.group + ' module. You ' +
           'can tick the ones for your own module.') });
    }

    const slots = obj.objSlotCount(period, task.frequency);
    if (!(slot >= 0) || slot >= slots) {
      return res.status(400).json({ ok: false,
        error: 'There is no slot ' + body.slot + ' in ' + period + ' for a ' +
               String(task.frequency).toLowerCase() + ' objective.' });
    }

    /*
      THE READ AND THE ARITHMETIC BOTH HAPPEN INSIDE THE LOCK.

      This function is handed to writeObjLog and called there, on the row
      as it stands under pg_advisory_xact_lock. Reading the log out here
      and passing the finished marks string would put the read outside the
      lock, and five slots ticked at once would each start from the same
      stale copy - tested, and three of five ticks were lost.
    */
    let marks = '';
    let markedAt = {};

    await objWrite.writeObjLog(period, obj.OBJ_KIND_TASK, task.id,
      function (had) {
        marks = obj.objMarksSet(
          obj.objMarksRead(had ? had.marks : '', slots), slot, mark);

        /*
          WHEN, AS WELL AS WHETHER.

          The time is what tells a square marked on its own day from one
          caught up on afterwards - green from yellow - so it is recorded
          at the moment the mark is made and cleared when the mark is
          cleared. Unmarking and marking again resets the clock, which is
          correct: it is a fresh claim about when the work was recorded.
        */
        markedAt = {};
        const hadTimes = (had && had.marked_at) || {};
        Object.keys(hadTimes).forEach(function (k) {
          const n = Number(hadTimes[k]);
          if (n > 0) markedAt[String(Number(k))] = n;
        });
        if (marks.charAt(slot) === obj.OBJ_DONE) {
          markedAt[String(slot)] = Date.now();
        } else {
          delete markedAt[String(slot)];
        }

        return { marks: marks, markedAt: markedAt };
      },
      { name: me.name, id: me.id });

    const state = obj.objTaskState(task, marks, period, new Date(), markedAt);
    res.json({
      ok: true,
      id: task.id,
      marks: state.marks, slots: state.slots, elapsed: state.elapsed,
      done: state.done, missed: state.missed, silent: state.silent,
      marked: state.marked, late: state.late,
      states: state.cells.map(function (c) { return c.state; }),
      open: state.open, onSchedule: state.onSchedule, due: state.due,
      by: me.name, at: Date.now()
    });

  } catch (err) {
    fail(res, err, 'could not record that tick');
  }
});


// ---------------------------------------------------------------------------
// POST /api/objectives/tick-milestone - mark one month of one SMART milestone.
// ---------------------------------------------------------------------------
/*
  Ported from tickObjMilestone [Objective.gs:2193].
  Body: { milestone_id: 'OBJ-007', period: '2026-11', mark: 'Y' }

  SECTION HEADS AND THE DEPARTMENT HEAD, plus admins. Not everybody: these
  twenty-nine are what the department is scored on. `planner` is true when
  the person's TEAM row has Head set, or they are admin and above.

  A milestone has ONE square for the whole month, so there is no slot - the
  mark is 'Y' or it is cleared, and nothing else.
*/
app.post('/api/objectives/tick-milestone', requireAuth, async function (req, res) {
  try {
    const body = req.body || {};
    const milestoneId = String(body.milestone_id || '').trim();
    const period = String(body.period || '').trim();
    const mark = String(body.mark === undefined ? '' : body.mark);

    const me = await objWrite.objWhoAmI(req.user.employeeId, req.user.role);
    if (!me.planner) {
      return res.status(403).json({ ok: false,
        error: 'Marking the SMART objective is for section heads and the ' +
               'department head. You can tick the unique-role objectives ' +
               'for your own module.' });
    }

    const periods = obj.objPeriods();
    if (periods.indexOf(period) === -1) {
      return res.status(400).json({ ok: false,
        error: 'That month is outside the objective period (' + periods[0] +
               ' to ' + periods[periods.length - 1] + ').' });
    }

    const milestone = await findMilestone(milestoneId);
    if (!milestone) {
      return res.status(404).json({ ok: false,
        error: 'There is no milestone with that id.' });
    }

    if (milestone.auto) {
      return res.status(400).json({ ok: false,
        error: 'That milestone is counted by the portal itself, so there is ' +
               'nothing to tick. It moves when the thing it counts moves.' });
    }

    const marks = (mark === obj.OBJ_DONE) ? obj.OBJ_DONE : obj.OBJ_PENDING;
    // When, as well as whether - it is what tells green from yellow.
    // Clearing the mark clears the time with it, so marking again is a
    // fresh claim.
    const markedAt = {};
    if (marks === obj.OBJ_DONE) markedAt['0'] = Date.now();

    await objWrite.writeObjLog(period, obj.OBJ_KIND_PLAN, milestone.id,
      function () { return { marks: marks, markedAt: markedAt }; },
      { name: me.name, id: me.id });

    const state = obj.objPlanMonthState(milestone,
      { marks: marks, markedAt: markedAt }, period, new Date(), false);

    res.json({ ok: true, id: milestone.id, period: period, marks: marks,
               state: state.state, at: state.at, by: me.name });

  } catch (err) {
    fail(res, err, 'could not mark that milestone');
  }
});


// ---------------------------------------------------------------------------
// POST /api/objectives/record-milestone - the FIGURE for one month.
// ---------------------------------------------------------------------------
/*
  Ported from recordObjMilestone [Objective.gs:2013].
  Body: { milestone_id: 'OBJ-007', period: '2026-11', value: 2 }

  THE FIGURE ONLY. THE MARK IS THE SQUARE.

  This used to set the mark as well, on the grounds that typing a figure is
  reviewing the month. It made the square impossible to take back: press it
  to clear November, save the figure for any reason, and November was
  marked again - which is exactly what "I unclick it and it does not save"
  looks like from the outside.

  They are two claims and they are allowed to disagree. "We completed two
  RCAs" is what was achieved; "somebody reviewed this in November" is the
  monitoring, and only the square says that.

  Note the refusal is narrower than tick-milestone's: only UNIQUE_ROLES is
  rejected, because the other counted sources still allow a typed figure to
  stand in when the source cannot be read.
*/
app.post('/api/objectives/record-milestone', requireAuth, async function (req, res) {
  try {
    const body = req.body || {};
    const milestoneId = String(body.milestone_id || '').trim();
    const period = String(body.period || '').trim();

    const me = await objWrite.objWhoAmI(req.user.employeeId, req.user.role);
    if (!me.planner) {
      return res.status(403).json({ ok: false,
        error: 'Recording against the SMART objective is for section heads ' +
               'and the department head. You can still tick the unique-role ' +
               'objectives for your own module.' });
    }

    const periods = obj.objPeriods();
    if (periods.indexOf(period) === -1) {
      return res.status(400).json({ ok: false,
        error: 'That month is outside the objective period (' + periods[0] +
               ' to ' + periods[periods.length - 1] + ').' });
    }

    const milestone = await findMilestone(milestoneId);
    if (!milestone) {
      return res.status(404).json({ ok: false,
        error: 'There is no milestone with that id.' });
    }

    if (milestone.auto === 'UNIQUE_ROLES') {
      return res.status(400).json({ ok: false,
        error: 'That milestone is counted from the ninety unique-role ' +
               'objectives and is not recorded by hand. Tick those and this ' +
               'moves with them.' });
    }

    const fields = {};
    if (body.value !== undefined && body.value !== null && body.value !== '') {
      const v = Number(body.value);
      if (!(v >= 0)) {
        return res.status(400).json({ ok: false,
          error: 'That is not a number this can record.' });
      }
      if (milestone.countType === 'PERCENT' && v > 100) {
        return res.status(400).json({ ok: false,
          error: 'A percentage cannot be more than 100.' });
      }
      fields.value = v;
    }

    const written = await objWrite.writeObjLog(period, obj.OBJ_KIND_PLAN,
      milestone.id, function () { return fields; },
      { name: me.name, id: me.id });

    res.json({ ok: true, at: written.at, by: written.by });

  } catch (err) {
    fail(res, err, 'could not record that milestone');
  }
});


// ---------------------------------------------------------------------------
// POST /api/objectives/note - one note against one period.
// ---------------------------------------------------------------------------
/*
  Ported from saveObjSlotNote [Objective.gs:2270].
  Body: { kind: 'TASK', ref_id: 'OJT-014', period: '2026-11',
          slot: 7, note: 'text' }

  An empty note deletes it. The permission depends on the kind: a milestone
  note needs planner, an objective note needs the same module rule as
  ticking it.
*/
const NOTE_MAX = 1000;             // Config.gs OBJECTIVE.NOTE_MAX

app.post('/api/objectives/note', requireAuth, async function (req, res) {
  try {
    const body = req.body || {};
    const kind = String(body.kind || '').trim().toUpperCase();
    const ref = String(body.ref_id || '').trim();
    const period = String(body.period || '').trim();
    const slot = Number(body.slot);

    const periods = obj.objPeriods();
    if (periods.indexOf(period) === -1) {
      return res.status(400).json({ ok: false,
        error: 'That month is outside the objective period (' + periods[0] +
               ' to ' + periods[periods.length - 1] + ').' });
    }

    const me = await objWrite.objWhoAmI(req.user.employeeId, req.user.role);
    let slots;

    if (kind === obj.OBJ_KIND_PLAN) {
      if (!me.planner) {
        return res.status(403).json({ ok: false,
          error: 'Notes on the SMART objective are for section heads and the ' +
                 'department head. You can write them on the unique-role ' +
                 'objectives for your own module.' });
      }
      const milestone = await findMilestone(ref);
      if (!milestone) {
        return res.status(404).json({ ok: false,
          error: 'There is no milestone with that id.' });
      }
      // A milestone is recorded once a month, so its month is its one slot.
      slots = 1;

    } else if (kind === obj.OBJ_KIND_TASK) {
      const all = await objRead.readObjTasks();
      let task = null;
      all.tasks.forEach(function (t) { if (t.id === ref) task = t; });
      if (!task) {
        return res.status(404).json({ ok: false,
          error: 'There is no objective with that id.' });
      }
      if (!objWrite.objMayTick(me, task)) {
        return res.status(403).json({ ok: false,
          error: me.reason ||
            ('That objective belongs to the ' + task.group + ' module. You ' +
             'can write notes on the ones for your own module.') });
      }
      slots = obj.objSlotCount(period, task.frequency);

    } else {
      return res.status(400).json({ ok: false,
        error: 'That is not something notes are kept against.' });
    }

    if (!(slot >= 0) || slot >= slots) {
      return res.status(400).json({ ok: false,
        error: 'There is no such period in ' + period + ' to write against.' });
    }

    const text = String(body.note === null || body.note === undefined
                        ? '' : body.note).trim();
    if (text.length > NOTE_MAX) {
      return res.status(400).json({ ok: false,
        error: 'That note is too long - ' + NOTE_MAX + ' characters at most, ' +
               'and this one is ' + text.length + '.' });
    }

    let saved = null;
    await objWrite.writeObjLog(period, kind, ref, function (had) {
      const notes = {};
      const hadNotes = (had && had.notes) || {};
      Object.keys(hadNotes).forEach(function (k) { notes[k] = hadNotes[k]; });

      const key = String(slot);
      const before = notes[key];
      const at = Date.now();

      if (!text) {
        delete notes[key];
      } else {
        notes[key] = {
          t: text, by: me.name, id: me.id, at: at,
          /*
            WHEN IT WAS FIRST WRITTEN SURVIVES AN EDIT. "Saved on the 3rd,
            edited on the 9th" is a different account of a month from
            "saved on the 9th", and only the first one is true.
          */
          made: (before && before.made) || at,
          n: ((before && before.n) || 0) + 1
        };
      }
      saved = notes[key] || null;
      return { notes: notes, noteSlot: slot };
    }, { name: me.name, id: me.id });

    res.json({ ok: true, kind: kind, id: ref, period: period, slot: slot,
               note: saved });

  } catch (err) {
    fail(res, err, 'could not save that note');
  }
});


/** One milestone out of the plan, by id. Used by the three above. */
async function findMilestone(id) {
  const plan = await objRead.readObjPlan();
  let found = null;
  plan.rows.forEach(function (row) {
    row.milestones.forEach(function (m) { if (m.id === id) found = m; });
  });
  return found;
}


// ===========================================================================
// MESSENGER - reading
// ===========================================================================

// ---------------------------------------------------------------------------
// GET /api/messages/mine - this person's own conversations.
// ---------------------------------------------------------------------------
/*
  Ported from myMessages [Messenger.gs:351].

  ONLY VERIFIED THREADS. See the long note in messenger-read.js: a thread
  started from the public sign-in page records what somebody TYPED, not who
  they are, and showing it to the owner of that employee ID would let a
  stranger put words into a colleague's panel.

  That is why a reply to a sign-in-page thread reaches nobody - the exact
  symptom of "I reset his password and sent a reply, and his chatbox is
  empty". The fix is attachSignInThread, not loosening this.
*/
app.get('/api/messages/mine', requireAuth, async function (req, res) {
  try {
    const threads = await msgRead.myThreads(req.user.employeeId);
    res.json({
      ok: true,
      threads: threads,
      unread: threads.reduce(function (n, t) { return n + t.unread; }, 0)
    });
  } catch (err) {
    fail(res, err, 'could not read your messages');
  }
});


// ---------------------------------------------------------------------------
// POST /api/messages/read - mark the team's replies in ONE query as seen.
// ---------------------------------------------------------------------------
/*
  Ported from markMyMessagesRead [Messenger.gs:367].

  PER QUERY, NOT ALL AT ONCE: opening one conversation is not reading the
  others, and clearing their dots would hide a reply the person has not
  looked at yet.

  Three conditions, all required: the thread exists, it is THEIRS, and it
  is verified. Anything else answers ok:false rather than explaining which
  one failed - the caller has no business knowing whether a thread id they
  do not own exists.
*/
app.post('/api/messages/read', requireAuth, async function (req, res) {
  try {
    const threadId = String((req.body && req.body.thread_id) || '').trim();

    const done = await db.query(
      `UPDATE msg_thread SET unread_by_person = 0
        WHERE thread_id = $1 AND person = $2 AND verified = true
        RETURNING thread_id`,
      [threadId, req.user.employeeId]);

    res.json({ ok: done.length > 0 });
  } catch (err) {
    fail(res, err, 'could not mark those as read');
  }
});


// ---------------------------------------------------------------------------
// GET /api/messages/threads - the team's inbox. ADMINS ONLY.
// ---------------------------------------------------------------------------
app.get('/api/messages/threads', requireAuth, requireAdmin,
  async function (req, res) {
    try {
      const threads = await msgRead.listThreads();
      res.json({
        ok: true,
        count: threads.length,
        owed: threads.filter(function (t) { return t.owed; }).length,
        threads: threads
      });
    } catch (err) {
      fail(res, err, 'could not read the inbox');
    }
  });


// ---------------------------------------------------------------------------
// GET /api/messages/waiting - the badge. ADMINS ONLY.
// ---------------------------------------------------------------------------
/*
  How many PEOPLE are owed a word, which is what the sidebar badge shows.

  Messenger.gs:873 - "People, not conversations, and that is the whole of
  this change ... Somebody asks two things and the team answers in one of
  them; the conversation has been had, both of them know it, and the badge
  went on saying 1 for ever."

  COUNTED BY t.key, NOT BY t.person. The key is the card the inbox groups
  by; counting persons instead would merge two cards into one number and
  the badge would contradict the pills it is meant to summarise. See the
  note on it in messenger-read.js.

  Counted from the same listThreads the inbox draws, deliberately: the
  number at the top of the screen and the pills down it come from one
  answer and so cannot differ.

  ANSWERS 0 RATHER THAN FAILING, like the original: "a missing tab is not a
  reason to fail the whole page load." ok:false says so without making the
  sidebar break, and the reason is logged where an admin will see it.
*/
app.get('/api/messages/waiting', requireAuth, requireAdmin,
  async function (req, res) {
    try {
      const threads = await msgRead.listThreads();
      const cards = {};
      threads.forEach(function (t) { if (t.owed) cards[t.key] = true; });
      res.json({ ok: true, waiting: Object.keys(cards).length });
    } catch (err) {
      console.error('  messages/waiting: ' + err.message);
      res.json({ ok: false, waiting: 0 });
    }
  });


// ===========================================================================
// MESSENGER - writing
// ===========================================================================

// ---------------------------------------------------------------------------
// POST /api/messages/send - a signed-in person writes.
// ---------------------------------------------------------------------------
/*
  Ported from sendMessage [Messenger.gs:166].

  thread_id is '' to start a new query, or one of THEIRS to add a line to
  it. Checked in the port, not here: a signed-in person who could pass any
  thread id would be writing into somebody else's conversation, signed with
  that person's name.
*/
app.post('/api/messages/send', requireAuth, async function (req, res) {
  try {
    const b = req.body || {};
    const out = await msgWrite.sendMessage(
      req.user.employeeId, b.thread_id, b.topic, b.text, b.name, b.images);
    res.status(out.ok ? 200 : 400).json(out);
  } catch (err) {
    fail(res, err, 'could not send that');
  }
});


// ---------------------------------------------------------------------------
// POST /api/messages/signin - the message box on the PUBLIC sign-in page.
// ---------------------------------------------------------------------------
/*
  Ported from sendUnverifiedMessage [Messenger.gs:310].

  NO requireAuth, AND THAT IS THE POINT. The person most likely to need the
  message box is the one who cannot get in. Everything that protects it is
  inside the port: an hourly cap for the whole door, a per-ID cap, a length
  limit, a shape check on the employee ID, and a thread marked unverified
  that the claimed owner of that ID will never see.

  IT ANSWERS IDENTICALLY WHETHER OR NOT THE EMPLOYEE ID EXISTS. Checking,
  and saying so, would turn this endpoint into a list of everybody who
  works here for anyone willing to try numbers at it. That includes the
  status code and the timing of the reply, not just the words.
*/
app.post('/api/messages/signin', async function (req, res) {
  try {
    const b = req.body || {};
    const out = await msgWrite.sendUnverifiedMessage(b.employee_id, b.text, b.name);
    res.status(out.ok ? 200 : 400).json(out);
  } catch (err) {
    fail(res, err, 'could not send that');
  }
});


// ---------------------------------------------------------------------------
// POST /api/messages/reply - the team answers. ADMINS ONLY.
// ---------------------------------------------------------------------------
app.post('/api/messages/reply', requireAuth, requireAdmin,
  async function (req, res) {
    try {
      const b = req.body || {};
      const out = await msgWrite.replyToThread(
        req.user.employeeId, b.thread_id, b.text, b.images);
      res.status(out.ok ? 200 : 400).json(out);
    } catch (err) {
      fail(res, err, 'could not send that reply');
    }
  });


// ---------------------------------------------------------------------------
// POST /api/messages/attach - put a sign-in thread on its account. ADMINS.
// ---------------------------------------------------------------------------
/*
  Ported from attachSignInThread [Messenger.gs:820]. This is the answer to
  "I replied and his chatbox was empty" - a person deciding, one
  conversation at a time, after confirming out of band who they rang.

  AN UNVERIFIED MESSAGE IS NOT EVIDENCE OF ANYTHING. It says somebody typed
  an employee ID into a box on a public web page. The admin pressing this
  has read the thread and knows who they spoke to; nothing is linked by
  matching an ID.
*/
app.post('/api/messages/attach', requireAuth, requireAdmin,
  async function (req, res) {
    try {
      const out = await msgWrite.attachSignInThread(
        req.user.employeeId, (req.body || {}).thread_id);
      res.status(out.ok ? 200 : 400).json(out);
    } catch (err) {
      fail(res, err, 'could not attach that conversation');
    }
  });


// ---------------------------------------------------------------------------
// POST /api/messages/delete - destroy a conversation. MASTER ONLY.
// ---------------------------------------------------------------------------
/*
  requireMaster, not requireAdmin, and the original says why: this destroys
  the conversation for the person who wrote it as well as for the team -
  their copy disappears from their own panel with everything they were told
  in it. That is not a thing every admin should be able to do to somebody
  else's record on a mis-click.

  POST rather than DELETE purely for consistency with every other write
  here; the blogspot page posts JSON to all of them.
*/
app.post('/api/messages/delete', requireAuth, requireMaster,
  async function (req, res) {
    try {
      const out = await msgWrite.deleteThread(
        req.user.employeeId, (req.body || {}).thread_id);
      res.status(out.ok ? 200 : 400).json(out);
    } catch (err) {
      fail(res, err, 'could not delete that conversation');
    }
  });


// ---------------------------------------------------------------------------
// GET /api/messages/boot - everything the panel needs to draw itself.
// ---------------------------------------------------------------------------
/*
  Ported from messengerBoot [Messenger.gs:66]. One round trip rather than
  three, because this runs on every page load for every person.
*/
app.get('/api/messages/boot', requireAuth, async function (req, res) {
  try {
    const me = req.user.employeeId;
    const threads = await msgRead.myThreads(me);
    const rank = rankOf(req.user.role);

    res.json({
      ok: true,
      signedIn: true,
      faq: await content.faqEntries(),
      threads: threads,
      unread: threads.reduce(function (n, t) { return n + t.unread; }, 0),
      name: await msgWrite.nameOf(me),
      // Whether that name is on their ACCOUNT, as opposed to one they typed
      // into this panel once. The panel asks for a name only while this is
      // false - a box that keeps asking for something already answered is
      // how the same person ends up stored three different ways.
      nameOnAccount: Boolean(await msgWrite.accountNameOf(me)),
      canAnswer: rank >= ROLE_RANK.ADMIN,
      // Deleting a conversation destroys it for the person who wrote it
      // too, so it belongs to whoever owns the dashboard rather than to
      // every admin.
      canDelete: rank >= ROLE_RANK.MASTER
    });
  } catch (err) {
    fail(res, err, 'could not open the message panel');
  }
});


// ===========================================================================
// CONTENT - the FAQ, the meeting links, Knowledge Share, Learnings
// ===========================================================================

// ---------------------------------------------------------------------------
// GET /api/faq - the published questions. NO SIGN-IN.
// ---------------------------------------------------------------------------
/*
  Ported from faqEntries [Questions.gs:53], which takes no token either:
  "The FAQ is on the sign-in page, where nobody has one, and there is
  nothing in it that is not already meant for everybody."

  The one endpoint in this API that is both public and read-only. It cannot
  be made to say anything about who works here, which is the property that
  makes leaving it open safe - unlike /api/messages/signin, which is public
  because it has to be and is defended from the inside.
*/
app.get('/api/faq', async function (req, res) {
  try {
    const faq = await content.faqEntries();
    res.json({ ok: true, count: faq.length, faq: faq });
  } catch (err) {
    fail(res, err, 'could not read the FAQ');
  }
});


// ---------------------------------------------------------------------------
// GET /api/links - the portal's own links.
// ---------------------------------------------------------------------------
/*
  Ported from portalLinks [Config.gs:1772]. Every address in it is public -
  a SharePoint site, a blogspot page, Microsoft's own sign-in - which is
  why they can be written down in a file at all. The one entry that is not
  a site carries `view: 'byweekly'` and opens the page of four section
  buttons instead, because the four addresses behind THAT are personal
  OneDrive links and live in a table.

  Signed in, like every other screen. The addresses are not secret, but
  which systems a company uses is not something to hand out to anybody who
  finds the API.
*/
app.get('/api/links', requireAuth, function (req, res) {
  try {
    const links = content.portalLinks();
    res.json({ ok: true, count: links.length, links: links });
  } catch (err) {
    fail(res, err, 'could not read the links');
  }
});


// ---------------------------------------------------------------------------
// GET /api/byweekly - where each section keeps its meeting deck.
// ---------------------------------------------------------------------------
app.get('/api/byweekly', requireAuth, async function (req, res) {
  try {
    res.json(await content.byWeeklyLinks());
  } catch (err) {
    fail(res, err, 'could not read the meeting links');
  }
});


// ---------------------------------------------------------------------------
// POST /api/byweekly - set one section's address. MASTER ONLY.
// ---------------------------------------------------------------------------
/*
  NOT IN THE ORIGINAL, where the four addresses are typed straight into the
  BY_WEEKLY tab and refreshByWeeklyLinks() is run from the script editor.
  There is no tab to type into any more, so without this the addresses
  could only be changed with SQL - which is a worse answer than a guarded
  endpoint for something four people need to update when SharePoint
  reissues a share link.

  MASTER, because these addresses are the one piece of this screen that is
  not already public: they are personal OneDrive links carrying their
  owner's work email in the path. Changing one points every colleague at a
  different document.
*/
app.post('/api/byweekly', requireAuth, requireMaster,
  async function (req, res) {
    try {
      const b = req.body || {};
      const out = await content.setByWeeklyLink(b.section, b.url);
      res.status(out.ok ? 200 : 400).json(out);
    } catch (err) {
      fail(res, err, 'could not save that address');
    }
  });


// ---------------------------------------------------------------------------
// GET /api/knowledge - everything the Knowledge Share page needs.
// ---------------------------------------------------------------------------
app.get('/api/knowledge', requireAuth, async function (req, res) {
  try {
    const data = await content.getKnowledge(req.user.employeeId);
    data.ok = true;
    res.json(data);
  } catch (err) {
    fail(res, err, 'could not read the shares');
  }
});


// ---------------------------------------------------------------------------
// POST /api/knowledge - post a share. ANYBODY SIGNED IN.
// ---------------------------------------------------------------------------
/*
  No admin check, and that is the screen's whole point. Knowledge.gs:
  "ANYBODY SIGNED IN CAN POST, there is no approval step, and there is no
  naming convention to get wrong." Learnings is the half with the approval
  step; this is the other half.
*/
app.post('/api/knowledge', requireAuth, async function (req, res) {
  try {
    const out = await content.createKnowledge(req.user.employeeId, req.body);
    res.status(out.ok ? 200 : 400).json(out);
  } catch (err) {
    fail(res, err, 'could not post that share');
  }
});


// ---------------------------------------------------------------------------
// POST /api/knowledge/delete - remove a share. THE AUTHOR ONLY.
// ---------------------------------------------------------------------------
/*
  requireAuth and no more, because the check is not about rank: it is the
  author and nobody else, not even a master. Knowledge.gs decided that
  deliberately - this is a page people post half-finished thoughts to, and
  a note somebody else can delete is a note people think twice about
  writing. The awkward case, a share whose author has left, is rare; the
  chilling effect would be constant.

  So requireMaster here would be the wrong guard, not a stricter one.
*/
app.post('/api/knowledge/delete', requireAuth, async function (req, res) {
  try {
    const out = await content.deleteKnowledge(
      req.user.employeeId, (req.body || {}).id);
    res.status(out.ok ? 200 : 400).json(out);
  } catch (err) {
    fail(res, err, 'could not remove that share');
  }
});


// ---------------------------------------------------------------------------
// GET /api/learn - the approved document library.
// ---------------------------------------------------------------------------
/*
  Ported from getLearning [Learn.gs:909]. READ ONLY from the page, and that
  is correct - "an SOP anybody can edit from a browser is not an SOP."
  Documents arrive by a folder scan, which this port has not replaced yet.
*/
app.get('/api/learn', requireAuth, async function (req, res) {
  try {
    const library = await content.readLearn();
    library.ok = true;
    res.json(library);
  } catch (err) {
    fail(res, err, 'could not read the library');
  }
});


// ===========================================================================
// KPI 1 - Error/Issue Resolution Time
// ===========================================================================

// ---------------------------------------------------------------------------
// GET /api/kpi1 - the figures for a month, a quarter, a list, or all of it.
// ---------------------------------------------------------------------------
/*
  Ported from getKpi1 [Kpi.gs:599].

      ?month=2026-10            one month
      ?month=2026-Q3            a company quarter
      ?month=2026-01,2026-08    two months, without the six between them
      ?month=ALL                every month there is

  ?standard=EAS scores the same tickets against the internal target of
  99.50 instead of the policy's 90.00. NOTHING IS STORED PER STANDARD - the
  counts are facts about the month and the bands are judgements against a
  target, worked out when the screen is drawn. That is what lets one set of
  tickets be read either way with no second table and no re-import.

  SCORED FROM THE TICKETS, NOT FROM A CACHE. See the note at the top of
  kpi-read.js for why the KPI_MONTHLY cache is not ported and why dropping
  it preserves, rather than threatens, the rule that an all-months figure
  is not an average of monthly ones.
*/
app.get('/api/kpi1', requireAuth, async function (req, res) {
  try {
    // Defaults to every month, which is what the screen opens on.
    const month = String(req.query.month || 'ALL').trim() || 'ALL';
    const out = await kpiRead.readKpi1(month, req.query.standard);
    out.ok = true;
    out.months = await kpiRead.monthsAvailable();
    res.json(out);
  } catch (err) {
    fail(res, err, 'could not read the KPI figures');
  }
});


// ---------------------------------------------------------------------------
// GET /api/kpi1/compare - KPI 1 across several months at once.
// ---------------------------------------------------------------------------
/*
  Ported from getKpiComparison [Kpi.gs:825].

      ?months=2026-08,2026-09,2026-10

  FOLLOWS THE SAME ?standard TOGGLE as /api/kpi1, and that is not a
  convenience. The two screens read the same counts, so judging them
  against different targets puts the same section in the same month in two
  different bands - which happened on the live system when the target
  moved and only one of the two recomputed.
*/
// ---------------------------------------------------------------------------
// GET /api/kpi1/boot - the few things the screen needs that /api/kpi1 lacks
// ---------------------------------------------------------------------------
/*
  The KPI 1 half of getBootstrap [Code.gs:191]. Most of what that sent is
  already in the /api/kpi1 reply - the months, the target, the standard's
  label - so this carries only the three things that are not.

  THE COVERAGE LINE IS ABOUT THE DATABASE, NOT THE VIEW. "January 2026 to
  September 2026" does not say whether September is a whole month or the
  first four days of one, and that decides whether the period's rate means
  anything yet: an export taken mid-month scores a month that is still
  running. The month picker says which slice you are reading; this says how
  much there is to read, which is a different question.

  BOTH STANDARDS, in the order the toggle shows them. The screen reads its
  labels, targets and band edges from here rather than repeating them, so a
  figure printed on the toggle cannot disagree with the figure the server
  scored against.
*/
app.get('/api/kpi1/boot', requireAuth, async function (req, res) {
  try {
    const span = (await db.query(
      `SELECT coalesce(to_char(min(request_date) AT TIME ZONE $1,
                               'YYYY-MM-DD'), '') AS from_day,
              coalesce(to_char(max(request_date) AT TIME ZONE $1,
                               'YYYY-MM-DD'), '') AS to_day,
              count(*)::int                       AS tickets
         FROM ticket
        WHERE request_date IS NOT NULL`, ['Asia/Dhaka']))[0];

    // How many ticket uploads the history still claims. With no tickets
    // stored, that is the "a run was killed part way" case, and the screen
    // says so rather than reporting an empty month.
    const logged = (await db.query(
      `SELECT count(*)::int AS n FROM upload_run
        WHERE upper(coalesce(report_types, '')) NOT LIKE '%FEEDBACK%'
          AND rows_added > 0`))[0].n;

    res.json({
      ok: true,
      configured: true,
      role: req.user.role,
      canAdmin: rankOf(req.user.role) >= ROLE_RANK.ADMIN,

      /*
        WHO, for the shell's top bar, as getBootstrap sends it [Code.gs:199].

        THIS WAS MISSING AND IT SHOWED. The pages had only what /api/login
        handed back, which they hold for as long as the tab lives - so after
        a reload, with a perfectly good token in sessionStorage and nobody
        to ask, "Signed in as" printed the ROLE. Everybody who refreshed the
        page was told they were signed in as MASTER.

        From the TOKEN, never from the body: req.user is what requireAuth
        verified a signature over.
      */
      username: req.user.employeeId,

      /*
        WHETHER THEY ARE STILL ON A PASSWORD SOMEBODY ELSE CHOSE.

        The sign-in reply carries this too, but that is only read by the
        tab that did the signing in. After a reload the token is still good
        and nothing has asked - so without it here, somebody could sign in
        with a one-time password, press F5, and never see the card that
        makes them choose their own. The whole point of a reset is that the
        password a master handed over is temporary.
      */
      mustChange: await accounts.mustChangeFor(req.user.employeeId),

      // For the shell's brand block, as getBootstrap sends them for the same
      // block [Code.gs:205]. From the server, not the page: the version is a
      // statement about what is deployed, and a copy inside a .html file that
      // the browser has cached can outlive the deployment it describes.
      appName: APP_NAME,
      appVersion: APP_VERSION,

      standards: [kpi.KPI_RESOLUTION, kpi.KPI_RESOLUTION_EAS],
      // For the chart labels: 'Supply Chain Applications' does not fit on an
      // axis, and dropping the word 'Applications' leaves it two words where
      // its neighbours have one. SCA is what that team calls itself.
      sections: roster.SECTIONS,

      ticketFrom: span.from_day,
      ticketTo: span.to_day,
      stats: { tickets: span.tickets, ticketUploads: logged }
    });
  } catch (err) {
    fail(res, err, 'could not open the KPI 1 screen');
  }
});


// ---------------------------------------------------------------------------
// GET /api/kpi1/affiliates - which affiliates have tickets in this period
// ---------------------------------------------------------------------------
/*
  listAffiliates [Kpi.gs:485]. Fills one dropdown, so it returns names and
  counts and nothing else - no person is named by it.
*/
app.get('/api/kpi1/affiliates', requireAuth, async function (req, res) {
  try {
    const month = String(req.query.month || 'ALL').trim() || 'ALL';
    res.json({ ok: true, affiliates: await kpiRead.affiliateList(month) });
  } catch (err) {
    fail(res, err, 'could not list the affiliates');
  }
});


// ---------------------------------------------------------------------------
// GET /api/kpi1/by-affiliate - one affiliate's people, scored from its tickets
// ---------------------------------------------------------------------------
/*
  getPeopleByAffiliate [Kpi.gs:518]. The standard is passed through because
  these rows sit in the same table as rows scored by /api/kpi1 - band them
  against a different target and the table contradicts itself halfway down.
*/
app.get('/api/kpi1/by-affiliate', requireAuth, async function (req, res) {
  try {
    const month = String(req.query.month || 'ALL').trim() || 'ALL';
    const out = await kpiRead.peopleByAffiliate(month, req.query.affiliate,
                                                req.query.standard);
    res.json(Object.assign({ ok: true }, out));
  } catch (err) {
    fail(res, err, 'could not read the affiliate figures');
  }
});


// ---------------------------------------------------------------------------
// GET /api/summary/boot - the indicators, the database, and the backups
// ---------------------------------------------------------------------------
/*
  The Summary half of getBootstrap [Code.gs:191]. Three cards: every
  indicator's target, bands and achievement; what is actually in the
  database; and whether the backups are happening.

  THE SECOND CARD IS THE POINT OF THIS SCREEN. App.html: "What is actually
  in the database, per KPI, beside what the history claims. When the two
  disagree this is the screen that says so plainly instead of leaving it to
  be inferred from an empty dashboard." So the counts are read from the
  tables themselves and the upload totals from the log, and the screen puts
  them next to each other.

  Any signed-in person. It names no individual and carries no figure that
  is not already on a dashboard they can open.
*/
app.get('/api/summary/boot', requireAuth, async function (req, res) {
  try {
    const [counts, months, quarters, feedbackMonths, audit, health] =
      await Promise.all([
        db.query(`
          SELECT
            (SELECT count(*)::int FROM ticket)   AS tickets,
            (SELECT count(*)::int FROM training) AS feedback,
            (SELECT count(*)::int FROM upload_run
              WHERE report_types NOT LIKE '%FEEDBACK%'
                AND notes NOT LIKE 'deleted%')   AS ticket_uploads,
            (SELECT count(*)::int FROM upload_run
              WHERE report_types LIKE '%FEEDBACK%'
                AND notes NOT LIKE 'deleted%')   AS feedback_uploads`),
        kpiRead.monthsAvailable(),
        kpi2Read.feedbackQuarters(),
        kpi2Read.feedbackMonths(),
        uploads.auditFeedback(),
        /*
          The backups, which have their own endpoint and are deliberately
          unguarded there. Folded in here so the screen is one call rather
          than two, and wrapped because a backup folder that cannot be read
          must not take the whole screen down with it - not being able to
          say how the backups are is itself worth showing.
        */
        backup.backupHealth().catch(function (err) {
          console.error('[api] backup health unreadable: ' + err.message);
          return null;
        })
      ]);

    const n = counts[0];

    res.json({
      ok: true,
      configured: true,
      role: req.user.role,
      canAdmin: rankOf(req.user.role) >= ROLE_RANK.ADMIN,
      username: req.user.employeeId,
      appName: APP_NAME,
      appVersion: APP_VERSION,
      mustChange: await accounts.mustChangeFor(req.user.employeeId),

      kpiList: kpiConfig.KPI_LIST,
      kpiPolicy: kpiConfig.POLICY,
      kpi1Standards: kpiConfig.KPI1_STANDARDS,

      sections: roster.SECTIONS,
      availableMonths: months,
      feedbackQuarters: quarters,
      feedbackMonths: feedbackMonths,

      stats: {
        tickets: n.tickets,
        feedback: n.feedback,
        ticketUploads: n.ticket_uploads,
        feedbackUploads: n.feedback_uploads
      },
      orphanedFeedback: audit.orphans,

      backup: health
    });
  } catch (err) {
    fail(res, err, 'could not open the summary screen');
  }
});


// ---------------------------------------------------------------------------
// GET /api/compare/boot - what the Comparison screen needs before it can draw
// ---------------------------------------------------------------------------
/*
  The comparison half of getBootstrap [Code.gs:191]: the four indicators,
  KPI 1's two standards, and the periods each live KPI actually has data
  for. Two lists and not one, because they are different questions - KPI 1
  compares months and KPI 2 compares quarters, and offering ticket months
  for a training comparison produced four columns of "No data".

  ALL FOUR INDICATORS ARE SENT, including the two with no ingest. App.html:
  "Every KPI is selectable - a disabled option tells you nothing about why."
  Picking one without data gets an explanation instead of an empty screen.
*/
app.get('/api/compare/boot', requireAuth, async function (req, res) {
  try {
    const [months, quarters] = await Promise.all([
      kpiRead.monthsAvailable(),
      kpi2Read.feedbackQuarters()
    ]);

    res.json({
      ok: true,
      configured: true,
      role: req.user.role,
      canAdmin: rankOf(req.user.role) >= ROLE_RANK.ADMIN,
      username: req.user.employeeId,
      appName: APP_NAME,
      appVersion: APP_VERSION,
      mustChange: await accounts.mustChangeFor(req.user.employeeId),

      /*
        The sections, for the chart's axis. shortLabel() turns 'Supply Chain
        Applications' into 'SCA' - the full name does not fit under a bar,
        and truncating it in CSS would hide which section you are looking
        at rather than shorten it.
      */
      sections: roster.SECTIONS,

      kpiList: kpiConfig.KPI_LIST,
      kpiPolicy: kpiConfig.POLICY,
      kpi1Standards: kpiConfig.KPI1_STANDARDS,

      availableMonths: months,
      feedbackQuarters: quarters
    });
  } catch (err) {
    fail(res, err, 'could not open the comparison screen');
  }
});


app.get('/api/kpi1/compare', requireAuth, async function (req, res) {
  try {
    const months = String(req.query.months || '')
      .split(',').map(function (m) { return m.trim(); }).filter(Boolean);
    const out = await kpiRead.kpiComparison(months, req.query.standard);
    out.ok = true;
    out.months = await kpiRead.monthsAvailable();
    res.json(out);
  } catch (err) {
    fail(res, err, 'could not compare those months');
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


// ===========================================================================
// THE ACCOUNTS SCREEN - master only, every one of them
// ===========================================================================
/*
  Ported from the MASTER section of src/Auth.gs. Its opening note applies
  here with more force than it did there:

      "Every one of these is master-only, checked on the server. The master
       screen is hidden from everyone else in the interface, but hiding is a
       courtesy: google.script.run.masterSetRole(...) can be typed into any
       visitor's console, so the guard is what actually holds."

  There it was a console. Here it is a URL on the network, so requireMaster
  is on every single route below, and the actor is taken from req.user -
  which requireAuth put there after verifying a signature - and never from
  the body. Every row the log gains says who did it, and the body cannot
  lie about that.
*/

/** What the Accounts screen needs before it can draw. */
app.get('/api/master/boot', requireAuth, requireMaster,
  async function (req, res) {
    try {
      const team = (await db.query(
        'SELECT count(*)::int AS n FROM team'))[0].n;

      res.json({
        ok: true,
        configured: true,
        role: req.user.role,
        canAdmin: true,
        username: req.user.employeeId,

      /*
        WHETHER THEY ARE STILL ON A PASSWORD SOMEBODY ELSE CHOSE.

        The sign-in reply carries this too, but that is only read by the
        tab that did the signing in. After a reload the token is still good
        and nothing has asked - so without it here, somebody could sign in
        with a one-time password, press F5, and never see the card that
        makes them choose their own. The whole point of a reset is that the
        password a master handed over is temporary.
      */
      mustChange: await accounts.mustChangeFor(req.user.employeeId),
        appName: APP_NAME,
        appVersion: APP_VERSION,

        /*
          HOW MANY PEOPLE THERE ARE TO HAVE LOGINS, which is the count the
          screen prints beside the accounts total. Informational only - see
          the note on the sign-ups box in Index.html: it closes when the
          master says so, never on reaching a number.
        */
        teamSize: team,

        /*
          THE SIGN-UPS SWITCH IS NOT PORTED, and the screen says so rather
          than drawing a control that does nothing. In Apps Script the
          switch governs registerAccount(), which lets anybody who reaches
          the URL claim an employee ID that has no account yet. There is no
          such door here: the only way an account comes into being is a
          master writing an employee ID down on this screen. A switch over
          a door that does not exist is worse than no switch, because it
          looks like a security control and is not one.
        */
        signups: { ported: false, open: false }
      });
    } catch (err) {
      fail(res, err, 'could not open the accounts screen');
    }
  });


/** Everyone, with enough about each to manage them. Never a hash. */
app.get('/api/master/accounts', requireAuth, requireMaster,
  async function (req, res) {
    try {
      res.json({ ok: true, accounts: await accounts.listAccounts() });
    } catch (err) {
      fail(res, err, 'could not list the accounts');
    }
  });


/** The sign-in log, newest first. Pruned on the way out. */
app.get('/api/master/log', requireAuth, requireMaster,
  async function (req, res) {
    try {
      res.json({ ok: true, log: await accounts.auditLog(req.query.limit) });
    } catch (err) {
      fail(res, err, 'could not read the sign-in log');
    }
  });


/** An employee ID gets a role, whether or not it has an account yet. */
app.post('/api/master/grant', requireAuth, requireMaster,
  async function (req, res) {
    try {
      const b = req.body || {};
      const out = await accounts.grantToEmployeeId(
        req.user.employeeId, b.employee_id, b.role);
      res.json(Object.assign({ ok: true }, out));
    } catch (err) {
      fail(res, err, 'could not give that access');
    }
  });


/** Gives or takes away admin. */
app.post('/api/master/role', requireAuth, requireMaster,
  async function (req, res) {
    try {
      const b = req.body || {};
      const out = await accounts.setRole(
        req.user.employeeId, b.employee_id, b.role);
      res.json(Object.assign({ ok: true }, out));
    } catch (err) {
      fail(res, err, 'could not change that role');
    }
  });


/** A name, or where somebody's alerts go. */
app.post('/api/master/details', requireAuth, requireMaster,
  async function (req, res) {
    try {
      const b = req.body || {};
      /*
        undefined MEANS "LEAVE IT ALONE" AND null DOES NOT SURVIVE JSON AS
        undefined - it arrives as null, which setDetails also reads as
        leave-alone. Both spellings have to mean the same thing here,
        because the screen sends one field and null for the other.
      */
      const out = await accounts.setDetails(
        req.user.employeeId, b.employee_id, b.full_name, b.email);
      res.json(Object.assign({ ok: true }, out));
    } catch (err) {
      fail(res, err, 'could not save that');
    }
  });


/**
 * A new password for somebody locked out. The password comes back ONCE.
 *
 * It is in the response body and nowhere else: not in the log row, which
 * records only that a reset happened and who did it, and not in any column
 * it could be read back from.
 */
app.post('/api/master/reset', requireAuth, requireMaster,
  async function (req, res) {
    try {
      const out = await accounts.resetPassword(
        req.user.employeeId, (req.body || {}).employee_id);
      res.json(Object.assign({ ok: true }, out));
    } catch (err) {
      fail(res, err, 'could not reset that password');
    }
  });


/** Takes a login away altogether. */
app.post('/api/master/remove', requireAuth, requireMaster,
  async function (req, res) {
    try {
      const out = await accounts.removeAccount(
        req.user.employeeId, (req.body || {}).employee_id);
      res.json(Object.assign({ ok: true }, out));
    } catch (err) {
      fail(res, err, 'could not remove that login');
    }
  });


// ---------------------------------------------------------------------------
// POST /api/password - somebody changing their own
// ---------------------------------------------------------------------------
/*
  requireAuth AND NOT requireMaster: this is the one thing on this page
  everybody may do. The employee ID comes from the token, never from the
  body, so it cannot be pointed at a colleague - changeMyPassword takes no
  ID argument at all for that reason.

  It is also the other half of a reset. Without it, must_change would be a
  flag nothing could ever clear, and resetting somebody's password would
  leave them permanently holding a password a master chose for them.
*/
app.post('/api/password', requireAuth, async function (req, res) {
  try {
    const b = req.body || {};
    const out = await accounts.changeMyPassword(
      req.user.employeeId, b.current, b.next, b.confirm);
    res.json({ ok: true, username: out.username });
  } catch (err) {
    fail(res, err, 'could not change your password');
  }
});


// ---------------------------------------------------------------------------
// KPI 2 - SAP User Training Satisfaction & Feedback.
// ---------------------------------------------------------------------------
/*
  Any signed-in person, as getKpi2 is. It is the department's own training
  feedback, not a personnel record, and hiding it from the people who gave
  it would be an odd way to ask them for more.

  IT IS NOT A POLICY KPI, and the response says so in every reply. Config.gs:
  TVL-KPI-001 section 5.3 gives EAS three KPIs and this is not one of them,
  so it "must never be presented as though it were". `policy: false` travels
  with the figures rather than being something the page has to remember.
*/
// ---------------------------------------------------------------------------
// GET /api/kpi2/boot - what the KPI 2 screen needs before it can draw
// ---------------------------------------------------------------------------
/*
  The KPI 2 half of getBootstrap [Code.gs:191]: the indicator's own
  definition, the quarters there is feedback for, and the orphan count.

  KPI 2 IS NOT A POLICY KPI AND THAT TRAVELS WITH IT. Config.gs is blunt
  about it - TVL-KPI-001 section 5.3 gives EAS three KPIs and this is not
  one of them, so it "must never be presented as though it were". The
  screen prints that, which means the screen has to be told.

  The orphan count goes to everybody, as it does on the Uploads screen and
  for the same reason: a viewer reading a figure inflated by responses
  nobody can account for should be told, whether or not they can fix it.
*/
app.get('/api/kpi2/boot', requireAuth, async function (req, res) {
  try {
    const [quarters, audit] = await Promise.all([
      kpi2Read.feedbackQuarters(),
      uploads.auditFeedback()
    ]);

    res.json({
      ok: true,
      configured: true,
      role: req.user.role,
      canAdmin: rankOf(req.user.role) >= ROLE_RANK.ADMIN,

      /*
        WHO, for the shell's top bar, as getBootstrap sends it [Code.gs:199].

        THIS WAS MISSING AND IT SHOWED. The pages had only what /api/login
        handed back, which they hold for as long as the tab lives - so after
        a reload, with a perfectly good token in sessionStorage and nobody
        to ask, "Signed in as" printed the ROLE. Everybody who refreshed the
        page was told they were signed in as MASTER.

        From the TOKEN, never from the body: req.user is what requireAuth
        verified a signature over.
      */
      username: req.user.employeeId,

      /*
        WHETHER THEY ARE STILL ON A PASSWORD SOMEBODY ELSE CHOSE.

        The sign-in reply carries this too, but that is only read by the
        tab that did the signing in. After a reload the token is still good
        and nothing has asked - so without it here, somebody could sign in
        with a one-time password, press F5, and never see the card that
        makes them choose their own. The whole point of a reset is that the
        password a master handed over is temporary.
      */
      mustChange: await accounts.mustChangeFor(req.user.employeeId),

      // For the shell's brand block, as getBootstrap sends them for the same
      // block [Code.gs:205]. From the server, not the page: the version is a
      // statement about what is deployed, and a copy inside a .html file that
      // the browser has cached can outlive the deployment it describes.
      appName: APP_NAME,
      appVersion: APP_VERSION,
      kpi: kpi2.KPI_FEEDBACK,
      // Whether a skipped question counts against the rate. The screen
      // says so under the mix chart, because it is the one choice that
      // moves the figure without appearing in any count on screen.
      countsNonResponses: kpi2.COUNT_NON_RESPONSES,
      quarters: quarters,
      orphanedFeedback: audit.orphans
    });
  } catch (err) {
    fail(res, err, 'could not open the KPI 2 screen');
  }
});


app.get('/api/kpi2', requireAuth, async function (req, res) {
  try {
    const out = await kpi2Read.readKpi2(req.query.scope);
    res.json(Object.assign({ ok: true, policy: false }, out));
  } catch (err) {
    fail(res, err, 'could not read the training feedback');
  }
});


/** Quarter by quarter, shaped exactly like /api/kpi1/compare. */
app.get('/api/kpi2/compare', requireAuth, async function (req, res) {
  try {
    const periods = String(req.query.periods || '')
      .split(',')
      .map(function (s) { return s.trim(); })
      .filter(Boolean);

    const out = await kpi2Read.kpi2Comparison(periods);
    res.json(Object.assign({ ok: true, policy: false }, out));
  } catch (err) {
    fail(res, err, 'could not compare the training feedback');
  }
});


/** Which periods have feedback at all, for the pickers. */
app.get('/api/kpi2/periods', requireAuth, async function (req, res) {
  try {
    const [months, quarters] = await Promise.all([
      kpi2Read.feedbackMonths(),
      kpi2Read.feedbackQuarters()
    ]);
    res.json({ ok: true, months: months, quarters: quarters });
  } catch (err) {
    fail(res, err, 'could not list the feedback periods');
  }
});


// ---------------------------------------------------------------------------
// Uploads - the five ITSM exports, straight into PostgreSQL.
// ---------------------------------------------------------------------------
/* The 8MB body for /api/uploads/tickets is set up near the top of this
   file, before the general 100KB parser - see the note there. */

// ---------------------------------------------------------------------------
// GET /api/uploads/boot - everything the screen needs before it can parse
// ---------------------------------------------------------------------------
/*
  Ported from the upload half of getBootstrap [Code.gs:191]. The old screen
  got this inside one big bootstrap that also carried the org chart, the
  month picker, the KPI standards and both comparison pickers; the Uploads
  screen reads seven fields out of all that, and this sends those seven and
  nothing else.

  WHY THE BROWSER IS SENT THE COLUMN LISTS AT ALL, rather than carrying its
  own copy. Code.gs is explicit about it: "Sending the list rather than
  duplicating it in App.html keeps one source of truth - add a column to
  Config.gs and the client follows." The same holds with more force here,
  because the lists now come from the very modules the INSERT statements are
  built from - ticket-merge.js and kpi2.js. A page that built its rows in a
  different order would file every value one column to the left, and no
  error would be raised: every cell is text.

  The patterns are a different kind of thing and worth being clear about.
  The module patterns decide what the upload log SAYS a file was; the
  section patterns the same. Neither decides a figure. Attribution is done
  on the server, from who handled the ticket and from Config, which is why a
  module the filename could not place is left blank rather than guessed at.
*/
app.get('/api/uploads/boot', requireAuth, async function (req, res) {
  try {
    const [trainers, audit] = await Promise.all([
      kpi2Read.trainerList(),
      /*
        THE COUNT GOES TO EVERYBODY, as it did in getBootstrap.

        It was admin-only here for one revision, on the reasoning that the
        button it feeds is admin-only. That was wrong, and App.html says why
        in as many words: "The warning is worth showing everybody - the
        button that acts on it is not, because removing responses changes
        KPI 2 for everyone." A viewer looking at a KPI 2 figure inflated by
        responses nobody can account for should be told, whether or not they
        are the person who can fix it.

        Only the count. The per-file breakdown stays behind
        GET /api/uploads/orphans with requireAdmin, because a feedback
        export's filename can carry the trainer's name.
      */
      uploads.auditFeedback()
    ]);

    const stats = (await db.query(
      'SELECT count(*)::int AS tickets FROM ticket'))[0];

    res.json({
      ok: true,
      configured: true,
      role: req.user.role,
      canAdmin: rankOf(req.user.role) >= ROLE_RANK.ADMIN,

      /*
        WHO, for the shell's top bar, as getBootstrap sends it [Code.gs:199].

        THIS WAS MISSING AND IT SHOWED. The pages had only what /api/login
        handed back, which they hold for as long as the tab lives - so after
        a reload, with a perfectly good token in sessionStorage and nobody
        to ask, "Signed in as" printed the ROLE. Everybody who refreshed the
        page was told they were signed in as MASTER.

        From the TOKEN, never from the body: req.user is what requireAuth
        verified a signature over.
      */
      username: req.user.employeeId,

      /*
        WHETHER THEY ARE STILL ON A PASSWORD SOMEBODY ELSE CHOSE.

        The sign-in reply carries this too, but that is only read by the
        tab that did the signing in. After a reload the token is still good
        and nothing has asked - so without it here, somebody could sign in
        with a one-time password, press F5, and never see the card that
        makes them choose their own. The whole point of a reset is that the
        password a master handed over is temporary.
      */
      mustChange: await accounts.mustChangeFor(req.user.employeeId),

      // For the shell's brand block, as getBootstrap sends them for the same
      // block [Code.gs:205]. From the server, not the page: the version is a
      // statement about what is deployed, and a copy inside a .html file that
      // the browser has cached can outlive the deployment it describes.
      appName: APP_NAME,
      appVersion: APP_VERSION,

      ticketColumns: merge.HEADERS,
      trainingColumns: kpi2.TRAINING_HEADERS,

      departments: roster.SECTIONS,
      trainingModules: kpi2.TRAINING_MODULES,
      trainerModules: trainers,

      // Drives the "logged but not stored" warning: a history that claims
      // tickets while the table is empty means a run was killed part way.
      stats: { tickets: stats.tickets },
      orphanedFeedback: audit.orphans
    });
  } catch (err) {
    fail(res, err, 'could not open the uploads screen');
  }
});


/** Opens an upload. Admin only, as beginUpload in Ingest.gs is. */
app.post('/api/uploads/begin', requireAuth, requireAdmin,
  async function (req, res) {
    try {
      const b = req.body || {};
      const out = await uploads.beginUpload({
        // FROM THE TOKEN, NEVER FROM THE BODY. The browser could claim to be
        // anybody; req.user is what requireAuth verified a signature over.
        who: req.user.employeeId,
        fileNames:   b.fileNames,
        reportTypes: b.reportTypes,
        departments: b.departments,
        totalRows:   b.totalRows,
        dateFrom:    b.dateFrom,
        dateTo:      b.dateTo
      });
      res.json({ ok: true, uploadId: out.uploadId, startedAt: out.startedAt });
    } catch (err) {
      fail(res, err, 'could not open the upload');
    }
  });


/** One chunk of rows. Admin only. */
app.post('/api/uploads/tickets', requireAuth, requireAdmin,
  async function (req, res) {
    const b = req.body || {};

    if (!Array.isArray(b.rows)) {
      return res.status(400).json({ ok: false, error: 'rows must be an array' });
    }

    try {
      const out = await uploads.appendTicketBatch(b.uploadId, b.rows);
      // nulCells is a COUNT, and the screen needs it as one. Left out, the
      // page could only count the problem STRINGS - one per batch - and a
      // real upload of 26,000 tickets reported "34 rows needed cleaning"
      // when what it meant was "34 batches had at least one bad cell in
      // them". Sent as a number so it can be added up honestly.
      res.json({ ok: true, appended: out.appended, inserted: out.inserted,
                 updated: out.updated, totalRows: out.totalRows,
                 nulCells: out.nulCells, problems: out.problems });
    } catch (err) {
      /*
        "was never opened" is the caller's mistake, not the server's, and it
        is the one failure here that a person can act on - so it gets a 400
        and its own sentence rather than the generic 500. Everything else
        still goes through fail(), which does not hand a stranger the text of
        a PostgreSQL error.
      */
      if (/never opened|No upload ID/.test(err.message)) {
        return res.status(400).json({ ok: false, error: err.message });
      }
      fail(res, err, 'could not store the rows');
    }
  });


/** One chunk of training feedback responses. Admin only. */
app.post('/api/uploads/feedback', requireAuth, requireAdmin,
  async function (req, res) {
    const b = req.body || {};

    if (!Array.isArray(b.rows)) {
      return res.status(400).json({ ok: false, error: 'rows must be an array' });
    }

    try {
      const out = await uploads.appendFeedbackBatch(b.uploadId, b.rows);
      res.json(Object.assign({ ok: true }, out));
    } catch (err) {
      if (/never opened|No upload ID/.test(err.message)) {
        return res.status(400).json({ ok: false, error: err.message });
      }
      fail(res, err, 'could not store the responses');
    }
  });


/** Closes a feedback upload. Admin only. Safe to call twice. */
app.post('/api/uploads/feedback/finish', requireAuth, requireAdmin,
  async function (req, res) {
    try {
      const out = await uploads.finishFeedbackUpload((req.body || {}).uploadId);
      res.json(Object.assign({ ok: true }, out));
    } catch (err) {
      if (/not found|No upload ID/.test(err.message)) {
        return res.status(404).json({ ok: false, error: err.message });
      }
      fail(res, err, 'could not close the upload');
    }
  });


/**
 * Training responses whose upload is no longer in the history.
 *
 * READ-ONLY, and separate from the purge on purpose. Ingest.gs keeps the
 * same split: you look at what would go before anything goes.
 */
app.get('/api/uploads/orphans', requireAuth, requireAdmin,
  async function (req, res) {
    try {
      const out = await uploads.auditFeedback();
      // orphanIds is for the purge, not for a screen - a list of thousands
      // of ids is not something a page should be asked to render.
      res.json({ ok: true, orphans: out.orphans, kept: out.kept,
                 files: out.files });
    } catch (err) {
      fail(res, err, 'could not audit the training responses');
    }
  });


/** Removes them. Admin only, as purgeOrphanedFeedback is. */
app.post('/api/uploads/orphans/purge', requireAuth, requireAdmin,
  async function (req, res) {
    try {
      const out = await uploads.purgeOrphanedFeedback();
      res.json(Object.assign({ ok: true }, out));
    } catch (err) {
      fail(res, err, 'could not remove the orphaned responses');
    }
  });


/** Closes the upload. Admin only. Safe to call twice. */
app.post('/api/uploads/finish', requireAuth, requireAdmin,
  async function (req, res) {
    try {
      const out = await uploads.finishUpload((req.body || {}).uploadId);
      res.json(Object.assign({ ok: true }, out));
    } catch (err) {
      if (/not found|No upload ID/.test(err.message)) {
        return res.status(404).json({ ok: false, error: err.message });
      }
      fail(res, err, 'could not close the upload');
    }
  });


/** The history table. Any signed-in person, as getUploadHistory is. */
app.get('/api/uploads', requireAuth, async function (req, res) {
  try {
    const list = await uploads.uploadHistory();
    res.json({ ok: true, count: list.length, uploads: list });
  } catch (err) {
    fail(res, err, 'could not read the upload history');
  }
});


/**
 * One slice of an upload's tickets, as CSV text.
 *
 * Any signed-in person, as getUploadCsvChunk is. It returns JSON holding the
 * text rather than a file, because the page assembles the slices and hands
 * the finished thing to the browser itself - which is what lets it show
 * progress instead of a download that either arrives or does not.
 */
app.get('/api/uploads/csv', requireAuth, async function (req, res) {
  try {
    const out = await uploads.uploadCsvChunk(req.query.uploadId,
                                             req.query.startRow);
    res.json(Object.assign({ ok: true }, out));
  } catch (err) {
    if (/not found|No upload ID/.test(err.message)) {
      return res.status(404).json({ ok: false, error: err.message });
    }
    fail(res, err, 'could not read the upload');
  }
});


/** Removes an upload and the rows that came only from its files. Admin only. */
app.post('/api/uploads/delete', requireAuth, requireAdmin,
  async function (req, res) {
    try {
      const out = await uploads.deleteUpload((req.body || {}).uploadId);
      res.json(Object.assign({ ok: true }, out));
    } catch (err) {
      if (/not found|No upload ID/.test(err.message)) {
        return res.status(404).json({ ok: false, error: err.message });
      }
      fail(res, err, 'could not delete the upload');
    }
  });


// ---------------------------------------------------------------------------
// GET /api/backup/health - is the database being looked after.
// ---------------------------------------------------------------------------
/*
  backupHealth() in Backup.gs, and NOT GUARDED BY A TOKEN, for the reason
  that file gives: it says when the last copy was made and nothing about
  what is in it, and somebody being able to see that the database is looked
  after is a good thing rather than a leak.

  TWO FIELDS ARE WITHHELD that backupHealth() returns. `folder` is an
  absolute path on the server, and `message` is the text of a failure, which
  can name a user, a host or a port. Neither is needed to render "last
  backup: 2am today", and the same reasoning applies as in fail() below: the
  detail belongs in the terminal, where the one person who can act on it is
  looking, not in a response a stranger can fetch.

  Both are in `node backup.js --health`, which only runs on the machine.
*/
app.get('/api/backup/health', async function (req, res) {
  try {
    const h = await backup.backupHealth();
    res.json({
      ok: true,
      on: h.on,
      last: h.last,
      name: h.name,
      lastOk: h.lastOk,
      count: h.count,
      keep: h.keep,
      bytes: h.bytes,
      stale: h.stale
    });
  } catch (err) {
    fail(res, err, 'could not read the backup history');
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
 *
 * ONE EXCEPTION, AND IT IS A DIFFERENT KIND OF ERROR ENTIRELY.
 *
 * "That is the only master account" is not a failure - it is the server
 * declining, in a sentence written here, on purpose, for a person to read.
 * Flattening it to "could not change that role" would leave the Accounts
 * screen saying something went wrong when nothing did, and hide the one
 * piece of information the master needs to decide what to do instead.
 *
 * The marker is set by whoever threw it (`err.said = true`), never inferred
 * from the text - because inferring it would mean a PostgreSQL message that
 * happened to match a pattern getting shown to a stranger. A module that
 * does not set it keeps today's behaviour exactly.
 *
 * 400 and not 500: it is the caller's request that cannot be honoured, and
 * the server is working perfectly.
 */
function fail(res, err, sentence) {
  if (err && err.said) {
    return res.status(400).json({ ok: false, error: err.message });
  }
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
