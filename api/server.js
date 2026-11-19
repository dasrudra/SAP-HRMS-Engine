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
const obj = require('./objectives');
const objRead = require('./objectives-read');
const objWrite = require('./objectives-write');

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
