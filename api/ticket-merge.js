/**
 * ticket-merge.js - the one definition of what merging two tickets means.
 * ===========================================================================
 *
 * THIS FILE EXISTS BECAUSE THERE ARE NOW TWO WAYS A TICKET GETS IN.
 *
 *   import-tickets.js   the CSV exported from the TICKETS tab, run from a
 *                       terminal. The bridge, while Apps Script still owns
 *                       the uploading.
 *   uploads.js          the Uploads screen, which is what replaces that.
 *
 * Both have to reach the same answer. Not "a similar answer" - the same one,
 * because the same ITSM export can arrive down either path and the figures
 * must not depend on which. Two copies of twenty-four near-identical CASE
 * expressions would agree on the day they were written and drift the first
 * time one of them is corrected.
 *
 * So the merge lives here, once, and both require it.
 *
 *
 * THE RULES, WHICH ARE Ingest.gs mergeRows
 *
 *   most columns   take the incoming value if the existing one is blank, OR
 *                  if the incoming row is newer. A blank incoming value
 *                  never overwrites anything - a partial export must not
 *                  erase what a fuller one supplied.
 *
 *   the two flags  are OR'd, always. "A ticket can legitimately appear in
 *                  both kinds of export", and which reports it appeared in
 *                  is the thing that decides whether EAS is scored on it.
 *
 *   Source Files   accumulates, unique, in the order first seen, "so the
 *                  audit trail shows every file that contributed".
 *
 * `newer` is decided on Last Updated, and a row with no readable stamp
 * counts as oldest - "the safe answer, since it cannot then overwrite
 * anything on a recency claim it has not made".
 *
 * Why recency and not "first value wins" is the long note in Ingest.gs
 * worth reading before changing anything here: Delay Days is 0 on an open
 * ticket, not blank, so the old rule kept the 0 and threw away the 5 that
 * says the ticket finished five days late. The KPI then scored it as on
 * time. Quietly, with no way to see it.
 *
 *
 * NO REAL DATA IS IN THIS FILE.
 */


/**
 * The TICKETS tab, column by column, in its own order.
 *
 * [ the spreadsheet heading, the database column, how to read the cell ]
 *
 * The order matters: rows arrive from the browser as plain arrays in this
 * order, because "for 20,000 rows, repeating 29 key names on every row would
 * multiply the payload for no benefit".
 */
const COLUMNS = [
  ['Ticket ID',                  'ticket_id',             'text'],
  ['Affiliate',                  'affiliate',             'text'],
  ['Service',                    'service',               'text'],
  ['Part',                       'part',                  'text'],
  ['Process',                    'process',               'text'],
  ['Category',                   'category',              'text'],
  ['Sub Category',               'sub_category',          'text'],
  ['Title',                      'title',                 'text'],
  ['Details',                    'details',               'text'],
  ['Request Date',               'request_date',          'ts'],
  ['Requestor',                  'requestor',             'text'],
  ['Current Activity',           'current_activity',      'text'],
  ['Current Activity Date',      'current_activity_date', 'ts'],
  ['Current Activity In Charge', 'in_charge',             'text'],
  ['Due date',                   'due_date',              'ts'],
  ['Completion Date',            'completion_date',       'ts'],
  ['Lead-time',                  'lead_time',             'num'],
  ['Delay Days',                 'delay_days',            'num'],
  ['Status',                     'status',                'text'],
  ['CTS Number',                 'cts_number',            'text'],
  ['Remarks',                    'remarks',               'text'],
  ['Acceptance M/H (Level1)',    'acceptance_mh',         'num'],
  ['Processing M/H (Level1)',    'processing_mh',         'num'],
  ['Man*Hour',                   'man_hour',              'num'],
  ['Department',                 'department',            'text'],
  ['In Overall Report',          'in_overall',            'bool'],
  ['In Dept Report',             'in_dept',               'bool'],
  ['Source Files',               'source_files',          'text'],
  ['Last Updated',               'last_updated',          'ts']
];

/** These three are merged by their own rules, not by "blank or newer". */
const SPECIAL = ['in_overall', 'in_dept', 'source_files'];

/** The spreadsheet headings, in order. CONFIG.TICKET_COLUMNS. */
const HEADERS = COLUMNS.map(function (c) { return c[0]; });

/** The database column names, in order. */
const NAMES = COLUMNS.map(function (c) { return c[1]; });

/** Where each heading sits, so a caller can address one by name. */
const AT = (function () {
  const index = {};
  COLUMNS.forEach(function (c, i) { index[c[1]] = i; });
  return index;
})();


// ---------------------------------------------------------------------------
// Reading one cell
// ---------------------------------------------------------------------------

/**
 * Ingest.gs isBlank, and the trim is the whole point.
 *
 *   "Some Completion Date cells in the ITSM export contain a single space.
 *    Testing only for '' treats that space as a real value, so the merge
 *    keeps it and the genuine completion date from the other report never
 *    replaces it - one ticket silently becomes incomplete. With a KPI whose
 *    whole margin is one ticket, that is not a rounding detail."
 */
function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === '';
}


/** Ingest.gs truthy. 'TRUE', 'true' and a real boolean; nothing else. */
function truthy(value) {
  return value === true || String(value).toLowerCase() === 'true';
}


/*
  NUL BYTES, WHICH REAL EXPORTS CONTAIN AND PostgreSQL CANNOT STORE.

  The first real import stopped on

      invalid byte sequence for encoding "UTF8": 0x00

  after reading 25,808 rows. U+0000 is perfectly valid UTF-8 and perfectly
  valid in a JavaScript string, so it travels all the way from the ITSM
  export into a parameter before the database refuses it. A PostgreSQL text
  value cannot contain one, at all, by design.

  A spreadsheet never complained, which is why these have been sitting in
  the data unnoticed: Sheets stores the cell and simply does not draw the
  character.

  SO IT IS STRIPPED, AND ONLY IT. Every other control character is storable
  and is left exactly as it came. The count is reported, because "we quietly
  removed characters from your tickets" is not something to do silently.

  The count is on the module rather than passed around, because both callers
  want the same thing from it - one number, at the end, to print. Reset it
  before a run that wants its own figure.
*/
let nulCells = 0;

function stripNul(text) {
  if (String(text).indexOf('\u0000') === -1) return String(text);
  nulCells++;
  return String(text).replace(/\u0000/g, '');
}

function nulCount() { return nulCells; }
function resetNulCount() { nulCells = 0; }


/** The dashboard's own timezone. appsscript.json. */
const TZ = 'Asia/Dhaka';


/**
 * The moment at which it was this wall-clock time in Dhaka.
 *
 * Guess that the numbers are UTC, ask what that instant looks like in
 * Dhaka, and correct by however far off that was. Two steps rather than a
 * hardcoded +6 so that the zone's own rules decide - Bangladesh ran an hour
 * of daylight saving in 2009 and could again.
 */
function dhakaInstant(y, mo, d, h, mi, s) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);

  const p = {};
  new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(new Date(guess)).forEach(function (part) {
    p[part.type] = part.value;
  });

  const seen = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day),
                        p.hour === '24' ? 0 : Number(p.hour),
                        Number(p.minute), Number(p.second));

  return new Date(guess - (seen - guess));
}


/**
 * A date cell as an ISO timestamp, or null.
 *
 * NULL FOR ANYTHING BLANK-ISH, which is where isCompleted's whitespace rule
 * moves to in a typed column. A Completion Date of ' ' becomes NULL here, so
 * the ticket is open - the same answer the Apps Script side reaches.
 *
 * An unreadable date is REPORTED rather than quietly becoming null, because
 * a column of dates that silently emptied is how a KPI loses a month.
 *
 *
 * A TIMESTAMP WITH NO TIMEZONE ON IT MEANS DHAKA, AND SAYING SO MATTERS.
 *
 * The ITSM exports write '2026-08-20 10:00'. That is ten in the morning in
 * the office, and nothing in the text says so. Handed to `new Date`, a
 * string like that is read in the TIMEZONE OF THE PROCESS - so the same
 * export produces different instants depending on what the machine's clock
 * is set to.
 *
 * Today that is invisible, because the import runs on a Windows machine in
 * Dhaka and the two agree. It stops being invisible the moment this runs on
 * a server, and almost every Linux server in the world is set to UTC. Every
 * timestamp would then land six hours late, and the ones that matter are
 * the ones near midnight: a ticket raised at 20:00 on 31 August becomes
 * 02:00 on 1 September, and a MONTHLY KPI moves it into the wrong month.
 * One ticket, in the month whose whole margin is one ticket.
 *
 * So a naive timestamp is read as Dhaka explicitly, and a timestamp that
 * does carry a zone is believed. Nothing changes on a machine already set
 * to Dhaka - which is why no re-import is needed - and nothing changes when
 * it moves.
 */
function readDate(value, problems, where) {
  if (isBlank(value)) return null;
  const text = stripNul(String(value).trim());

  // 2026-08-20 10:00, 2026-08-20 10:00:00, 2026-08-20T10:00
  const naive = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (naive) {
    return dhakaInstant(Number(naive[1]), Number(naive[2]), Number(naive[3]),
                        Number(naive[4]), Number(naive[5]),
                        Number(naive[6] || 0)).toISOString();
  }

  // 2026-08-20. ISO says a bare date is UTC midnight, which is 6am in the
  // office - a day that starts at breakfast. Midnight in Dhaka is what the
  // export means.
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (day) {
    return dhakaInstant(Number(day[1]), Number(day[2]), Number(day[3]),
                        0, 0, 0).toISOString();
  }

  // Anything else - an ISO string with a Z or an offset, or one of the
  // wordier formats - says what it means, so it is believed.
  const when = new Date(text);
  if (isNaN(when.getTime())) {
    if (problems) problems.push(where + ': cannot read the date ' + JSON.stringify(text));
    return null;
  }
  return when.toISOString();
}


/** A number cell, or null. Blank is null, not zero. */
function readNumber(value, problems, where) {
  if (isBlank(value)) return null;
  const n = parseFloat(stripNul(String(value).trim()));
  if (isNaN(n)) {
    if (problems) problems.push(where + ': cannot read the number ' +
                                JSON.stringify(String(value)));
    return null;
  }
  return n;
}


/**
 * One row of cells, in COLUMNS order, as the values for MERGE_SQL.
 *
 * @param {Array} cells      29 cells in COLUMNS order; short rows are padded
 * @param {Object} [opts]
 * @param {string} [opts.lastUpdated]  ISO timestamp that REPLACES whatever
 *     the caller put in the Last Updated cell. The Uploads screen passes the
 *     upload's own start time here, for the reason Ingest.gs gives:
 *
 *       "An upload arrives in batches 500 seconds apart, and mergeRows
 *        decides which of two rows for the same ticket is newer by comparing
 *        these - so two files of the same upload have to carry the same
 *        stamp, or the last batch to land would outrank the first for no
 *        reason."
 *
 * @param {string[]} [opts.problems]  unreadable cells are appended here
 * @param {string}   [opts.where]     what to call this row in a problem
 * @return {Array} values, one per column, ready for MERGE_SQL
 */
function valuesFromCells(cells, opts) {
  const o = opts || {};
  const row = cells || [];

  return COLUMNS.map(function (c, i) {
    const col = c[1];
    const kind = c[2];
    const cell = row[i];

    if (col === 'last_updated' && o.lastUpdated) return o.lastUpdated;
    if (kind === 'ts')   return readDate(cell, o.problems, o.where);
    if (kind === 'num')  return readNumber(cell, o.problems, o.where);
    if (kind === 'bool') return truthy(cell);
    return isBlank(cell) ? '' : stripNul(String(cell).trim());
  });
}


// ---------------------------------------------------------------------------
// The merge, as one statement
// ---------------------------------------------------------------------------
/**
 * Ingest.gs mergeRows, written as ON CONFLICT DO UPDATE.
 *
 * The original reads the existing row, merges in JavaScript and writes the
 * result back. That is a read-modify-write, and two uploads running together
 * would each start from the same copy. One statement cannot do that: the row
 * is read and written inside it, by the database.
 *
 * Written out by rule rather than by hand, because twenty-four
 * near-identical CASE expressions typed one after another is twenty-four
 * chances to paste the wrong column name into one of them - and that mistake
 * is invisible: the import succeeds and one field silently stops updating.
 *
 * RETURNING (xmax = 0) is how a caller tells an insert from an update. xmax
 * holds the transaction that deleted or locked a row version; on a row this
 * statement has just created it is 0, and on one it updated it is not.
 */
function buildMergeSql() {
  const placeholders = NAMES.map(function (_, i) { return '$' + (i + 1); });

  const sets = [];
  COLUMNS.forEach(function (c) {
    const col = c[1];
    const kind = c[2];
    if (col === 'ticket_id' || SPECIAL.indexOf(col) !== -1) return;

    // Blank means '' for text and NULL for everything typed.
    const incomingBlank = kind === 'text'
      ? "btrim(EXCLUDED." + col + ") = ''"
      : 'EXCLUDED.' + col + ' IS NULL';
    const existingBlank = kind === 'text'
      ? "btrim(ticket." + col + ") = ''"
      : 'ticket.' + col + ' IS NULL';

    sets.push(
      '  ' + col + ' = CASE' +
      ' WHEN ' + incomingBlank + ' THEN ticket.' + col +
      ' WHEN ' + existingBlank + ' OR EXCLUDED.last_updated >' +
      " coalesce(ticket.last_updated, 'epoch'::timestamptz)" +
      ' THEN EXCLUDED.' + col +
      ' ELSE ticket.' + col + ' END');
  });

  sets.push('  in_overall = ticket.in_overall OR EXCLUDED.in_overall');
  sets.push('  in_dept    = ticket.in_dept    OR EXCLUDED.in_dept');

  /*
    The union of two ' | ' separated lists, unique, order preserved. Done in
    SQL so that it happens inside the same statement as everything else -
    pulling the existing list into JavaScript to concatenate it would put
    the read back outside the write.

    WITH ORDINALITY is what keeps the order: without it the DISTINCT could
    hand the names back in any order it liked, and the audit trail would
    stop saying which file arrived first.
  */
  sets.push(
    "  source_files = (\n" +
    "    SELECT coalesce(string_agg(f, ' | ' ORDER BY n), '')\n" +
    "      FROM (SELECT DISTINCT ON (f) f, n FROM unnest(\n" +
    "              string_to_array(\n" +
    "                CASE WHEN btrim(ticket.source_files) = '' THEN EXCLUDED.source_files\n" +
    "                     WHEN btrim(EXCLUDED.source_files) = '' THEN ticket.source_files\n" +
    "                     ELSE ticket.source_files || ' | ' || EXCLUDED.source_files END,\n" +
    "                ' | ')\n" +
    "            ) WITH ORDINALITY AS t(f, n)\n" +
    "            WHERE btrim(f) <> ''\n" +
    "            ORDER BY f, n) AS u)");

  return 'INSERT INTO ticket (' + NAMES.join(', ') + ')\n' +
         'VALUES (' + placeholders.join(', ') + ')\n' +
         'ON CONFLICT (ticket_id) DO UPDATE SET\n' +
         sets.join(',\n') + '\n' +
         'RETURNING (xmax = 0) AS inserted';
}


/** Built once. It is the same statement every time; building it per row
 *  would be twenty-nine string concatenations per ticket for no reason. */
const MERGE_SQL = buildMergeSql();


module.exports = {
  COLUMNS, SPECIAL, HEADERS, NAMES, AT,
  TZ, dhakaInstant,
  isBlank, truthy, stripNul, nulCount, resetNulCount,
  readDate, readNumber, valuesFromCells,
  buildMergeSql, MERGE_SQL
};
