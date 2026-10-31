// readTeam(), on the server, against a sheet.
//
// WHY THIS EXISTS AND WHAT IT CAUGHT
// The EAS Team page is covered in the browser by portal-test.js, and that
// suite drives a harness whose getTeam() returns a canned object. So it tests
// how the page DRAWS a directory and nothing at all about how the directory
// is WORKED OUT. Two mutations proved it: deleting the department-head rule
// in Team.gs and emptying PORTAL_SECTION_ORDER in Config.gs both left
// portal-test at 41/41, because neither line runs in a browser.
//
// Everything the page relies on is decided here instead:
//
//   the department head        a row whose Sub-Department is ALL is not a
//                              section - it is the person above them
//   the order of the sections  the organogram's, which no rule produces
//   interim                    leading a section you do not sit in
//   the count on a card        has to equal what opening it shows
//
//   node tests/team-test.js
const fs = require('fs'), vm = require('vm'), path = require('path');
const SRC = process.env.EAS_SRC || path.join(__dirname, '..', 'src');

const out = [];
const check = (n, ok, d) => {
  out.push(ok);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (d ? '   [' + d + ']' : ''));
};

// ---------------------------------------------------------------------------
// the fixture
// ---------------------------------------------------------------------------
// Deliberately not tidy. It carries every shape the real tab has and the page
// has to survive:
//
//   Utpal      Sub-Department ALL, and his Head cell names a section he is
//              not in - department head AND interim lead of Supply Chain
//   Pradip     ordinary head: Head says Yes and he sits in the section
//   Nobody     in the tab, not in CONFIG.ROSTER - the drift report
//   Financial  present, with nobody marked as its head at all
//
// The rows are in the order the real spreadsheet has them, which is NOT the
// order the page shows: Financial appears before Supply Chain here, so an
// implementation that keeps sheet order fails the ordering assertion.
const HEADERS = ['SL#', 'Employee Name', 'Employee ID', 'Designation', 'Module',
                 'Department', 'Sub-Department', 'Blood Group', 'Computer Name',
                 'Office Location', 'Ext#', 'WhatApp/Cell No.', 'Mail Address',
                 'Head', 'Photo', 'Note'];

const ROWS = [
  [1, 'Utpal Biswas', 20990001, 'Senior Manager', 'MM', 'EAS', 'ALL', 'A+', '',
   'TVL HQ', '9001/9011', '01700000001', 'utpal@x.test', 'Supply Chain Applications', '', ''],
  [2, 'Abul Bashar', 20990002, 'Manager', 'FI/CO', 'EAS', 'Financial Applications', '', '',
   'YHT', '9002', '01700000002', 'bashar@x.test', '', '', ''],
  [3, 'Sadril Ali', 20990003, 'Assistant Officer', 'FI', 'EAS', 'Financial Applications', '', '',
   'TVL HQ', '9003', '01700000003', 'sadril@x.test', '', '', ''],
  [4, 'Md. Abul Masum Siddique', 20990004, 'Manager', 'SD', 'EAS',
   'Sales and Customer Applications', 'B+', '', 'YCL', '9004/9014', '01700000004',
   'masum@x.test', 'yes', '', ''],
  [5, 'Lincoln Barua', 20990005, 'Deputy Manager', 'SD', 'EAS',
   'Sales and Customer Applications', 'A+', '', 'YCL', '9005', '01700000005',
   'lincoln@x.test', '', '', ''],
  [6, 'Pradip Kumar Nath', 20990006, 'Manager', 'PP', 'EAS', 'Manufacturing Applications',
   'B+', '', 'TVL HQ', '9006', '01700000006', 'pradip@x.test', 'Yes', '', ''],
  [7, 'Rudra Das', 20990007, 'Assistant Engineer', 'PP', 'EAS', 'Manufacturing Applications',
   'B+', '', 'TVL HQ', '9007', '01700000007', 'rudra@x.test', '', '', ''],
  [8, 'Sudip Paul', 20990008, 'Assistant Manager', 'MD', 'EAS', 'Supply Chain Applications',
   'O+', '', 'YCL', '9008', '01700000008', 'sudip@x.test', '', '', ''],
  [9, 'Nobody In Roster', 20999999, 'Officer', 'MM', 'EAS', 'Supply Chain Applications',
   '', '', 'YCL', '', '01700000000', 'nobody@x.test', '', '', '']
];

// ---------------------------------------------------------------------------
// a spreadsheet just real enough
// ---------------------------------------------------------------------------
function makeSheet(rows) {
  const all = [HEADERS].concat(rows);
  return {
    getLastRow: () => all.length,
    getLastColumn: () => HEADERS.length,
    getRange: function (r, c, n, w) {
      return {
        getValues: function () {
          const got = [];
          for (let i = 0; i < n; i++) {
            got.push((all[r - 1 + i] || []).slice(c - 1, c - 1 + w));
          }
          return got;
        },
        setValues: () => ({ setFontWeight: () => ({ setBackground: () => ({ setFontColor: () => {} }) }) })
      };
    }
  };
}

function load(rows) {
  const ctx = {
    console: console,
    Logger: { log: () => {} },
    SpreadsheetApp: {},
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(SRC, 'Config.gs'), 'utf8'), ctx);

  // The two helpers Team.gs leans on, which live in other files. Stubbed
  // rather than loaded: sheetWithHeaders would need the whole of Questions.gs
  // and a Drive, and neither decides anything this suite is about.
  const sheet = makeSheet(rows);
  ctx.sheetWithHeaders = () => sheet;
  ctx.requireSignedIn = () => ({ u: '20000000', r: 'ADMIN' });

  vm.runInContext(fs.readFileSync(path.join(SRC, 'Team.gs'), 'utf8'), ctx);
  return ctx;
}

const ctx = load(ROWS);
const team = ctx.readTeam();

// ---------------------------------------------------------------------------
// the department head is not a section
// ---------------------------------------------------------------------------
check('a row whose section is ALL becomes the department head',
  team.lead !== null && team.lead.name === 'Utpal Biswas',
  team.lead ? team.lead.name : '(none)');

check('and is taken out of the section list rather than heading one called ALL',
  team.sections.filter((s) => /^ALL$/i.test(s.name)).length === 0 &&
  team.sections.length === 4,
  team.sections.length + ' sections: ' + team.sections.map((s) => s.name).join(', '));

// ---------------------------------------------------------------------------
// the organogram's order
// ---------------------------------------------------------------------------
// The fixture's rows run Financial, Sales, Manufacturing, Supply Chain. Sheet
// order would give that back; this has to give the organogram's.
check('the sections come back in the organogram order, not the sheet order',
  team.sections.map((s) => s.name).join(' | ') ===
    'Supply Chain Applications | Sales and Customer Applications | ' +
    'Manufacturing Applications | Financial Applications',
  team.sections.map((s) => s.name).join(' | '));

const find = (text) => team.sections.filter((x) => new RegExp(text, 'i').test(x.name))[0];

check('matched loosely, so the tab may say Sales and Customer Applications',
  find('sales').name === 'Sales and Customer Applications',
  'CONFIG.DEPARTMENTS calls the same section Sales Applications');

// ---------------------------------------------------------------------------
// who leads what, and when that is interim
// ---------------------------------------------------------------------------
const sca = find('supply chain');
check('a Head cell naming a section makes that person its head',
  sca.head !== null && sca.head.name === 'Utpal Biswas',
  sca.head ? sca.head.name : '(none)');

check('and it is interim, because the section is not the one he sits in',
  sca.interim === true, 'his own Sub-Department is ALL');

const mfg = find('manufactur');
check('a Head cell saying Yes makes them head of their OWN section',
  mfg.head !== null && mfg.head.name === 'Pradip Kumar Nath' && mfg.interim === false,
  (mfg.head ? mfg.head.name : '(none)') + ', interim ' + mfg.interim);

check('Yes is read whatever its case',
  find('sales').head !== null &&
  find('sales').head.name === 'Md. Abul Masum Siddique',
  'row 4 says lower-case yes');

// A SECTION NOBODY IS MARKED AS LEADING FALLS TO THE DEPARTMENT HEAD.
//
// This is the arrangement the team is in rather than a convenience: Supply
// Chain has no head of its own and the head of EAS covers it. Deriving it
// means nobody has to describe it in a spreadsheet, and the day somebody is
// appointed their Yes takes over without anyone coming back to undo this.
const fin = find('financial');
check('a section nobody claims falls to the department head, as interim',
  fin.head !== null && fin.head.name === 'Utpal Biswas' && fin.interim === true,
  (fin.head ? fin.head.name : '(none)') + ', interim ' + fin.interim);

// AND STILL NOT BY SENIORITY. Abul Bashar is a Manager sitting in Financial;
// rank would pick him, confidently, and would be picking between two Managers
// on no evidence. Covering a section and running it are different facts.
check('and not by rank, which would have picked a Manager out of the section',
  fin.head.name !== 'Abul Bashar',
  'two Managers sit in Financial - rank would choose between them');

// With nobody above them either, there is simply no head, and the card says
// so rather than inventing one.
const orphan = load(ROWS.filter((r) => r[6] !== 'ALL')).readTeam();
check('with no department head either, an unled section says so',
  orphan.lead === null &&
  orphan.sections.filter((s) => /Financial/.test(s.name))[0].head === null,
  'nothing above it to fall to');

// ---------------------------------------------------------------------------
// the number on the card
// ---------------------------------------------------------------------------
// It is printed on a closed card and has to equal what opening it shows:
// the head plus the people under them.
team.sections.forEach(function (section) {
  const shown = section.members.length + (section.head ? 1 : 0);
  check('"' + section.name + '" counts what opening it would show',
    section.count === shown, section.count + ' said, ' + shown + ' drawn');
});

check('an interim head is counted in the section he leads',
  sca.count === 3 && sca.members.length === 2,
  'Sudip and Nobody sit in it, Utpal leads it: three people under Supply Chain');

check('and is NOT listed twice inside his own section',
  sca.members.filter((p) => p.name === 'Utpal Biswas').length === 0,
  'he is the card you press, and the first card behind it');

check('a head who sits in their section is not repeated in its members either',
  mfg.members.filter((p) => p.name === 'Pradip Kumar Nath').length === 0 &&
  mfg.count === 2,
  mfg.members.map((p) => p.name).join(', '));

// ---------------------------------------------------------------------------
// the contact details, read off the columns by meaning
// ---------------------------------------------------------------------------
check('an employee ID arrives as a string without a trailing .0',
  team.lead.id === '20990001', team.lead.id);

check('and the mobile, extension and address come off the right columns',
  team.lead.phone === '01700000001' && team.lead.ext === '9001/9011' &&
  team.lead.email === 'utpal@x.test',
  team.lead.ext + ' / ' + team.lead.phone);

// A tab whose headers were renamed or reordered still has to work: it is
// filled by pasting from a spreadsheet somebody else maintains.
const moved = load(ROWS);
check('the columns are found by meaning, so Ext# may be renamed Extension',
  (function () {
    const flat = ctx.teamColumnIndex(['Name', 'Mail', 'Extension', 'Mobile', 'Head']);
    return flat.name === 0 && flat.email === 1 && flat.ext === 2 &&
           flat.phone === 3 && flat.head === 4;
  })(),
  'matched on a squashed, lower-cased header');

// ---------------------------------------------------------------------------
// the roster disagreement
// ---------------------------------------------------------------------------
check('somebody in the tab but not in CONFIG.ROSTER is reported',
  team.drift.unknown.indexOf('Nobody In Roster') !== -1,
  team.drift.unknown.join(', ') || '(none)');

check('and the roster names missing from the tab are reported too',
  team.drift.missing.length > 0 &&
  team.drift.missing.indexOf('Rudra Das') === -1,
  team.drift.missing.length + ' missing, and Rudra Das is in both');

// THE ONE THAT WOULD HAVE CRIED WOLF.
// The directory says 'Md. Abul Masum Siddique'; CONFIG.ROSTER says 'Muhammad
// Abul Masum Siddique'. One person. Comparing the raw strings reports him
// twice - once as missing and once as unknown - and sends whoever reads the
// notice looking for a staffing problem that is a spelling.
check('an honorific spelled differently in the two lists is not a disagreement',
  team.drift.unknown.indexOf('Md. Abul Masum Siddique') === -1 &&
  team.drift.missing.indexOf('Muhammad Abul Masum Siddique') === -1,
  'drift.unknown: ' + (team.drift.unknown.join(', ') || '(none)'));

// ---------------------------------------------------------------------------
// an empty tab
// ---------------------------------------------------------------------------
// A page that says "nobody has filled this in" is useful. One that fails to
// load is not.
const empty = load([]);
const none = empty.readTeam();
check('an empty tab returns an empty directory rather than throwing',
  none.filled === false && none.count === 0 &&
  none.sections.length === 0 && none.lead === null,
  'filled: ' + none.filled);

// ---------------------------------------------------------------------------
// a Drive link in the Photo column
// ---------------------------------------------------------------------------
// What people copy out of Drive is a VIEWER page, not an image. Put straight
// into an <img> it is a broken icon.
check('a Drive sharing link becomes something an img can actually load',
  ctx.teamPhotoUrl('https://drive.google.com/file/d/1aB2cD3eF4gH5iJ6kL7mN8oP9qR0sT1u/view?usp=sharing') ===
  'https://drive.google.com/thumbnail?id=1aB2cD3eF4gH5iJ6kL7mN8oP9qR0sT1u&sz=w320',
  ctx.teamPhotoUrl('https://drive.google.com/file/d/1aB2cD3eF4gH5iJ6kL7mN8oP9qR0sT1u/view'));

check('a bare Drive id works too, and anything else is left alone',
  ctx.teamPhotoUrl('1aB2cD3eF4gH5iJ6kL7mN8oP9qR0sT1u').indexOf('thumbnail?id=') !== -1 &&
  ctx.teamPhotoUrl('https://example.test/me.jpg') === 'https://example.test/me.jpg' &&
  ctx.teamPhotoUrl('not a link') === '',
  'a value that is not a URL is dropped rather than put in an src');

const failed = out.filter((r) => !r).length;
console.log('\n' + (out.length - failed) + '/' + out.length + ' passed');
process.exit(failed ? 1 : 0);
