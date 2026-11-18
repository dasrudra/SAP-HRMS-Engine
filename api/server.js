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

app.get('/api/team', async function (req, res) {
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
app.get('/api/team/:id', async function (req, res) {
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
app.get('/api/sections', async function (req, res) {
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
