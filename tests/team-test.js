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

// CONFIG is declared with `const` at the top level of Config.gs, so it lives
// in the vm's global LEXICAL scope and never appears on the context object -
// ctx.CONFIG is undefined. Read it the way the other suites do.
const CFG = vm.runInContext('CONFIG', ctx);

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
// Blood Group is in this list deliberately, and nowhere near the eighth
// position it occupies in the real sheet. It is the one column here whose
// value is meaningless out of place and dangerous read off the wrong row:
// an inserted column ahead of it, matched by position, would put one
// colleague's blood group under another colleague's name on the card a
// third colleague reads to a hospital.
check('the columns are found by meaning, so Ext# may be renamed Extension',
  (function () {
    const flat = ctx.teamColumnIndex(['Name', 'Mail', 'Extension', 'Mobile',
                                      'Head', 'Blood Group']);
    return flat.name === 0 && flat.email === 1 && flat.ext === 2 &&
           flat.phone === 3 && flat.head === 4 && flat.blood === 5;
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
// the order people are listed in
// ---------------------------------------------------------------------------
// The chart has a sequence - seniority, mostly - and the TEAM tab does not
// carry it: rows sit in whatever order they were pasted. CONFIG.ROSTER does
// carry it, so the page reads it off there.
//
// The fixture below is DELIBERATELY SHUFFLED against the roster. Sorted by
// sheet order it comes out backwards, so an implementation that quietly did
// nothing would fail rather than pass by coincidence.
{
  const SCM = 'Supply Chain Applications';
  const shuffled = [
    [1, 'Utpal Biswas', 20990001, 'Senior Manager', 'MM', 'EAS', 'ALL', '', '',
     'TVL HQ', '9001', '01700000001', 'u@x.test', SCM, '', ''],
    // roster order is Ashraful Islam, Shanta Aich, Aungshuman Das, Jowel
    // Barua, Sudip Paul, Ashraful Karim, Abdullah Al Mamun, Debobroto Mondol
    [2, 'Debobroto Mondol', 20990002, 'Assistant Officer', 'MM', 'EAS', SCM, '', '',
     'YCL', '9002', '01700000002', 'd@x.test', '', '', ''],
    [3, 'Shanta Aich', 20990003, 'Assistant Manager', 'MM', 'EAS', SCM, '', '',
     'YCL', '9003', '01700000003', 's@x.test', '', '', ''],
    [4, 'Md. Ashraful Islam', 20990004, 'Deputy Manager', 'MM', 'EAS', SCM, '', '',
     'YCL', '9004', '01700000004', 'a@x.test', '', '', ''],
    // Not in CONFIG.ROSTER at all. Has to keep a place rather than vanish.
    [5, 'Brand New Person', 20990005, 'Officer', 'MM', 'EAS', SCM, '', '',
     'YCL', '9005', '01700000005', 'n@x.test', '', '', ''],
    [6, 'Sudip Paul', 20990006, 'Assistant Manager', 'MM', 'EAS', SCM, '', '',
     'YCL', '9006', '01700000006', 'p@x.test', '', '', '']
  ];

  const ctx2 = load(shuffled);
  const scm = ctx2.readTeam().sections.filter((x) => x.name === SCM)[0];
  const order = scm.members.map((m) => m.name);

  check('members come back in the roster order, not the order of the tab',
    JSON.stringify(order.slice(0, 4)) === JSON.stringify(
      ['Md. Ashraful Islam', 'Shanta Aich', 'Sudip Paul', 'Debobroto Mondol']),
    order.join(' | '));

  check('and somebody the roster does not name keeps a place, at the end',
    order[order.length - 1] === 'Brand New Person' &&
    order.length === 5,
    order.length + ' members, last is ' + order[order.length - 1]);

  check('(fixture check) the tab order really is different from the roster order',
    JSON.stringify(order) !== JSON.stringify(
      ['Debobroto Mondol', 'Shanta Aich', 'Md. Ashraful Islam',
       'Brand New Person', 'Sudip Paul']),
    'otherwise sorting nothing at all would pass this');

  // The two lists spell the sections differently - the tab says 'Sales and
  // Customer Applications', Config.gs says 'Sales Applications' - so the
  // match has to be loose or the order silently does not apply at all.
  const loose = ctx2.rosterOrderFor('Sales and Customer Applications');
  // Counted off CONFIG rather than written as a number here. The number was
  // 11, and it became 10 the day somebody resigned - which is a change to
  // the team, not to the loose matching this line is about. What makes the
  // assertion real is the head landing first and the line below it, where a
  // section name that matches nothing has to come back empty.
  const sales = CFG.ROSTER['Sales Applications'];
  check('a section the two files spell differently still finds its order',
    loose.length === sales.length && loose.length > 1 &&
    loose[0] === ctx.matchPerson('Muhammad Abul Masum Siddique'),
    loose.length + ' names matched for "Sales and Customer Applications", ' +
    sales.length + ' in the roster');

  check('and a section name that matches nothing returns no order at all',
    ctx2.rosterOrderFor('Something Else Entirely').length === 0,
    'rather than imposing the wrong section order on it');
}

// ---------------------------------------------------------------------------
// what goes beside a designation
// ---------------------------------------------------------------------------
// Every card prints "<designation> . <module>". Everybody's module is their
// own, with one exception that is the point of this block: the department
// head's Module cell names a module because the sheet has to put something
// there, and he does not belong to one. His card says the department.
{
  const find = (name) => {
    let hit = null;
    if (team.lead && team.lead.name === name) hit = team.lead;
    team.sections.forEach((s) => {
      if (s.head && s.head.name === name) hit = hit || s.head;
      s.members.forEach((m) => { if (m.name === name) hit = hit || m; });
    });
    return hit;
  };

  const rudra = find('Rudra Das');
  check('an ordinary person carries their own module',
    rudra && rudra.moduleLabel === 'PP',
    rudra ? rudra.title + ' / ' + rudra.moduleLabel : '(not found)');

  // HE CARRIES HIS MODULE, LIKE EVERYONE ELSE. readTeam used to override
  // this one person's label to the DEPARTMENT, which put "Senior Manager -
  // EAS" at the head of a chart whose other three cards read "Manager - SD",
  // "Manager - PP" and "Manager - FI/CO" - the only card in four that did
  // not answer the question the line exists to answer. Whatever the Module
  // cell says is now what the label says, for him too.
  check('the department head carries his own module, not the department',
    team.lead && team.lead.moduleLabel === team.lead.module &&
    team.lead.moduleLabel === 'MM',
    team.lead ? 'Module cell "' + team.lead.module + '", card says "' +
                team.lead.moduleLabel + '"' : '(no lead)');

  // The same object is reached through three routes - the lead card, the
  // section head and the member list - and all three have to agree, which
  // they only do because readTeam sets it once on the person rather than at
  // each place that draws one.
  const asHead = team.sections.filter((s) => s.head && s.head.name === 'Utpal Biswas')[0];
  check('and says the same thing wherever he appears',
    asHead && asHead.head.moduleLabel === 'MM',
    asHead ? asHead.name + ' head says ' + asHead.head.moduleLabel : '(not a head anywhere)');

  check('a section head keeps their designation as well as their chart role',
    asHead && asHead.head.title === 'Senior Manager' && asHead.interim === true,
    asHead ? asHead.head.title + ', interim ' + asHead.interim : '(none)');

  // -------------------------------------------------------------------------
  // BLOOD GROUP
  // -------------------------------------------------------------------------
  // The column has been in TEAM_COLUMNS since the tab was first laid out -
  // it is the team spreadsheet's own eighth column - and readTeam simply
  // walked past it. It reaches the card now, which is the whole point: the
  // one moment anybody wants this is an accident, and an accident is not
  // when somebody goes looking for the spreadsheet it is filed in.
  //
  // Read BY NAME and not by position. There are sixteen columns and two of
  // them are blank for most people, so an off-by-one here would publish one
  // colleague's blood group under another colleague's name.
  // Heads as well as members: a section head is not in its member list, and
  // the first run of this reported one of them as undefined rather than as
  // a missing blood group - which would have read as a bug in readTeam.
  const everyone = team.sections.reduce(
    (all, s) => all.concat(s.head ? [s.head] : [], s.members),
    team.lead ? [team.lead] : []);
  const bloodOf = (n) => (everyone.filter((p) => p.name === n)[0] || {}).blood;

  check('a blood group is read off the row it belongs to',
    bloodOf('Utpal Biswas') === 'A+' && bloodOf('Sudip Paul') === 'O+' &&
    bloodOf('Md. Abul Masum Siddique') === 'B+',
    'Utpal ' + bloodOf('Utpal Biswas') + ', Sudip ' + bloodOf('Sudip Paul') +
    ', Masum ' + bloodOf('Md. Abul Masum Siddique'));

  check('and an empty cell stays empty rather than borrowing the row below',
    bloodOf('Abul Bashar') === '' && bloodOf('Sadril Ali') === '',
    'Bashar "' + bloodOf('Abul Bashar') + '", Sadril "' +
    bloodOf('Sadril Ali') + '" - both blank in the sheet');
}

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

// ---------------------------------------------------------------------------
// SOMEBODY LEAVING MUST NOT MOVE LAST QUARTER'S FIGURES
// ---------------------------------------------------------------------------
// The obvious way to handle a resignation is to delete the name from
// CONFIG.ROSTER. It clears the organogram and it clears the drift notice,
// and it also drops the person out of rosterIndex() - after which
// sectionFor() falls back to the Department recorded at upload, which is
// the exact thing the roster exists to override. Three people here hold
// MM/MD module roles while reporting into Sales, so their tickets LOOK like
// supply-chain work; a leaver in that position would have every month they
// ever worked silently re-filed under the wrong section, and the only
// symptom would be two totals moving in a period nobody touched.
//
// CONFIG.FORMER is the answer, and these three assertions are the whole
// contract: off the chart, out of the drift notice, still scored.
const gone = Object.keys(CFG.FORMER || {});
check('(fixture check) somebody has actually left, so this tests something',
  gone.length > 0, gone.join(', ') || 'CONFIG.FORMER is empty');

if (gone.length) {
  const leaver = gone[0];
  const theirSection = CFG.FORMER[leaver];

  check('a leaver is off the roster, so the chart and the sheet stop expecting them',
    ctx.rosterNames().indexOf(leaver) === -1 &&
    ctx.rosterOrderFor(theirSection).indexOf(ctx.matchPerson(leaver)) === -1,
    leaver + ' is still on the chart');

  // AND THIS IS THE ONE THAT MATTERS. Tickets they handled still have to
  // land in the section they handled them for.
  check('but their tickets still score to the section they worked in',
    ctx.sectionFor(leaver, '2026-09', 'Supply Chain Applications') === theirSection,
    ctx.sectionFor(leaver, '2026-09', 'Supply Chain Applications') +
    ', expected ' + theirSection);

  // The fallback in that call is deliberately the WRONG section: it is what
  // sectionFor() returns for a name it does not know, so if FORMER were
  // dropped the assertion above would come back with it and say so.
  check('and a name nobody has ever heard of still falls back, as before',
    ctx.sectionFor('Someone Not On Any List', '2026-09',
                   'Supply Chain Applications') === 'Supply Chain Applications',
    'the fallback is unchanged - FORMER adds a name, it does not replace it');
}

// ---------------------------------------------------------------------------
// matching a photograph to the person in it
// ---------------------------------------------------------------------------
// THE FAILURE THIS GUARDS IS SILENT. Thirty-six pictures pasted into
// thirty-six cells by hand is one transposition away from a card carrying
// somebody else's face, and the card beside it carrying theirs, with neither
// mistake visible to whoever made it. So the matching is a pure function and
// it is asked the questions this team's own names actually pose.
//
// The people below are the real shapes: two men whose names differ only in
// the surname and share an honorific, one honorific spelled three ways in
// three places, and one short name that is a substring risk.
const FACES = [
  { name: 'Utpal Biswas', id: '20990021', row: 2 },
  { name: 'Md. Ashraful Islam', id: '20990022', row: 3 },
  { name: 'Md. Ashraful Karim', id: '20990023', row: 4 },
  { name: 'Mohammad Abul Kalam', id: '20990024', row: 5 },
  { name: 'Rudra Das', id: '20990025', row: 6 },
  // A short name, to hold the floor on rule 3 in place. Nobody on the team
  // is called this today; the shortest real name squashes to exactly eight
  // characters, which is close enough to the floor that the first colleague
  // to arrive with a shorter one would quietly stop matching.
  { name: 'Jo Lee', id: '20990026', row: 7 }
];
const who = (file) => {
  const hit = ctx.photoRowFor(file, FACES);
  return hit.ambiguous ? 'AMBIGUOUS' : hit.person ? hit.person.name : '(none)';
};

check('an employee ID in the filename is enough, however it is wrapped',
  who('20990021.jpg') === 'Utpal Biswas' &&
  who('IMG_20990022 (1).png') === 'Md. Ashraful Islam' &&
  who('20990025 - profile.JPEG') === 'Rudra Das',
  'the ID is the one part of a filename that cannot mean two people');

check('and a full name matches without one',
  who('Utpal Biswas.jpg') === 'Utpal Biswas' &&
  who('rudra das.png') === 'Rudra Das',
  who('Utpal Biswas.jpg') + ' / ' + who('rudra das.png'));

// THE ONE THAT WOULD HAVE PUT THE WRONG FACE ON A CARD. These two differ by
// a surname and share an honorific that is spelled four ways in the wild. A
// matcher that collapsed the honorific and stopped there would have them as
// one person - and whichever file came out of Drive second would overwrite
// the first.
check('two colleagues differing only in the surname stay two people',
  who('Md. Ashraful Islam.jpg') === 'Md. Ashraful Islam' &&
  who('Mohammad Ashraful Karim.jpg') === 'Md. Ashraful Karim',
  who('Md. Ashraful Islam.jpg') + ' / ' + who('Mohammad Ashraful Karim.jpg'));

check('and the honorific may be spelled any of its ways',
  who('Mohammad Ashraful Islam.png') === 'Md. Ashraful Islam' &&
  who('MD ASHRAFUL ISLAM.PNG') === 'Md. Ashraful Islam' &&
  who('mohd ashraful islam.jpg') === 'Md. Ashraful Islam',
  'md / md. / mohammad / mohd are one word in this directory');

check('a name inside a longer filename is still found',
  who('Utpal Biswas - EAS - 2026.jpg') === 'Utpal Biswas' &&
  who('EAS Team/Rudra Das (PP).png') === 'Rudra Das',
  who('Utpal Biswas - EAS - 2026.jpg'));

// THE FLOOR ON RULE 3, which is the rule that asks whether a name appears
// anywhere inside a filename. A short key turns up inside words that have
// nothing to do with it, so below six characters that rule does not apply -
// the whole-name rules still do. Unmatched is printed in the log; matched
// to the wrong person is printed on their card.
check('a short name still matches its own file, whole',
  who('Jo Lee.jpg') === 'Jo Lee' && who('20990026.png') === 'Jo Lee',
  who('Jo Lee.jpg') + ' / ' + who('20990026.png'));

check('but is not hunted for inside a longer filename',
  who('workshop jolee group 2026.jpg') === '(none)',
  who('workshop jolee group 2026.jpg') +
  ' - five characters inside a sentence is a coincidence, not a match');

check('and a filename that means nobody matches nobody',
  who('group photo.jpg') === '(none)' && who('IMG_0042.png') === '(none)' &&
  who('Ashraful.jpg') === '(none)',
  'a bare first name two people share is not a match, it is a coin toss');

// A FIFTY-FIFTY GUESS IS NOT WORTH MAKING SILENTLY. Reported, so the import
// skips the file and says which two people it could not choose between.
const twins = [{ name: 'Rudra Das', id: '1', row: 2 },
               { name: 'Rudra Das', id: '2', row: 3 }];
check('a filename that answers to two rows is refused, not guessed',
  ctx.photoRowFor('Rudra Das.jpg', twins).ambiguous !== undefined &&
  ctx.photoRowFor('Rudra Das.jpg', twins).person === undefined,
  JSON.stringify(ctx.photoRowFor('Rudra Das.jpg', twins)));

check('a Drive folder link gives up its id, and a stray string does not',
  ctx.driveFolderId('https://drive.google.com/drive/folders/1aB2cD3eF4gH5iJ6kL7m?usp=sharing') ===
    '1aB2cD3eF4gH5iJ6kL7m' &&
  ctx.driveFolderId('1aB2cD3eF4gH5iJ6kL7m') === '1aB2cD3eF4gH5iJ6kL7m' &&
  ctx.driveFolderId('the photos folder') === '',
  'so a mistyped argument is told rather than treated as an id');

const failed = out.filter((r) => !r).length;
console.log('\n' + (out.length - failed) + '/' + out.length + ' passed');
process.exit(failed ? 1 : 0);
