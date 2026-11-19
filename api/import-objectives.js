/**
 * import-objectives.js - OBJ_PLAN.csv and OBJ_TASK.csv into PostgreSQL.
 * ===========================================================================
 *
 *     cd api
 *     node import-objectives.js
 *
 * That is the whole procedure. It finds the two CSVs in ..\data\, tells you
 * what it found wrong, loads them, and prints the numbers to check.
 *
 * Re-runnable: it clears the two tables first, so running it again after
 * fixing a cell in the sheet just does the right thing.
 *
 * WHY THIS REPLACED A SQL FILE AND TWO pgAdmin IMPORT DIALOGS
 *
 * The first version staged each CSV into a holding table and cleaned on the
 * way across. That is the correct shape for data nobody has looked at, and
 * it is how the TEAM import works. Here it was the wrong call: it meant
 * seven dialog steps done twice, and the holding tables were called
 * obj_plan_import and obj_task_import, which the object tree sorts directly
 * beneath obj_plan and obj_task.
 *
 * Rudra right-clicked the real tables, pgAdmin said "Process failed", and
 * nothing explained why. The names were one letter apart in a list and the
 * warning was buried in a comment inside the SQL file. A process that
 * depends on picking the right one of two near-identical rows, twice, is a
 * process with a defect in it.
 *
 * One command cannot pick the wrong table.
 *
 * NO REAL DATA IS IN THIS FILE. It reads the CSVs, which .gitignore keeps
 * out of the repository.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const db = require('./db');

const DATA = path.join(__dirname, '..', 'data');
const PLAN_CSV = path.join(DATA, 'OBJ_PLAN.csv');
const TASK_CSV = path.join(DATA, 'OBJ_TASK.csv');


/**
 * A CSV parser, because these cells contain commas, quotes and newlines.
 *
 * Splitting on commas is wrong the moment a cell contains one, and the
 * Objective / Description column is full of prose. The rules are the ones
 * every spreadsheet writes:
 *
 *   - a field may be wrapped in double quotes
 *   - inside quotes, "" means one literal quote
 *   - inside quotes, a comma or a newline is just a character
 *
 * Thirty lines and no dependency, which matters on a machine where
 * installing things is awkward.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;

  // A file saved by Windows may start with a byte order mark, which would
  // otherwise become part of the first column's name and stop it matching.
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

  while (i < text.length) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += ch; i++; continue;
    }

    if (ch === '"') { quoted = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }

    field += ch; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }

  // A trailing newline leaves one empty row; so do blank lines in the file.
  return rows.filter(function (r) {
    return r.some(function (c) { return String(c).trim() !== ''; });
  });
}


function readCsv(file) {
  if (!fs.existsSync(file)) {
    console.error('');
    console.error('  Cannot find ' + file);
    console.error('');
    console.error('  Export the tab from the Google Sheet:');
    console.error('    File -> Download -> Comma Separated Values (.csv)');
    console.error('  then save it there with exactly that name.');
    console.error('');
    process.exit(1);
  }
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  if (rows.length < 2) {
    console.error('  ' + path.basename(file) + ' has no rows under its header.');
    process.exit(1);
  }
  return { header: rows[0].map(function (h) { return String(h).trim(); }),
           rows: rows.slice(1) };
}


const trim = function (v) {
  return String(v === null || v === undefined ? '' : v).trim();
};
const orNull = function (v) { const s = trim(v); return s === '' ? null : s; };

/** A number, or null for a blank or anything that is not one. */
const num = function (v) {
  const s = trim(v);
  if (!/^-?[0-9]+(\.[0-9]+)?$/.test(s)) return null;
  return Number(s);
};


async function main() {
  console.log('');
  console.log('  Reading from ' + DATA);
  console.log('');

  const plan = readCsv(PLAN_CSV);
  const task = readCsv(TASK_CSV);

  /*
    THE HEADERS ARE CHECKED, because the columns are matched by POSITION.
    If somebody inserts a column in the sheet, every field after it lands
    in the wrong place - and nothing would complain, because they are all
    text. The import would "succeed" and the page would be quietly wrong.
  */
  const PLAN_HEAD = ['Milestone ID', 'Row ID', 'Category', 'Weight', 'Objective',
    'Milestone', 'Expected Outcome', 'Count Type', 'Target', 'Per', 'Owner',
    'Auto Source'];
  const TASK_HEAD = ['Objective ID', 'Category', 'Objective name', 'Group',
    'Area', 'KPI', 'Objective / Description', 'Target', 'Measurement Method',
    'Frequency', 'Responsible Person', 'Remarks / Outcome'];

  function checkHeader(what, got, want) {
    for (let i = 0; i < want.length; i++) {
      if (trim(got[i]).toLowerCase() !== want[i].toLowerCase()) {
        console.error('');
        console.error('  ' + what + ' column ' + (i + 1) + ' should be "' +
                      want[i] + '" but reads "' + trim(got[i]) + '".');
        console.error('');
        console.error('  The columns are matched by position, so this would');
        console.error('  load every later field into the wrong column without');
        console.error('  any error. Nothing has been changed.');
        console.error('');
        process.exit(1);
      }
    }
  }
  checkHeader('OBJ_PLAN', plan.header, PLAN_HEAD);
  checkHeader('OBJ_TASK', task.header, TASK_HEAD);

  // ---- what is wrong, before anything is written ------------------------
  const planGood = [];
  const planSeen = {};
  let planNoId = 0, planDup = 0;

  plan.rows.forEach(function (r) {
    const id = trim(r[0]);
    if (!id) { planNoId++; return; }
    if (planSeen[id]) { planDup++; return; }     // first one wins
    planSeen[id] = true;
    planGood.push(r);
  });

  const taskGood = [];
  const taskSeen = {};
  let taskSkipped = 0, taskDup = 0, taskNoFreq = 0;

  task.rows.forEach(function (r) {
    const id = trim(r[0]);
    const name = trim(r[2]);
    // Objective.gs: if (!id || !name) return;
    if (!id || !name) { taskSkipped++; return; }
    if (taskSeen[id]) { taskDup++; return; }
    taskSeen[id] = true;
    if (!trim(r[9])) taskNoFreq++;
    taskGood.push(r);
  });

  // Objective.gs: kpi: /^y/i.test(String(r[5] || '').trim())
  const isKpi = function (r) { return /^y/i.test(trim(r[5])); };
  const kpis = taskGood.filter(isKpi).length;

  const oddType = planGood.filter(function (r) {
    return ['PERCENT', 'NUMBER', 'DONE'].indexOf(trim(r[7]).toUpperCase()) === -1;
  });
  const oddPer = planGood.filter(function (r) {
    return ['MONTH', 'PERIOD'].indexOf(trim(r[9]).toUpperCase()) === -1;
  });

  console.log('  OBJ_PLAN.csv   ' + plan.rows.length + ' rows');
  console.log('    blank Milestone ID, skipped .......... ' + planNoId);
  console.log('    duplicate ID, first kept ............. ' + planDup);
  console.log('    Count Type not PERCENT/NUMBER/DONE ... ' + oddType.length +
              (oddType.length ? '  ' + oddType.map(function (r) { return trim(r[0]); }).join(' ') : ''));
  console.log('    Per not MONTH/PERIOD ................. ' + oddPer.length +
              (oddPer.length ? '  ' + oddPer.map(function (r) { return trim(r[0]); }).join(' ') : ''));
  console.log('    will be imported ..................... ' + planGood.length);
  console.log('');
  console.log('  OBJ_TASK.csv   ' + task.rows.length + ' rows');
  console.log('    no ID or no name, skipped ............ ' + taskSkipped);
  console.log('    duplicate ID, first kept ............. ' + taskDup);
  console.log('    blank Frequency, becomes Monthly ..... ' + taskNoFreq);
  console.log('    marked KPI (nobody ticks these) ...... ' + kpis);
  console.log('    will be imported ..................... ' + taskGood.length);
  console.log('');

  // ---- write it ---------------------------------------------------------
  /*
    ONE TRANSACTION. If the second table fails halfway, the first is rolled
    back too - rather than leaving 29 milestones against no objectives,
    which would make the page draw confidently wrong figures.
  */
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM obj_plan');
    await client.query('DELETE FROM obj_task');

    for (const r of planGood) {
      await client.query(
        `INSERT INTO obj_plan (milestone_id, row_id, category, weight,
           objective, milestone, expected_outcome, count_type, target, per,
           owner, auto_source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [trim(r[0]), orNull(r[1]), orNull(r[2]), num(r[3]),
         orNull(r[4]), orNull(r[5]), orNull(r[6]),
         // Upper-cased: objMilestoneScore compares against 'PERCENT' and
         // 'DONE'. A cell reading "Percent" would take the NUMBER path.
         orNull(trim(r[7]).toUpperCase()), num(r[8]),
         orNull(trim(r[9]).toUpperCase()), orNull(r[10]), orNull(r[11])]);
    }

    for (const r of taskGood) {
      await client.query(
        `INSERT INTO obj_task (objective_id, category, objective_name, grp,
           area, kpi, description, target, method, frequency, owner, remarks)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [trim(r[0]), orNull(r[1]), trim(r[2]),
         // Objective.gs: String(r[3] || '').trim() || 'Unassigned'
         trim(r[3]) || 'Unassigned',
         orNull(r[4]), isKpi(r), orNull(r[6]), orNull(r[7]), orNull(r[8]),
         // Objective.gs: String(r[9] || 'Monthly').trim()
         trim(r[9]) || 'Monthly',
         orNull(r[10]), orNull(r[11])]);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('');
    console.error('  Import failed, nothing was changed: ' + err.message);
    console.error('');
    process.exit(1);
  } finally {
    client.release();
  }

  // ---- the numbers the objectives page rests on -------------------------
  // db.pool.query, not db.query: the latter logs every statement, which is
  // what you want from a running server and clutter in a one-shot report.
  const counts = (await db.pool.query(`
    SELECT (SELECT count(*)::int FROM obj_plan)               AS milestones,
           (SELECT count(*)::int FROM obj_task)               AS objectives,
           (SELECT count(*)::int FROM obj_task WHERE kpi)     AS kpis,
           (SELECT count(*)::int FROM obj_task WHERE NOT kpi) AS eas`)).rows;
  const c = counts[0];

  const rows = (await db.pool.query(
    'SELECT row_id, count(*)::int AS n FROM obj_plan GROUP BY row_id ORDER BY row_id')).rows;
  const freq = (await db.pool.query(
    'SELECT frequency, count(*)::int AS n FROM obj_task WHERE NOT kpi GROUP BY frequency ORDER BY 2 DESC')).rows;

  console.log('  IMPORTED');
  console.log('    milestones ........ ' + c.milestones);
  console.log('    objectives ........ ' + c.objectives);
  console.log('    of those, KPIs .... ' + c.kpis);
  console.log('    counted as EAS .... ' + c.eas +
              (c.eas === 86 ? '   <- the number both cards divide by' : ''));
  console.log('');
  console.log('    rows: ' + rows.map(function (r) { return r.row_id + '=' + r.n; }).join('  '));
  console.log('    freq: ' + freq.map(function (f) { return f.frequency + '=' + f.n; }).join('  '));
  console.log('');

  if (c.eas !== 86) {
    console.log('  NOTE: EAS came to ' + c.eas + ', not 86. Both summary cards');
    console.log('  divide by this, so check the KPI column in OBJ_TASK -');
    console.log('  exactly four rows should read Yes.');
    console.log('');
  }

  await db.pool.end();
}

main().catch(function (err) {
  console.error('\n  Failed: ' + err.message + '\n');
  process.exit(1);
});
