/**
 * roster.js - which section handled a ticket, and when.
 * ===========================================================================
 *
 * Ported from src/Config.gs: matchPerson, rosterIndex, sectionFor,
 * rosterOrderFor. Proved identical by roster-equivalence-test.js.
 *
 * WHY THIS IS NOT "LOOK UP THE PERSON'S DEPARTMENT"
 *
 * Three things make it harder than it sounds, and each one was learned from
 * a figure coming out wrong.
 *
 *   A TICKET CARRIES A NAME, NOT AN ID. 'Current Activity In Charge' is
 *   text the ITSM wrote, and it writes one person several ways: the
 *   honorific abbreviated or spelled out, with the full stop or without,
 *   with a space after it or run straight into the first name. Config.gs
 *   lists the real examples. All of those have to resolve to one person,
 *   or their tickets split across two rows of the table, one of them
 *   labelled '(unassigned)'.
 *
 *   THE SECTION IS NOT THE MODULE. Three people hold MM and MD module
 *   roles while reporting into Sales & Customer Applications, so their
 *   tickets look like supply-chain work. Config.gs names them and says
 *   why it matters: "Sorting by module would file them under the wrong
 *   section every month."
 *
 *   SECTIONS CHANGED SHAPE IN AUGUST 2026. Before that there were two, not
 *   four. A ticket from March scored against today's four sections would
 *   put work in a section that did not exist, so months before the split
 *   are reported under the names in force then.
 *
 * WHERE THE NAMES LIVE. In the roster table, loaded by import-roster.js
 * from CONFIG.ROSTER and CONFIG.FORMER. Not in this file and not in any
 * other file in this repository, which is public.
 */

const db = require('./db');

// Config.gs:126. The month the four sections replaced the two.
const SECTION_ERA_START = '2026-08';

/*
  Config.gs:274 PRE_SPLIT_SECTION. What each of today's sections was called
  before the split, for scoring months that predate it.

  Not personal data - four section names and the mapping between them - so
  it stays in the code, where the original keeps it.
*/
const PRE_SPLIT_SECTION = {
  'Manufacturing Applications': 'Functional Applications',
  'Sales Applications':         'Functional Applications',
  'Supply Chain Applications':  'Functional Applications',
  'Financial Applications':     'Financial Applications',
  'EAS':                        'EAS'
};


/**
 * A name squashed to something matchable.   [Config.gs:2009]
 *
 * Lower-cased, everything but letters removed, and the four spellings of
 * the honorific folded into one 'md' - so 'Mohammad', 'Muhammad', 'Mohd'
 * and 'Md' are the same prefix. The \b matters: it stops 'Mdhuri' being
 * read as an honorific followed by 'huri'.
 */
function matchPerson(name) {
  const text = String(name || '').toLowerCase().replace(/[^a-z]+/g, ' ').trim();
  if (!text) return '';
  return text.replace(/^(mohammad|muhammad|mohd|md)\b\s*/, 'md ').replace(/\s+/g, '');
}


/**
 * The lookup sectionFor uses, built from roster rows.   [Config.gs:2068]
 *
 * Three maps, and the second two exist for one reason each:
 *
 *   full   person_key -> section
 *   bare   the same key with the honorific dropped, "so a ticket raised
 *          written without the honorific still finds the person listed
 *          with it. The
 *          ITSM writes the honorific today, but if it ever stops, the
 *          symptom would be silent - that person's tickets would drop into
 *          '(unassigned)' and the section totals would quietly go wrong."
 *   clash  bare forms that two different people share, which are dropped
 *          rather than guessed at.
 *
 * LEAVERS ARE ADDED SECOND, so that if a name somehow appears in both, the
 * person who is still here wins.
 *
 * THE CLASH MAP CAN NEVER BE POPULATED, and that is worth writing down
 * rather than discovering twice.
 *
 * A bare form is only recorded when it differs from the key - that is, when
 * the key begins with 'md' - and it is produced by removing exactly that
 * prefix. So for two keys to share a bare form:
 *
 *     k1.slice(2) === k2.slice(2)  with both starting 'md'   =>   k1 === k2
 *
 * which is one person, not two. Checked by brute force over the honorific
 * spellings and the awkward names ('Mdhuri', 'Mdeep', a name whose second
 * word is 'Md'): no pair of distinct keys collides.
 *
 * It is KEPT because this is a port and Config.gs has it, and because a
 * guard that costs nothing is not worth removing to save a line. But it is
 * dead code, two deliberate breaks of it cannot be caught by any test, and
 * roster-equivalence-test.js says so where it would otherwise look like a
 * gap in the testing. Nobody should rely on it to catch a duplicate name:
 * two people with the same name are one entry in `full`, and the second
 * silently replaces the first - which import-roster.js DOES report.
 */
function buildIndex(rows) {
  const full = {};
  const bare = {};
  const clash = {};

  const add = function (key, section) {
    if (!key) return;
    full[key] = section;

    const stripped = key.replace(/^md/, '');
    if (!stripped || stripped === key) return;
    if (bare[stripped] && bare[stripped] !== section) clash[stripped] = true;
    bare[stripped] = section;
  };

  rows.filter(function (r) { return !r.is_former; })
      .forEach(function (r) { add(r.person_key, r.section); });

  rows.filter(function (r) { return r.is_former; })
      .forEach(function (r) { if (!full[r.person_key]) add(r.person_key, r.section); });

  return { full: full, bare: bare, clash: clash };
}


/** The whole roster, as an index. One query, not one per ticket. */
async function loadIndex() {
  const rows = await db.query(
    'SELECT person_key, section, is_former FROM roster ORDER BY person_key');
  return buildIndex(rows);
}


/**
 * Which section this person was in, for this month.   [Config.gs:2134]
 *
 * @param index     from buildIndex
 * @param person    the name as the ITSM wrote it
 * @param month     'YYYY-MM', or null for "as things are now"
 * @param fallback  the Department column the upload claimed
 */
function sectionFor(index, person, month, fallback) {
  const key = matchPerson(person);

  let current = index.full[key];
  if (!current && key) {
    const stripped = key.replace(/^md/, '');
    if (stripped && !index.clash[stripped]) current = index.bare[stripped];
  }

  if (!current) {
    // Someone not on the chart - a leaver nobody recorded, a new joiner, or
    // a name the ITSM spells in a way matchPerson does not reach. Fall back
    // to whatever the upload claimed rather than dropping the ticket on the
    // floor: a ticket filed under a doubtful section is still a ticket the
    // department was sent, and losing it would make the totals disagree
    // with the ITSM's own report.
    return String(fallback || '').trim();
  }

  // Before the split there were two sections, not four. Scoring an old
  // month against today's shape would put work in a section that did not
  // exist then.
  if (month && month < SECTION_ERA_START) {
    return PRE_SPLIT_SECTION[current] || current;
  }

  return current;
}


/**
 * The order a section's people are listed in on the chart. [Config.gs:2044]
 *
 * MATCHED LOOSELY, because the two lists do not spell the sections the same
 * way: the TEAM tab says 'Sales and Customer Applications' where the roster
 * says 'Sales Applications'. Both reduce to something starting 'sales'.
 *
 * @param sections  section -> [person_key], in roster order
 */
function rosterOrderFor(sections, sectionName) {
  const trim = function (value) {
    return String(value || '').toLowerCase()
      .replace(/applications?/g, '')
      .replace(/[^a-z ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  };

  const want = trim(sectionName);
  if (!want) return [];

  const keys = Object.keys(sections);
  for (let i = 0; i < keys.length; i++) {
    const have = trim(keys[i]);
    if (!have) continue;
    if (want === have || want.indexOf(have) === 0 || have.indexOf(want) === 0) {
      return sections[keys[i]];
    }
  }
  return [];
}

/** section -> [person_key], in the order the roster lists them. */
async function loadSections() {
  const rows = await db.query(
    `SELECT section, person_key FROM roster
      WHERE NOT is_former ORDER BY section, loaded_at, person_key`);
  const out = {};
  rows.forEach(function (r) {
    (out[r.section] = out[r.section] || []).push(r.person_key);
  });
  return out;
}


module.exports = {
  SECTION_ERA_START, PRE_SPLIT_SECTION,
  matchPerson, buildIndex, loadIndex, sectionFor,
  rosterOrderFor, loadSections
};
