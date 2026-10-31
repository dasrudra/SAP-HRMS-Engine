// Presence.gs, on the server, against a cache and a clock.
//
// WHY THIS EXISTS
// The browser suite drives a harness whose presenceTick and getPresence are
// twenty lines of fixture, so it tests how the page DRAWS a dot and nothing
// at all about how the dot is DECIDED. Everything that could actually be
// wrong is on this side:
//
//   the join           a login is whatever was typed when the account was
//                      made; the directory knows people by employee ID. The
//                      two do not have to agree and nobody has written down
//                      which convention is in use
//   staleness          an entry outlives the window that makes it mean
//                      something, deliberately, so OFFLINE is decided by
//                      arithmetic and not by the cache forgetting
//   whose state        the endpoint is a public URL. If it can be made to
//                      mark somebody else away, that is the whole feature
//                      turned into a prank
//
//   node tests/presence-test.js
const fs = require('fs'), vm = require('vm'), path = require('path');
const SRC = process.env.EAS_SRC || path.join(__dirname, '..', 'src');

const out = [];
const check = (n, ok, d) => {
  out.push(ok);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (d ? '   [' + d + ']' : ''));
};

// ---------------------------------------------------------------------------
// the directory the dots are drawn against
// ---------------------------------------------------------------------------
// The same shape as the real tab. Three people matter here:
//
//   Utpal       Sub-Department ALL, so he is the department head and appears
//               in the map without sitting in any section
//   Masum       spelled 'Md. Abul Masum Siddique' in the tab while the
//               roster says 'Muhammad', which is the case that made
//               matchPerson exist and is therefore the case the join has to
//               survive
//   Nobody      no employee ID at all, so the map has to key them by name
const HEADERS = ['SL#', 'Employee Name', 'Employee ID', 'Designation', 'Module',
                 'Department', 'Sub-Department', 'Blood Group', 'Computer Name',
                 'Office Location', 'Ext#', 'WhatApp/Cell No.', 'Mail Address',
                 'Head', 'Photo', 'Note'];

const ROWS = [
  [1, 'Utpal Biswas', 20990001, 'Senior Manager', 'MM', 'EAS', 'ALL', 'A+', '',
   'TVL HQ', '9001', '01700000001', 'utpal@x.test', 'Supply Chain Applications', '', ''],
  [2, 'Md. Abul Masum Siddique', 20990004, 'Manager', 'SD', 'EAS',
   'Sales and Customer Applications', 'B+', '', 'YCL', '9004', '01700000004',
   'masum@x.test', 'yes', '', ''],
  [3, 'Rudra Das', 20990007, 'Assistant Engineer', 'PP', 'EAS',
   'Manufacturing Applications', 'B+', '', 'TVL HQ', '9007', '01700000007',
   'rudra@x.test', '', '', ''],
  [4, 'Pradip Kumar Nath', 20990006, 'Manager', 'PP', 'EAS',
   'Manufacturing Applications', 'B+', '', 'TVL HQ', '9006', '01700000006',
   'pradip@x.test', 'Yes', '', ''],
  // No employee ID. The map keys them by name instead, which is the one
  // branch of presenceIdOf that a tidy fixture never reaches.
  [5, 'Nobody Without Id', '', 'Officer', 'MM', 'EAS',
   'Supply Chain Applications', '', '', 'YCL', '', '', 'nobody@x.test', '', '', '']
];

function makeSheet(rows) {
  const all = [HEADERS].concat(rows);
  return {
    getLastRow: () => all.length,
    getLastColumn: () => HEADERS.length,
    getRange: function (r, c, n, w) {
      return {
        getValues: function () {
          const got = [];
          for (let i = 0; i < n; i++) got.push((all[r - 1 + i] || []).slice(c - 1, c - 1 + w));
          return got;
        },
        setValues: () => ({ setFontWeight: () => ({ setBackground: () => ({ setFontColor: () => {} }) }) })
      };
    }
  };
}

// ---------------------------------------------------------------------------
// a cache that never forgets anything
// ---------------------------------------------------------------------------
// ON PURPOSE, and it is the most important decision in this file. The real
// CacheService drops a row after its TTL, so a fake that also expired would
// let the read-time staleness check be deleted without a single assertion
// noticing - the row would simply be gone either way.
//
// It is also what production does. The entry TTL is thirty minutes and the
// freshness window is eight, so for twenty-two of those minutes the row is
// really there and really means nothing, and only the arithmetic says so.
function makeCache() {
  const store = {};
  const puts = [];          // every ttl the code asked for, to assert on
  const reads = [];
  return {
    store: store, puts: puts, reads: reads,
    api: {
      get: function (key) { reads.push(key); return (key in store) ? store[key] : null; },
      getAll: function (keys) {
        const got = {};
        (keys || []).forEach(function (key) {
          reads.push(key);
          if (key in store) got[key] = store[key];
        });
        return got;
      },
      put: function (key, value, ttl) { store[key] = value; puts.push({ key, ttl }); },
      putAll: function (values, ttl) {
        Object.keys(values).forEach(function (key) {
          store[key] = values[key];
          puts.push({ key: key, ttl: ttl });
        });
      },
      remove: function (key) { delete store[key]; },
      removeAll: function (keys) { (keys || []).forEach(function (k) { delete store[k]; }); }
    }
  };
}

// ---------------------------------------------------------------------------
// the sandbox
// ---------------------------------------------------------------------------
function load(options) {
  const opts = options || {};
  const cache = makeCache();
  let now = opts.now || 1762000000000;

  const ctx = {
    console: console,
    Logger: { log: () => {} },
    SpreadsheetApp: {},
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    CacheService: { getScriptCache: () => cache.api }
  };

  // Date, with a clock a test can wind forward. A Proxy rather than an
  // object with one method on it, so `new Date()` anywhere in the loaded
  // files still behaves like a date.
  ctx.Date = new Proxy(Date, {
    get: function (target, prop) {
      if (prop === 'now') return function () { return now; };
      const got = target[prop];
      return typeof got === 'function' ? got.bind(target) : got;
    }
  });

  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(SRC, 'Config.gs'), 'utf8'), ctx);

  let sheetReads = 0;
  const sheet = makeSheet(opts.rows || ROWS);
  ctx.sheetWithHeaders = () => { sheetReads++; return sheet; };

  // The sessions this suite can present. currentSession lives in Auth.gs and
  // decides nothing this file is about; what matters is only that it is the
  // ONLY thing presenceTick is allowed to learn an identity from.
  const sessions = opts.sessions || { 'good.sig': { u: '20990007', r: 'USER' } };
  ctx.currentSession = (token) => sessions[token] || null;
  ctx.requireSignedIn = function (token) {
    if (!sessions[token]) {
      throw new Error('Your session has ended. Reload the page and sign in again.');
    }
  };

  vm.runInContext(fs.readFileSync(path.join(SRC, 'Team.gs'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(SRC, 'Presence.gs'), 'utf8'), ctx);

  return {
    ctx: ctx, cache: cache,
    sheetReads: () => sheetReads,
    wind: (ms) => { now += ms; },
    at: () => now,
    // A top-level const in a .gs file is not a property of the global
    // OBJECT - it lives in the global lexical scope, which is shared between
    // scripts but invisible to ctx.NAME. That is exactly how Apps Script
    // behaves too, which is why Team.gs can see CONFIG at all. Reading one
    // therefore means evaluating it rather than looking it up.
    evalIn: (expr) => vm.runInContext(expr, ctx)
  };
}

// ---------------------------------------------------------------------------
// the join, which is the thing most likely to be silently wrong
// ---------------------------------------------------------------------------
// Nobody has written down whether a login is an employee ID or a name, and
// the people who created the accounts are not the people who filled in the
// TEAM tab. All three of these are logins somebody could plausibly have, and
// all three have to find Rudra Das's card.
['20990007', 'Rudra Das', 'rudra.das'].forEach(function (login) {
  const h = load({ sessions: { 'good.sig': { u: login, r: 'USER' } } });
  h.ctx.presenceTick('good.sig', false);
  const map = h.ctx.readPresence();
  check('a login of "' + login + '" lights up Rudra Das',
    map['20990007'] === 'ACTIVE',
    'his card reads ' + map['20990007']);
});

// And the honorific, because the tab and the roster disagree about it.
{
  const h = load({ sessions: { 'good.sig': { u: 'Muhammad Abul Masum Siddique', r: 'USER' } } });
  h.ctx.presenceTick('good.sig', false);
  check('Muhammad signing in lights up the card the tab spells Md.',
    h.ctx.readPresence()['20990004'] === 'ACTIVE',
    'matchPerson collapses the honorific on both sides of the join');
}

// A login that matches nobody must light up nobody - the join failing open
// would be worse than it failing shut.
{
  const h = load({ sessions: { 'good.sig': { u: 'someone.else', r: 'USER' } } });
  h.ctx.presenceTick('good.sig', false);
  const map = h.ctx.readPresence();
  check('a login matching nobody in the directory lights up nobody',
    Object.keys(map).every(function (id) { return map[id] === 'OFFLINE'; }),
    Object.keys(map).map((id) => id + '=' + map[id]).join(' '));
}

// ---------------------------------------------------------------------------
// whose state the endpoint sets
// ---------------------------------------------------------------------------
// The deployment is published to "Anyone", so this function is a URL a
// stranger can POST to. The only thing a caller may say about themselves is
// the away flag; an extra argument must not become an identity.
{
  const h = load();
  h.ctx.presenceTick('good.sig', false, '20990001', 'AWAY');
  const map = h.ctx.readPresence();
  check('extra arguments cannot mark somebody else',
    map['20990007'] === 'ACTIVE' && map['20990001'] === 'OFFLINE',
    'Utpal reads ' + map['20990001'] + ' after a call naming him');

  // Stronger, and the version that survives a refactor: the only keys
  // written at all are the ones derived from the session's own username.
  const written = h.cache.puts.map((p) => p.key).filter((k) => k !== 'pres:roster');
  check('and the only keys written are the signed-in person\'s own',
    written.length > 0 &&
    written.every((k) => h.ctx.presenceWriteKeys('20990007').indexOf(k) !== -1),
    written.join(', '));
}

{
  const h = load();
  let threw = '';
  try { h.ctx.presenceTick('forged.sig', false); } catch (e) { threw = e.message; }
  check('a token the server does not recognise cannot beat at all',
    /session has ended/i.test(threw),
    threw || 'it returned instead of throwing');

  let threwToo = '';
  try { h.ctx.getPresence('forged.sig'); } catch (e) { threwToo = e.message; }
  check('and cannot read the map either',
    /session has ended/i.test(threwToo),
    threwToo || 'it returned instead of throwing');
}

// ---------------------------------------------------------------------------
// away, and the difference between away and gone
// ---------------------------------------------------------------------------
{
  const h = load();
  h.ctx.presenceTick('good.sig', true);
  check('pressing Away reads back as AWAY and not as ACTIVE',
    h.ctx.readPresence()['20990007'] === 'AWAY',
    h.ctx.readPresence()['20990007']);

  h.ctx.presenceTick('good.sig', false);
  check('and coming back reads as ACTIVE again',
    h.ctx.readPresence()['20990007'] === 'ACTIVE',
    h.ctx.readPresence()['20990007']);
}

// ---------------------------------------------------------------------------
// staleness, decided by arithmetic
// ---------------------------------------------------------------------------
{
  const h = load();
  h.ctx.presenceTick('good.sig', false);

  // Seven minutes: one missed beat and a bit. Still here - this is the
  // dropped-poll case, and blinking somebody off the page for it is the
  // behaviour the eight-minute window exists to avoid.
  h.wind(7 * 60 * 1000);
  check('a beat seven minutes old still counts as at their desk',
    h.ctx.readPresence()['20990007'] === 'ACTIVE',
    h.ctx.readPresence()['20990007']);

  // Nine. Nobody has said anything for three beats; the laptop is shut.
  h.wind(2 * 60 * 1000);
  check('a beat nine minutes old does not',
    h.ctx.readPresence()['20990007'] === 'OFFLINE',
    h.ctx.readPresence()['20990007']);

  check('and the row is still sitting in the cache while it reads OFFLINE',
    Object.keys(h.cache.store).some((k) => k.indexOf('pres:20990007') === 0),
    'so it is the clock that decided, not the cache forgetting');
}

// An AWAY entry goes stale the same way. Somebody who pressed Away and then
// went home must not stay amber all evening.
{
  const h = load();
  h.ctx.presenceTick('good.sig', true);
  h.wind(9 * 60 * 1000);
  check('a stale AWAY goes to OFFLINE rather than staying amber',
    h.ctx.readPresence()['20990007'] === 'OFFLINE',
    h.ctx.readPresence()['20990007']);
}

// A row the cache never had at all. The server returns no key for somebody
// who has not signed in, and every one of them has to come back OFFLINE.
{
  const h = load();
  const map = h.ctx.readPresence();
  check('everybody is OFFLINE before anybody beats',
    Object.keys(map).length === 5 &&
    Object.keys(map).every((id) => map[id] === 'OFFLINE'),
    Object.keys(map).length + ' people, states: ' +
      Object.keys(map).map((id) => map[id]).join(','));
}

// A row that is in the cache but malformed - a half-written value, or one
// from an older version of this file. It must read as OFFLINE, not as
// ACTIVE, and not throw.
{
  const h = load();
  h.cache.store['pres:20990007'] = 'ACTIVE';            // no timestamp at all
  h.cache.store['pres:20990001'] = 'ACTIVE|not-a-number';
  let map = null, threw = '';
  try { map = h.ctx.readPresence(); } catch (e) { threw = e.message; }
  check('a value with no usable timestamp reads OFFLINE rather than throwing',
    !threw && map['20990007'] === 'OFFLINE' && map['20990001'] === 'OFFLINE',
    threw || (map['20990007'] + ' / ' + map['20990001']));
}

// ---------------------------------------------------------------------------
// signing out
// ---------------------------------------------------------------------------
{
  const h = load();
  h.ctx.presenceTick('good.sig', false);
  h.ctx.presenceClear('good.sig');
  check('signing out takes the dot off now rather than in eight minutes',
    h.ctx.readPresence()['20990007'] === 'OFFLINE',
    h.ctx.readPresence()['20990007']);

  check('and leaves no row behind in the cache',
    !Object.keys(h.cache.store).some((k) => k.indexOf('pres:20990007') === 0),
    Object.keys(h.cache.store).join(', '));
}

// ---------------------------------------------------------------------------
// how the map is keyed, because the page looks people up in it
// ---------------------------------------------------------------------------
// Both sides take the string from the same readTeam() output, so there is
// nothing to normalise - but that is only true while presenceIdOf and the
// page agree on which field to use.
{
  const h = load();
  const map = h.ctx.readPresence();
  check('people are keyed by employee ID when they have one',
    Object.prototype.hasOwnProperty.call(map, '20990001'),
    Object.keys(map).join(', '));

  check('and by name when they have not',
    Object.prototype.hasOwnProperty.call(map, 'Nobody Without Id'),
    'a row with an empty ID column still gets a dot');

}

// THE DEPARTMENT HEAD GETS A DOT TOO, and proving it needs a fixture of its
// own. In ROWS above, Utpal is the department head AND the named head of
// Supply Chain, so he reaches the roster by two routes and deleting either
// one leaves him there - which is exactly what happened: removing the line
// that adds the department head left this assertion passing.
//
// Here every section has a head of its own, so Utpal heads nothing. He sits
// above the organogram, in no section, led by nobody - and he is the person
// whose extension gets rung most.
{
  const h = load({
    rows: [
      [1, 'Utpal Biswas', 20990001, 'Senior Manager', 'MM', 'EAS', 'ALL', 'A+', '',
       'TVL HQ', '9001', '01700000001', 'utpal@x.test', '', '', ''],
      [2, 'Md. Abul Masum Siddique', 20990004, 'Manager', 'SD', 'EAS',
       'Sales and Customer Applications', 'B+', '', 'YCL', '9004', '01700000004',
       'masum@x.test', 'yes', '', ''],
      [3, 'Pradip Kumar Nath', 20990006, 'Manager', 'PP', 'EAS',
       'Manufacturing Applications', 'B+', '', 'TVL HQ', '9006', '01700000006',
       'pradip@x.test', 'Yes', '', ''],
      [4, 'Rudra Das', 20990007, 'Assistant Engineer', 'PP', 'EAS',
       'Manufacturing Applications', 'B+', '', 'TVL HQ', '9007', '01700000007',
       'rudra@x.test', '', '', '']
    ],
    sessions: { 'good.sig': { u: '20990001', r: 'MASTER' } }
  });

  const team = h.ctx.readTeam();
  check('(fixture check) the department head heads none of the sections',
    team.lead && team.lead.name === 'Utpal Biswas' &&
    team.sections.every((s) => s.head && s.head.name !== 'Utpal Biswas'),
    'otherwise this assertion proves nothing, which is how it passed before');

  h.ctx.presenceTick('good.sig', false);
  check('a department head who heads no section still gets a dot',
    h.ctx.readPresence()['20990001'] === 'ACTIVE',
    'he is above the sections, not in one, and still has an extension');
}

// ---------------------------------------------------------------------------
// what a beat costs
// ---------------------------------------------------------------------------
// The whole design rests on a beat being cheap: thirty-seven people through
// an eight-hour day is thousands of calls against a daily runtime allowance
// the KPI engine also has to fit inside. A beat that read the spreadsheet
// would not be affordable, and nothing about the page would look wrong.
{
  const h = load();
  h.ctx.presenceTick('good.sig', false);
  check('a beat does not read the spreadsheet',
    h.sheetReads() === 0,
    h.sheetReads() + ' sheet read(s) for one beat');

  // The first map read builds the roster from the tab. Every one after it
  // must come out of the cache.
  h.ctx.readPresence();
  const afterFirst = h.sheetReads();
  h.ctx.readPresence();
  h.ctx.readPresence();
  check('and the roster is read from the tab once, then cached',
    afterFirst === 1 && h.sheetReads() === 1,
    afterFirst + ' then ' + h.sheetReads());

  // The two numbers have to stay the right way round. If the entry TTL ever
  // drops below the freshness window, the cache starts deciding who is
  // offline before the arithmetic does - every test above would still pass,
  // and the dropped-poll slack the window exists to provide would be gone.
  const entryTtl = h.evalIn('PRESENCE_ENTRY_TTL');
  const freshMs = h.evalIn('PRESENCE_FRESH_MS');
  check('a beat is written with a TTL longer than the freshness window',
    h.cache.puts.filter((p) => p.key.indexOf('pres:roster') !== 0).length > 0 &&
    h.cache.puts.filter((p) => p.key.indexOf('pres:roster') !== 0)
      .every((p) => p.ttl === entryTtl) &&
    entryTtl * 1000 > freshMs,
    'entry ttl ' + entryTtl + 's vs window ' + (freshMs / 1000) + 's');
}

// ---------------------------------------------------------------------------
// a correction to the tab reaches the dots
// ---------------------------------------------------------------------------
// THE BUG THIS EXISTS FOR. A person with no employee ID is keyed by name.
// Fill the ID in - which is a tidy-up somebody does precisely to make this
// page better - and their key changes. With nothing refreshing the cached
// roster, their dot would go on being looked for under a name that nothing
// writes any more, and they would sit grey at their own desk for six hours.
{
  const WITHOUT = [
    [1, 'Utpal Biswas', 20990001, 'Senior Manager', 'MM', 'EAS', 'ALL', 'A+', '',
     'TVL HQ', '9001', '01700000001', 'utpal@x.test', 'Supply Chain Applications', '', ''],
    [2, 'Late Joiner', '', 'Officer', 'MM', 'EAS', 'Supply Chain Applications',
     '', '', 'YCL', '1111', '01700000000', 'late@x.test', '', '', '']
  ];

  const h = load({
    rows: WITHOUT,
    sessions: { 'good.sig': { u: 'Late Joiner', r: 'USER' } }
  });

  h.ctx.presenceTick('good.sig', false);
  check('(before) somebody with no ID gets a dot under their name',
    h.ctx.readPresence()['Late Joiner'] === 'ACTIVE',
    'keyed by name, because the ID column is empty');

  // Somebody fills the ID in. The sheet behind the sandbox is the same
  // object, so mutating the row is exactly what editing the tab does.
  WITHOUT[1][2] = 20900001;

  // Without the refresh in getTeam, the cached roster still says the old
  // key and this comes back OFFLINE under the new one.
  h.ctx.getTeam('good.sig');
  const after = h.ctx.readPresence();

  check('filling in the ID moves their dot to the new key, not into the dark',
    after['20900001'] === 'ACTIVE' && after['Late Joiner'] === undefined,
    'new key reads ' + after['20900001'] + ', old key ' + after['Late Joiner']);

  check('and opening the directory is what refreshed it',
    h.evalIn('PRESENCE_ROSTER_KEY') === 'pres:roster' &&
    JSON.parse(h.cache.store['pres:roster'])
      .some((p) => String(p.id) === '20900001'),
    'getTeam caches the roster it has just read');
}

// A corrupt roster row must not take the page down with it - it is a cache,
// and the tab is still there.
{
  const h = load();
  h.cache.store['pres:roster'] = '{ this is not json';
  let map = null, threw = '';
  try { map = h.ctx.readPresence(); } catch (e) { threw = e.message; }
  check('a corrupt cached roster is rebuilt from the tab instead of throwing',
    !threw && map && Object.keys(map).length === 5,
    threw || (map ? Object.keys(map).length + ' people' : 'nothing came back'));
}

// An empty tab. Nobody has pasted the directory yet, and the top bar still
// has to work.
{
  const h = load({ rows: [] });
  let map = null, threw = '';
  try { map = h.ctx.readPresence(); } catch (e) { threw = e.message; }
  check('an empty TEAM tab gives an empty map rather than an error',
    !threw && map && Object.keys(map).length === 0,
    threw || 'ok');

  let beat = null;
  try { beat = h.ctx.presenceTick('good.sig', false); } catch (e) { threw = e.message; }
  check('and a beat still works, because my own dot does not need the tab',
    beat && beat.me === 'ACTIVE',
    threw || (beat ? beat.me : 'nothing came back'));
}

const failed = out.filter((r) => !r).length;
console.log('\n' + (out.length - failed) + '/' + out.length + ' passed');
process.exit(failed ? 1 : 0);
