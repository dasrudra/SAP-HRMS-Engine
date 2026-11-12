// Minutes.gs - the four sections' meeting minutes, on the server.
//
// WHY THIS SUITE EXISTS
// These minutes are the only record of what four meetings decided. A deck
// on somebody's laptop at least fails loudly - the file is missing, or it
// is not the latest one. A shared record fails quietly: it saves to the
// wrong row, it drops the agenda row somebody added last fortnight, it lets
// a person from another section rewrite a meeting they were not in. Nobody
// notices for weeks, and by then there is nothing to compare against.
//
// WHAT IT GUARDS, worst first:
//
//   a new meeting is a COPY      the sections' own words: "agenda can
//                                change, we copy the latest slide and then
//                                edit on the copied slide". A new meeting
//                                that helpfully reset the cells would hand
//                                the host a blank form instead of last
//                                fortnight's position, which is the one
//                                thing they said they do not do
//   rows added survive a reopen  the seed decides the COLUMNS; the sheet
//                                decides the ROWS. Letting the seed win
//                                would silently undo every agenda change
//   who may write                by Sub-Department, with the interim head
//                                case the directory actually has
//   deleting is narrower         than writing. A wrong figure is a
//                                correction; a deleted meeting is a
//                                fortnight of the record gone
//   a body that will not parse   opens as an empty meeting, never as a
//                                page that will not open
//   the cell ceiling             refused with the size in the message. A
//                                truncated JSON body does not parse, so a
//                                silent truncation loses the whole meeting
//                                rather than the end of it
//   the lock is released         on every path out, errors included. A lock
//                                taken and not released is a Minutes tab
//                                that stops accepting saves
//
//   node tests/minutes-test.js
const fs = require('fs'), vm = require('vm'), path = require('path');
const SRC = process.env.EAS_SRC || path.join(__dirname, '..', 'src');

const out = [];
const check = (n, ok, d) => {
  out.push(ok);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (d ? '   [' + d + ']' : ''));
};

const MEET_HEAD = ['Meeting ID', 'Section', 'Date', 'Time', 'Host',
                   'Attendees', 'Status', 'Body', 'By', 'By ID', 'At',
                   'History'];

// ---------------------------------------------------------------------------
// a sheet, a directory, and a clock that can be moved on
// ---------------------------------------------------------------------------
function makeTab(name, headers, rows) {
  const all = [headers.slice()].concat((rows || []).map((r) => r.slice()));
  return {
    rows: all,
    getName: () => name,
    getLastRow: () => all.length,
    getLastColumn: () => all[0].length,
    appendRow: function (row) { all.push(row.slice()); },
    deleteRow: function (r) { all.splice(r - 1, 1); },
    setColumnWidth: function () { return this; },
    getRange: function (r, c, n, w) {
      return {
        getValue: () => (all[r - 1] || [])[c - 1],
        setValue: function (v) {
          if (!all[r - 1]) all[r - 1] = [];
          all[r - 1][c - 1] = v;
        },
        getValues: function () {
          const got = [];
          for (let i = 0; i < (n === undefined ? 1 : n); i++) {
            got.push((all[r - 1 + i] || []).slice(c - 1, c - 1 + (w || 1)));
          }
          return got;
        },
        setValues: function (vals) {
          for (let i = 0; i < vals.length; i++) all[r - 1 + i] = vals[i].slice();
          return { setFontWeight: () => ({ setBackground: () => ({ setFontColor: () => {} }) }) };
        }
      };
    }
  };
}

/*
  THE DIRECTORY, in the shape readTeam() really returns.

  Not a simplified stand-in: minWhoAmI walks lead, section heads and members
  separately and reads the Head cell's three meanings out of `leads`. A
  flattened fake would make all three paths look like one and the interim-head
  case - the one the directory actually contains - would never be exercised.
*/
function person(id, name, leads) {
  return { id: id, name: name, module: '', leads: leads || '' };
}

function directory() {
  return {
    lead: { id: '20000001', name: 'Department Head', module: 'MM',
            leads: 'Supply Chain Applications', section: 'ALL' },
    sections: [
      { name: 'Financial Applications',
        head: person('20000011', 'FI Head', 'Yes'),
        members: [person('20000012', 'FI Member'),
                  // Sits in Financial, covers Supply Chain. The directory
                  // records that by putting the covered section's name in
                  // the Head cell rather than Yes - the same convention the
                  // head of EAS is recorded under, without his ALL section
                  // also granting everything and hiding whether the cell
                  // was read at all.
                  person('20000013', 'FI Member Covering SCA',
                         'Supply Chain Applications')] },
      { name: 'Sales Applications',
        head: person('20000021', 'SD Head', 'Yes'),
        members: [person('20000022', 'SD Member')] },
      { name: 'supply chain applications',          // lower case on purpose
        head: null,
        members: [person('20000032', 'SCA Member')] },
      { name: 'Manufacturing Applications',
        head: person('20000041', 'PP Head', 'Yes'),
        members: [person('20000042', 'PP Member')] },
      { name: 'Unassigned', head: null,
        members: [person('20000099', 'Nobody In Particular')] }
    ]
  };
}

const TODAY = [2026, 10, 12];            // 12 November 2026

function load(opts) {
  const o = opts || {};
  const logs = [];
  const locks = { taken: 0, released: 0 };
  const tab = makeTab('MIN_MEET', MEET_HEAD, o.meetings || []);

  const ctx = {
    console: console,
    Logger: {
      log: function (fmt) {
        const args = Array.prototype.slice.call(arguments, 1);
        let i = 0;
        logs.push(String(fmt).replace(/%s/g, () =>
          (i < args.length ? String(args[i++]) : '%s')));
      }
    },
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: () => null, setProperty: () => {} })
    },
    LockService: {
      getScriptLock: () => ({
        waitLock: function () {
          locks.taken++;
          if (o.lockBusy) throw new Error('could not obtain lock');
        },
        releaseLock: function () { locks.released++; }
      })
    },
    Session: { getScriptTimeZone: () => 'Asia/Dhaka' },
    Utilities: {
      // Only the two formats Minutes.gs asks for, written out rather than
      // stubbed to a constant: a stamp that never changes makes "the save
      // time was updated" pass whether it was or not.
      formatDate: function (d, tz, fmt) {
        const two = (n) => (n < 10 ? '0' : '') + n;
        const date = d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' +
                     two(d.getDate());
        return fmt === 'yyyy-MM-dd'
          ? date
          : date + ' ' + two(d.getHours()) + ':' + two(d.getMinutes());
      }
    },
    SpreadsheetApp: {},
    DriveApp: {}
  };

  vm.createContext(ctx);

  // A fixed today, and a way to move it on - two saves on the same
  // millisecond make "the stamp was refreshed" pass either way.
  vm.runInContext(
    '(function () {' +
    '  var Real = Date;' +
    '  var FIXED = new Real(' + TODAY[0] + ',' + TODAY[1] + ',' + TODAY[2] +
    ',10,0,0).getTime();' +
    '  function Fake(a, b, c, d, e, f, g) {' +
    '    if (arguments.length === 0) return new Real(FIXED);' +
    '    if (arguments.length === 1) return new Real(a);' +
    '    return new Real(a, b, c, d || 0, e || 0, f || 0, g || 0);' +
    '  }' +
    '  Fake.now = function () { return FIXED; };' +
    '  Fake.parse = Real.parse; Fake.UTC = Real.UTC;' +
    '  Fake.prototype = Real.prototype;' +
    '  Date = Fake;' +
    '  globalThis.__advance = function (ms) { FIXED += ms; };' +
    '})();', ctx);

  vm.runInContext(fs.readFileSync(path.join(SRC, 'Config.gs'), 'utf8'), ctx);

  const reads = { MIN_MEET: 0, TEAM: 0 };
  ctx.sheetWithHeaders = (name) => {
    if (name !== 'MIN_MEET') throw new Error('no such tab: ' + name);
    reads.MIN_MEET++;
    return tab;
  };
  ctx.readTeam = function () {
    reads.TEAM++;
    if (o.noTeam) throw new Error('the directory could not be read');
    return o.team === undefined ? directory() : o.team;
  };
  ctx.requireSignedIn = () => {
    if (o.signedOut) throw new Error('Please sign in.');
  };
  ctx.currentSession = () =>
    (o.session === null ? null : (o.session || { u: '20000012', r: 'USER' }));
  ctx.rankOf = (r) => ({ USER: 1, ADMIN: 2, MASTER: 3 }[r] || 0);
  ctx.ROLE_ADMIN = 'ADMIN';

  vm.runInContext(fs.readFileSync(path.join(SRC, 'Minutes.gs'), 'utf8'), ctx);

  /*
    A top-level `const` in a vm context lives in the script's lexical scope
    and never appears on the sandbox object, so ctx.MIN_SECTIONS reads as
    undefined however correct the file is. Functions do appear, which is why
    only the constants need this. Listed by name rather than swept up with a
    loop so that a renamed constant fails here, loudly, rather than
    reappearing as undefined in an assertion that then quietly passes.
  */
  vm.runInContext(
    ['CONFIG', 'MIN_SECTIONS', 'MIN_SEEDS', 'MIN_MEET_COLUMNS', 'MIN_ROWS_MAX',
     'MIN_CELL_MAX', 'MIN_TEXT_MAX', 'MIN_BODY_MAX', 'MIN_HISTORY_KEPT',
     'MIN_HISTORY_SHOWN', 'MIN_DRAFT', 'MIN_FINAL']
      .map(function (name) { return 'globalThis.' + name + ' = ' + name + ';'; })
      .join(''), ctx);

  /*
    A Date built out here is a Date of THIS realm, and `value instanceof
    Date` inside the context tests the context's Date. The two never match,
    so a suite that passed its own Date objects in would be measuring vm
    realm semantics rather than minDate - and would report a fault that
    cannot exist in Apps Script, which has one realm.
  */
  vm.runInContext(
    'globalThis.__date = function (y, m, d) { return new Date(y, m, d); };', ctx);

  ctx.__tab = tab;
  ctx.__locks = locks;
  ctx.__reads = reads;
  ctx.__logs = logs;
  return ctx;
}

/** The body cell of row `n` of the fake tab, parsed. */
function bodyOf(ctx, n) {
  return JSON.parse(ctx.__tab.rows[n][7]);
}

/** A ready-made meeting row. */
function meeting(id, code, date, body, extra) {
  const e = extra || {};
  return [id, code, date, e.time || '10:30 AM', e.host || '',
          e.attendees || '', e.status || 'DRAFT',
          typeof body === 'string' ? body : JSON.stringify(body),
          e.by || 'Somebody', e.byId || '20000012', e.at || '2026-11-01 09:00',
          e.history || ''];
}


// ===========================================================================
// 1. the sections, and the join to the directory
// ===========================================================================
{
  const ctx = load();

  check('there are four sections', ctx.MIN_SECTIONS.length === 4);
  check('and every one of them has a seed',
    ctx.MIN_SECTIONS.every((s) => ctx.MIN_SEEDS[s.code] &&
                                  ctx.MIN_SEEDS[s.code].length),
    ctx.MIN_SECTIONS.map((s) => s.code + ':' +
      (ctx.MIN_SEEDS[s.code] || []).length).join(' '));

  check('a Sub-Department finds its section',
    ctx.minSectionOfSub('Financial Applications') === 'FICO');

  /*
    CASE AND SPACING COME FROM A HAND-TYPED CELL. The directory's third
    section really is spelt in lower case in this fixture because that is
    the kind of thing a directory contains, and matching exactly would cost
    that whole section its write button with nothing on the page to say why.
  */
  check('and finds it however the cell was typed',
    ctx.minSectionOfSub('  supply chain APPLICATIONS ') === 'SCA');

  check('a Sub-Department that is not one of the four finds nothing',
    ctx.minSectionOfSub('Unassigned') === '');
  check('and neither does an empty cell', ctx.minSectionOfSub('') === '');

  check('a section is found by code', ctx.minSection('pp').code === 'PP');
  check('and an unknown code is null', ctx.minSection('XX') === null);

  /*
    THIS IS WHERE THE WORST BUG SO FAR GOT THROUGH, so the replacement is
    worth explaining.

    The assertion used to be that the four Sub-Departments here were exactly
    the keys of CONFIG.SECTION_MODULES. That list is older than the TEAM tab
    and still calls one section 'Sales Applications' where the directory
    says 'Sales & Customer Applications' - so the test did not catch the
    wrong name, it REQUIRED it, and a whole section lost its write button
    with a green suite above it.

    A unit test cannot know what the live TEAM tab says; only checkMinutes
    can, which is why that now prints every Sub-Department it finds. What
    IS checkable here is that the table is coherent: every section has at
    least one spelling, no two sections claim the same one, and the older
    Config.gs names all still resolve to something rather than being
    dropped on the way.
  */
  const noSpelling = ctx.MIN_SECTIONS.filter(function (s) {
    return !s.subs || !s.subs.length || !s.subs[0];
  });
  check('every section says how the directory spells it',
    noSpelling.length === 0,
    noSpelling.map(function (s) { return s.code; }).join(','));

  const claimed = {};
  const clash = [];
  ctx.MIN_SECTIONS.forEach(function (s) {
    (s.subs || []).forEach(function (name) {
      const key = name.toUpperCase();
      if (claimed[key]) clash.push(name + ': ' + claimed[key] + ' and ' + s.code);
      claimed[key] = s.code;
    });
  });
  check('and no two sections claim the same spelling',
    clash.length === 0, clash.join('; '));

  const orphan = Object.keys(ctx.CONFIG.SECTION_MODULES).filter(function (name) {
    return !ctx.minSectionOfSub(name);
  });
  check('and every older Config.gs section name still resolves',
    orphan.length === 0, orphan.join(' | '));

  check('the tab shows the section\'s own name',
    ctx.minSection('SDMM').name === 'Sales & Customer Applications',
    ctx.minSection('SDMM').name);
}


// ===========================================================================
// 2. the seeds carry no people
// ===========================================================================
/*
  THIS REPOSITORY IS PUBLIC. The seeds are column headings and the standing
  activity list; every Owner, Resp. and Attendee cell is a name and belongs
  in the spreadsheet. A seeded name would be committed, pushed, and visible
  to anyone - and it would also be wrong within a month.
*/
{
  const ctx = load();
  const text = JSON.stringify(ctx.MIN_SEEDS);

  // Every seeded Owner cell is empty.
  const owners = [];
  Object.keys(ctx.MIN_SEEDS).forEach(function (code) {
    ctx.MIN_SEEDS[code].forEach(function (block) {
      if (block.type !== 'table') return;
      block.columns.forEach(function (col, i) {
        if (!/owner|resp/i.test(col.label) && !/owner/i.test(col.key)) return;
        (block.rows || []).forEach(function (row) {
          if (/owner/i.test(col.key) && row[i]) owners.push(code + ':' + row[i]);
        });
      });
    });
  });
  check('no seeded Owner cell holds a name', owners.length === 0,
    owners.join(', '));

  /*
    AND EVERY Resp. CELL IS A SECTOR CODE. That column is the one a name
    plausibly gets typed into - it is the column that answers "who" - and
    the only things that legitimately belong in it are the two sectors.

    An earlier version of this guard tried to spot names by their shape: two
    capitalised words in a row. It fired on "Key Control", "Pending Status"
    and seventeen others, which is what a shape test on English does. A
    closed list of what IS allowed catches the same mistake and cannot be
    argued with.
  */
  const sectors = /^(RMG|MG|RMG\/MG)$/;
  const wrong = [];
  Object.keys(ctx.MIN_SEEDS).forEach(function (code) {
    ctx.MIN_SEEDS[code].forEach(function (block) {
      if (block.type !== 'table') return;
      block.columns.forEach(function (col, i) {
        if (!/^(resp|owner)$/.test(col.key)) return;
        (block.rows || []).forEach(function (row) {
          const cell = String(row[i] || '');
          if (cell && !sectors.test(cell)) wrong.push(code + ':' + cell);
        });
      });
    });
  });
  check('and every seeded Resp. cell is a sector code, never a person',
    wrong.length === 0, wrong.join(', '));

  check('no seed carries an email address', text.indexOf('@') === -1);
  check('and none carries anything shaped like an employee ID',
    !/\b20\d{6}\b/.test(text), (text.match(/\b20\d{6}\b/g) || []).join(', '));

  check('the whole file is ASCII',
    !/[^\x00-\x7F]/.test(fs.readFileSync(path.join(SRC, 'Minutes.gs'), 'utf8')));
}


// ===========================================================================
// 2b. the seeds describe a table that can actually be drawn
// ===========================================================================
/*
  THE SEEDS ARE A DRAWING INSTRUCTION, and a wrong one fails silently: a
  span that runs off the end swallows a column's heading, a group index
  pointing at a column that is not there merges nothing, a row longer than
  the columns drops cells off the right. None of it throws. All of it
  reaches the slide somebody presents.
*/
{
  const ctx = load();
  const faults = [];
  const note = (where, what) => faults.push(where + ': ' + what);

  ctx.MIN_SECTIONS.forEach(function (section) {
    const theme = section.theme || {};
    ['band', 'head', 'ink', 'rule', 'title'].forEach(function (key) {
      if (!/^#[0-9a-f]{6}$/.test(String(theme[key]))) {
        note(section.code, 'theme.' + key + ' is ' + theme[key]);
      }
    });
    if (section.layout !== 'wide' && section.layout !== 'split') {
      note(section.code, 'layout is ' + section.layout);
    }

    ctx.MIN_SEEDS[section.code].forEach(function (b) {
      const where = section.code + '/' + b.id;
      if (['left', 'right', 'full'].indexOf(b.side) === -1) {
        note(where, 'side is ' + b.side);
      }
      if (b.type === 'notes') {
        if (!b.lines || !b.lines.length) note(where, 'no lines');
        return;
      }

      const n = b.columns.length;
      (b.groups || []).forEach(function (i) {
        if (!(i >= 0 && i < n)) note(where, 'group column ' + i + ' of ' + n);
      });
      (b.tones || []).forEach(function (t) {
        if (!/^#[0-9a-f]{6}$/.test(t)) note(where, 'tone ' + t);
      });
      if (b.zebra && !/^#[0-9a-f]{6}$/.test(b.zebra)) note(where, 'zebra ' + b.zebra);

      // Widths add up to the full table.
      const total = b.columns.reduce(function (sum, c) { return sum + c.width; }, 0);
      if (total < 98 || total > 102) note(where, 'widths total ' + total);

      // Spans stay inside the table, and every unlabelled column is either
      // covered by one or is the deliberate blank beside a merged heading.
      const covered = {};
      b.columns.forEach(function (c, i) {
        const span = c.span || 1;
        if (i + span > n) note(where, 'column ' + i + ' spans past the end');
        for (let k = 1; k < span; k++) covered[i + k] = true;
      });
      b.columns.forEach(function (c, i) {
        if (!c.label && !covered[i]) {
          note(where, 'column ' + i + ' (' + c.key + ') has no heading and ' +
                      'nothing spans over it');
        }
      });

      // No row is wider than the table it is drawn in.
      (b.rows || []).forEach(function (row, r) {
        if (row.length > n) note(where, 'row ' + r + ' has ' + row.length +
                                        ' cells for ' + n + ' columns');
      });
    });
  });

  check('every seed describes a table that can be drawn',
    faults.length === 0, faults.join('; '));

  /*
    AND THE ONE THAT MATTERS TO A READER ACROSS THE ROOM: the three sections
    that colour-code their rows still do. The tint is not decoration on SD
    and PP - it is how somebody finds the daily block, or their own zone,
    without reading a word.
  */
  const flat = [];
  [['SDMM', 'sd'], ['SDMM', 'mm'], ['PP', 'ops']].forEach(function (pair) {
    const block = ctx.MIN_SEEDS[pair[0]].filter(function (b) {
      return b.id === pair[1];
    })[0];
    const tones = (block && block.tones) || [];
    // Three runs, and the first and second must differ - a table whose
    // daily and weekly blocks are the same colour has lost the distinction
    // even though it still has a `tones` array.
    if (tones.length < 3 || tones[0] === tones[1]) {
      flat.push(pair.join('/') + ': ' + JSON.stringify(tones));
    }
  });
  check('SD and PP keep their colour-coded row groups, each run distinct ' +
        'from the next', flat.length === 0, flat.join('; '));
}


// ===========================================================================
// 3. who may write
// ===========================================================================
{
  const member = load({ session: { u: '20000012', r: 'USER' } }).minWhoAmI('t');
  check('a member writes their own section',
    member.write.join(',') === 'FICO', member.write.join(','));
  check('and deletes nothing', member.remove.length === 0);
  check('and is not a head', member.head === false);
  check('and has a name, not an employee ID', member.name === 'FI Member');

  const head = load({ session: { u: '20000021', r: 'USER' } }).minWhoAmI('t');
  check('a section head writes their own section',
    head.write.join(',') === 'SDMM', head.write.join(','));
  check('and may delete in it', head.remove.join(',') === 'SDMM');

  /*
    THE INTERIM HEAD - a Head cell that names a section rather than saying
    Yes. The directory's own convention, and the reason the rule cannot just
    read Sub-Department.

    TESTED ON SOMEBODY WHO IS NOT THE DEPARTMENT HEAD, deliberately. The
    real case is the head of EAS covering Supply Chain, but he also sits in
    ALL and so gets all four sections from a different rule entirely -
    which means his rights look right whether the Head cell is read or
    ignored. Mutation testing caught exactly that: deleting the branch
    changed nothing any assertion could see.
  */
  const cover = load({ session: { u: '20000013', r: 'USER' } }).minWhoAmI('t');
  check('a Head cell naming another section grants that section too',
    cover.write.slice().sort().join(',') === 'FICO,SCA',
    cover.write.join(','));
  check('and the right to delete in the section they cover',
    cover.remove.join(',') === 'SCA', cover.remove.join(','));
  check('but not in the section they merely sit in',
    cover.remove.indexOf('FICO') === -1);

  const lead = load({ session: { u: '20000001', r: 'USER' } }).minWhoAmI('t');
  check('the department head writes every section',
    lead.write.length === 4, lead.write.join(','));
  check('and may delete in every section', lead.remove.length === 4);
  check('and is a head', lead.head === true);

  const stray = load({ session: { u: '20000099', r: 'USER' } }).minWhoAmI('t');
  check('somebody in no meeting section writes nothing',
    stray.write.length === 0);
  check('and is told why, naming the cell to fix',
    /Sub-Department/.test(stray.reason), stray.reason);

  const ghost = load({ session: { u: '20990009', r: 'USER' } }).minWhoAmI('t');
  check('somebody not in the directory writes nothing',
    ghost.write.length === 0);
  check('and is told that, rather than told nothing',
    /not in the team directory/.test(ghost.reason), ghost.reason);

  const admin = load({ session: { u: '20000012', r: 'ADMIN' } }).minWhoAmI('t');
  check('an admin writes every section', admin.write.length === 4);
  check('and deletes in every section', admin.remove.length === 4);

  const none = load({ session: null }).minWhoAmI('');
  check('nobody signed in writes nothing', none.write.length === 0);

  /*
    A DIRECTORY THAT WILL NOT READ MUST NOT HAND OUT RIGHTS. It is the only
    thing that says which section somebody is in, so a failed read is "we do
    not know", never "allow it".
  */
  const blind = load({ noTeam: true,
                       session: { u: '20000021', r: 'USER' } }).minWhoAmI('t');
  check('a directory that cannot be read grants nothing',
    blind.write.length === 0, blind.write.join(','));
  check('and says so', /directory could not be read/.test(blind.reason));

  const blindAdmin = load({ noTeam: true,
                            session: { u: '20000012', r: 'ADMIN' } }).minWhoAmI('t');
  check('though an admin still gets through',
    blindAdmin.write.length === 4);
}


// ===========================================================================
// 4. a new meeting is a copy of the one before it
// ===========================================================================
/*
  THE CENTRE OF THE WHOLE FEATURE, in the sections' own words: "agenda can
  change, we copy the latest slide and then edit on the copied slide."

  A new meeting that reset the status cells to their seeded defaults would
  look tidier and would be wrong: the host would arrive at a blank form
  instead of last fortnight's position to amend, and every row they had
  added would be gone.
*/
{
  const was = {
    v: 1, head: { purpose: 'A purpose somebody edited', minutesBy: 'Someone' },
    blocks: [
      { id: 'ops', type: 'table', rows: [
        ['1.  FI/TR', 'DEPZ', 'RMG', 'KSI Workshop Project Running.'],
        ['', '', 'MG', 'Normal Trend'],
        ['3.  A ROW SOMEBODY ADDED', 'KEPZ', 'RMG', 'Watching this one']
      ] }
    ]
  };
  const ctx = load({ meetings: [meeting('FICO-20261029', 'FICO', '2026-10-29', was,
                       { host: 'The usual host', attendees: 'The usual people' })],
                     session: { u: '20000011', r: 'USER' } });

  const made = ctx.newMinutes('t', 'FICO', '2026-11-12', '12:00 PM');
  check('a new meeting is accepted', made.ok === true, made.error);
  check('and says it was copied', made.copied === true && made.from === 'FICO-20261029');

  const body = bodyOf(ctx, 2);
  check('the copy keeps the edited status text, not the seeded one',
    body.blocks[0].rows[0][3] === 'KSI Workshop Project Running.',
    body.blocks[0].rows[0][3]);
  check('and keeps the row somebody added',
    body.blocks[0].rows.length === 3 &&
    body.blocks[0].rows[2][0] === '3.  A ROW SOMEBODY ADDED',
    body.blocks[0].rows.length + ' rows');
  check('and keeps the edited purpose',
    body.head.purpose === 'A purpose somebody edited');

  /*
    MINUTES BY IS THE ONE THING THAT DOES NOT CARRY OVER. It names whoever
    wrote the last one, and a deck that opens claiming this fortnight was
    minuted by somebody who was not there is a worse lie than a blank.
  */
  check('but not who minuted the last one', body.head.minutesBy === '');

  /*
    The header's other two DO carry, because the same section meets the same
    people every fortnight and both are one edit away in the header. Only
    the authorship claim is withheld.
  */
  check('the host carries over', ctx.__tab.rows[2][4] === 'The usual host',
    ctx.__tab.rows[2][4]);
  check('and so do the attendees',
    ctx.__tab.rows[2][5] === 'The usual people', ctx.__tab.rows[2][5]);

  check('the id reads as the section and the date',
    made.id === 'FICO-20261112', made.id);
  check('it is a draft', ctx.__tab.rows[2][6] === 'DRAFT');
  check('and it records who started it', ctx.__tab.rows[2][8] === 'FI Head');

  const again = ctx.newMinutes('t', 'FICO', '2026-11-12', '12:00 PM');
  check('a second meeting the same day gets its own id',
    again.ok === true && again.id === 'FICO-20261112-2', again.id);

  /*
    AND THE ANSWER CARRIES THE PAGE WITH IT.

    A save used to be two round trips - write, then read the whole page back
    - and over the Apps Script bridge that is two waits of a second or more
    for one press of one button. The write answers with the page now, so a
    page that still called getMinutes afterwards would be paying for a trip
    it no longer needs.
  */
  check('starting a meeting answers with the page, not just an id',
    Boolean(again.data) && again.data.ok === true,
    JSON.stringify(Object.keys(again)));
  check('and the new meeting is the one it opens',
    again.data.meeting.id === again.id, again.data.meeting.id);
  check('and the list in it already has it',
    again.data.list.some(function (m) { return m.id === again.id; }));

  check('the lock was taken and released each time',
    ctx.__locks.taken === 2 && ctx.__locks.released === 2,
    ctx.__locks.taken + ' taken, ' + ctx.__locks.released + ' released');
}


// ===========================================================================
// 5. the first meeting of a section comes from the seed
// ===========================================================================
{
  const ctx = load({ session: { u: '20000021', r: 'USER' } });
  const made = ctx.newMinutes('t', 'SDMM', '2026-11-12', '10:30 am');
  check('the first meeting in a section is accepted', made.ok === true, made.error);
  check('and is not a copy', made.copied === false);

  const body = bodyOf(ctx, 1);
  const sd = body.blocks.filter((b) => b.id === 'sd')[0];
  check('it carries the seeded control table',
    sd && sd.rows.length === 14, sd ? sd.rows.length + ' rows' : 'no sd block');
  check('with the standing activities in it',
    sd.rows[0][1] === 'POD vs. Billing', sd.rows[0][1]);
  check('and the escalation line seeded Nil',
    body.blocks.filter((b) => b.id === 'esc')[0].lines[0].value === 'Nil');

  /*
    The seed is deep-copied on the way out. Shared by reference, the first
    meeting ever created in a section would become that section's seed for
    the rest of the script's life - and only for the sections somebody had
    used that day, which is the kind of bug that cannot be reproduced.
  */
  /*
    MUTATED THROUGH minSeedBlocks ITSELF. An earlier version wrote into the
    JSON that had just come back out of the sheet cell - which is a detached
    copy whatever the code does, so the shared-reference bug it was meant to
    catch sailed straight through it.
  */
  const first = ctx.minSeedBlocks('SDMM');
  first[0].rows[0][1] = 'MUTATED';
  first[0].columns[0].label = 'MUTATED';
  check('and editing what the seed handed out does not edit the seed',
    ctx.minSeedBlocks('SDMM')[0].rows[0][1] === 'POD vs. Billing',
    ctx.minSeedBlocks('SDMM')[0].rows[0][1]);
  check('nor its columns',
    ctx.minSeedBlocks('SDMM')[0].columns[0].label === 'Activity',
    ctx.minSeedBlocks('SDMM')[0].columns[0].label);

  const second = load({ session: { u: '20000021', r: 'USER' } });
  second.newMinutes('t', 'SDMM', '2026-11-26', '10:30 am');
  check('so the next meeting still gets the real one',
    bodyOf(second, 1).blocks[0].rows[0][1] === 'POD vs. Billing',
    bodyOf(second, 1).blocks[0].rows[0][1]);
}


// ===========================================================================
// 6. a new meeting somebody is not entitled to
// ===========================================================================
{
  const ctx = load({ session: { u: '20000012', r: 'USER' } });   // FI member
  const made = ctx.newMinutes('t', 'PP', '2026-11-12', '09:00 AM');
  check('a meeting in another section is refused', made.ok === false);
  check('and names the section that may', /Manufacturing/.test(made.error),
    made.error);
  check('and nothing was written', ctx.__tab.rows.length === 1);
  check('and the lock was released even so',
    ctx.__locks.taken === ctx.__locks.released);

  const bad = ctx.newMinutes('t', 'NOPE', '2026-11-12', '');
  check('a section that does not exist is refused', bad.ok === false);

  const undated = ctx.newMinutes('t', 'FICO', 'next tuesday', '');
  check('and so is a meeting with no readable date', undated.ok === false,
    undated.error);

  /*
    A LOCK THAT CANNOT BE TAKEN IS NOT A WRITE THAT GOES AHEAD. waitLock
    throws when somebody else holds it; swallowing that would mean two
    people appending a row for the same meeting, which is the exact bug the
    objectives log had.
  */
  const busy = load({ lockBusy: true, session: { u: '20000011', r: 'USER' } });
  const stuck = busy.newMinutes('t', 'FICO', '2026-11-12', '');
  check('a lock that cannot be taken refuses the write', stuck.ok === false);
  check('and says it is somebody else, not that the data is wrong',
    /Somebody else is saving/.test(stuck.error), stuck.error);
  check('and nothing was written', busy.__tab.rows.length === 1);
}


// ===========================================================================
// 7. saving
// ===========================================================================
{
  const ctx = load({
    meetings: [meeting('PP-20261029', 'PP', '2026-10-29',
      { v: 1, head: { purpose: 'p', minutesBy: '' },
        blocks: [{ id: 'ops', type: 'table',
                   rows: [['KEPZ', 'RMG', 'Normal', '']] }] })],
    session: { u: '20000042', r: 'USER' } });

  ctx.__advance(60 * 60 * 1000);
  const saved = ctx.saveMinutes('t', 'PP-20261029', {
    host: 'A host', attendees: 'Several people', time: '09:00 - 09:30',
    minutesBy: 'The minute taker',
    blocks: [{ id: 'ops', type: 'table',
               rows: [['KEPZ', 'RMG', 'Normal', 'Routing(Sweater)'],
                      ['', 'MG', 'Normal', 'Leftover']] }]
  });

  check('a save is accepted', saved.ok === true, saved.error);
  check('the cell was written',
    bodyOf(ctx, 1).blocks[0].rows[0][3] === 'Routing(Sweater)');
  check('and the row somebody added is in it',
    bodyOf(ctx, 1).blocks[0].rows.length === 2);
  check('the metadata went into real columns, not the body',
    ctx.__tab.rows[1][4] === 'A host' && ctx.__tab.rows[1][5] === 'Several people',
    ctx.__tab.rows[1][4] + ' / ' + ctx.__tab.rows[1][5]);
  check('and minutesBy went into the body, because it is on the slide',
    bodyOf(ctx, 1).head.minutesBy === 'The minute taker');

  check('a save answers with the page too',
    Boolean(saved.data) && saved.data.meeting.id === 'PP-20261029',
    JSON.stringify(Object.keys(saved)));
  check('and what it carries is what was just written',
    saved.data.meeting.blocks.filter(function (b) {
      return b.id === 'ops';
    })[0].rows[0][3] === 'Routing(Sweater)');

  check('who saved it is recorded', ctx.__tab.rows[1][8] === 'PP Member');
  check('with their employee ID', ctx.__tab.rows[1][9] === '20000042');
  check('and the time was refreshed, not left at the old one',
    ctx.__tab.rows[1][10] === '2026-11-12 11:00', ctx.__tab.rows[1][10]);

  const history = JSON.parse(ctx.__tab.rows[1][11]);
  check('the save is in the history', history.length === 1 &&
    history[0].by === 'PP Member', JSON.stringify(history));

  ctx.__advance(60 * 60 * 1000);
  ctx.saveMinutes('t', 'PP-20261029', { host: 'Another host' });
  const two = JSON.parse(ctx.__tab.rows[1][11]);
  check('and a second save goes on top of it, newest first',
    two.length === 2 && two[0].at > two[1].at, JSON.stringify(two));

  /*
    A SAVE THAT CHANGES ONE FIELD MUST NOT BLANK THE REST. The page sends
    what changed; a save that treated the absent keys as "set to empty"
    would wipe the whole meeting the first time somebody edited the time.
  */
  check('and a one-field save left the body alone',
    bodyOf(ctx, 1).blocks[0].rows.length === 2);
  check('and left the attendees alone', ctx.__tab.rows[1][5] === 'Several people');

  check('both locks were released',
    ctx.__locks.taken === ctx.__locks.released && ctx.__locks.taken === 2);
}


// ===========================================================================
// 8. saving what somebody may not save
// ===========================================================================
{
  const ctx = load({
    meetings: [meeting('PP-20261029', 'PP', '2026-10-29', { v: 1, blocks: [] })],
    session: { u: '20000012', r: 'USER' } });          // FI member

  const no = ctx.saveMinutes('t', 'PP-20261029', { host: 'Me' });
  check('another section cannot save your minutes', no.ok === false);
  check('and the row is untouched', ctx.__tab.rows[1][4] === '');

  const gone = ctx.saveMinutes('t', 'FICO-19990101', { host: 'Me' });
  check('saving a meeting that is not there is refused', gone.ok === false);
  check('and says it is gone rather than that you may not',
    /no longer there/.test(gone.error), gone.error);

  check('every lock taken was released',
    ctx.__locks.taken === ctx.__locks.released);

  const head = load({
    meetings: [meeting('PP-20261029', 'PP', '2026-10-29', { v: 1, blocks: [] })],
    session: { u: '20000001', r: 'USER' } });          // department head
  check('but the head of EAS can', head.saveMinutes('t', 'PP-20261029',
    { host: 'Him' }).ok === true);
}


// ===========================================================================
// 9. what a save is allowed to contain
// ===========================================================================
/*
  EVERYTHING THE PAGE SENDS IS REBUILT, not trusted and stored. The body is
  written back into a cell and read by every later reader, so an unchecked
  save is an unchecked save for everybody afterwards.
*/
{
  const ctx = load({
    meetings: [meeting('FICO-20261029', 'FICO', '2026-10-29', { v: 1, blocks: [] })],
    session: { u: '20000011', r: 'USER' } });

  ctx.saveMinutes('t', 'FICO-20261029', { blocks: [
    { id: 'ops', type: 'table', rows: [['a', 'b']],
      sneak: 'a key nobody asked for' },
    { id: '', type: 'table', rows: [['dropped, no id']] },
    { id: '../../etc', type: 'table', rows: [['dropped, bad id']] },
    { id: 'notes1', type: 'notes',
      lines: [{ key: 'text', value: 'kept' },
              { key: '', value: 'dropped, no key' }] },
    'not an object'
  ] });

  const body = bodyOf(ctx, 1);
  check('a block with an unusable id is dropped',
    body.blocks.length === 2, JSON.stringify(body.blocks.map((b) => b.id)));
  check('and so is anything that is not a block',
    body.blocks.every((b) => b && typeof b === 'object'));
  check('an unknown key on a block is not stored',
    body.blocks[0].sneak === undefined);
  check('a line with no key is dropped',
    body.blocks[1].lines.length === 1 && body.blocks[1].lines[0].key === 'text');
  check('and no label is stored, because labels come from the seed',
    body.blocks[1].lines[0].label === undefined);

  // Cells are capped, rows are capped.
  const many = [];
  for (let i = 0; i < 400; i++) many.push(['row ' + i]);
  ctx.saveMinutes('t', 'FICO-20261029', { blocks: [
    { id: 'ops', type: 'table', rows: many } ] });
  check('a runaway table is capped',
    bodyOf(ctx, 1).blocks[0].rows.length === ctx.MIN_ROWS_MAX,
    bodyOf(ctx, 1).blocks[0].rows.length + ' rows');

  ctx.saveMinutes('t', 'FICO-20261029', { blocks: [
    { id: 'ops', type: 'table', rows: [['x'.repeat(2000)]] } ] });
  check('and so is a runaway cell',
    bodyOf(ctx, 1).blocks[0].rows[0][0].length === ctx.MIN_CELL_MAX);

  /*
    CARRIAGE RETURNS. A cell pasted out of PowerPoint carries them and
    JSON.stringify keeps them, so the same text saved from two machines
    produces two different cells - and the history then records a change
    nobody made.
  */
  ctx.saveMinutes('t', 'FICO-20261029', { blocks: [
    { id: 'ops', type: 'table', rows: [['one\r\ntwo\rthree']] } ] });
  check('pasted line endings are normalised',
    bodyOf(ctx, 1).blocks[0].rows[0][0] === 'one\ntwo\nthree',
    JSON.stringify(bodyOf(ctx, 1).blocks[0].rows[0][0]));
}


// ===========================================================================
// 10. the cell ceiling
// ===========================================================================
/*
  REFUSED WITH THE SIZE, never truncated. A truncated JSON body does not
  parse, so a silent truncation does not lose the end of the meeting - it
  loses the meeting.
*/
{
  const ctx = load({
    meetings: [meeting('FICO-20261029', 'FICO', '2026-10-29',
      { v: 1, head: { purpose: 'p', minutesBy: '' },
        blocks: [{ id: 'ops', type: 'table', rows: [['keep me']] }] })],
    session: { u: '20000011', r: 'USER' } });

  const rows = [];
  for (let i = 0; i < 110; i++) rows.push(['x'.repeat(490), 'y'.repeat(490)]);

  let threw = '';
  try {
    ctx.saveMinutes('t', 'FICO-20261029', { blocks: [
      { id: 'ops', type: 'table', rows: rows } ] });
  } catch (e) { threw = String(e.message || e); }

  check('a body over the cell limit is refused', threw !== '', threw);
  check('and the message carries the actual size', /\d{5}/.test(threw), threw);
  check('and the meeting that was there is still there',
    bodyOf(ctx, 1).blocks[0].rows[0][0] === 'keep me');
  check('and the lock was released on the way out',
    ctx.__locks.taken === ctx.__locks.released,
    ctx.__locks.taken + ' taken, ' + ctx.__locks.released + ' released');
}


// ===========================================================================
// 11. deleting
// ===========================================================================
{
  const rows = [meeting('PP-20261029', 'PP', '2026-10-29', { v: 1, blocks: [] }),
                meeting('PP-20261015', 'PP', '2026-10-15', { v: 1, blocks: [] })];

  const member = load({ meetings: rows, session: { u: '20000042', r: 'USER' } });
  const no = member.deleteMinutes('t', 'PP-20261029');
  check('somebody who may write may not delete', no.ok === false);
  check('and is told who can', /section head/.test(no.error), no.error);
  check('and both meetings are still there', member.__tab.rows.length === 3);

  const head = load({ meetings: rows, session: { u: '20000041', r: 'USER' } });
  check('the section head can', head.deleteMinutes('t', 'PP-20261029').ok === true);
  check('and the right row went',
    head.__tab.rows.length === 2 && head.__tab.rows[1][0] === 'PP-20261015',
    head.__tab.rows.map((r) => r[0]).join(','));

  const lead = load({ meetings: rows, session: { u: '20000001', r: 'USER' } });
  check('so can the head of EAS',
    lead.deleteMinutes('t', 'PP-20261029').ok === true);

  const other = load({ meetings: rows, session: { u: '20000011', r: 'USER' } });
  check('a head of another section cannot',
    other.deleteMinutes('t', 'PP-20261029').ok === false);
  check('and every lock was released',
    other.__locks.taken === other.__locks.released);
}


// ===========================================================================
// 12. reading, and what the page is sent
// ===========================================================================
{
  const ctx = load({ meetings: [
    meeting('PP-20261015', 'PP', '2026-10-15', { v: 1, blocks: [] }),
    meeting('PP-20261112', 'PP', '2026-11-12', { v: 1, blocks: [] }),
    meeting('PP-20261029', 'PP', '2026-10-29', { v: 1, blocks: [] }),
    meeting('FICO-20261110', 'FICO', '2026-11-10', { v: 1, blocks: [] })
  ], session: { u: '20000042', r: 'USER' } });

  const got = ctx.getMinutes('t', 'PP');
  check('the list is newest first',
    got.list.map((m) => m.id).join(',') ===
    'PP-20261112,PP-20261029,PP-20261015',
    got.list.map((m) => m.id).join(','));
  check('and only that section', got.list.length === 3);
  check('the newest is the one opened', got.meeting.id === 'PP-20261112');
  check('every section is counted for the tabs',
    got.sections.filter((s) => s.code === 'FICO')[0].count === 1);

  /*
    AND EVERY SECTION CARRIES ITS PALETTE. Left out of this payload, the
    page draws perfectly correct tables with no colour in any of them - the
    four decks reduced to four identical grey grids. Nothing throws:
    theme.head is undefined, the inline style reads "background:undefined",
    and the browser ignores it. It took a screenshot to notice.
  */
  const unthemed = got.sections.filter(function (s) {
    return !s.theme || !/^#[0-9a-f]{6}$/.test(String(s.theme.head)) ||
           !/^#[0-9a-f]{6}$/.test(String(s.theme.band)) ||
           !/^#[0-9a-f]{6}$/.test(String(s.theme.title));
  });
  check('and carries its own palette with it',
    unthemed.length === 0,
    unthemed.map(function (s) { return s.code; }).join(','));
  check('a section also says which layout it wants',
    got.sections.every(function (s) {
      return s.layout === 'wide' || s.layout === 'split';
    }));

  /*
    THE LIST CARRIES NO BODIES. The page is a list beside one document; a
    list that carried every body would send twenty-nine PP meetings to draw
    one, over a connection where the whole point is that it is slow.
  */
  check('the list carries no bodies',
    got.list.every((m) => m.body === undefined),
    JSON.stringify(Object.keys(got.list[0])));
  const size = JSON.stringify(got.list).length;
  check('so a three-meeting list is a few hundred bytes', size < 800, size + ' bytes');

  // Opening one by id works without knowing its section.
  const one = ctx.getMinutes('t', '', 'FICO-20261110');
  check('a meeting opens by id alone', one.meeting.id === 'FICO-20261110');
  check('and brings its own section with it', one.section === 'FICO');

  // Nothing asked for falls to the viewer's own section.
  check('nothing asked for opens your own section',
    ctx.getMinutes('t', '').section === 'PP');

  const stray = load({ meetings: [], session: { u: '20000099', r: 'USER' } });
  check('and somebody with no section still gets a page',
    stray.getMinutes('t', '').section === 'FICO');
  check('with nothing in it rather than an error',
    stray.getMinutes('t', '').meeting === null);

  check('a section with no meetings yet reads as empty',
    ctx.getMinutes('t', 'SCA').list.length === 0);
  check('and says so by sending no meeting',
    ctx.getMinutes('t', 'SCA').meeting === null);
}


// ===========================================================================
// 13. the seed decides the columns, the sheet decides the rows
// ===========================================================================
/*
  THE SPLIT THAT MAKES THE WHOLE THING EDITABLE. A heading corrected in the
  seed shows on every meeting ever saved; a row added to a meeting stays on
  that meeting. Letting the seed decide the rows too would undo every agenda
  change the moment the meeting was reopened - which is precisely the thing
  the section said they do.
*/
{
  const ctx = load({ meetings: [meeting('FICO-20261029', 'FICO', '2026-10-29',
    { v: 1, head: { purpose: '', minutesBy: '' },
      blocks: [{ id: 'ops', type: 'table', rows: [
        ['1.  FI/TR', 'DEPZ', 'RMG', 'Something somebody typed'],
        // A SHORT ROW, on purpose. A meeting saved before a column was
        // added holds fewer cells than the seed now defines, and the first
        // version of this fixture gave every row its full four - so the
        // padding below was asserted against rows that needed none and the
        // assertion passed whatever the code did.
        ['2.  CO', 'CEPZ'],
        ['9.  AN EXTRA ROW', 'KEPZ', 'MG', 'And its status']
      ] }] })], session: { u: '20000011', r: 'USER' } });

  const ops = ctx.getMinutes('t', 'FICO').meeting.blocks[0];
  check('the columns come from the seed',
    ops.columns.map((c) => c.key).join(',') === 'module,zone,sector,status',
    ops.columns.map((c) => c.key).join(','));
  check('and the labels with them', ops.columns[0].label === 'Module');
  check('the rows come from the sheet',
    ops.rows.length === 3, ops.rows.length + ' rows, expected 3');
  check('including the one somebody added',
    ops.rows[2][0] === '9.  AN EXTRA ROW');
  check('a row saved before a column existed is padded out to it',
    ops.rows[1].length === 4, JSON.stringify(ops.rows[1]));
  check('with empty cells, not with the seed\'s own values',
    ops.rows[1][2] === '' && ops.rows[1][3] === '',
    JSON.stringify(ops.rows[1]));

  /*
    A BLOCK THE SEED NO LONGER HAS IS STILL SHOWN. Taking a block out of the
    seed is a decision about future meetings; it is not an agreement to lose
    what was written in it last fortnight.
  */
  const retired = load({ meetings: [meeting('PP-20261029', 'PP', '2026-10-29',
    { v: 1, blocks: [{ id: 'oldThing', type: 'table',
                       rows: [['something', 'from before']] }] })],
    session: { u: '20000042', r: 'USER' } });
  const blocks = retired.getMinutes('t', 'PP').meeting.blocks;
  const old = blocks.filter((b) => b.id === 'oldThing')[0];
  check('a block the seed no longer defines is still sent', Boolean(old));
  check('with its content', old && old.rows[0][1] === 'from before');
  check('and marked as retired, so the page can say so',
    old && old.retired === true);
}


// ===========================================================================
// 14. a body that will not parse
// ===========================================================================
/*
  ONE UNREADABLE MEETING IS A THING SOMEBODY CAN RETYPE. A Minutes tab that
  will not open is not.
*/
{
  const ctx = load({ meetings: [
    meeting('PP-20261112', 'PP', '2026-11-12', '{ this is not json'),
    meeting('PP-20261029', 'PP', '2026-10-29', '')
  ], session: { u: '20000042', r: 'USER' } });

  let threw = '';
  let got = null;
  try { got = ctx.getMinutes('t', 'PP'); } catch (e) { threw = String(e); }

  check('an unreadable body does not take the page down', threw === '', threw);
  check('the meeting opens, empty', got && got.meeting.id === 'PP-20261112');
  check('and still shows the section its blocks',
    got.meeting.blocks.length === ctx.MIN_SEEDS.PP.length);
  check('with the seeded rows, because there is nothing else to show',
    got.meeting.blocks[0].rows.length === 6);
  check('a blank body is the same', ctx.getMinutes('t', '', 'PP-20261029')
    .meeting.blocks[0].rows.length === 6);

  /*
    A body that parses but is not a meeting - an array, a number, a bare
    string - reads as empty too, rather than reaching the page as something
    whose `blocks` is undefined.
  */
  ['[1,2,3]', '5', '"a string"', 'null', 'true'].forEach(function (text) {
    const got = ctx.parseMinBody(text);
    check('a body of ' + text + ' reads as an empty meeting',
      got && Array.isArray(got.blocks) && got.blocks.length === 0 &&
      got.head && got.head.purpose === '', JSON.stringify(got));
  });
}


// ===========================================================================
// 15. checkMinutes
// ===========================================================================
{
  const ctx = load({ meetings: [
    meeting('PP-20261112', 'PP', '2026-11-12', '{ not json'),
    meeting('XX-20261029', 'XX', '2026-10-29', { v: 1, blocks: [] }),
    meeting('FICO-20261110', 'FICO', '2026-11-10', { v: 1, blocks: [] })
  ] });

  const report = ctx.checkMinutes();
  check('the unreadable meeting is named', /PP-20261112/.test(report));
  check('and so is the one in a section that does not exist',
    /XX-20261029/.test(report));
  check('the sections are counted', /FICO\s+1/.test(report));

  /*
    AND IT MUST NOT ALSO SAY EVERYTHING IS FINE. Checking only that the
    faults are listed lets a report that prints them and then signs off
    'Nothing wrong found' underneath pass - which is the version somebody
    scrolls to the bottom of and closes.
  */
  check('and it does not sign off as healthy',
    !/Nothing wrong found/.test(report), report);

  /*
    THE DIRECTORY JOIN IS THE THING MOST LIKELY TO BE QUIETLY WRONG. A
    Sub-Department spelt differently from the organogram costs that whole
    section its write button and says nothing about why.
  */
  const drifted = load({ team: { lead: null, sections: [
    { name: 'Financial Applications', head: null, members: [] },
    { name: 'Sales Application', head: null, members: [] }   // singular
  ] } });
  const second = drifted.checkMinutes();
  check('a section the directory does not match is reported',
    /NO DIRECTORY SECTION MATCHES[^\n]*Sales & Customer Applications/.test(second),
    second);

  /*
    AND IT PRINTS WHAT THE DIRECTORY ACTUALLY SAYS. Naming the section that
    did not match tells somebody that something is wrong and not what to
    type; the two strings side by side is the whole diagnosis.
  */
  check('and every Sub-Department it found is listed beside it',
    /Sub-Departments on the TEAM tab/.test(second) &&
    /Sales Application\b/.test(second), second);
  check('with the ones it could not place marked as such',
    /not one of the four meeting sections/.test(second), second);
  check('and the ones that do match are not',
    !/NO DIRECTORY SECTION MATCHES[^\n]*Financial/.test(second), second);
  check('and that report does not sign off as healthy either',
    !/Nothing wrong found/.test(second), second);

  const clean = load({ meetings: [
    meeting('FICO-20261110', 'FICO', '2026-11-10', { v: 1, blocks: [] })] });
  check('and a healthy tab says so', /Nothing wrong found/.test(clean.checkMinutes()));
}


// ===========================================================================
// 16. dates, ids and the shape of a row
// ===========================================================================
{
  const ctx = load();

  check('a Date cell reads as a date',
    ctx.minDate(ctx.__date(2026, 10, 12)) === '2026-11-12',
    ctx.minDate(ctx.__date(2026, 10, 12)));
  check('a text cell reads as a date', ctx.minDate('2026-11-12') === '2026-11-12');
  check('a text cell with a time on it still reads',
    ctx.minDate('2026-11-12T09:00:00Z') === '2026-11-12');
  check('and anything else reads as nothing',
    ctx.minDate('12 Nov') === '' && ctx.minDate('') === '' &&
    ctx.minDate(null) === '');

  check('the row the tab is created with is the row that is read',
    ctx.MIN_MEET_COLUMNS.length === 12 &&
    ctx.MIN_MEET_COLUMNS[7] === 'Body',
    ctx.MIN_MEET_COLUMNS.join(','));

  /*
    THE TAB IS READ BY HEADER NAME. Somebody who inserts a column in the
    spreadsheet - which is an ordinary thing to do to a spreadsheet - must
    not thereby make every meeting read its host out of the status column.
  */
  const moved = load({ meetings: [] });
  moved.__tab.rows[0] = ['Meeting ID', 'Section', 'Note', 'Date', 'Time',
                         'Host', 'Attendees', 'Status', 'Body', 'By', 'By ID',
                         'At', 'History'];
  moved.__tab.rows.push(['PP-1', 'PP', 'a note somebody added', '2026-11-12',
                         '09:00', 'The host', '', 'DRAFT', '{"v":1}', 'X',
                         '20000042', '2026-11-12 09:00', '']);
  const read = moved.readMinutes()[0];
  check('an inserted column does not shift every field along',
    read.date === '2026-11-12' && read.host === 'The host',
    read.date + ' / ' + read.host);
}


// ===========================================================================
console.log('');
const bad = out.filter((x) => !x).length;
console.log((out.length - bad) + '/' + out.length + ' passed' +
            (bad ? ', ' + bad + ' failed' : ''));
process.exit(bad ? 1 : 0);
