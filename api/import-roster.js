/**
 * import-roster.js - CONFIG.ROSTER and CONFIG.FORMER into the roster table.
 * ===========================================================================
 *
 *     cd api
 *     node import-roster.js
 *
 * No CSV to export and nothing to type. It reads src/Config.gs, which is
 * where the org chart already lives, and loads it.
 *
 * WHY IT READS THE .gs FILE RATHER THAN A SPREADSHEET TAB
 *
 * Because that is where this list is. CONFIG.ROSTER is not a tab - it is
 * the authority, in code, and Config.gs says so in capitals:
 *
 *   "THIS IS THE AUTHORITY, not the filename and not the ticket's module."
 *
 * Three people make that distinction necessary - they hold MM and MD
 * module roles while reporting into Sales & Customer Applications, so
 * their tickets look like supply-chain work. Config.gs names them and
 * adds: "Sorting by module would file them under the wrong section every
 * month."
 *
 * Retyping thirty-seven names into a CSV would be a second copy to keep in
 * step, and the first time the two disagreed a month's figures would move
 * with nothing to say why.
 *
 * WHY NOT THE team TABLE. It does not have the leavers, and CONFIG.FORMER
 * exists precisely so that "their tickets are still in every month they
 * worked, and those months have to keep totalling the same number tomorrow
 * as they did yesterday". It also spells the sections differently on
 * purpose. See the note in db/12-roster.sql.
 *
 * RE-RUNNABLE. It replaces the table's contents, because the roster is a
 * complete list rather than something that accumulates - moving somebody
 * between sections in Config.gs and running this again is the whole
 * procedure, and is what recomputeKpiCache() was for on the other side.
 *
 * NO NAMES ARE WRITTEN INTO THIS FILE or any other in the repository. They
 * are read from src/Config.gs, which already carries them, and they go
 * into the database.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const db = require('./db');
const roster = require('./roster');

const CONFIG_GS = path.join(__dirname, '..', 'src', 'Config.gs');


/**
 * Lifts one object literal out of Config.gs by its key.
 *
 * Config.gs is 2,700 lines that call SpreadsheetApp and PropertiesService
 * at load time, so it cannot be required. The two keys wanted here are
 * plain data, so the text between the key and its closing brace is read
 * and evaluated on its own in a sandbox with nothing in it.
 *
 * BRACE COUNTING, NOT A REGEX FOR THE CLOSING BRACE. The roster contains
 * nested arrays and comments; a lazy match would stop at the first '}' it
 * found, which is inside the object rather than at the end of it.
 */
function liftObject(source, key, openCh, closeCh) {
  const o = openCh || '{';
  const c = closeCh || '}';

  const start = source.indexOf('\n  ' + key + ': ' + o);
  if (start === -1) return null;

  const open = source.indexOf(o, start);
  let depth = 0;
  let inString = null;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (inLineComment) { if (ch === '\n') inLineComment = false; continue; }
    if (inBlockComment) {
      if (ch === '*' && next === '/') { inBlockComment = false; i++; }
      continue;
    }
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '/' && next === '/') { inLineComment = true; i++; continue; }
    if (ch === '/' && next === '*') { inBlockComment = true; i++; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }

    if (ch === o) depth++;
    else if (ch === c) {
      depth--;
      if (depth === 0) {
        const text = source.slice(open, i + 1);
        const sandbox = {};
        vm.createContext(sandbox);
        return vm.runInContext('(' + text + ')', sandbox);
      }
    }
  }
  return null;
}


async function main() {
  console.log('');

  if (!fs.existsSync(CONFIG_GS)) {
    console.error('  Could not find ' + CONFIG_GS);
    console.error('  This reads the org chart out of the Apps Script source.');
    console.error('');
    process.exit(1);
  }

  const source = fs.readFileSync(CONFIG_GS, 'utf8');

  /*
    THE TRAINER FALLBACK LIST, lifted for the same reason the chart is: it is
    three colleagues' names and this repository is public. api/kpi2.js takes
    it as an argument and holds none of it - see db/17-trainer-module.sql.
  */
  const TRAINER_MODULES = liftObject(source, 'TRAINER_MODULES', '[', ']') || [];

  const ROSTER = liftObject(source, 'ROSTER');
  if (!ROSTER || !Object.keys(ROSTER).length) {
    console.error('  Could not read CONFIG.ROSTER from src/Config.gs.');
    console.error('  Either it was renamed, or this importer needs updating.');
    console.error('');
    process.exit(1);
  }
  // FORMER may legitimately be empty - nobody has left since it was added.
  const FORMER = liftObject(source, 'FORMER') || {};

  /*
    AND THE MODULE EXCEPTIONS. CONFIG.PERSON_MODULES is the people whose
    module is not their section's usual one - and only those; everybody
    else takes SECTION_MODULES, which lives in the code because four
    section names mapped to four module names is not personal data.
  */
  const PERSON_MODULES = liftObject(source, 'PERSON_MODULES') || {};

  /*
    ONE ROW PER PERSON, KEYED BY THE NORMALISED NAME. Two spellings of one
    person in the roster would collide here rather than quietly becoming
    two people, which is the failure this key exists to prevent - so a
    collision is reported instead of being silently overwritten.
  */
  const rows = [];
  const seen = {};
  const collisions = [];

  Object.keys(ROSTER).forEach(function (section) {
    (ROSTER[section] || []).forEach(function (person) {
      const key = roster.matchPerson(person);
      if (!key) return;
      if (seen[key]) {
        collisions.push(person + ' and ' + seen[key].display +
                        ' both reduce to "' + key + '"');
        return;
      }
      seen[key] = { display: person, section: section };
      rows.push([key, person, section, false, null]);
    });
  });

  let leavers = 0;
  Object.keys(FORMER).forEach(function (person) {
    const key = roster.matchPerson(person);
    if (!key || seen[key]) return;        // still here: that entry wins
    seen[key] = { display: person, section: FORMER[person] };
    rows.push([key, person, FORMER[person], true, null]);
    leavers++;
  });

  /*
    The exceptions go onto the rows that are already there. Somebody in
    PERSON_MODULES who is NOT on the chart is reported rather than
    silently dropped - their exception would otherwise stop applying with
    nothing to say why, and the symptom would be their tickets quietly
    moving to another module's row.
  */
  let withModule = 0;
  const strays = [];
  Object.keys(PERSON_MODULES).forEach(function (person) {
    const key = roster.matchPerson(person);
    const row = rows.filter(function (r) { return r[0] === key; })[0];
    if (!row) { strays.push(person); return; }
    row[4] = PERSON_MODULES[person];
    withModule++;
  });

  if (strays.length) {
    console.log('  In PERSON_MODULES but not on the chart, so their module');
    console.log('  exception is NOT being applied:');
    strays.forEach(function (p) { console.log('    ' + p); });
    console.log('');
  }

  if (collisions.length) {
    console.log('  Two names reduce to the same key and only the first was ' +
                'kept:');
    collisions.forEach(function (c) { console.log('    ' + c); });
    console.log('');
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    // Replaced, not merged: the roster is a complete list, and somebody
    // removed from Config.gs should leave the table too.
    await client.query('DELETE FROM roster');
    for (const r of rows) {
      await client.query(
        `INSERT INTO roster (person_key, display_name, section, is_former, module)
         VALUES ($1,$2,$3,$4,$5)`, r);
    }

    // Same transaction and the same rule: a complete list, replaced rather
    // than merged, so a trainer removed from Config.gs leaves the table too.
    await client.query('DELETE FROM trainer_module');
    for (const t of TRAINER_MODULES) {
      const key = String(t.match || '').trim().toLowerCase();
      if (!key) continue;
      await client.query(
        `INSERT INTO trainer_module (match_key, module) VALUES ($1,$2)
         ON CONFLICT (match_key) DO UPDATE SET module = EXCLUDED.module`,
        [key, String(t.name || '').trim()]);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('  Nothing was imported: ' + err.message);
    console.error('');
    process.exit(1);
  } finally {
    client.release();
  }

  const bySection = await db.query(
    `SELECT section, count(*)::int AS n,
            count(*) FILTER (WHERE is_former)::int AS gone
       FROM roster GROUP BY section ORDER BY section`);

  console.log('  ' + TRAINER_MODULES.length + ' trainer fallback(s) loaded ' +
              'into trainer_module');
  console.log('  ' + rows.length + ' people loaded, ' + leavers +
              ' of them no longer here, ' + withModule +
              ' with a module of their own');
  console.log('');
  bySection.forEach(function (s) {
    console.log('    ' + String(s.section).padEnd(30) + s.n +
                (s.gone ? '   (' + s.gone + ' former)' : ''));
  });

  /*
    HOW MANY TICKETS THIS CAN NOW PLACE. The number that matters is not how
    many names loaded but how many tickets they account for - a roster that
    looks complete and still leaves a thousand tickets unassigned is a
    roster with a spelling problem in it.
  */
  const t = await db.query('SELECT count(*)::int AS n FROM ticket');
  if (t[0].n) {
    const index = roster.buildIndex(
      await db.query('SELECT person_key, section, is_former FROM roster'));

    const names = await db.query(
      `SELECT in_charge, count(*)::int AS n FROM ticket
        WHERE btrim(in_charge) <> '' GROUP BY in_charge`);

    let placed = 0, unplaced = 0;
    const strangers = [];
    names.forEach(function (r) {
      if (roster.sectionFor(index, r.in_charge, null, '')) placed += r.n;
      else { unplaced += r.n; strangers.push(r.in_charge + ' (' + r.n + ')'); }
    });

    console.log('');
    console.log('  Of ' + t[0].n + ' tickets, ' + placed + ' can be placed ' +
                'in a section by name.');
    if (unplaced) {
      console.log('  ' + unplaced + ' cannot, and fall back to the ' +
                  'Department column the upload wrote:');
      strangers.sort().slice(0, 15).forEach(function (s) {
        console.log('    ' + s);
      });
      if (strangers.length > 15) {
        console.log('    ... and ' + (strangers.length - 15) + ' more names');
      }
      console.log('');
      console.log('  Those are people off the chart - leavers, joiners, or a ');
      console.log('  spelling matchPerson does not reach. A leaver whose');
      console.log('  months must keep totalling belongs in CONFIG.FORMER.');
    }
  }

  console.log('');
  process.exit(0);
}

main().catch(function (err) {
  console.error('');
  console.error('  Failed: ' + err.message);
  console.error('');
  process.exit(1);
});
