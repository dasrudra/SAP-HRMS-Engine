/**
 * objectives-write.js - who may tick what, and recording it safely.
 * ===========================================================================
 *
 * Ported from src/Objective.gs: objWhoAmI, objMayTick and objWriteLog.
 *
 * Reading was the easy half. This half decides who is allowed to change the
 * department's score, and it writes to a row other people are writing to at
 * the same time, so both rules below are copied exactly rather than
 * reasoned out afresh.
 */

const db = require('./db');
const obj = require('./objectives');

const ROLE_RANK = { USER: 1, ADMIN: 2, MASTER: 3 };
const HISTORY_KEPT = 20;          // Config.gs OBJECTIVE.HISTORY_KEPT


/**
 * Who the caller is, and which modules are theirs.   [Objective.gs:1592]
 *
 * The modules come from the Module cell of the TEAM tab, which people fill
 * in by hand as "MM", "MD/MM (Purchase)", "FI/CO" or "MM, SD". Splitting on
 * / , & + ; and the word "and" is what Objective.gs does, and the list it
 * produces is matched against the objective's Group.
 *
 * `all` is admin and above: an admin may tick for any module. `planner` is
 * a section head or the department head - that is what Head means on the
 * organogram, and there is no second list to keep.
 */
async function objWhoAmI(employeeId, role) {
  const id = String(employeeId || '');
  const admin = ROLE_RANK[String(role || '').toUpperCase()] >= ROLE_RANK.ADMIN;

  const me = { id: id, name: id, admin: admin,
               groups: [], all: admin, planner: admin, reason: '' };
  if (!id) return me;

  const rows = await db.query(
    'SELECT full_name, module, is_head FROM team WHERE employee_id = $1', [id]);

  if (!rows.length) {
    me.reason = 'Your employee ID is not in the team directory, so there is ' +
                'no module against your name.';
    return me;
  }

  const found = rows[0];
  me.name = found.full_name || id;
  if (found.is_head) me.planner = true;

  const modules = String(found.module || '')
    .split(/[\/,&+;]| and /i)
    .map(function (m) { return m.trim().toUpperCase(); })
    .filter(Boolean);

  me.groups = modules;
  if (!modules.length && !admin) {
    me.reason = 'No module is set against your name in the team directory, ' +
                'so there is nothing here for you to tick yet. Ask for your ' +
                'Module cell to be filled in.';
  }
  return me;
}


/**
 * Whether this person may tick this objective.   [Objective.gs:1685]
 *
 * TAKES THE OBJECTIVE, NOT ITS GROUP NAME, so that the two rules that
 * decide this - it is a KPI, and it is not your module - live together.
 * The first version took the group, which meant an admin got true for the
 * four KPIs: the page drew a tick button and the endpoint then refused the
 * press. A button that does nothing is worse than no button.
 *
 * A KPI IS NOBODY'S TO TICK, an admin included. Its figure comes from the
 * engine, and a hand-set tick beside a measured percentage is a second,
 * quieter answer to a question that already has one.
 */
function objMayTick(me, task) {
  if (!me || !me.id || !task) return false;
  if (task.kpi) return false;
  if (me.all) return true;
  const g = String(task.group || '').trim().toUpperCase();
  return me.groups.indexOf(g) !== -1;
}


/**
 * Writes one log row, keeping the timeline.   [Objective.gs:1897]
 *
 * ONE WRITER AT A TIME, per row.
 *
 * Objective.gs takes a SCRIPT-WIDE LockService lock, because its storage is
 * a spreadsheet and the operation is find-the-row-then-write-it. The page
 * fires ticks concurrently on purpose - pressing five days in a row sends
 * five calls without waiting - and two landing together both found no row,
 * both appended one, and from then on every later save went into whichever
 * duplicate the reader did not use. That is how a month of recording
 * disappears.
 *
 * pg_advisory_xact_lock is the same guarantee per KEY rather than per
 * script, so two people ticking different objectives no longer queue behind
 * each other. It is released automatically when the transaction ends, so a
 * crash mid-write cannot leave it held - which the Apps Script version
 * could not promise.
 *
 * `compute` IS A FUNCTION, NOT A SET OF FIELDS, AND THAT IS THE WHOLE
 * POINT. It receives the row as it exists INSIDE the lock and returns what
 * to write.
 *
 * The first version took plain fields, so the caller read the log, worked
 * out the new marks string, and only then called this - taking the lock
 * after the read it was supposed to protect. Five slots of one objective
 * ticked at once all read the same empty string, each produced a string
 * with its own single Y, and the last writers won:
 *
 *     expected  YYYYY      got  Y...Y      three ticks silently lost
 *
 * A lock around only the write is not a lock. The read has to be inside
 * it, which means the caller's arithmetic has to be inside it too.
 */
async function writeObjLog(period, kind, ref, compute, who) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const key = obj.objLogKey(period, kind, ref);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);

    const had = (await client.query(
      `SELECT marks, value, status, note, by_name, by_id, at, history,
              marked_at, notes
         FROM obj_log WHERE period = $1 AND kind = $2 AND ref_id = $3`,
      [period, kind, ref])).rows[0] || null;

    /*
      The caller's arithmetic runs HERE, on the row as it is under the
      lock - not on a copy read before it.
    */
    const fields = compute(had);

    let history = had ? (had.history || []) : [];
    const marks    = had ? (had.marks  || '') : '';
    const value    = had ? had.value : null;
    const status   = had ? (had.status || '') : '';
    const note     = had ? (had.note   || '') : '';
    const markedAt = had ? (had.marked_at || {}) : {};
    const notes    = had ? (had.notes  || {}) : {};

    /*
      THE TIMELINE RECORDS WHAT THE ROW SAID BEFORE THIS WRITE, not what it
      is about to say - so the newest entry is the previous state and the
      row itself is the current one. Only when there was a previous write
      to describe: `at` is null on a row that has never been saved.
    */
    if (had && had.at) {
      const entry = {
        at: new Date(had.at).getTime(),
        by: had.by_name || '',
        byId: had.by_id || '',
        value: value === null ? null : Number(value),
        status: status,
        note: note,
        marks: marks
      };
      /*
        WHAT A NOTE SAID BEFORE IT WAS EDITED, and only that. The timeline
        cannot carry the whole Notes column, so an edit leaves behind the
        one note it replaced, cut to a couple of lines. That answers "what
        did it say before", which is the only question anybody asks of an
        edited note, and it is bounded by the number of versions rather
        than the number of notes.
      */
      if (fields.noteSlot !== undefined) {
        const was = notes[String(fields.noteSlot)];
        entry.noteSlot = Number(fields.noteSlot);
        entry.noteWas = was ? String(was.t || was).slice(0, 240) : '';
      }
      history = [entry].concat(history);
    }
    history = history.slice(0, HISTORY_KEPT);

    const next = {
      marks:    fields.marks    !== undefined ? fields.marks    : marks,
      value:    fields.value    !== undefined ? fields.value    : value,
      status:   fields.status   !== undefined ? fields.status   : status,
      note:     fields.note     !== undefined ? fields.note     : note,
      markedAt: fields.markedAt !== undefined ? fields.markedAt : markedAt,
      notes:    fields.notes    !== undefined ? fields.notes    : notes
    };

    /*
      ON CONFLICT DO UPDATE - insert or update in one statement. The
      advisory lock above already serialises writers for this key; this
      makes the write itself atomic as well, so there is no window in
      which the row exists but is half-written.
    */
    await client.query(
      `INSERT INTO obj_log (period, kind, ref_id, marks, value, status, note,
         by_name, by_id, at, history, marked_at, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now(), $10, $11, $12)
       ON CONFLICT (period, kind, ref_id) DO UPDATE
         SET marks = EXCLUDED.marks, value = EXCLUDED.value,
             status = EXCLUDED.status, note = EXCLUDED.note,
             by_name = EXCLUDED.by_name, by_id = EXCLUDED.by_id,
             at = EXCLUDED.at, history = EXCLUDED.history,
             marked_at = EXCLUDED.marked_at, notes = EXCLUDED.notes`,
      [period, kind, ref, next.marks, next.value, next.status, next.note,
       who.name, who.id,
       JSON.stringify(history), JSON.stringify(next.markedAt),
       JSON.stringify(next.notes)]);

    await client.query('COMMIT');
    return { at: Date.now(), by: who.name, history: history };

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}


module.exports = { objWhoAmI, objMayTick, writeObjLog, ROLE_RANK };
