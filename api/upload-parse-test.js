/**
 * IS THE NEW PARSER THE SAME PARSER?
 *
 *   node upload-parse-test.js
 *
 * api/public/upload-parse.js has to turn a dropped .xlsx into exactly the
 * rows src/App.html turned it into. Not nearly - exactly, cell for cell,
 * including the cells it leaves blank and the dates it overrules.
 *
 * So this suite does not check the port against my idea of what the parser
 * should do. It lifts the REAL functions out of src/App.html, runs them
 * beside the port on thousands of generated files, and compares every cell
 * of every row. The same arrangement as kpi-equivalence-test.js and the
 * roster and module suites, with one difference: those read .gs files, where
 * every function is top level and a vm can simply run the file. App.html's
 * script is one IIFE, so nothing inside it can be reached from outside -
 * the functions are cut out of it by name instead.
 *
 * That cut is deliberately brittle. It asserts that it found every name it
 * went looking for and that each one parses. If App.html is ever reformatted
 * this suite stops with a message saying so, which is the right outcome: the
 * alternative is a suite that quietly extracts nothing and passes.
 *
 * NEEDS NOTHING SWITCHED ON. No database, no server, no browser.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const SRC = process.env.EAS_SRC || path.join(__dirname, '..', 'src');
const parse = require('./public/upload-parse');
const merge = require('./ticket-merge');
const kpi2 = require('./kpi2');

let passed = 0;
let failed = 0;
let comparisons = 0;

function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ok   ' + name); return; }
  failed++;
  console.log('  FAIL ' + name + (detail === undefined ? '' : '   ' + detail));
}


// ===========================================================================
// LIFTING THE ORIGINALS OUT OF App.html
// ===========================================================================

/**
 * One declaration's source text, cut out of the script block.
 *
 * Anchored on indentation, not on brace counting. Everything inside the
 * IIFE sits at two spaces, so a declaration starts at column 2 and ends at
 * the next line that is exactly '  }' or '  ];'. Brace counting would have
 * to understand that the braces in /[A-Za-z .&']{2,40}/ are a repetition
 * count and not a block.
 */
function declarationOf(source, name) {
  const lines = source.split('\n');
  const starts = [
    '  function ' + name + '(',
    '  const ' + name + ' = ',
    '  let ' + name + ' = '
  ];

  let from = -1;
  for (let i = 0; i < lines.length && from === -1; i++) {
    for (let s = 0; s < starts.length; s++) {
      if (lines[i].indexOf(starts[s]) === 0) { from = i; break; }
    }
  }
  if (from === -1) {
    throw new Error('src/App.html no longer declares ' + name +
                    ' at the top level of its script block');
  }

  // A one-line declaration: 'const DETAILS_LIMIT = 300;'
  if (/;\s*$/.test(lines[from]) && lines[from].indexOf('function ') === -1) {
    return lines[from];
  }

  for (let i = from + 1; i < lines.length; i++) {
    if (lines[i] === '  }' || lines[i] === '  ];') {
      return lines.slice(from, i + 1).join('\n');
    }
  }
  throw new Error('could not find where ' + name + ' ends in src/App.html');
}


/*
  THE CONFIGURATION THE ORIGINAL READ OFF state.boot.

  detectModule and detectSection reached into it. The port takes the same
  arrays as arguments, so the comparison is: one reads them from here, the
  other is handed them, and both must answer the same.
*/
const cfgBox = {
  console, Object, String, Number, Array, Math, JSON, RegExp, Date,
  isFinite, Boolean, Error, parseInt, parseFloat
};
cfgBox.globalThis = cfgBox;
vm.createContext(cfgBox);
vm.runInContext(fs.readFileSync(path.join(SRC, 'Config.gs'), 'utf8'), cfgBox);
const CONFIG = vm.runInContext('CONFIG', cfgBox);

const TICKET_COLUMNS = CONFIG.TICKET_COLUMNS;
const TRAINING_COLUMNS = CONFIG.TRAINING_COLUMNS;

/*
  SYNTHETIC TRAINERS, NOT THE REAL ONES.

  CONFIG.TRAINER_MODULES names three colleagues, and this repository is
  public. The real list is still exercised - it is read out of Config.gs
  below and compared without ever being printed - but the fixtures that go
  in the file use invented names, so the suite keeps working the day those
  names are taken out of Config.gs and the test file never carried them.
*/
const FAKE_TRAINERS = [
  { name: 'MM', match: 'qadir' },
  { name: 'PP', match: 'tahmina' },
  { name: 'SD', match: 'o\\.? ?brien' }
];

const NAMES = {
  modules: CONFIG.TRAINING_MODULES,
  trainers: FAKE_TRAINERS,
  sections: CONFIG.DEPARTMENTS
};

const LIFT = [
  'DETAILS_LIMIT',
  'FEEDBACK_DATE_TOLERANCE_DAYS',
  'FEEDBACK_QUESTIONS',
  'isBlank',
  'formatDate',
  'asDate',
  'findFeedbackQuestions',
  'detectReportType',
  'describeFeedbackFile',
  'detectModule',
  'detectSection',
  'feedbackDateParts',
  'feedbackDate',
  'normalizeFeedback',
  'normalizeRows',
  'mergeFiles'
];

const appHtml = fs.readFileSync(path.join(SRC, 'App.html'), 'utf8');

const box = {
  console, Object, String, Number, Array, Math, JSON, RegExp, Date,
  isFinite, Boolean, Error, parseInt, parseFloat,
  /*
    WHAT state.boot HELD.

    The original reads the module patterns, the section patterns and the
    ticket column list off here; the port is handed all three. Leaving
    ticketColumns out of this stub made the original throw "Cannot read
    properties of undefined" while the port answered correctly - which the
    suite caught only because it compares the two sides' ERROR MESSAGES as
    well as their rows. Compare rows alone and a missing stub reads as a
    pass on both sides having "failed the same way".
  */
  state: { boot: { trainingModules: NAMES.modules, trainerModules: NAMES.trainers,
                   departments: NAMES.sections, ticketColumns: TICKET_COLUMNS,
                   trainingColumns: TRAINING_COLUMNS } }
};
box.globalThis = box;
vm.createContext(box);

const lifted = LIFT.map(function (name) {
  const text = declarationOf(appHtml, name);
  vm.runInContext(text, box, { filename: 'App.html:' + name });
  return { name: name, lines: text.split('\n').length };
});

const old = {};
LIFT.forEach(function (name) { old[name] = vm.runInContext(name, box); });

console.log('');
console.log('  Lifted ' + lifted.length + ' declarations out of src/App.html (' +
            lifted.reduce(function (n, d) { return n + d.lines; }, 0) + ' lines)');
console.log('  ' + TICKET_COLUMNS.length + ' ticket columns, ' +
            TRAINING_COLUMNS.length + ' training columns, ' +
            NAMES.modules.length + ' modules, ' + NAMES.sections.length + ' sections');


// ===========================================================================
console.log('');
console.log('  The column lists the browser builds rows in');
// ===========================================================================
/*
  THE PORT HAS TO AGREE WITH THE SERVER, NOT ONLY WITH App.html.

  In the old system the browser got these lists from the bootstrap, so
  client and server could not disagree. In the new one the browser is handed
  them by /api/uploads/boot, which reads them from ticket-merge.js and
  kpi2.js - the same modules the insert statements are built from. If those
  ever drift from Config.gs, the parse would still "work" and file every
  value one column to the left.
*/
check('the ticket column list is identical to Config.gs, in order',
      JSON.stringify(merge.HEADERS) === JSON.stringify(TICKET_COLUMNS),
      merge.HEADERS.length + ' vs ' + TICKET_COLUMNS.length);
check('and the training column list likewise',
      JSON.stringify(kpi2.TRAINING_HEADERS) === JSON.stringify(TRAINING_COLUMNS),
      kpi2.TRAINING_HEADERS.length + ' vs ' + TRAINING_COLUMNS.length);
check('the port caps Details where App.html capped it',
      parse.DETAILS_LIMIT === old.DETAILS_LIMIT,
      parse.DETAILS_LIMIT + ' vs ' + old.DETAILS_LIMIT);
check('and tolerates a typed session date by the same number of days',
      parse.FEEDBACK_DATE_TOLERANCE_DAYS === old.FEEDBACK_DATE_TOLERANCE_DAYS,
      parse.FEEDBACK_DATE_TOLERANCE_DAYS + ' vs ' +
      old.FEEDBACK_DATE_TOLERANCE_DAYS);
check('the seven questions are matched on the same seven phrases, in order',
      JSON.stringify(parse.FEEDBACK_QUESTIONS) ===
      JSON.stringify(old.FEEDBACK_QUESTIONS));


// ===========================================================================
console.log('');
console.log('  isBlank and formatDate');
// ===========================================================================
const BLANKS = ['', ' ', '   ', '\t', '\n', 0, false, null, undefined, 'a', ' a ',
                '0', 'null', NaN, -1, 1.5, [], {}];
let blankSame = true;
BLANKS.forEach(function (v) {
  comparisons++;
  if (parse.isBlank(v) !== old.isBlank(v)) blankSame = false;
});
check('every value is blank, or not, on both sides', blankSame);

let dateSame = true;
for (let y = 1974; y <= 2027; y += 1) {
  for (let m = 0; m < 12; m++) {
    const d = new Date(y, m, (m * 2 + 3) % 28 + 1, (m + 7) % 24, m * 5 % 60, m * 3 % 60);
    comparisons++;
    if (parse.formatDate(d) !== old.formatDate(d)) dateSame = false;
  }
}
check('every date formats identically, over fifty years of them', dateSame);
// Single digits are where a hand-rolled formatter goes wrong.
check('a single-digit month, day, hour, minute and second are all padded',
      parse.formatDate(new Date(2026, 0, 2, 3, 4, 5)) === '2026-01-02 03:04:05',
      parse.formatDate(new Date(2026, 0, 2, 3, 4, 5)));


// ===========================================================================
console.log('');
console.log('  asDate - a cell that may be a Date, a string, or neither');
// ===========================================================================
const CELLS = [
  new Date(2026, 5, 15, 10, 30, 0), new Date(1974, 0, 1),
  '2026-06-15', '2026-06-15 10:30:00', '2026-06-15T10:30:00Z',
  '15/06/2026', '15-06-2026', 'June 15 2026', '2026-6-15', '20260615',
  '', '   ', 'n/a', '-', 0, 46162, 46162.5, null, undefined, true,
  '  2026-06-15  ', '2026-13-45', '9999-12-31'
];
let asDateSame = true;
const asDateDiff = [];
CELLS.forEach(function (v) {
  comparisons++;
  if (parse.asDate(v) !== old.asDate(v)) {
    asDateSame = false;
    asDateDiff.push(String(v));
  }
});
check('every cell reads the same way', asDateSame, asDateDiff.join(', '));
/*
  THE EXCEL SERIAL NUMBER IS THE ONE THAT MATTERS.

  A date cell read without cellDates comes back as 46162, and 46162 is not a
  date - it is the number of days since 1900. asDate refusing it is what
  makes the page's 'cellDates: true' load-bearing rather than decorative: if
  the option is ever dropped, every session date goes blank and KPI 2 goes
  blank with it, instead of every response landing in 1900.
*/
check('AN EXCEL SERIAL NUMBER IS NOT A DATE', parse.asDate(46162) === '');
check('a plain YYYY-MM-DD is', parse.asDate('2026-06-15') === '2026-06-15');
check('and a real Date cell becomes the ITSM\'s own text format',
      parse.asDate(new Date(2026, 5, 15, 10, 30, 0)) === '2026-06-15 10:30:00',
      parse.asDate(new Date(2026, 5, 15, 10, 30, 0)));


// ===========================================================================
console.log('');
console.log('  Reading a filename - module, section, title, trainer');
// ===========================================================================
/*
  REAL FILENAME SHAPES, with no real person in them.

  Every form these have actually taken: the quarter in front, the quarter
  behind, the trainer appended after a dash, an em dash instead, a module
  code that is also a word ('CO' inside 'Accounting'), a combined export
  named after nothing, and the ones that are only a trainer's name.
*/
const FILENAMES = [
  'Trainee Feedback MM Basics - Q.Adir.xlsx',
  'Trainee Feedback_Inventory Management_Qadir.xlsx',
  'Training Feedback - Purchase Requisition - Tahmina.xlsx',
  'Trainee Feedback \u2013 Production Planning \u2013 Tahmina.xlsx',
  'Trainee Feedback \u2014 Export Documentation \u2014 O Brien.xlsx',
  'Q1-2026 Trainee Feedback MM.xlsx',
  'Trainee Feedback Q1#2026 MM.xlsx',
  'TraineeFeedbackMM.xlsx',
  'Trainee Feedback.xlsx',
  'feedback.xlsx',
  'qadir.xlsx',
  'tahmina-session.xlsx',
  'o.brien.xlsx',
  'e-accounting refresher.xlsx',
  'E Accounting Refresher.xlsx',
  'eaccounting.xlsx',
  'FI_TR Month End.xlsx',
  'FI-TR Month End.xlsx',
  'fitr.xlsx',
  'fi tr.xlsx',
  'Accounting Overview.xlsx',
  'Recovery Plan.xlsx',
  'MCD Training.xlsx',
  'YPL Line Setup.xlsx',
  'MD Overview.xlsx',
  'Shipping Instructions SD.xlsx',
  '7-26_Overall KPI-1_ITSM.xlsx',
  '7-26_Manufacturing Applications_ITSM.xlsx',
  '7-26_Sales Applications_ITSM.xlsx',
  '7-26_Supply Chain Applications_ITSM.xlsx',
  '7-26_Financial Applications_ITSM.xlsx',
  /*
    TWO SECTIONS IN ONE NAME. 'sales' is five letters and 'eas' is three, so
    the longer pattern has to win - without the length test the last entry in
    the list wins instead, which is EAS, and a Sales export would be logged
    against the team lead's own section. Mutation testing found this: dropping
    the length test changed no answer in the whole fixture set.
  */
  '7-26_EAS Sales Applications_ITSM.xlsx',
  /*
    AND A NAME WITH NO SECTION IN IT AT ALL, only 'eas' buried inside
    'release'. This is the case the word boundary exists for, and the only
    filename here that distinguishes a bounded match from a substring one -
    'release notes measure eas' has a standalone 'eas' too, so both answers
    agree on it and it proves nothing.
  */
  'release notes.xlsx',
  'release notes measure eas.xlsx',
  'manufacturing.xlsx',
  'MANUFACTURING.XLSX',
  '',
  '.xlsx',
  'a.xlsx',
  'x_y.xlsx',
  'Trainee Feedback_MM_.xlsx',
  'Trainee Feedback__MM.xlsx'
];

/*
  Two sub-lists, chosen by what the name IS rather than by position. These
  were slice(0, 20) and slice(26, 36), and adding two filenames to the list
  above moved the window - which is a silent way to stop testing something.
*/
const FEEDBACK_NAMES = FILENAMES.filter(function (f) {
  return !/_ITSM\.xlsx$/i.test(f);
});
const TICKET_NAMES = FILENAMES.filter(function (f) {
  return /_ITSM\.xlsx$/i.test(f) || /^(manufacturing|release)/i.test(f);
});

let moduleSame = true, sectionSame = true, describeSame = true;
const nameDiff = [];
FILENAMES.forEach(function (f) {
  comparisons += 3;
  if (parse.detectModule(f, NAMES.modules, NAMES.trainers) !== old.detectModule(f)) {
    moduleSame = false; nameDiff.push('module:' + f);
  }
  if (parse.detectSection(f, NAMES.sections) !== old.detectSection(f)) {
    sectionSame = false; nameDiff.push('section:' + f);
  }
  if (JSON.stringify(parse.describeFeedbackFile(f)) !==
      JSON.stringify(old.describeFeedbackFile(f))) {
    describeSame = false; nameDiff.push('describe:' + f);
  }
});
check('the module read out of a filename is the same', moduleSame,
      nameDiff.filter(function (d) { return /^module/.test(d); }).join(' | '));
check('the section read out of a filename is the same', sectionSame,
      nameDiff.filter(function (d) { return /^section/.test(d); }).join(' | '));
check('and the title and trainer are the same', describeSame,
      nameDiff.filter(function (d) { return /^describe/.test(d); }).join(' | '));

/*
  THE REAL TRAINER LIST, COMPARED WITHOUT BEING PRINTED.

  The fixtures above use invented names so this file carries none. But the
  patterns people's files are actually named after are the ones that have to
  work, so they are read out of Config.gs and run through both sides. Only
  the count and whether the two agreed is reported.
*/
const realTrainers = CONFIG.TRAINER_MODULES || [];
box.state.boot.trainerModules = realTrainers;
let realSame = realTrainers.length > 0;
realTrainers.forEach(function (t) {
  const f = 'Trainee Feedback session - ' + String(t.match).replace(/\\\.?/g, '') + '.xlsx';
  comparisons++;
  if (parse.detectModule(f, NAMES.modules, realTrainers) !== old.detectModule(f)) {
    realSame = false;
  }
});
check('the real trainer patterns in Config.gs resolve identically',
      realSame, realTrainers.length + ' patterns');
box.state.boot.trainerModules = NAMES.trainers;

/*
  A PATTERN WITH A REGULAR-EXPRESSION CHARACTER IN IT.

  'o.brien' as a pattern would match 'oxbrien' unescaped. detectModule
  escapes module patterns but NOT trainer patterns - which is the original's
  behaviour, carried over deliberately, because the trainer patterns are
  written as regular expressions on purpose ('o\\.? ?brien' matches
  'obrien', 'o brien' and 'o.brien'). Pinned so that "fixing" it later is a
  decision rather than an accident.
*/
/*
  'exaccounting', not 'exbaccounting'. The pattern is 'e.accounting' and an
  unescaped dot matches exactly ONE character, so the name has to have
  exactly one character where the dot is or the mutation passes anyway -
  which it did, until a mutation run pointed at this line.
*/
check('a module pattern with a dot in it is escaped',
      parse.detectModule('exaccounting.xlsx',
                         [{ name: 'X', match: ['e.accounting'] }], []) === '',
      parse.detectModule('exaccounting.xlsx',
                         [{ name: 'X', match: ['e.accounting'] }], []));
check('and matches the literal text',
      parse.detectModule('e.accounting refresher.xlsx',
                         [{ name: 'X', match: ['e.accounting'] }], []) === 'X');
check('a TRAINER pattern is a regular expression, as it was before',
      parse.detectModule('obrien.xlsx', [], NAMES.trainers) === 'SD' &&
      parse.detectModule('o brien.xlsx', [], NAMES.trainers) === 'SD');


// ===========================================================================
console.log('');
console.log('  Which kind of file is this?');
// ===========================================================================
const Q = [
  'How would you rate the overall training session? [overall]',
  'Was the content relevant and useful for your job?',
  'How would you rate the trainer\'s knowledge and expertise?',
  'Could the trainer explain concepts clearly?',
  'Were the training materials helpful?',
  'Do you feel more confident using the system?',
  'Was the duration and pace appropriate?'
];

const HEADER_SETS = [
  { name: 'a full feedback export',
    headers: ['ID', 'Start time', 'Completion time', 'Email', 'Name',
              'Employee ID', 'Employee Name', 'Plant', 'Zone', 'Module',
              'Date & Time of the session'].concat(Q) },
  { name: 'a feedback export with four of the seven',
    headers: ['ID', 'Completion time'].concat(Q.slice(0, 4)) },
  { name: 'a feedback export with only three',
    headers: ['ID', 'Completion time'].concat(Q.slice(0, 3)) },
  { name: 'an older feedback export with no Zone and no Module',
    headers: ['ID', 'Completion time', 'Employee ID', 'Employee Name',
              'Plant', 'Date & Time'].concat(Q) },
  { name: 'the ITSM overall export',
    headers: ['Ticket ID', 'Request Date', 'Title', 'Details', 'Part',
              'Requestor', 'Department', 'Status', 'Completion Date'] },
  { name: 'the ITSM individual export',
    headers: ['Ticket ID', 'Request Date', 'Title', 'Man*Hour',
              'Delay Days', 'Handled By'] },
  /*
    THE SAME QUESTION ASKED TWICE.

    Real forms grow columns: a question gets reworded and the old column is
    left in place, and both then contain the phrase that identifies it. The
    FIRST one wins, and nothing in this fixture set said so until a mutation
    that took the last one instead passed every check.
  */
  { name: 'a feedback export with a question column twice',
    headers: ['ID', 'Completion time'].concat(Q)
      .concat(['How would you rate the overall training session? (old wording)']) },
  { name: 'a sheet with nothing recognisable in it', headers: ['A', 'B', 'C'] },
  { name: 'an empty header row', headers: [] },
  { name: 'a header row of blanks', headers: ['', '', ''] }
];

let typeSame = true, foundSame = true;
HEADER_SETS.forEach(function (set) {
  comparisons += 2;
  const a = parse.detectReportType(set.headers);
  const b = old.detectReportType(set.headers);
  if (a !== b) { typeSame = false; check('type of ' + set.name, false, a + ' vs ' + b); }
  if (JSON.stringify(parse.findFeedbackQuestions(set.headers)) !==
      JSON.stringify(old.findFeedbackQuestions(set.headers))) foundSame = false;
});
check('every header set is routed to the same pipeline', typeSame);
check('and the same question columns are found in each', foundSame);
check('four of seven questions is enough to be a feedback form',
      parse.detectReportType(HEADER_SETS[1].headers) === 'FEEDBACK');
check('three is not', parse.detectReportType(HEADER_SETS[2].headers) !== 'FEEDBACK');
check('Man*Hour is what makes an ITSM export INDIVIDUAL',
      parse.detectReportType(HEADER_SETS[5].headers) === 'INDIVIDUAL');
check('and without it, OVERALL',
      parse.detectReportType(HEADER_SETS[4].headers) === 'OVERALL');


// ===========================================================================
console.log('');
console.log('  A typed session date against the submission stamp');
// ===========================================================================
/*
  THE EXCEL PROBLEM, which is the single worst thing in this file.

  'Date & Time' is a text box the attendee types into. A session held in
  June 2026 came back as January 1974, June 1984, March 1993 and September
  2003 across the real files, because Excel reads '15/6/26' as a date when
  the sheet is opened and saved. 'Completion time' is stamped by the form
  and cannot be typed wrong.
*/
const DATE_CASES = [];
[['2026-06-15', '2026-06-15'],      // agree
 ['2026-06-15', '2026-06-16'],      // a day out: the typed one stands
 ['2026-06-15', '2026-09-20'],      // 97 days: inside tolerance
 ['2026-06-15', '2026-10-20'],      // 127 days: overruled
 ['1974-01-01', '2026-06-20'],      // the real failure
 ['1984-06-15', '2026-06-20'],
 ['1993-03-01', '2026-06-20'],
 ['2003-09-11', '2026-06-20'],
 ['2027-12-31', '2026-06-20'],      // typed in the FUTURE, also overruled
 ['', '2026-06-20'],                // nothing typed
 ['2026-06-15', ''],                // no submission stamp
 ['', ''],                          // neither
 ['not a date', '2026-06-20'],
 ['2026-06-15', 'not a date']
].forEach(function (pair) {
  DATE_CASES.push({ typed: pair[0], submitted: pair[1] });
});

let partsSame = true;
const partsDiff = [];
DATE_CASES.forEach(function (c) {
  // Every arrangement of which columns the form actually had.
  [{ when: 0, completed: 1 }, { when: 0 }, { completed: 1 }, {}].forEach(function (pos) {
    comparisons++;
    const raw = [c.typed, c.submitted];
    const a = parse.feedbackDateParts(raw, pos);
    const b = old.feedbackDateParts(raw, pos);
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      partsSame = false;
      partsDiff.push(c.typed + '/' + c.submitted);
    }
  });
});
check('every typed-against-submitted pair resolves the same way', partsSame,
      partsDiff.join(', '));

const far = parse.feedbackDateParts(['1984-06-15', '2026-06-20'],
                                    { when: 0, completed: 1 });
check('A SESSION EXCEL DATED TO 1984 IS FILED UNDER THE SUBMISSION DATE',
      far.date === '2026-06-20' && far.corrected === true,
      JSON.stringify(far));
const near = parse.feedbackDateParts(['2026-06-15', '2026-06-16'],
                                      { when: 0, completed: 1 });
check('a date a day out from the submission is believed, and not flagged',
      near.date === '2026-06-15' && near.corrected === false,
      JSON.stringify(near));
const future = parse.feedbackDateParts(['2027-12-31', '2026-06-20'],
                                        { when: 0, completed: 1 });
check('a date typed too far FORWARD is overruled too, not only backward',
      future.date === '2026-06-20' && future.corrected === true,
      JSON.stringify(future));
const edge = parse.feedbackDateParts(['2026-06-15', '2026-10-13'],
                                      { when: 0, completed: 1 });
check('exactly 120 days apart is still believed - the boundary is >, not >=',
      edge.date === '2026-06-15' && edge.corrected === false,
      JSON.stringify(edge));
const over = parse.feedbackDateParts(['2026-06-15', '2026-10-14'],
                                      { when: 0, completed: 1 });
check('and 121 days is not', over.date === '2026-10-14' && over.corrected === true,
      JSON.stringify(over));
const onlyTyped = parse.feedbackDateParts(['2026-06-15', ''],
                                           { when: 0, completed: 1 });
check('with no submission stamp there is nothing to check against, so it stands',
      onlyTyped.date === '2026-06-15' && onlyTyped.corrected === false,
      JSON.stringify(onlyTyped));


// ===========================================================================
console.log('');
console.log('  A whole feedback export, row by row');
// ===========================================================================
/*
  GENERATED, NOT HAND-WRITTEN.

  Hand-written fixtures agree with whatever the code did on the day they
  were written. These are built out of every combination that occurs: each
  header layout, each filename shape, each date pair, answers present and
  absent, an ID column and none.
*/
const ANSWER_SETS = [
  ['Excellent', 'Relevant and useful', 'Excellent', 'Very clear',
   'Very helpful', 'Much more confident', 'Just right'],
  ['Good', 'Relevant', 'Good', 'Clear', 'Helpful', 'More confident', 'Appropriate'],
  ['Average', 'Somewhat relevant', 'Average', 'Somewhat clear',
   'Somewhat helpful', 'Slightly more confident', 'Too long'],
  ['Poor', 'Not relevant', 'Poor', 'Unclear', 'Not helpful',
   'No more confident', 'Too short'],
  ['', '', '', '', '', '', ''],
  ['  Good  ', '', '', '', '', '', ''],
  ['Something nobody put on the form', '', '', '', '', '', ''],
  [null, undefined, 'Good', '', '', '', '']
];

function feedbackFile(layout, fileName, rowSpecs) {
  const headers = layout.headers;
  const at = {};
  headers.forEach(function (h, i) { if (at[h] === undefined) at[h] = i; });

  const rows = rowSpecs.map(function (spec, n) {
    const row = headers.map(function () { return ''; });
    const put = function (name, value) {
      if (at[name] !== undefined) row[at[name]] = value;
    };
    put('ID', spec.id === undefined ? String(n + 1) : spec.id);
    put('Completion time', spec.submitted);
    put('Date & Time of the session', spec.typed);
    put('Date & Time', spec.typed);
    put('Employee ID', spec.empId);
    put('Employee Name', spec.empName);
    put('Plant', spec.plant);
    put('Zone', spec.zone);
    put('Module', spec.module);
    Q.forEach(function (q, i) { put(q, spec.answers[i]); });
    return row;
  });

  return { fileName: fileName, headers: headers, rows: rows };
}

const FEEDBACK_LAYOUTS = HEADER_SETS.filter(function (s) {
  return parse.detectReportType(s.headers) === 'FEEDBACK';
});

/** One layout by its description, so adding a layout cannot renumber these. */
function layout(name) {
  const hit = FEEDBACK_LAYOUTS.filter(function (s) {
    return s.name.indexOf(name) !== -1;
  })[0];
  if (!hit) throw new Error('no feedback layout called "' + name + '"');
  return hit;
}

let feedbackSame = true;
let feedbackRows = 0;
const feedbackDiff = [];

FEEDBACK_LAYOUTS.forEach(function (layout) {
  FEEDBACK_NAMES.forEach(function (fileName) {
    // One file per date case, so single-session and many-session files both
    // occur - the title gets the date appended only in the second kind.
    const specs = [];
    DATE_CASES.forEach(function (c, i) {
      specs.push({
        id: i % 7 === 6 ? undefined : 'R' + (i + 1),
        typed: c.typed, submitted: c.submitted,
        empId: '200000' + (10 + i), empName: 'Person ' + (i + 1),
        plant: i % 2 ? 'KEPZ' : 'Chattogram',
        zone: i % 3 === 0 ? 'KEPZ' : (i % 3 === 1 ? '' : 'DEPZ'),
        module: i % 4 === 0 ? 'MM' : '',
        answers: ANSWER_SETS[i % ANSWER_SETS.length]
      });
    });

    const file = feedbackFile(layout, fileName, specs);

    let a, b, aErr = '', bErr = '';
    try { a = parse.normalizeFeedback(file, TRAINING_COLUMNS, NAMES.modules, NAMES.trainers); }
    catch (e) { aErr = e.message; }
    try { b = old.normalizeFeedback(file, TRAINING_COLUMNS); }
    catch (e) { bErr = e.message; }

    comparisons++;
    if (aErr || bErr) {
      if (aErr !== bErr) {
        feedbackSame = false;
        feedbackDiff.push(fileName + ': "' + aErr + '" vs "' + bErr + '"');
      }
      return;
    }

    if (a.length !== b.length) {
      feedbackSame = false;
      feedbackDiff.push(fileName + ': ' + a.length + ' rows vs ' + b.length);
      return;
    }
    if (a.corrected !== b.corrected || a.moduleFound !== b.moduleFound) {
      feedbackSame = false;
      feedbackDiff.push(fileName + ': corrected ' + a.corrected + '/' + b.corrected +
                        ' moduleFound ' + a.moduleFound + '/' + b.moduleFound);
      return;
    }

    for (let r = 0; r < a.length; r++) {
      feedbackRows++;
      for (let c = 0; c < TRAINING_COLUMNS.length; c++) {
        comparisons++;
        if (a[r][c] !== b[r][c]) {
          feedbackSame = false;
          feedbackDiff.push(fileName + ' row ' + r + ' ' + TRAINING_COLUMNS[c] +
                            ': "' + a[r][c] + '" vs "' + b[r][c] + '"');
          return;
        }
      }
    }
  });
});
check('EVERY FEEDBACK ROW IS IDENTICAL, CELL FOR CELL', feedbackSame,
      feedbackDiff.slice(0, 3).join(' | '));
check('and that was a real number of rows, not an empty loop',
      feedbackRows > 500, feedbackRows + ' rows compared');


// A few of the answers that matter, asserted outright rather than only
// against the original - so a change to BOTH sides still fails.
const sample = parse.normalizeFeedback(
  feedbackFile(layout('a full feedback export'), 'Trainee Feedback MM Basics - Q.Adir.xlsx', [
    { id: '7', typed: '2026-06-15', submitted: '2026-06-16',
      empId: '20000011', empName: 'Person One', plant: 'KEPZ', zone: 'KEPZ',
      module: 'MM', answers: ANSWER_SETS[0] }
  ]), TRAINING_COLUMNS, NAMES.modules, NAMES.trainers);
const atCol = function (name) { return TRAINING_COLUMNS.indexOf(name); };
check('the Response ID is the filename and the form\'s own row id',
      sample[0][atCol('Response ID')] ===
      'Trainee Feedback MM Basics - Q.Adir.xlsx#7',
      sample[0][atCol('Response ID')]);
check('the answers are stored as the words the attendee chose',
      sample[0][atCol('Q1 Overall')] === 'Excellent' &&
      sample[0][atCol('Q6 Confidence')] === 'Much more confident');
check('the month comes off the session date',
      sample[0][atCol('Month')] === '2026-06', sample[0][atCol('Month')]);
check('THE MODULE IS ONLY WHAT THE FORM SAID, never a guess from the filename',
      sample[0][atCol('Module')] === 'MM');

const noModuleCol = parse.normalizeFeedback(
  feedbackFile(layout('an older feedback export'), 'Trainee Feedback MM Basics - Q.Adir.xlsx', [
    { id: '1', typed: '2026-06-15', submitted: '2026-06-16', answers: ANSWER_SETS[0] }
  ]), TRAINING_COLUMNS, NAMES.modules, NAMES.trainers);
check('an older file with no Module column leaves it BLANK, to be resolved later',
      noModuleCol[0][atCol('Module')] === '',
      JSON.stringify(noModuleCol[0][atCol('Module')]));
check('and its Zone is blank for the same reason',
      noModuleCol[0][atCol('Zone')] === '');
check('the Source File is always written, so a response can find its file',
      noModuleCol[0][atCol('Source File')] ===
      'Trainee Feedback MM Basics - Q.Adir.xlsx');

const blankAnswers = parse.normalizeFeedback(
  feedbackFile(layout('a full feedback export'), 'x.xlsx', [
    { id: '1', typed: '2026-06-15', submitted: '2026-06-15', answers: ANSWER_SETS[4] },
    { id: '2', typed: '2026-06-15', submitted: '2026-06-15', answers: ANSWER_SETS[0] }
  ]), TRAINING_COLUMNS, NAMES.modules, NAMES.trainers);
check('A RESPONDENT WHO ANSWERED NOTHING IS NOT A RESPONDENT',
      blankAnswers.length === 1, String(blankAnswers.length));

const twoDays = parse.normalizeFeedback(
  feedbackFile(layout('a full feedback export'), 'Trainee Feedback MM Basics - Q.Adir.xlsx', [
    { id: '1', typed: '2026-06-15', submitted: '2026-06-15', answers: ANSWER_SETS[0] },
    { id: '2', typed: '2026-06-18', submitted: '2026-06-18', answers: ANSWER_SETS[1] }
  ]), TRAINING_COLUMNS, NAMES.modules, NAMES.trainers);
check('A FILE HOLDING TWO SESSIONS GETS THE DATE APPENDED TO EACH TITLE',
      twoDays[0][atCol('Session Title')] === 'MM Basics \u00b7 2026-06-15' &&
      twoDays[1][atCol('Session Title')] === 'MM Basics \u00b7 2026-06-18',
      twoDays[0][atCol('Session Title')]);
const oneDay = parse.normalizeFeedback(
  feedbackFile(layout('a full feedback export'), 'Trainee Feedback MM Basics - Q.Adir.xlsx', [
    { id: '1', typed: '2026-06-15', submitted: '2026-06-15', answers: ANSWER_SETS[0] },
    { id: '2', typed: '2026-06-15', submitted: '2026-06-15', answers: ANSWER_SETS[1] }
  ]), TRAINING_COLUMNS, NAMES.modules, NAMES.trainers);
check('a one-session file keeps its plain title, so re-uploading it changes nothing',
      oneDay[0][atCol('Session Title')] === 'MM Basics',
      oneDay[0][atCol('Session Title')]);

let threw = '';
try {
  parse.normalizeFeedback({ fileName: 'thin.xlsx',
                            headers: ['ID'].concat(Q.slice(0, 3)), rows: [] },
                          TRAINING_COLUMNS, NAMES.modules, NAMES.trainers);
} catch (e) { threw = e.message; }
check('a file with only three questions recognised is refused, and says so',
      /only 3 of the 7 questions were recognised/.test(threw), threw);


// ===========================================================================
console.log('');
console.log('  A whole ITSM export, row by row');
// ===========================================================================
const TICKET_HEADER_SETS = [
  ['Ticket ID', 'Request Date', 'Title', 'Details', 'Part', 'Requestor',
   'Department', 'Status', 'Completion Date', 'Delay Days'],
  ['Ticket ID', 'Request Date', 'Title', 'Man*Hour', 'Delay Days',
   'Handled By', 'Part', 'Status'],
  // Columns in a different order, which is the whole reason the parse maps
  // by name. And a column the TICKET sheet does not have.
  ['Status', 'Part', 'Ticket ID', 'Details', 'Request Date', 'Nothing We Keep'],
  ['Ticket ID'],
  ['Request Date', 'Title'],                      // no Ticket ID at all
  /*
    THE SAME COLUMN TWICE, which the ITSM has been seen to do when a report
    is edited. The FIRST one wins. Without a header set like this, taking the
    last one instead changed no answer anywhere.
  */
  ['Ticket ID', 'Part', 'Request Date', 'Part', 'Status', 'Details']
];

const LONG = 'x'.repeat(500);
const TICKET_ROW_SHAPES = [
  { id: 'T1001', date: '2026-07-01 09:15:00', title: 'Cannot post invoice',
    details: 'short', part: 'MM', status: 'Completed', delay: 0 },
  { id: 'T1002', date: new Date(2026, 6, 2, 14, 30, 0), title: 'Price list',
    details: LONG, part: 'SD', status: 'Pending', delay: 3 },
  { id: ' T1003 ', date: '', title: '', details: '', part: '', status: '', delay: '' },
  { id: '', date: '2026-07-04', title: 'no id', details: '', part: 'PP',
    status: 'Completed', delay: 1 },
  { id: '   ', date: '2026-07-05', title: 'blank id', details: '', part: '',
    status: '', delay: '' },
  { id: 1006, date: 46205, title: 0, details: null, part: undefined,
    status: false, delay: 2.5 },
  { id: 'T1007', date: ' ', title: ' ', details: ' ', part: ' ', status: ' ', delay: ' ' },
  { id: 'T1008', date: '2026-07-08', title: 'quote "this" & <that>',
    details: 'a | b', part: 'FI', status: 'Completed', delay: 0 }
];

function ticketFile(headers, fileName, shapes) {
  const at = {};
  headers.forEach(function (h, i) { if (at[h] === undefined) at[h] = i; });
  const rows = shapes.map(function (s) {
    const row = headers.map(function () { return ''; });
    const put = function (name, value) {
      if (at[name] !== undefined) row[at[name]] = value;
    };
    put('Ticket ID', s.id);
    put('Request Date', s.date);
    put('Title', s.title);
    put('Details', s.details);
    put('Part', s.part);
    put('Status', s.status);
    put('Delay Days', s.delay);
    put('Completion Date', s.status === 'Completed' ? s.date : '');
    put('Requestor', 'Requestor ' + s.id);
    put('Handled By', 'Engineer ' + s.id);
    put('Man*Hour', s.delay);
    put('Nothing We Keep', 'ignore me');
    return row;
  });
  return { fileName: fileName, headers: headers, rows: rows };
}

let ticketSame = true;
let ticketRows = 0;
const ticketDiff = [];

TICKET_HEADER_SETS.forEach(function (headers) {
  ['OVERALL', 'INDIVIDUAL'].forEach(function (type) {
    TICKET_NAMES.forEach(function (fileName) {
      const section = type === 'INDIVIDUAL'
        ? parse.detectSection(fileName, NAMES.sections) : '';
      const file = ticketFile(headers, fileName, TICKET_ROW_SHAPES);

      let a, b, aErr = '', bErr = '';
      try { a = parse.normalizeRows(file, type, section, TICKET_COLUMNS); }
      catch (e) { aErr = e.message; }
      try { b = old.normalizeRows(file, type, section); }
      catch (e) { bErr = e.message; }

      comparisons++;
      if (aErr || bErr) {
        if (aErr !== bErr) {
          ticketSame = false;
          ticketDiff.push(fileName + ': "' + aErr + '" vs "' + bErr + '"');
        }
        return;
      }

      if (a.length !== b.length) {
        ticketSame = false;
        ticketDiff.push(fileName + ': ' + a.length + ' vs ' + b.length + ' rows');
        return;
      }

      for (let r = 0; r < a.length; r++) {
        ticketRows++;
        for (let c = 0; c < TICKET_COLUMNS.length; c++) {
          comparisons++;
          if (a[r][c] !== b[r][c]) {
            ticketSame = false;
            ticketDiff.push(fileName + ' ' + type + ' row ' + r + ' ' +
                            TICKET_COLUMNS[c] + ': "' + a[r][c] + '" vs "' + b[r][c] + '"');
            return;
          }
        }
      }
    });
  });
});
check('EVERY TICKET ROW IS IDENTICAL, CELL FOR CELL', ticketSame,
      ticketDiff.slice(0, 3).join(' | '));
check('and that was a real number of rows too', ticketRows > 300,
      ticketRows + ' rows compared');

const tFile = ticketFile(TICKET_HEADER_SETS[0], '7-26_Overall KPI-1_ITSM.xlsx',
                         TICKET_ROW_SHAPES);
const tAt = function (name) { return TICKET_COLUMNS.indexOf(name); };
const overall = parse.normalizeRows(tFile, 'OVERALL', '', TICKET_COLUMNS);
check('a row with no Ticket ID is dropped, and one with a blank one too',
      overall.length === TICKET_ROW_SHAPES.length - 2, String(overall.length));
check('an OVERALL export sets In Overall Report and not In Dept Report',
      overall[0][tAt('In Overall Report')] === true &&
      overall[0][tAt('In Dept Report')] === false);
check('and carries no Department, whatever the filename said',
      overall[0][tAt('Department')] === '');
/*
  AND NOT EVEN IF IT IS HANDED ONE.

  normalizeRows is always called with '' for an overall export, so the guard
  that blanks the Department for OVERALL looks like it cannot matter - and a
  mutation removing it survived every other check here for exactly that
  reason. It matters the day somebody calls this with a section in hand,
  because an overall export covers all four sections and labelling its
  tickets with one would hand a quarter of the company's work to the wrong
  team. Asserted directly, since the fixture set cannot reach it.
*/
const forced = parse.normalizeRows(tFile, 'OVERALL', 'Sales Applications',
                                   TICKET_COLUMNS);
check('AN OVERALL EXPORT HAS NO SECTION EVEN WHEN ONE IS PASSED IN',
      forced[0][tAt('Department')] === '',
      JSON.stringify(forced[0][tAt('Department')]));
check('and it is still an overall export, not a section one',
      forced[0][tAt('In Overall Report')] === true &&
      forced[0][tAt('In Dept Report')] === false);
check('the Source Files cell is this file\'s own name',
      overall[0][tAt('Source Files')] === '7-26_Overall KPI-1_ITSM.xlsx');
check('Last Updated is left for the server to stamp',
      overall[0][tAt('Last Updated')] === '');
check('A DETAILS CELL OF 500 CHARACTERS IS CUT TO 300 AND MARKED',
      overall[1][tAt('Details')].length === 301 &&
      overall[1][tAt('Details')].slice(-1) === '\u2026',
      String(overall[1][tAt('Details')].length));
check('a Date cell becomes the ITSM\'s own text format',
      overall[1][tAt('Request Date')] === '2026-07-02 14:30:00',
      String(overall[1][tAt('Request Date')]));
check('a number stays a number, so the server can read it as one',
      overall[0][tAt('Delay Days')] === 0 &&
      typeof overall[0][tAt('Delay Days')] === 'number',
      typeof overall[0][tAt('Delay Days')]);
check('a column the export does not have is blank, not undefined',
      overall[0][tAt('Zone')] === '' ||
      TICKET_COLUMNS.indexOf('Zone') === -1);

const individual = parse.normalizeRows(
  ticketFile(TICKET_HEADER_SETS[1], '7-26_Manufacturing Applications_ITSM.xlsx',
             TICKET_ROW_SHAPES),
  'INDIVIDUAL', 'Manufacturing Applications', TICKET_COLUMNS);
check('an INDIVIDUAL export sets In Dept Report and carries its section',
      individual[0][tAt('In Dept Report')] === true &&
      individual[0][tAt('In Overall Report')] === false &&
      individual[0][tAt('Department')] === 'Manufacturing Applications');

let noId = '';
try {
  parse.normalizeRows(ticketFile(TICKET_HEADER_SETS[4], 'x.xlsx', TICKET_ROW_SHAPES),
                      'OVERALL', '', TICKET_COLUMNS);
} catch (e) { noId = e.message; }
check('a sheet with no Ticket ID column is refused by name',
      /has no "Ticket ID" column/.test(noId), noId);


// ===========================================================================
console.log('');
console.log('  Merging the dropped files against each other');
// ===========================================================================
let mergeSame = true;
const mergeDiff = [];

// Every pairing of the two kinds, in both orders - a merge that depends on
// which file was read first is a merge that depends on the drop order.
const MERGE_CASES = [];
['OVERALL', 'INDIVIDUAL'].forEach(function (t1) {
  ['OVERALL', 'INDIVIDUAL'].forEach(function (t2) {
    MERGE_CASES.push([t1, t2]);
    MERGE_CASES.push([t2, t1]);
  });
});

MERGE_CASES.forEach(function (pair) {
  TICKET_HEADER_SETS.slice(0, 3).forEach(function (headers) {
    const perFile = pair.map(function (type, i) {
      const fileName = (i === 0 ? '7-26_Overall KPI-1_ITSM.xlsx'
                                : '7-26_Sales Applications_ITSM.xlsx');
      const section = type === 'INDIVIDUAL'
        ? parse.detectSection(fileName, NAMES.sections) : '';
      // The second file describes the SAME tickets from the other angle:
      // some cells filled where the first left them blank.
      const shapes = TICKET_ROW_SHAPES.map(function (s, n) {
        if (i === 0) return s;
        return { id: s.id, date: s.date || '2026-07-09',
                 title: s.title || 'filled in by the section export',
                 details: s.details || 'also filled in', part: s.part || 'MM',
                 status: s.status || 'Completed', delay: s.delay === '' ? 4 : s.delay };
      });
      try {
        return parse.normalizeRows(ticketFile(headers, fileName, shapes),
                                   type, section, TICKET_COLUMNS);
      } catch (e) { return []; }
    });

    comparisons++;
    const a = parse.mergeFiles(perFile, TICKET_COLUMNS);
    const b = old.mergeFiles(perFile.map(function (rows) {
      return rows.map(function (r) { return r.slice(); });
    }), TICKET_COLUMNS);

    if (a.length !== b.length) {
      mergeSame = false;
      mergeDiff.push(pair.join('+') + ': ' + a.length + ' vs ' + b.length);
      return;
    }
    for (let r = 0; r < a.length; r++) {
      for (let c = 0; c < TICKET_COLUMNS.length; c++) {
        comparisons++;
        if (a[r][c] !== b[r][c]) {
          mergeSame = false;
          mergeDiff.push(pair.join('+') + ' row ' + r + ' ' + TICKET_COLUMNS[c] +
                         ': "' + a[r][c] + '" vs "' + b[r][c] + '"');
          return;
        }
      }
    }
  });
});
check('EVERY MERGE IS IDENTICAL', mergeSame, mergeDiff.slice(0, 3).join(' | '));

/*
  AND THE MERGE HAS TO MEAN THE SAME THING THE SERVER'S DOES.

  The browser merges the dropped files against each other; ticket-merge.js
  merges what arrives against what is stored. Two implementations of one
  rule. These assert the three rules both have to follow, on the browser
  side - the server side is asserted in uploads-test.js against a real
  database, and the two sets of assertions say the same sentences.
*/
const bothReports = parse.mergeFiles([
  parse.normalizeRows(ticketFile(TICKET_HEADER_SETS[0], 'overall.xlsx',
    [{ id: 'T1', date: '2026-07-01', title: 'from overall', details: '',
       part: 'MM', status: 'Completed', delay: 0 }]),
    'OVERALL', '', TICKET_COLUMNS),
  parse.normalizeRows(ticketFile(TICKET_HEADER_SETS[1], 'sales.xlsx',
    [{ id: 'T1', date: '2026-07-01', title: 'from the section export',
       details: '', part: 'MM', status: 'Completed', delay: 5 }]),
    'INDIVIDUAL', 'Sales Applications', TICKET_COLUMNS)
], TICKET_COLUMNS);
check('one ticket in both exports becomes ONE row',
      bothReports.length === 1, String(bothReports.length));
check('and it counts in both reports - the flags are OR\'d, never replaced',
      bothReports[0][tAt('In Overall Report')] === true &&
      bothReports[0][tAt('In Dept Report')] === true);
check('both filenames are kept, in the order they were read',
      bothReports[0][tAt('Source Files')] === 'overall.xlsx | sales.xlsx',
      bothReports[0][tAt('Source Files')]);
check('the section export is believed about which section owns it',
      bothReports[0][tAt('Department')] === 'Sales Applications',
      bothReports[0][tAt('Department')]);
check('and the first file\'s title stands, because it was not blank',
      bothReports[0][tAt('Title')] === 'from overall',
      bothReports[0][tAt('Title')]);

const spaceWins = parse.mergeFiles([
  parse.normalizeRows(ticketFile(TICKET_HEADER_SETS[0], 'a.xlsx',
    [{ id: 'T1', date: '2026-07-01', title: ' ', details: '', part: '',
       status: 'Completed', delay: 0 }]), 'OVERALL', '', TICKET_COLUMNS),
  parse.normalizeRows(ticketFile(TICKET_HEADER_SETS[0], 'b.xlsx',
    [{ id: 'T1', date: '2026-07-01', title: 'the real title', details: '',
       part: '', status: 'Completed', delay: 0 }]), 'OVERALL', '', TICKET_COLUMNS)
], TICKET_COLUMNS);
check('A CELL HOLDING ONE SPACE IS BLANK, so the real value replaces it',
      spaceWins[0][tAt('Title')] === 'the real title',
      JSON.stringify(spaceWins[0][tAt('Title')]));

/*
  TWO MUTATIONS OF mergeFiles CANNOT BE CAUGHT, and both are facts about the
  ORIGINAL rather than gaps in this suite. Recorded with the assertions that
  make them true, so that if either stops being true the suite says so.

  1. TAKING THE REPORT FLAGS OUT OF THE SKIP LIST changes nothing. The
     generic rule is "fill a blank cell from a non-blank one", and isBlank
     stringifies - so String(false) is 'false', which is not blank. The loop
     can therefore never touch a boolean, and the explicit OR afterwards is
     what merges them either way. The skip list is still right: it says the
     flags are not ordinary cells, and the day isBlank learns about booleans
     is the day the loop would start erasing a true with a false.

  2. THE EXPLICIT 'the section export is authoritative' BLOCK IS REDUNDANT.
     Department is NOT in the skip list, so the generic loop has already
     filled it from the section export by the time that block runs, under
     the identical condition. It is kept because it is in the original and
     because it states the intent in words - but it is not load-bearing.
*/
check('a boolean is never blank, which is why the flags cannot be merged ' +
      'by the generic rule',
      parse.isBlank(true) === false && parse.isBlank(false) === false);
check('and Department is not in the skip list, which is why its own block ' +
      'is redundant',
      [TICKET_COLUMNS.indexOf('In Overall Report'),
       TICKET_COLUMNS.indexOf('In Dept Report'),
       TICKET_COLUMNS.indexOf('Source Files')]
        .indexOf(TICKET_COLUMNS.indexOf('Department')) === -1);

const sameFileTwice = parse.mergeFiles([
  parse.normalizeRows(ticketFile(TICKET_HEADER_SETS[0], 'a.xlsx',
    [{ id: 'T1', date: '2026-07-01', title: 'x', details: '', part: '',
       status: 'Completed', delay: 0 }]), 'OVERALL', '', TICKET_COLUMNS),
  parse.normalizeRows(ticketFile(TICKET_HEADER_SETS[0], 'a.xlsx',
    [{ id: 'T1', date: '2026-07-01', title: 'x', details: '', part: '',
       status: 'Completed', delay: 0 }]), 'OVERALL', '', TICKET_COLUMNS)
], TICKET_COLUMNS);
check('and one file dropped twice is listed once',
      sameFileTwice[0][tAt('Source Files')] === 'a.xlsx',
      sameFileTwice[0][tAt('Source Files')]);


// ===========================================================================
console.log('');
console.log('  gridToFile - what the page hands over');
// ===========================================================================
const grid = [
  ['  Ticket ID  ', 'Request Date', null, 'Details'],
  ['T1', '2026-07-01', 'x', 'y'],
  ['T2', '2026-07-02', 'x', 'y']
];
const built = parse.gridToFile('a.xlsx', grid);
check('the header row is trimmed', built.headers[0] === 'Ticket ID',
      JSON.stringify(built.headers[0]));
check('a null heading becomes an empty string, not the word null',
      built.headers[2] === '', JSON.stringify(built.headers[2]));
check('the rows are everything after the header row', built.rows.length === 2);
check('and the filename comes through', built.fileName === 'a.xlsx');
let emptyGrid = '';
try { parse.gridToFile('empty.xlsx', []); } catch (e) { emptyGrid = e.message; }
check('an empty sheet is refused by name',
      emptyGrid === 'empty.xlsx looks empty', emptyGrid);


// ===========================================================================
console.log('');
console.log('  ' + comparisons.toLocaleString('en-US') + ' comparisons');
console.log('  ' + passed + ' passed, ' + failed + ' failed');
console.log('');
process.exit(failed ? 1 : 0);
