/**
 * objectives-read.js - the three tables, in the shapes Objective.gs uses.
 * ===========================================================================
 *
 * The arithmetic in objectives.js is a line-for-line port and is proved
 * identical over 23,000 comparisons. It expects its input in the exact
 * shapes readObjPlan(), readObjTasks() and objReadLog() produce from the
 * spreadsheet. This file produces those same shapes from PostgreSQL.
 *
 * KEEPING THE SHAPES IS THE WHOLE POINT. Tidying them on the way through -
 * renaming `byKey`, flattening plan.rows, dropping a field nothing reads
 * yet - would mean the ported functions had to change too, and then they
 * would no longer be the functions that were proved equivalent.
 */

const db = require('./db');


/**
 * The SMART sheet: milestones grouped into rows.
 *
 *   { rows: [ { id, category, weight, milestones: [ {...} ] } ] }
 *
 * objPlanSquares walks plan.rows then row.milestones, and objProgressAll
 * counts `base` as the total of row.milestones.length - so the grouping is
 * not presentation, it is what the arithmetic reads.
 */
async function readObjPlan() {
  const rows = await db.query(`
    SELECT milestone_id, row_id, category, weight, objective, milestone,
           expected_outcome, count_type, target, per, owner, auto_source
      FROM obj_plan
     ORDER BY milestone_id`);

  const byRow = {};
  const order = [];

  rows.forEach(function (r) {
    const rowId = r.row_id || 'Unassigned';
    if (!byRow[rowId]) {
      byRow[rowId] = { id: rowId, category: r.category || '',
                       weight: r.weight === null ? null : Number(r.weight),
                       milestones: [] };
      order.push(rowId);
    }
    byRow[rowId].milestones.push({
      id: r.milestone_id,
      category: r.category || '',
      weight: r.weight === null ? null : Number(r.weight),
      objective: r.objective || '',
      milestone: r.milestone || '',
      outcome: r.expected_outcome || '',
      // countType, per and auto are read by objMilestoneScore and
      // objPlanMonthState under exactly these names.
      countType: r.count_type || '',
      target: r.target === null ? null : Number(r.target),
      per: r.per || '',
      owner: r.owner || '',
      auto: r.auto_source || ''
    });
  });

  return { rows: order.map(function (id) { return byRow[id]; }) };
}


/**
 * The Unique Roles sheet: a flat list of 90.
 *
 * kpi is already a boolean in the table - see the long note in
 * 06-objectives.sql. objProgressAll filters with `!t.kpi`, and storing the
 * words "Yes"/"No" instead would exclude all ninety.
 */
async function readObjTasks() {
  const rows = await db.query(`
    SELECT objective_id, category, objective_name, grp, area, kpi,
           description, target, method, frequency, owner, remarks
      FROM obj_task
     ORDER BY objective_id`);

  const groups = [];
  const tasks = rows.map(function (r) {
    if (groups.indexOf(r.grp) === -1) groups.push(r.grp);
    return {
      id: r.objective_id,
      category: r.category || '',
      name: r.objective_name,
      group: r.grp,
      area: r.area || '',
      kpi: r.kpi === true,
      description: r.description || '',
      target: r.target === null ? '' : String(r.target),
      method: r.method || '',
      frequency: r.frequency,
      owner: r.owner || '',
      remarks: r.remarks || ''
    };
  });

  return { tasks: tasks, count: tasks.length, groups: groups,
           filled: tasks.length > 0 };
}


/**
 * The log, keyed the way every caller looks it up.
 *
 *   { byKey: { '2026-11|TASK|OJT-005': { marks, markedAt, value, ... } } }
 *
 * objLogKey() builds that key, and it is the same function on both sides,
 * so the two cannot drift apart.
 *
 * markedAt KEYS ARE STRINGS. objTaskState reads `when[String(i)]`, and
 * jsonb hands back an object whose keys are already strings - but the
 * VALUES arrive as JSON numbers and must stay numbers, because they are
 * compared against objSlotEnd's millisecond timestamp.
 */
async function readObjLog() {
  const { objLogKey } = require('./objectives');

  const rows = await db.query(`
    SELECT period, kind, ref_id, marks, value, status, note,
           by_name, by_id, at, history, marked_at, notes
      FROM obj_log`);

  const byKey = {};
  rows.forEach(function (r) {
    const markedAt = {};
    Object.keys(r.marked_at || {}).forEach(function (k) {
      const n = Number(r.marked_at[k]);
      if (n > 0) markedAt[String(Number(k))] = n;
    });

    byKey[objLogKey(r.period, r.kind, r.ref_id)] = {
      period: r.period,
      kind: r.kind,
      ref: r.ref_id,
      marks: r.marks || '',
      value: r.value === null ? null : Number(r.value),
      status: String(r.status || '').trim().toUpperCase(),
      note: r.note || '',
      by: r.by_name || '',
      byId: r.by_id || '',
      at: r.at ? new Date(r.at).getTime() : 0,
      history: r.history || [],
      markedAt: markedAt,
      notes: r.notes || {}
    };
  });

  return { byKey: byKey, count: rows.length };
}


module.exports = { readObjPlan, readObjTasks, readObjLog };
