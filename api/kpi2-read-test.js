/**
 * kpi2-read-test.js - KPI 2 off the table, not off a fixture in the head.
 * ===========================================================================
 *
 *     cd api
 *     node kpi2-read-test.js
 *
 * NEEDS THE DATABASE, NOT THE SERVER.
 *
 *
 * WHAT THIS TESTS THAT THE EQUIVALENCE SUITE DOES NOT
 *
 * kpi2-equivalence-test.js proves the arithmetic and the attribution match
 * the original over 27,991 comparisons. None of that touches a database. The
 * bucketing does: which rows are in scope, which bucket they land in, what
 * order the buckets come back in, and which of them exist at all when
 * nothing landed in them.
 *
 * Three of those are silent when wrong:
 *
 *   SCOPE BY QUARTER is answered by the quarter each response RESOLVES to,
 *   not by its month. Get that wrong and a file named Q1-2026, whose dates a
 *   spreadsheet turned into 1974, drops out of Q1 entirely - and the table
 *   still adds up.
 *
 *   ZONES ARE SEEDED, not discovered. A zone with no training must stay on
 *   the table showing zero, because "KEPZ ran nothing this quarter" is a
 *   finding and a row that vanishes hides it.
 *
 *   QUARTERS SORT BY TIME, never by size. A trend sorted by volume is not a
 *   trend.
 *
 *
 * EVERY RESPONSE IT WRITES STARTS 'TEST-K2-' and every file it names starts
 * 'TEST-K2-'. Both are swept at the start of a run as well as at the end.
 * The months are in 2099, the reserved year, so a test row can never be the
 * newest real period on a picker.
 *
 * NO REAL NAMES. The trainer fallbacks it needs are invented and inserted
 * into trainer_module for the length of the test, then removed.
 */

require('dotenv').config();

const db = require('./db');
const kpi2 = require('./kpi2');
const read = require('./kpi2-read');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '   ' + detail : '')); }
}

const POS = 'Excellent';
const AVG = 'Average';
const BAD = 'Poor';
const NONE = 'No response';

/** One response row, in the shape scoreResponses reads. */
function row(o) {
  const answers = o.answers || [POS, POS, POS, POS, POS, POS, POS];
  return {
    response_id: o.id,
    month: o.month === undefined ? '' : o.month,
    session_month: o.sessionMonth === undefined ? '' : o.sessionMonth,
    module: o.module === undefined ? '' : o.module,
    session_title: o.title === undefined ? '' : o.title,
    trainer: o.trainer === undefined ? '' : o.trainer,
    plant: o.plant === undefined ? '' : o.plant,
    zone: o.zone === undefined ? '' : o.zone,
    source_file: o.file === undefined ? '' : o.file,
    q1_overall: answers[0], q2_relevance: answers[1], q3_knowledge: answers[2],
    q4_explanation: answers[3], q5_materials: answers[4],
    q6_confidence: answers[5], q7_duration: answers[6]
  };
}


async function main() {
  console.log('');

  // =======================================================================
  console.log('  Scope - which responses are counted');
  // =======================================================================
  const spread = [
    row({ id: 'a', month: '2099-01', file: 'TEST-K2-mm Q1-2099.xlsx' }),
    row({ id: 'b', month: '2099-02', file: 'TEST-K2-mm Q1-2099.xlsx' }),
    row({ id: 'c', month: '2099-05', file: 'TEST-K2-sd Q2-2099.xlsx' }),
    row({ id: 'd', month: '2099-08', file: 'TEST-K2-pp Q3-2099.xlsx' })
  ];

  check('ALL counts every response',
        read.scoreResponses(spread, { scope: 'ALL' }).total.respondents === 4);
  check('one month counts only that month',
        read.scoreResponses(spread, { scope: '2099-02' }).total.respondents === 1);
  check('a list of months counts all of them',
        read.scoreResponses(spread, { scope: '2099-01,2099-08' })
            .total.respondents === 2);
  check('a quarter counts the responses that resolve to it',
        read.scoreResponses(spread, { scope: '2099-Q1' }).total.respondents === 2);
  check('a period with nothing in it has no data, and does not throw',
        read.scoreResponses(spread, { scope: '2099-12' }).hasData === false);
  check('and reports zero months covered',
        read.scoreResponses(spread, { scope: '2099-12' }).monthsCovered === 0);
  check('no rows at all is the same answer',
        read.scoreResponses([], { scope: 'ALL' }).hasData === false);

  /*
    THE CASE THE QUARTER RULE EXISTS FOR. A file named Q1-2099 whose session
    dates a spreadsheet mangled into 1974. Asking for 2099-Q1 must find it;
    asking by month cannot.
  */
  const mangled = [
    row({ id: 'm1', month: '1974-01', file: 'TEST-K2-mm Q1-2099.xlsx' }),
    row({ id: 'm2', month: '2099-01', file: 'TEST-K2-sd.xlsx' })
  ];
  check('A FILE NAMED Q1-2099 IS IN Q1 2099 EVEN WITH 1974 DATES',
        read.scoreResponses(mangled, { scope: '2099-Q1' }).total.respondents === 2,
        String(read.scoreResponses(mangled, { scope: '2099-Q1' }).total.respondents));
  check('and asking for its mangled month still finds it by month',
        read.scoreResponses(mangled, { scope: '1974-01' }).total.respondents === 1);

  check('the month comes from the session date when the column is blank',
        read.scoreResponses([row({ id: 's', sessionMonth: '2099-03',
                                   file: 'TEST-K2-x.xlsx' })],
                            { scope: '2099-03' }).total.respondents === 1);
  check('and the Month column wins when both are there',
        read.scoreResponses([row({ id: 's', month: '2099-04',
                                   sessionMonth: '2099-03',
                                   file: 'TEST-K2-x.xlsx' })],
                            { scope: '2099-04' }).total.respondents === 1);

  check('a row with no response id is not counted',
        read.scoreResponses([row({ id: '   ', month: '2099-01' })],
                            { scope: 'ALL' }).hasData === false);


  // =======================================================================
  console.log('');
  console.log('  The buckets');
  // =======================================================================
  const mixed = [
    row({ id: '1', month: '2099-01', file: 'TEST-K2-mm.xlsx', title: 'MM Basics',
          trainer: 'T One', zone: 'KEPZ' }),
    row({ id: '2', month: '2099-01', file: 'TEST-K2-mm.xlsx', title: 'MM Basics',
          trainer: 'T One', zone: 'KEPZ',
          answers: [AVG, POS, POS, POS, POS, POS, POS] }),
    row({ id: '3', month: '2099-01', file: 'TEST-K2-sd.xlsx', title: 'SD Intro',
          trainer: 'T Two', zone: 'CEPZ',
          answers: [BAD, NONE, POS, POS, POS, POS, 'Brilliant'] }),
    row({ id: '4', month: '2099-01', file: 'TEST-K2-unknownfile.xlsx',
          title: '', trainer: '', zone: '' })
  ];
  const k = read.scoreResponses(mixed, { scope: 'ALL' });

  check('there is data', k.hasData === true);
  check('four respondents', k.total.respondents === 4);
  check('twenty-eight answers, seven each', k.total.responses === 28);
  check('the target and floor travel with the figures',
        k.target === kpi2.KPI_FEEDBACK.target &&
        k.yellowFloor === kpi2.KPI_FEEDBACK.yellowFloor);

  const moduleNames = k.modules.map(function (m) { return m.name; });
  check('MM and SD were read off the filenames',
        moduleNames.indexOf('MM') !== -1 && moduleNames.indexOf('SD') !== -1,
        moduleNames.join(', '));
  check('a file naming no module pools into (unassigned)',
        moduleNames.indexOf(read.UNASSIGNED) !== -1, moduleNames.join(', '));
  /*
    BUSIEST FIRST, PROVED AGAINST INSERTION ORDER. In `mixed` above, MM
    happens to be both first seen and largest, so the sort does no work and
    removing it changed nothing - mutation testing said so. Here the small
    module is seen first, so only a sort can put the big one at the top.
  */
  const lopsided = read.scoreResponses([
    row({ id: 'L1', month: '2099-01', file: 'TEST-K2-sd.xlsx' }),
    row({ id: 'L2', month: '2099-01', file: 'TEST-K2-mm.xlsx' }),
    row({ id: 'L3', month: '2099-01', file: 'TEST-K2-mm.xlsx' }),
    row({ id: 'L4', month: '2099-01', file: 'TEST-K2-mm.xlsx' })
  ], { scope: 'ALL' });
  check('BUSIEST MODULE FIRST, EVEN WHEN A SMALLER ONE WAS SEEN FIRST',
        lopsided.modules[0].name === 'MM' && lopsided.modules[0].respondents === 3,
        lopsided.modules.map(function (m) {
          return m.name + '=' + m.respondents;
        }).join(', '));
  check('and the same for sessions and trainers',
        read.scoreResponses([
          row({ id: 'S1', month: '2099-01', file: 'TEST-K2-mm.xlsx',
                title: 'Small', trainer: 'T Small' }),
          row({ id: 'S2', month: '2099-01', file: 'TEST-K2-mm.xlsx',
                title: 'Big', trainer: 'T Big' }),
          row({ id: 'S3', month: '2099-01', file: 'TEST-K2-mm.xlsx',
                title: 'Big', trainer: 'T Big' })
        ], { scope: 'ALL' }).sessions[0].name === 'Big');

  /*
    "(unassigned) answers no question at all unless you can see which files
     went into it."
  */
  check('and the file that caused it is named',
        k.unassignedFiles.length === 1 &&
        k.unassignedFiles[0].fileName === 'TEST-K2-unknownfile.xlsx',
        JSON.stringify(k.unassignedFiles));
  check('with how many responses came from it',
        k.unassignedFiles[0].respondents === 1);

  check('sessions are grouped by title', k.sessions.length === 3);
  check('an untitled session is named, not dropped',
        k.sessions.some(function (s) { return s.name === '(untitled session)'; }));
  check('an unnamed trainer likewise',
        k.trainers.some(function (t) { return t.name === '(unnamed)'; }));

  check('the seven questions come back in form order',
        k.questions.length === 7 &&
        k.questions[0].name === kpi2.QUESTION_LABELS[0] &&
        k.questions[6].name === kpi2.QUESTION_LABELS[6]);
  check('and each counts one answer per respondent',
        k.questions.every(function (q) { return q.respondents === 4; }));

  /*
    An answer nobody anticipated counts in the denominator, never in the
    numerator, and is SURFACED. "A new form wording that silently counted as
    positive would move the KPI without anyone noticing."
  */
  check('AN UNRECOGNISED ANSWER IS REPORTED, NOT SWALLOWED',
        k.unknownAnswers.length === 1 &&
        k.unknownAnswers[0].answer === 'Brilliant', JSON.stringify(k.unknownAnswers));
  check('and it counted against the rate rather than for it',
        k.total.unknown === 1 && k.total.positive === 24,
        k.total.positive + ' positive, ' + k.total.unknown + ' unknown');


  // =======================================================================
  console.log('');
  console.log('  Zones are seeded, not discovered');
  // =======================================================================
  check('all three zones are on the table',
        k.zones.length >= 3, String(k.zones.length));
  check('in their configured order, not by size',
        k.zones[0].name === kpi2.ZONES[0].name &&
        k.zones[1].name === kpi2.ZONES[1].name &&
        k.zones[2].name === kpi2.ZONES[2].name,
        k.zones.map(function (z) { return z.name; }).join(', '));
  /*
    "KEPZ ran nothing this month is a finding, and a row that vanishes hides
     it."
  */
  const depz = k.zones.filter(function (z) { return z.name === 'DEPZ'; })[0];
  check('A ZONE WITH NO TRAINING STAYS ON THE TABLE SHOWING ZERO',
        depz && depz.respondents === 0 && depz.band === 'NO DATA',
        depz ? depz.band : 'missing');
  check('Unspecified is added only because something landed there',
        k.zones.some(function (z) { return z.name === kpi2.ZONE_UNSPECIFIED; }));
  check('and is last, after the three known places',
        k.zones[k.zones.length - 1].name === kpi2.ZONE_UNSPECIFIED);
  check('each zone reports how many sessions it ran',
        k.zones[0].sessions === 1, String(k.zones[0].sessions));

  const noUnspecified = read.scoreResponses(
    [row({ id: 'z', month: '2099-01', file: 'TEST-K2-mm.xlsx', zone: 'KEPZ' })],
    { scope: 'ALL' });
  check('with nothing unplaced, Unspecified does not appear at all',
        noUnspecified.zones.length === 3,
        noUnspecified.zones.map(function (z) { return z.name; }).join(', '));


  // =======================================================================
  console.log('');
  console.log('  Quarters read left to right in time');
  // =======================================================================
  const overQuarters = [
    row({ id: 'q4a', month: '2099-11', file: 'TEST-K2-mm Q4-2099.xlsx' }),
    row({ id: 'q1a', month: '2099-01', file: 'TEST-K2-mm Q1-2099.xlsx' }),
    row({ id: 'q1b', month: '2099-02', file: 'TEST-K2-mm Q1-2099.xlsx' }),
    row({ id: 'q1c', month: '2099-03', file: 'TEST-K2-mm Q1-2099.xlsx' }),
    row({ id: 'q2a', month: '2099-05', file: 'TEST-K2-mm Q2-2099.xlsx' }),
    row({ id: 'nq',  month: '',        file: 'TEST-K2-mm.xlsx' })
  ];
  const q = read.scoreResponses(overQuarters, { scope: 'ALL' });
  const keys = q.quarters.map(function (x) { return x.key; });

  check('QUARTERS SORT BY TIME, NOT BY VOLUME',
        JSON.stringify(keys.slice(0, 3)) ===
        JSON.stringify(['2099-Q1', '2099-Q2', '2099-Q4']), keys.join(', '));
  check('and (no quarter) is last rather than first',
        keys[keys.length - 1] === read.NO_QUARTER, keys.join(', '));
  check('Q1 has the three responses, not the one that is busiest',
        q.quarters[0].respondents === 3);
  check('each quarter carries a readable label',
        q.quarters[0].name === 'Quarter 1 (2099)', q.quarters[0].name);

  /*
    A file whose name carries no quarter leaned on its session date, which
    is the unreliable source. Surfaced for the same reason as (unassigned).
  */
  check('files that had to fall back to the date are named',
        q.undatedFiles.length === 1 &&
        q.undatedFiles[0].fileName === 'TEST-K2-mm.xlsx',
        JSON.stringify(q.undatedFiles));
  /*
    AND HOW MANY RESPONSES LEANED ON IT. Naming the file without the count
    says a file is unreliable; the count says how much of the figure rests
    on it. The first version checked only the name, and removing the
    counting line changed nothing.
  */
  check('with how many responses leaned on that date',
        q.undatedFiles[0].respondents === 1,
        String(q.undatedFiles[0].respondents));
  check('and the quarter the date produced',
        q.undatedFiles[0].quarter === '' &&
        q.undatedFiles[0].quarterLabel === '',
        JSON.stringify(q.undatedFiles[0]));


  // =======================================================================
  console.log('');
  console.log('  The trainer fallback comes from the table');
  // =======================================================================
  const invented = [{ match: 'testtrainerx', name: 'PP' }];
  const byTrainerFile = [row({ id: 't1', month: '2099-01',
                              file: 'TEST-K2-testtrainerx.xlsx' })];

  check('with no list, a trainer-only file is unassigned',
        read.scoreResponses(byTrainerFile, { scope: 'ALL' })
            .modules[0].name === read.UNASSIGNED);
  check('WITH THE LIST, IT LANDS IN THAT TRAINER\'S MODULE',
        read.scoreResponses(byTrainerFile,
                            { scope: 'ALL', trainers: invented })
            .modules[0].name === 'PP');
  check('and a filename that names a module still beats the trainer',
        read.scoreResponses(
          [row({ id: 't2', month: '2099-01',
                 file: 'TEST-K2-e-accounting_testtrainerx.xlsx' })],
          { scope: 'ALL', trainers: invented })
          .modules[0].name === 'E-Accounting');


  // =======================================================================
  console.log('');
  console.log('  The comparison shape');
  // =======================================================================
  const entry = read.comparisonEntry(
    { respondents: 4, responses: 28, positive: 24, rate: 85.71,
      achievement: 95.23, band: 'YELLOW', headroom: -2 });
  check('notPositive is everything that was not positive',
        entry.notPositive === 4, String(entry.notPositive));
  check('and it carries the band and headroom through',
        entry.band === 'YELLOW' && entry.headroom === -2);

  check('(no quarter) sorts last', read.byQuarterKey('2099-Q1', read.NO_QUARTER) < 0);
  check('and two real quarters sort by time',
        read.byQuarterKey('2099-Q1', '2099-Q2') < 0 &&
        read.byQuarterKey('2099-Q4', '2099-Q2') > 0);


  // =======================================================================
  console.log('');
  console.log('  Against the real table');
  // =======================================================================
  async function sweep() {
    await db.query("DELETE FROM training WHERE response_id LIKE 'TEST-K2-%'");
    await db.query("DELETE FROM trainer_module WHERE match_key LIKE 'testk2%'");
  }
  await sweep();

  const before = await read.feedbackMonths();

  await db.query(
    `INSERT INTO training (response_id, month, source_file, session_title,
                           trainer, zone, q1_overall, q2_relevance,
                           q3_knowledge, q4_explanation, q5_materials,
                           q6_confidence, q7_duration, session_date)
     VALUES ('TEST-K2-1', '2099-01', 'TEST-K2-mm Q1-2099.xlsx', 'MM Basics',
             'T One', 'KEPZ', $1,$1,$1,$1,$1,$1,$1, '2099-01-15 10:00+06'),
            ('TEST-K2-2', '',        'TEST-K2-sd.xlsx',         'SD Intro',
             'T Two', 'CEPZ', $1,$1,$1,$2,$1,$1,$1, '2099-02-20 10:00+06'),
            /*
              A MANGLED MONTH WITH A GOOD FILENAME. This is the real case
              the quarter rule exists for, and it does two jobs here: it
              puts a SECOND module into 2099-Q1, so the comparison has more
              than one section to sort, and its stored month resolves to a
              different quarter from its filename, so feedbackQuarters has
              to be reading the name rather than the date.
            */
            ('TEST-K2-3', '1974-03', 'TEST-K2-pp Q1-2099.xlsx', 'PP Session',
             'T Three', 'DEPZ', $1,$1,$1,$1,$1,$1,$1, '1974-03-01 10:00+06')`,
    [POS, AVG]);

  const live = await read.readKpi2('ALL');
  check('the three rows are read back', live.total.respondents === 3,
        String(live.total.respondents));
  check('their twenty-one answers are scored', live.total.responses === 21);
  check('twenty positive, one average',
        live.total.positive === 20 && live.total.average === 1,
        live.total.positive + '/' + live.total.average);
  check('the module came off the filename',
        live.modules.some(function (m) { return m.name === 'MM'; }));

  /*
    THE SECOND ROW HAS NO MONTH COLUMN, so its month had to come from
    session_date - rendered by the database in Dhaka. On a machine set to
    UTC that timestamp is 2099-02-20 04:00, still February; the row exists
    to prove the query is doing the conversion rather than Node.
  */
  const months = await read.feedbackMonths();
  check('a row with no Month column still has a month, from its date',
        months.indexOf('2099-02') !== -1, months.join(', '));
  check('and the one with a Month column uses it',
        months.indexOf('2099-01') !== -1, months.join(', '));
  check('the month list is newest first',
        months.slice().sort().reverse().join(',') === months.join(','));

  const quarters = await read.feedbackQuarters();
  check('the quarter named in a filename is listed',
        quarters.indexOf('2099-Q1') !== -1, quarters.join(', '));
  /*
    TEST-K2-3 is stored under March 1974 and named Q1-2099. If the picker
    were reading the date it would offer 1974-Q1, which is a quarter nobody
    ran any training in and which would then show an empty table.
  */
  check('AND A MANGLED DATE DOES NOT PUT A PHANTOM QUARTER ON THE PICKER',
        quarters.indexOf('1974-Q1') === -1, quarters.join(', '));

  const compare = await read.kpi2Comparison(['2099-Q1', '2099-Q2']);
  check('the comparison names itself KPI2', compare.kpi === 'KPI2');
  check('it describes its own columns, so one screen serves both KPIs',
        compare.periodKind === 'QUARTER' && compare.sectionLabel === 'Module' &&
        compare.measures.length === 4);
  check('a period with data has totals', Boolean(compare.totals['2099-Q1']));
  check('a period with none is simply absent, not zero',
        compare.totals['2099-Q2'] === undefined);
  check('three modules landed in Q1, so there is something to sort',
        compare.sections.length === 3, compare.sections.join(', '));
  check('sections are sorted, so the rows do not move between runs',
        compare.sections.slice().sort().join(',') === compare.sections.join(','),
        compare.sections.join(', '));

  const none = await read.kpi2Comparison([]);
  check('comparing nothing is an empty shape, not an error',
        none.sections.length === 0 && Object.keys(none.totals).length === 0);

  await sweep();
  const after = await read.feedbackMonths();
  check('the test rows are gone', after.join(',') === before.join(','),
        after.join(','));

  console.log('');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('');
  process.exit(fail ? 1 : 0);
}


main().catch(function (e) {
  console.error(e);
  process.exit(1);
});
