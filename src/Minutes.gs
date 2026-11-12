/**
 * Minutes.gs - the four sections' bi-weekly meeting minutes.
 * =========================================================================
 *
 * WHAT THIS IS
 * EAS runs four standing meetings, one per section of the organogram. Each
 * has been kept as a PowerPoint deck: one slide per meeting, copied forward
 * from the last one and edited. Four decks, four layouts, four owners, on
 * somebody's laptop.
 *
 *   FICO   Financial Applications      "Weekly Meeting (FI/CO)"
 *   SDMM   Sales Applications          "SD & MM_PUR Bi-Weekly Connect"
 *   SCA    Supply Chain Applications   "Supply Chain Application"
 *   PP     Manufacturing Applications  "Weekly Connect (PP)"
 *
 * This file moves that into the portal without moving the LAYOUTS. Each
 * section keeps its own shape - FI/CO's single wide table, SD's two
 * side-by-side control tables, SCA's two columns of small tables and free
 * text, PP's one wide zone table - because those shapes are what each
 * section reads at speed, and a house style imposed on all four would cost
 * four teams their habits to gain nothing.
 *
 * WHY A MEETING IS A COPY OF THE ONE BEFORE IT
 * Asked how the agenda changes, the team's own answer was: "agenda can
 * change, we copy the latest slide and then edit on the copied slide." So
 * that is exactly what newMinutes() does - it duplicates the previous
 * meeting of that section verbatim and changes the date. Nothing is cleared
 * and nothing is defaulted, because a cleared cell is a question the host
 * now has to answer and a copied one is a line they can leave alone.
 *
 * The templates below are therefore a SEED, not a form. They are used once
 * per section - for the very first meeting, when there is nothing to copy -
 * and after that the sheet carries the truth. Add a row to a meeting and
 * every later meeting has it; this file never needs to know.
 *
 * WHY THE BODY IS JSON IN ONE CELL
 * The four layouts have genuinely different tables: four columns here, six
 * there, a merged group column in two of them, free text in another. A tab
 * general enough to hold all four would be block/row/column/value - four
 * hundred rows per meeting and unreadable to anybody who opens the
 * spreadsheet. Instead the metadata that people search on - section, date,
 * host, who saved it and when - sits in real columns, and the body of the
 * meeting is one JSON cell beside it. A full SD meeting, the longest of the
 * four, measures about 1.6KB against the 50,000 characters a cell holds.
 *
 * WHAT IS NOT IN THIS FILE
 * No names. The seeds carry column headings and the standing activity list -
 * "POD vs. Billing", "Export Register Check" - and leave every Owner, Resp.
 * and Attendee cell empty. This repository is public; the people are in the
 * TEAM tab and the minutes are in the spreadsheet, and both stay there.
 *
 * WHO MAY DO WHAT
 *   read any section's minutes    anyone signed in
 *   write a section's minutes     that section, its head, the department
 *                                 head, admin
 *   delete a meeting              that section's head, department head, admin
 *
 * Reading is open on purpose. The four meetings exist so that the sections
 * know what the other three are dealing with, and a permission wall between
 * them would recreate the problem the portal is here to solve.
 */


// ---------------------------------------------------------------------------
// THE TABS
// ---------------------------------------------------------------------------

/**
 * One row per meeting.
 *
 * Body is the JSON described above. History is who saved it and when, most
 * recent first - the same shape OBJ_LOG keeps, and for the same reason: when
 * two people edit the same meeting, the only useful question afterwards is
 * who touched it last.
 */
const MIN_MEET_COLUMNS = [
  'Meeting ID', 'Section', 'Date', 'Time', 'Host', 'Attendees',
  'Status', 'Body', 'By', 'By ID', 'At', 'History'
];

/** How many saves are kept against a meeting before the oldest is dropped. */
const MIN_HISTORY_KEPT = 20;

/** How many of those the page is sent. */
const MIN_HISTORY_SHOWN = 8;

/**
 * A meeting is DRAFT until somebody marks it FINAL. Nothing is enforced on
 * a draft - it is a label, so that a half-written meeting can be told apart
 * from one that was presented.
 */
const MIN_DRAFT = 'DRAFT';
const MIN_FINAL = 'FINAL';

/**
 * The body cell ceiling, well under the 50,000 characters a cell holds. A
 * save that would exceed it is refused with the size in the message rather
 * than silently truncated, because a truncated JSON body does not parse and
 * the meeting would read as empty.
 */
const MIN_BODY_MAX = 45000;

/** One free-text answer. Long enough for a paragraph, short of an essay. */
const MIN_TEXT_MAX = 4000;

/** One table cell. */
const MIN_CELL_MAX = 500;

/** Guards against a pasted table running away with the tab. */
const MIN_ROWS_MAX = 120;


function minMeetTab() {
  return sheetWithHeaders(minTabName('MIN_MEET'), MIN_MEET_COLUMNS);
}

/**
 * The tab's name from CONFIG when it is there, and the literal otherwise.
 *
 * CONFIG.SHEETS is where every other tab name lives and this one belongs
 * there too. The fallback is so that this file works against a Config.gs
 * that has not been updated yet, which is the state every deployment is in
 * for the few minutes between pasting one file and pasting the next.
 */
/**
 * A value worth not working out twice, for a few minutes.
 *
 * Never throws and never refuses to answer: CacheService is simply absent
 * in some contexts, and a page that fell over because a cache was missing
 * would be worse than a slow one. A failed read or write costs the speed
 * and nothing else.
 */
function minCached(key, seconds, build) {
  let cache = null;
  try { cache = CacheService.getScriptCache(); } catch (e) { cache = null; }

  if (cache) {
    try {
      const had = cache.get(key);
      if (had) return JSON.parse(had);
    } catch (e) { /* a bad entry is no entry */ }
  }

  const made = build();
  if (cache) {
    try { cache.put(key, JSON.stringify(made), seconds); }
    catch (e) { /* too big, or unavailable; it still works, just slower */ }
  }
  return made;
}


function minTabName(name) {
  const sheets = (typeof CONFIG !== 'undefined' && CONFIG && CONFIG.SHEETS) || {};
  return sheets[name] || name;
}


// ---------------------------------------------------------------------------
// THE FOUR SECTIONS
// ---------------------------------------------------------------------------

/**
 * Section code -> what it is called, which Sub-Department owns it, and what
 * the deck's own title line says.
 *
 * SUB-DEPARTMENT IS THE JOIN. It is the Sub-Department column of the TEAM
 * tab, the same string CONFIG.SECTION_MODULES is keyed on, so there is no
 * second list of who is in which section to drift out of step. Somebody
 * moved between sections in the directory can write their new section's
 * minutes the moment the cell is changed.
 *
 * 'Sales Applications' owns the SD & MM_PUR connect. The team calls that
 * meeting Sales & Customer Applications; the organogram calls the section
 * Sales Applications. Same section, two names, and the directory's spelling
 * is the one that has to match.
 */
/*
  EACH SECTION'S `theme` IS ITS DECK'S OWN PALETTE, read off the deck rather
  than chosen here. FI/CO is brown, PP is navy over a bright blue header
  band, Supply Chain is a dark teal on pale blue, SD is colour-coded by how
  often each check runs. Those are not decoration: on SD the tint is how
  somebody finds the daily block without reading, and on PP it is how they
  find their zone.

  The values were sampled from the rendered slides, not from the theme
  accents in the file - PowerPoint tints a table cell's scheme colour before
  it draws it, so the accent in the XML (a saturated orange) is nothing like
  the pale peach anybody actually sees.

    band   the title block behind the meeting's name and date
    head   a table's header row
    ink    the text on band and head
    rule   the line between cells
*/
const MIN_SECTIONS = [
  {
    code: 'FICO',
    name: 'Financial Applications',
    short: 'FI / CO',
    subs: ['Financial Applications'],
    title: 'Weekly Meeting (FI/CO)',
    purpose: 'To review Financial Application operational status across all ' +
             'plants, prevent issues and keep everyone aligned',
    layout: 'wide',
    theme: { band: '#7c3414', head: '#7c3414', ink: '#ffffff',
             rule: '#e8d0c8', title: '#ffffff' }
  },
  {
    code: 'SDMM',
    name: 'Sales & Customer Applications',
    short: 'SD & MM_PUR',
    /*
      TWO SPELLINGS, and the first is the one the directory uses.

      Config.gs's SECTION_MODULES still calls this section 'Sales
      Applications' - an older name that no longer matches the TEAM tab -
      and seeding from that list cost the whole section its write button,
      silently, until checkMinutes was run. Both are accepted so that
      correcting one list does not break the other.
    */
    subs: ['Sales & Customer Applications', 'Sales Applications'],
    title: 'SD & MM_PUR Bi-Weekly Connect',
    purpose: 'Sales and customer applications across all zones',
    layout: 'split',
    theme: { band: '#ffffff', head: '#deeaf6', ink: '#1d1d1b',
             rule: '#b4b4b4', title: '#7030a0' }
  },
  {
    code: 'SCA',
    name: 'Supply Chain Applications',
    short: 'Supply Chain',
    subs: ['Supply Chain Applications'],
    title: 'Supply Chain Application',
    purpose: 'Master data and inventory management across all zones',
    layout: 'split',
    theme: { band: '#ecf9fe', head: '#104862', ink: '#ffffff',
             rule: '#ffffff', title: '#0070c0' }
  },
  {
    code: 'PP',
    name: 'Manufacturing Applications',
    short: 'PP',
    subs: ['Manufacturing Applications'],
    title: 'Weekly Connect (PP)',
    purpose: 'To review operational status across all sites',
    layout: 'wide',
    theme: { band: '#204494', head: '#0070c0', ink: '#ffffff',
             rule: '#ffffff', title: '#ffffff' }
  }
];



/** A section by its code, or null. */
function minSection(code) {
  const want = String(code || '').trim().toUpperCase();
  for (let i = 0; i < MIN_SECTIONS.length; i++) {
    if (MIN_SECTIONS[i].code === want) return MIN_SECTIONS[i];
  }
  return null;
}


/**
 * The section code a Sub-Department belongs to, or ''.
 *
 * Matched case-insensitively and on the trimmed string, because a directory
 * cell typed by hand is 'Supply chain applications' about as often as it is
 * the org chart's own capitalisation.
 */
function minSectionOfSub(sub) {
  const want = String(sub || '').trim().toUpperCase();
  if (!want) return '';
  for (let i = 0; i < MIN_SECTIONS.length; i++) {
    const spellings = MIN_SECTIONS[i].subs || [];
    for (let k = 0; k < spellings.length; k++) {
      if (spellings[k].toUpperCase() === want) return MIN_SECTIONS[i].code;
    }
  }
  return '';
}


/** What to call a section in a sentence: its own name. */
function minSubOf(section) {
  return (section && section.subs && section.subs[0]) || '';
}


// ---------------------------------------------------------------------------
// THE SEEDS
// ---------------------------------------------------------------------------
/*
  One per section, transcribed from the deck each section is actually using.
  Read the header of this file for why these are a seed and not a form.

  A BLOCK is one thing on the slide:

    type 'table'   columns + rows. `groups` lists the column indexes whose
                   blank cells continue the value above them - SD's
                   frequency column, PP's zone column, and both of FI/CO's
                   first two. The page draws those as merged cells and the
                   deck export merges them for real.

                   `tones` tints each run of that first group column in
                   turn, cycling: SD's daily block peach, weekly green,
                   monthly peach; PP's three zones lavender, mint, pink.
                   By RUN and not by the text in the cell, so renaming a
                   group does not silently recolour the table.

                   `zebra` alternates a second tint within each run, which
                   is how FI/CO separates RMG from MG.

                   A column may carry `span` to widen its heading over the
                   columns after it - FI/CO's single 'Status' heading sits
                   over both the sector and the status - `tint` or
                   `cellTint` to colour its header or its cells, and `plain`
                   to sit out the row tone. SD uses the last of those to
                   tint what is CHECKED and leave what it SAID on white.

    type 'notes'   one or more labelled free-text lines. `lines` is a list
                   of { key, label }; a single unlabelled line is the common
                   case and is written as one entry with an empty label.

  `side` is 'left', 'right' or 'full' and only means anything on a section
  whose layout is 'split'. On a 'wide' section everything is full width.

  Column `label` is what the deck prints, which is not always what the column
  holds - see the note on FICO below. `key` is what the body JSON is keyed
  on and is never shown.
*/
const MIN_SEEDS = {

  /*
    FI/CO. One wide table under one heading, in the deck's brown.

    'STATUS' IS ONE HEADING OVER TWO COLUMNS, not a header row that has
    slipped. Reading the file's XML it looks like an off-by-one - the third
    column is headed Status and holds RMG or MG, and the fourth has no
    heading at all - and an earlier version of this comment said exactly
    that. The rendered slide shows a single merged Status cell spanning
    both, which is correct and reads correctly. It is reproduced with
    `span`.

    Module and Zone both merge downward, so every zone covers its own RMG
    and MG rows.
  */
  FICO: [
    { id: 'ops', type: 'table', side: 'full',
      title: 'Operational Issues/Escalations',
      groups: [0, 1],
      tones: ['#f8e8e8'],
      zebra: '#f4d4cc',
      columns: [
        { key: 'module', label: 'Module', width: 27 },
        { key: 'zone',   label: 'Zone',   width: 25 },
        { key: 'sector', label: 'Status', width: 24, span: 2 },
        { key: 'status', label: '',       width: 24 }
      ],
      rows: [
        ['1.  FI/TR', 'DEPZ', 'RMG', 'Normal Trend'],
        ['',          '',     'MG',  'Normal Trend'],
        ['',          'KEPZ', 'RMG', 'Normal Trend'],
        ['',          '',     'MG',  'Normal Trend'],
        ['',          'CEPZ', 'RMG', 'Normal Trend'],
        ['',          '',     'MG',  'Normal Trend'],
        ['2.  CO',    'DEPZ', 'RMG', 'Normal Trend'],
        ['',          '',     'MG',  'Normal Trend'],
        ['',          'KEPZ', 'RMG', 'Normal Trend'],
        ['',          '',     'MG',  'Normal Trend'],
        ['',          'CEPZ', 'RMG', 'Normal Trend'],
        ['',          '',     'MG',  'Normal Trend']
      ] }
  ],

  /*
    SD & MM_PUR. Two control tables side by side, then one escalation line
    across the bottom.

    THE TWO TABLES PUT THE ZONES IN DIFFERENT ORDERS - SD reads DEPZ, CEPZ,
    KEPZ and MM_PUR reads CEPZ, KEPZ, DEPZ. That is how the deck has them.
    It is almost certainly an accident, and it is also how the section reads
    the numbers every fortnight, so it is reproduced rather than tidied.
  */
  SDMM: [
    { id: 'sd', type: 'table', side: 'left',
      title: 'SD-Key Control Management',
      groups: [0],
      tones: ['#fbe2d5', '#dcefd5', '#fbe2d5'],   // daily, weekly, monthly
      columns: [
        { key: 'freq',     label: 'Activity', width: 10, span: 2,
          tint: '#deeaf6' },
        { key: 'activity', label: '',         width: 40 },
        { key: 'resp',     label: 'Resp.',    width: 12, tint: '#f2e2f2',
          cellTint: '#dcefd5' },
        { key: 'depz',     label: 'DEPZ',     width: 13, tint: '#dae3f3',
          plain: true },
        { key: 'cepz',     label: 'CEPZ',     width: 12, tint: '#f2e2f2',
          plain: true },
        { key: 'kepz',     label: 'KEPZ',     width: 13, tint: '#dcefd5',
          plain: true }
      ],
      rows: [
        ['Daily Activity',   'POD vs. Billing',                      'RMG/MG', 'Normal', 'Normal', 'Normal'],
        ['',                 'Delivery Challan Status Check',        'MG',     'Normal', 'Normal', 'Normal'],
        ['Weekly Activity',  'Commercial Invoice Check',             'RMG/MG', 'Normal', 'Normal', 'Normal'],
        ['',                 'BL Management Check',                  '',       'Normal', 'Normal', 'Normal'],
        ['',                 'Bank Key Mapping Check',               'RMG',    'Normal', 'Normal', 'Normal'],
        ['',                 'Export Register Check',                'RMG',    'Normal', 'Normal', 'Normal'],
        ['',                 'Export Cost Register Check',           'RMG',    'Normal', 'Normal', 'Normal'],
        ['',                 'Release Billing Docs for Accounting',  'RMG/MG', 'Normal', 'Normal', 'Normal'],
        ['',                 'SO vs BOM Monitoring',                 'RMG',    'Normal', 'Normal', 'Normal'],
        ['',                 'GI vs POD Check',                      'RMG/MG', 'Normal', 'Normal', 'Normal'],
        ['',                 'Over Delivery Tracking Report',        'MG',     'Normal', 'Normal', 'Normal'],
        ['',                 'Unnecessary SO stock Check',           'MG',     'Normal', 'Normal', 'Normal'],
        ['Monthly Activity', 'Unnecessary Delivery Order Monitoring', 'RMG/MG', 'Normal', 'Normal', 'Normal'],
        ['',                 'Ship Plan vs Delivery Order',          'RMG/MG', 'Normal', 'Normal', 'Normal']
      ] },

    { id: 'mm', type: 'table', side: 'right',
      title: 'MM_PUR. Key Point Monitoring',
      groups: [0],
      tones: ['#fbe2d5', '#ffffff', '#fbe2d5'],   // daily, weekly, monthly
      columns: [
        { key: 'freq',     label: 'Activity', width: 15, span: 2,
          tint: '#deeaf6' },
        { key: 'activity', label: '',         width: 43 },
        { key: 'resp',     label: 'Resp.',    width: 10, cellTint: '#dcefd5' },
        { key: 'cepz',     label: 'CEPZ',     width: 11 },
        { key: 'kepz',     label: 'KEPZ',     width: 10 },
        { key: 'depz',     label: 'DEPZ',     width: 11 }
      ],
      rows: [
        ['Daily Monitoring',             'Info. Record (Freight & Custom)', 'RMG/MG', 'Normal', 'Normal', 'Normal'],
        ['',                             'Int. PO-SO Monitor',              'RMG/MG', 'Normal', 'Normal', 'Normal'],
        ['',                             'PO Over Percentage',              'RMG',    'Normal', 'Normal', 'Normal'],
        ['',                             'PO Monitoring',                   'RMG/MG', 'Normal', 'Normal', 'Normal'],
        ['',                             'PO Monitoring (SAM/REP)',         'RMG',    'Normal', 'Normal', 'Normal'],
        ['Weekly / Bi-Weekly Monitoring', 'PO Print Status',                'RMG',    'Normal', 'Normal', 'Normal'],
        ['',                             'PO Pending Status',               'RMG',    'Normal', 'Normal', 'Normal'],
        ['Monthly Monitoring',           'PO Pending Status',               'RMG/MG', 'Normal', 'Normal', 'Normal'],
        ['',                             'Unsettled PO Check',              'RMG/MG', 'Normal', 'Normal', 'Normal']
      ] },

    { id: 'esc', type: 'notes', side: 'full', title: 'Escalation',
      lines: [
        { key: 'one', label: '1.', value: 'Nil' },
        { key: 'two', label: '2.', value: 'Nil' }
      ] }
  ],

  /*
    Supply Chain. Master data down the left, inventory management down the
    right, each a small table under its own heading, then action plan and
    knowledge share.

    ONE SEEDED ZONE IS CORRECTED. The deck's follow-up objectives table lists
    DEPZ twice and never KEPZ, which is a copy-paste slip in a three-row
    table whose other two rows are DEPZ and CEPZ. Seeding it as written would
    bake the slip into every future meeting, so the third row reads KEPZ
    here. Nothing else is changed.
  */
  SCA: [
    { id: 'mdIssue', type: 'table', side: 'left',
      title: 'MD/ Master Data Processing Issue & Escalations:',
      tones: ['#ecf9fe'],
      columns: [
        { key: 'zone',   label: 'Zone',              width: 10 },
        { key: 'issue',  label: 'Issue Description', width: 41 },
        { key: 'status', label: 'Status',            width: 25 },
        { key: 'owner',  label: 'Owner',             width: 24 }
      ],
      rows: [
        ['DEPZ', '', 'Normal Trend', ''],
        ['CEPZ', '', 'Normal Trend', ''],
        ['KEPZ', '', 'Normal Trend', '']
      ] },

    { id: 'mdWeight', type: 'table', side: 'left',
      title: 'MD/ Net weight Info update (Weekly):',
      tones: ['#ecf9fe'],
      columns: [
        { key: 'zone',   label: 'Zone',   width: 10 },
        { key: 'status', label: 'Status', width: 73 },
        { key: 'owner',  label: 'Owner',  width: 17 }
      ],
      rows: [
        ['DEPZ', '', ''],
        ['CEPZ', '', ''],
        ['KEPZ', '', '']
      ] },

    { id: 'mdOther', type: 'notes', side: 'left',
      title: 'MD/ other topics discussion:',
      lines: [{ key: 'text', label: '', value: '' }] },

    { id: 'mmFind', type: 'table', side: 'right',
      title: 'MM/ Inventory Management (Application Process Findings):',
      groups: [0],
      tones: ['#ecf9fe'],
      columns: [
        { key: 'process', label: 'Application Process', width: 33 },
        { key: 'zone',    label: 'Zone',                width: 22 },
        { key: 'status',  label: 'Status',              width: 19 },
        { key: 'owner',   label: 'Owner',               width: 26 }
      ],
      rows: [
        ['1. Goods Receipt\n2. Goods Issue\n3. Stock Transfer\n' +
         '4. Leftover Management\n5. Inventory Management',
         'DEPZ-(RMG & MG)', 'Normal Trend', ''],
        ['', 'CEPZ-(RMG & MG)', 'Normal Trend', ''],
        ['', 'KEPZ-(RMG & MG)', 'Normal Trend', '']
      ] },

    { id: 'mmObj', type: 'table', side: 'right',
      title: 'MM/ Follow-up Objectives (Inventory Management):',
      groups: [0],
      tones: ['#ecf9fe'],
      columns: [
        { key: 'objective', label: 'Objective Description', width: 57 },
        { key: 'zone',      label: 'Zone',                  width: 22 },
        { key: 'status',    label: 'Status',                width: 21 }
      ],
      rows: [
        ['1. Document Reversal Posting (RM GR-GI) - [Daily]\n' +
         '2. Weekly RM Leftover Declaration - [Monthly]\n' +
         '3. STO Monitoring - [Weekly/ Monthly]\n' +
         '4. Requisition-based GI Status Check - [Monthly]\n' +
         '5. GR-based IV - [Monthly]\n' +
         '6. Aging Report - [Monthly]\n' +
         '7. Sister Plant reconciliation - [Monthly]',
         'DEPZ-(RMG & MG)', 'Follow-up by responsible person'],
        ['', 'CEPZ-(RMG & MG)', 'Follow-up by responsible person'],
        ['', 'KEPZ-(RMG & MG)', 'Follow-up by responsible person']
      ] },

    { id: 'action', type: 'notes', side: 'right', title: 'Action Plan:',
      lines: [
        { key: 'md', label: 'MD:',      value: '' },
        { key: 'mm', label: 'MM(INV):', value: '' }
      ] },

    { id: 'knowledge', type: 'notes', side: 'right',
      title: 'Knowledge Share, Tips & Tricks, Upskilling:',
      lines: [{ key: 'text', label: '', value: '' }] }
  ],

  /*
    PP. One wide table across the whole slide, then the discussion.
  */
  PP: [
    { id: 'ops', type: 'table', side: 'full', title: '',
      groups: [0],
      // lavender, mint, pink - one per zone, which is how somebody finds
      // their own three rows on a slide across the room.
      tones: ['#e8e8fc', '#a4ecdc', '#f4e8f4'],
      columns: [
        { key: 'zone',   label: 'Zone',                  width: 15 },
        { key: 'sector', label: 'Sector',                width: 18 },
        { key: 'status', label: 'Status',                width: 21 },
        { key: 'follow', label: 'Follow Up/Action Items', width: 46 }
      ],
      rows: [
        ['KEPZ', 'RMG', 'Normal', ''],
        ['',     'MG',  'Normal', ''],
        ['DEPZ', 'RMG', 'Normal', ''],
        ['',     'MG',  'Normal', ''],
        ['CEPZ', 'RMG', 'Normal', ''],
        ['',     'MG',  'Normal', '']
      ] },

    { id: 'topics', type: 'notes', side: 'full',
      title: 'Main Topic Discussion',
      lines: [{ key: 'text', label: '', value: '' }] }
  ]
};


/**
 * A section's seed, deep-copied.
 *
 * COPIED, because the caller writes into the rows it gets back and a shared
 * reference would mean the first meeting ever created in a section quietly
 * became that section's seed for the rest of the script's life.
 */
function minSeedBlocks(code) {
  const seed = MIN_SEEDS[String(code || '').trim().toUpperCase()];
  return seed ? JSON.parse(JSON.stringify(seed)) : [];
}


// ---------------------------------------------------------------------------
// THE BODY
// ---------------------------------------------------------------------------

/**
 * The body cell, parsed, never throwing.
 *
 * A meeting whose JSON will not parse reads as an empty meeting rather than
 * taking the page down with it. That is the right trade: one unreadable
 * meeting is a thing somebody can retype, and a Minutes tab that will not
 * open is not.
 */
function parseMinBody(cell) {
  const text = String(cell === null || cell === undefined ? '' : cell).trim();
  if (!text) return minEmptyBody();

  let body = null;
  try { body = JSON.parse(text); } catch (e) { return minEmptyBody(); }
  if (!body || typeof body !== 'object') return minEmptyBody();

  const out = minEmptyBody();
  if (body.head && typeof body.head === 'object') {
    out.head.purpose = String(body.head.purpose || '');
    out.head.minutesBy = String(body.head.minutesBy || '');
  }
  if (body.blocks && typeof body.blocks === 'object') out.blocks = body.blocks;
  return out;
}


function minEmptyBody() {
  return { v: 1, head: { purpose: '', minutesBy: '' }, blocks: [] };
}


/**
 * The body as it goes into the cell, with the ceiling enforced.
 *
 * Throws rather than truncates - see MIN_BODY_MAX.
 */
function minBodyText(body) {
  const text = JSON.stringify(body || minEmptyBody());
  if (text.length > MIN_BODY_MAX) {
    throw new Error('This meeting is too long to save (' + text.length +
                    ' characters against a limit of ' + MIN_BODY_MAX +
                    '). Shorten the longest notes, or split the meeting.');
  }
  return text;
}


/**
 * One incoming block, cleaned.
 *
 * EVERYTHING THE PAGE SENDS IS REBUILT HERE rather than trusted and stored.
 * The body is JSON written back into a cell and read by every later reader,
 * so an unchecked save is an unchecked save for everyone afterwards. Cells
 * are strings, trimmed, capped; rows are capped; unknown keys are dropped.
 */
function minCleanBlock(block) {
  if (!block || typeof block !== 'object') return null;

  const id = String(block.id || '').trim();
  if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(id)) return null;

  const type = block.type === 'notes' ? 'notes' : 'table';
  const out = { id: id, type: type };

  if (type === 'notes') {
    const lines = [];
    const given = Array.isArray(block.lines) ? block.lines : [];
    for (let i = 0; i < given.length && i < 20; i++) {
      const line = given[i] || {};
      const key = String(line.key || '').trim();
      if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(key)) continue;
      lines.push({ key: key, value: minText(line.value, MIN_TEXT_MAX) });
    }
    out.lines = lines;
    return out;
  }

  const rows = [];
  const given = Array.isArray(block.rows) ? block.rows : [];
  for (let r = 0; r < given.length && r < MIN_ROWS_MAX; r++) {
    const row = Array.isArray(given[r]) ? given[r] : [];
    const cells = [];
    for (let c = 0; c < row.length && c < 12; c++) {
      cells.push(minText(row[c], MIN_CELL_MAX));
    }
    rows.push(cells);
  }
  out.rows = rows;
  return out;
}


/**
 * A string, trimmed and capped, with the line endings normalised.
 *
 * Carriage returns are stripped because a cell pasted out of PowerPoint
 * carries them and JSON.stringify keeps them, which means the same text
 * saved twice from two machines produces two different cells and the history
 * records a change nobody made.
 */
function minText(value, max) {
  let text = String(value === null || value === undefined ? '' : value);
  text = text.replace(/\r\n?/g, '\n').replace(/[\t\v\f\u0000-\u0008]/g, ' ');
  text = text.replace(/[ ]+$/gm, '');
  if (text.length > max) text = text.slice(0, max);
  return text.trim();
}


// ---------------------------------------------------------------------------
// IDS AND DATES
// ---------------------------------------------------------------------------

/** A date cell, as yyyy-MM-dd, or '' when the cell holds nothing usable. */
function minDate(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, minZone(), 'yyyy-MM-dd');
  }
  const text = String(value === null || value === undefined ? '' : value).trim();
  const hit = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  return hit ? hit[1] + '-' + hit[2] + '-' + hit[3] : '';
}


function minZone() {
  try { return Session.getScriptTimeZone() || 'Asia/Dhaka'; }
  catch (e) { return 'Asia/Dhaka'; }
}


/**
 * SECTION-YYYYMMDD, with a suffix when that section already met that day.
 *
 * READABLE IN THE SHEET IS THE WHOLE POINT. Somebody looking at the tab to
 * find the meeting of 24 February should be able to see it without opening
 * the body, and a generated id of 'm_lx94kd' would mean sorting by date to
 * find anything.
 */
function minMakeId(sheet, code, date) {
  const base = code + '-' + String(date).replace(/-/g, '');
  const taken = {};
  const last = sheet.getLastRow();
  if (last >= 2) {
    const ids = sheet.getRange(2, 1, last - 1, 1).getValues();
    for (let i = 0; i < ids.length; i++) {
      taken[String(ids[i][0] || '').trim()] = true;
    }
  }
  if (!taken[base]) return base;
  for (let n = 2; n < 100; n++) {
    if (!taken[base + '-' + n]) return base + '-' + n;
  }
  return base + '-' + Date.now();
}


// ---------------------------------------------------------------------------
// READING
// ---------------------------------------------------------------------------

/** Every meeting, newest first. One read of the tab. */
function readMinutes() {
  const sheet = minMeetTab();
  const last = sheet.getLastRow();
  if (last < 2) return [];

  const wide = Math.max(sheet.getLastColumn(), MIN_MEET_COLUMNS.length);
  const rows = sheet.getRange(2, 1, last - 1, wide).getValues();
  const at = minColumnIndex(sheet.getRange(1, 1, 1, wide).getValues()[0]);

  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const id = String(row[at.id] || '').trim();
    if (!id) continue;

    out.push({
      id: id,
      section: String(row[at.section] || '').trim().toUpperCase(),
      date: minDate(row[at.date]),
      time: String(row[at.time] || '').trim(),
      host: String(row[at.host] || '').trim(),
      attendees: String(row[at.attendees] || '').trim(),
      status: String(row[at.status] || '').trim().toUpperCase() === MIN_FINAL
                ? MIN_FINAL : MIN_DRAFT,
      body: String(row[at.body] || ''),
      by: String(row[at.by] || '').trim(),
      byId: String(row[at.byId] || '').trim(),
      at: String(row[at.at] || '').trim(),
      history: parseMinHistory(row[at.history]),
      row: i + 2
    });
  }

  /*
    Newest first, and a meeting with no date last rather than first. Sorted
    on the id as a tie-break so that two meetings on one day keep the order
    they were created in, which is the order they happened in.
  */
  out.sort(function (a, b) {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return a.id < b.id ? 1 : -1;
  });
  return out;
}


/** Column positions by header name, so a reordered tab still reads. */
function minColumnIndex(headers) {
  const seen = {};
  for (let i = 0; i < headers.length; i++) {
    seen[String(headers[i] || '').trim().toLowerCase().replace(/[^a-z]/g, '')] = i;
  }
  const find = function (name, fallback) {
    const key = name.toLowerCase().replace(/[^a-z]/g, '');
    return seen[key] === undefined ? fallback : seen[key];
  };
  return {
    id:        find('Meeting ID', 0),
    section:   find('Section', 1),
    date:      find('Date', 2),
    time:      find('Time', 3),
    host:      find('Host', 4),
    attendees: find('Attendees', 5),
    status:    find('Status', 6),
    body:      find('Body', 7),
    by:        find('By', 8),
    byId:      find('By ID', 9),
    at:        find('At', 10),
    history:   find('History', 11)
  };
}


function parseMinHistory(cell) {
  const text = String(cell === null || cell === undefined ? '' : cell).trim();
  if (!text) return [];
  let list = null;
  try { list = JSON.parse(text); } catch (e) { return []; }
  if (!Array.isArray(list)) return [];

  const out = [];
  for (let i = 0; i < list.length && i < MIN_HISTORY_KEPT; i++) {
    const h = list[i] || {};
    out.push({ by: String(h.by || ''), id: String(h.id || ''),
               at: String(h.at || ''), what: String(h.what || '') });
  }
  return out;
}


// ---------------------------------------------------------------------------
// WHO IS ASKING
// ---------------------------------------------------------------------------

/**
 * The signed-in person's name, section and what they may write.
 *
 * Shaped like objWhoAmI and for the same reasons - one place where the rule
 * lives, and a `reason` the page can print when somebody has no section,
 * because "the button is missing" is not an explanation.
 */
function minWhoAmI(token) {
  const session = currentSession(token);
  const id = session ? String(session.u || '') : '';
  const admin = Boolean(session) && rankOf(session.r) >= rankOf(ROLE_ADMIN);

  const me = {
    id: id, name: id, admin: admin, head: false,
    section: '', write: [], remove: [], reason: ''
  };
  if (!id) return me;

  if (admin) {
    me.write = MIN_SECTIONS.map(function (s) { return s.code; });
    me.remove = me.write.slice();
  }

  /*
    THE DIRECTORY READ IS CACHED, and leaving it uncached was most of why
    this page felt slow.

    Every call to getMinutes asked minWhoAmI which section somebody is in,
    and minWhoAmI read the WHOLE TEAM tab to answer it - so switching
    between the four tabs cost four full directory reads, measured off a
    screen recording at between one and a half and three and a half seconds
    each, with nothing on screen in between.

    The answer is two short strings - your section, and whether you head one
    - and neither changes during a sitting. Keyed on the employee ID and the
    role, so signing in as an admin does not inherit the viewer's cached
    answer. The same thing objWhoAmI does, and for the same reason.
  */
  let team = null;
  try {
    team = minCached('min.team.' + id + '.' + (admin ? 'a' : 'u'), 600,
                     function () {
      const read = readTeam();
      // Trimmed to what this function uses. The whole directory carries
      // photo URLs and phone numbers, which have no business in a cache
      // and would push the entry past the 100KB one holds.
      const flat = [];
      const add = function (person, section) {
        if (!person) return;
        flat.push({ id: String(person.id || ''), name: person.name || '',
                    leads: person.leads || '', section: section || '' });
      };
      add(read.lead, read.lead ? read.lead.section : '');
      (read.sections || []).forEach(function (sec) {
        add(sec.head, sec.name);
        (sec.members || []).forEach(function (m) { add(m, sec.name); });
      });
      return { flat: flat };
    });
  } catch (e) { team = null; }

  if (!team) {
    me.reason = 'The team directory could not be read, so your section is ' +
                'not known.';
    return me;
  }

  let found = null;
  const everyone = (team && team.flat) || [];
  for (let i = 0; i < everyone.length; i++) {
    if (everyone[i].id === id) {
      found = { person: everyone[i], section: everyone[i].section };
      break;
    }
  }

  if (!found) {
    me.reason = 'Your employee ID is not in the team directory, so there is ' +
                'no section against your name.';
    return me;
  }

  me.name = found.person.name || id;
  me.section = minSectionOfSub(found.section);

  /*
    THE HEAD CELL SAYS WHICH SECTION, NOT JUST THAT SOMEBODY IS A HEAD. The
    department head covers Supply Chain on an interim basis while sitting in
    no section himself, and the directory records that by putting the section
    name in his Head cell. So a head's writing rights follow that cell, and
    his own Sub-Department of ALL grants nothing on its own.
  */
  const leads = String(found.person.leads || '').trim();
  const leadsOwn = /^(y|yes|true|1|head)$/i.test(leads);
  const leadsNamed = leads && !leadsOwn ? minSectionOfSub(leads) : '';

  const allow = function (code) {
    if (!code) return;
    if (me.write.indexOf(code) === -1) me.write.push(code);
  };
  const allowRemove = function (code) {
    if (!code) return;
    if (me.remove.indexOf(code) === -1) me.remove.push(code);
  };

  allow(me.section);
  if (leadsOwn) { me.head = true; allowRemove(me.section); }
  if (leadsNamed) {
    me.head = true;
    allow(leadsNamed);
    allowRemove(leadsNamed);
  }

  /*
    The department head writes and deletes everywhere. He is above the four
    sections on the organogram and chairs none of them, which is exactly the
    person who ends up fixing a meeting somebody typed into the wrong
    section.
  */
  if (minIsDepartmentHead(found.section)) {
    me.head = true;
    MIN_SECTIONS.forEach(function (s) { allow(s.code); allowRemove(s.code); });
  }

  if (!me.write.length) {
    me.reason = 'Your Sub-Department does not match one of the four meeting ' +
                'sections, so you can read these minutes but not write them. ' +
                'Ask for your Sub-Department cell to be checked.';
  }
  return me;
}


function minIsDepartmentHead(section) {
  const dept = (typeof CONFIG !== 'undefined' && CONFIG &&
                CONFIG.DEPARTMENT_SECTION) || 'ALL';
  return String(section || '').trim().toUpperCase() ===
         String(dept).trim().toUpperCase();
}


function minMayWrite(me, code) {
  if (!me || !me.id) return false;
  return me.write.indexOf(String(code || '').toUpperCase()) !== -1;
}


function minMayRemove(me, code) {
  if (!me || !me.id) return false;
  return me.remove.indexOf(String(code || '').toUpperCase()) !== -1;
}


// ---------------------------------------------------------------------------
// WHAT THE PAGE CALLS
// ---------------------------------------------------------------------------

/**
 * Everything the Minutes page needs, in one call.
 *
 * The LIST of every meeting in the section - which is small, a line each -
 * and the FULL BODY of exactly one. The page is a list beside a document and
 * sending every body would mean sending twenty-nine PP meetings to draw one.
 *
 * `meetingId` wins over `section` when both are given, so that a link
 * straight to a meeting works without the caller having to know which
 * section it is in.
 */
function getMinutes(token, section, meetingId) {
  requireSignedIn(token);
  return minPayload(minWhoAmI(token), section, meetingId);
}


/**
 * The same answer, for a caller that already knows who is asking.
 *
 * SPLIT OUT SO THAT A WRITE CAN ANSWER WITH IT. A save used to be two round
 * trips - write, then read the whole page back - and over the Apps Script
 * bridge that is two waits of a second or more each, for one press of one
 * button. Now the write returns the page in its answer and the second trip
 * is gone.
 */
function minPayload(me, section, meetingId) {
  const all = readMinutes();

  let want = null;
  const askedId = String(meetingId || '').trim();
  if (askedId) {
    for (let i = 0; i < all.length; i++) {
      if (all[i].id === askedId) { want = all[i]; break; }
    }
  }

  let code = want ? want.section : String(section || '').trim().toUpperCase();
  if (!minSection(code)) {
    // Nothing asked for, or something that is not a section: the viewer's own
    // section if they have one, and the first otherwise.
    code = minSection(me.section) ? me.section : MIN_SECTIONS[0].code;
  }

  const mine = all.filter(function (m) { return m.section === code; });
  if (!want) want = mine[0] || null;

  const list = mine.map(function (m) {
    return { id: m.id, date: m.date, time: m.time, host: m.host,
             status: m.status, by: m.by, at: m.at };
  });

  const counts = {};
  MIN_SECTIONS.forEach(function (s) { counts[s.code] = 0; });
  all.forEach(function (m) {
    if (counts[m.section] !== undefined) counts[m.section]++;
  });

  return {
    ok: true,
    me: { id: me.id, name: me.name, section: me.section, head: me.head,
          admin: me.admin, write: me.write, remove: me.remove,
          reason: me.reason },
    /*
      THE THEME TRAVELS WITH THE SECTION. It was left out of the first
      version of this payload, and the page went on drawing perfectly
      correct tables with no colour in them at all - the four decks reduced
      to four identical grey grids, which is the one thing this feature was
      not allowed to do. Nothing threw; `theme.head` was simply undefined
      and the inline background came out as the word "undefined".
    */
    sections: MIN_SECTIONS.map(function (s) {
      return { code: s.code, name: s.name, short: s.short,
               sub: minSubOf(s), title: s.title,
               purpose: s.purpose, layout: s.layout, theme: s.theme,
               count: counts[s.code], mayWrite: minMayWrite(me, s.code) };
    }),
    section: code,
    list: list,
    meeting: want ? minMeetingOut(want, code) : null
  };
}


/**
 * One meeting, as the page draws it: the stored body laid over the section's
 * block definitions.
 *
 * THE DEFINITIONS COME FROM THE SEED AND THE VALUES FROM THE SHEET. That
 * split is what lets a column heading be corrected in one place while every
 * meeting ever saved keeps its own cells - and it is also why a saved body
 * holds only ids, rows and lines, with not a single label in it.
 */
function minMeetingOut(meeting, code) {
  const body = parseMinBody(meeting.body);
  const section = minSection(code) || MIN_SECTIONS[0];
  const blocks = minSeedBlocks(code);

  const saved = {};
  const list = Array.isArray(body.blocks) ? body.blocks : [];
  list.forEach(function (b) {
    if (b && b.id) saved[String(b.id)] = b;
  });

  const out = [];
  blocks.forEach(function (def) {
    const have = saved[def.id];
    if (def.type === 'notes') {
      const values = {};
      if (have && Array.isArray(have.lines)) {
        have.lines.forEach(function (l) {
          if (l && l.key) values[String(l.key)] = String(l.value || '');
        });
      }
      def.lines = def.lines.map(function (line) {
        return { key: line.key, label: line.label,
                 value: values[line.key] !== undefined
                          ? values[line.key] : String(line.value || '') };
      });
    } else if (have && Array.isArray(have.rows)) {
      /*
        A saved meeting's rows win outright, including their count. The seed
        decides the COLUMNS and the sheet decides the ROWS, because adding a
        row is the ordinary way a section's agenda grows and a seed that
        overrode it would undo that edit every time the meeting was reopened.
      */
      def.rows = have.rows.map(function (row) {
        const cells = [];
        for (let c = 0; c < def.columns.length; c++) {
          cells.push(String((row && row[c]) || ''));
        }
        return cells;
      });
    }
    out.push(def);
  });

  /*
    A block saved against an id the seed no longer has is kept and shown,
    rather than dropped. A section that removes a block from the seed has
    not thereby agreed to lose what was written in it last fortnight.
  */
  Object.keys(saved).forEach(function (id) {
    let known = false;
    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i].id === id) { known = true; break; }
    }
    if (known) return;
    const orphan = saved[id];
    out.push({
      id: id, type: orphan.type === 'notes' ? 'notes' : 'table',
      side: 'full', title: '', retired: true,
      columns: minOrphanColumns(orphan),
      rows: Array.isArray(orphan.rows) ? orphan.rows : [],
      lines: Array.isArray(orphan.lines)
               ? orphan.lines.map(function (l) {
                   return { key: l.key, label: '', value: String(l.value || '') };
                 })
               : []
    });
  });

  return {
    id: meeting.id, section: code, date: meeting.date, time: meeting.time,
    host: meeting.host, attendees: meeting.attendees, status: meeting.status,
    purpose: body.head.purpose || section.purpose,
    minutesBy: body.head.minutesBy || '',
    by: meeting.by, byId: meeting.byId, at: meeting.at,
    history: meeting.history.slice(0, MIN_HISTORY_SHOWN),
    blocks: out
  };
}


/** Column stubs for a block the seed no longer defines. */
function minOrphanColumns(block) {
  let width = 0;
  (Array.isArray(block.rows) ? block.rows : []).forEach(function (row) {
    if (Array.isArray(row) && row.length > width) width = row.length;
  });
  const columns = [];
  for (let i = 0; i < width; i++) {
    columns.push({ key: 'c' + i, label: '', width: Math.floor(100 / width) });
  }
  return columns;
}


// ---------------------------------------------------------------------------
// WRITING
// ---------------------------------------------------------------------------

/**
 * A new meeting, copied from the section's last one.
 *
 * COPIED VERBATIM. Read the header of this file: duplicating the previous
 * slide and editing it is what the sections already do, and clearing the
 * cells on the way through would hand the host a blank form instead of last
 * fortnight's position to amend.
 */
function newMinutes(token, section, date, time) {
  requireSignedIn(token);

  const code = String(section || '').trim().toUpperCase();
  const def = minSection(code);
  if (!def) return { ok: false, error: 'There is no section called ' + code + '.' };

  const me = minWhoAmI(token);
  if (!minMayWrite(me, code)) {
    return { ok: false, error: me.reason ||
             'Only ' + minSubOf(def) + ' can start a meeting in ' +
             def.name + '.' };
  }

  const when = minDate(date);
  if (!when) {
    return { ok: false, error: 'A meeting needs a date, as yyyy-mm-dd.' };
  }

  const lock = LockService.getScriptLock();
  try { lock.waitLock(20000); }
  catch (e) {
    return { ok: false, error: 'Somebody else is saving right now. Try again ' +
                               'in a moment.' };
  }

  try {
    const sheet = minMeetTab();
    const all = readMinutes();

    let previous = null;
    for (let i = 0; i < all.length; i++) {
      if (all[i].section === code) { previous = all[i]; break; }
    }

    const body = minEmptyBody();
    if (previous) {
      const was = parseMinBody(previous.body);
      body.head.purpose = was.head.purpose;
      body.head.minutesBy = '';
      body.blocks = Array.isArray(was.blocks) ? was.blocks : [];
    } else {
      body.head.purpose = def.purpose;
      body.blocks = minSeedBlocks(code).map(function (b) {
        return b.type === 'notes'
          ? { id: b.id, type: 'notes',
              lines: b.lines.map(function (l) {
                return { key: l.key, value: String(l.value || '') };
              }) }
          : { id: b.id, type: 'table', rows: b.rows };
      });
    }

    /*
      HOST AND ATTENDEES CARRY OVER; MINUTES BY DOES NOT.

      The first two are a starting point that is usually right - the same
      section meets the same people every fortnight - and both sit in the
      header where a change is one edit away.

      The third is a claim about who wrote THIS document. Carried over, a
      deck opens saying it was minuted by somebody who has not read it, and
      it can be presented that way. Blank is the honest state, and the page
      asks for it on the first save.
    */
    const id = minMakeId(sheet, code, when);
    const stamp = minStamp();
    sheet.appendRow([
      id, code, when, String(time || '').trim(),
      previous ? previous.host : '',
      previous ? previous.attendees : '',
      MIN_DRAFT, minBodyText(body), me.name, me.id, stamp,
      JSON.stringify([{ by: me.name, id: me.id, at: stamp, what: 'started' }])
    ]);

    return { ok: true, id: id, copied: Boolean(previous),
             from: previous ? previous.id : '',
             data: minPayload(me, code, id) };
  } finally {
    try { lock.releaseLock(); } catch (e) { /* released anyway */ }
  }
}


/**
 * Save a meeting.
 *
 * ONE ENDPOINT FOR THE WHOLE MEETING rather than one per field. A meeting is
 * edited as a document - several cells, a heading and a free-text panel in
 * one sitting - and a save per keystroke would be a write per keystroke
 * against a spreadsheet that takes a second to answer.
 */
function saveMinutes(token, meetingId, update) {
  requireSignedIn(token);

  const id = String(meetingId || '').trim();
  if (!id) return { ok: false, error: 'No meeting was named.' };

  const me = minWhoAmI(token);
  const change = update || {};

  const lock = LockService.getScriptLock();
  try { lock.waitLock(20000); }
  catch (e) {
    return { ok: false, error: 'Somebody else is saving right now. Try again ' +
                               'in a moment.' };
  }

  try {
    const sheet = minMeetTab();
    const all = readMinutes();

    let meeting = null;
    for (let i = 0; i < all.length; i++) {
      if (all[i].id === id) { meeting = all[i]; break; }
    }
    if (!meeting) return { ok: false, error: 'That meeting is no longer there.' };

    const def = minSection(meeting.section);
    if (!minMayWrite(me, meeting.section)) {
      return { ok: false, error: me.reason ||
               'Only ' + (def ? minSubOf(def) : 'that section') +
               ' can write these minutes.' };
    }

    const body = parseMinBody(meeting.body);
    if (change.purpose !== undefined) {
      body.head.purpose = minText(change.purpose, MIN_TEXT_MAX);
    }
    if (change.minutesBy !== undefined) {
      body.head.minutesBy = minText(change.minutesBy, 200);
    }
    if (Array.isArray(change.blocks)) {
      const clean = [];
      for (let i = 0; i < change.blocks.length && i < 40; i++) {
        const block = minCleanBlock(change.blocks[i]);
        if (block) clean.push(block);
      }
      body.blocks = clean;
    }

    const at = minColumnIndex(
      sheet.getRange(1, 1, 1,
        Math.max(sheet.getLastColumn(), MIN_MEET_COLUMNS.length)).getValues()[0]);

    const put = function (index, value) {
      sheet.getRange(meeting.row, index + 1).setValue(value);
    };

    if (change.date !== undefined) {
      const when = minDate(change.date);
      if (!when) return { ok: false, error: 'That is not a date I can read.' };
      put(at.date, when);
    }
    if (change.time !== undefined) put(at.time, minText(change.time, 100));
    if (change.host !== undefined) put(at.host, minText(change.host, 200));
    if (change.attendees !== undefined) {
      put(at.attendees, minText(change.attendees, 1500));
    }
    if (change.status !== undefined) {
      put(at.status,
          String(change.status).toUpperCase() === MIN_FINAL ? MIN_FINAL : MIN_DRAFT);
    }

    put(at.body, minBodyText(body));

    const stamp = minStamp();
    put(at.by, me.name);
    put(at.byId, me.id);
    put(at.at, stamp);

    const history = meeting.history.slice();
    history.unshift({ by: me.name, id: me.id, at: stamp, what: 'saved' });
    put(at.history, JSON.stringify(history.slice(0, MIN_HISTORY_KEPT)));

    return { ok: true, id: id, at: stamp, by: me.name,
             data: minPayload(me, meeting.section, id) };
  } finally {
    try { lock.releaseLock(); } catch (e) { /* released anyway */ }
  }
}


/**
 * Delete a meeting.
 *
 * HEADS AND ADMIN ONLY, and deliberately narrower than the right to write
 * one. A wrong figure is a correction; a deleted meeting is a fortnight of
 * the section's record gone, and the person who typed it is not usually the
 * person who should be able to decide that.
 */
function deleteMinutes(token, meetingId) {
  requireSignedIn(token);

  const id = String(meetingId || '').trim();
  if (!id) return { ok: false, error: 'No meeting was named.' };

  const me = minWhoAmI(token);

  const lock = LockService.getScriptLock();
  try { lock.waitLock(20000); }
  catch (e) {
    return { ok: false, error: 'Somebody else is saving right now. Try again ' +
                               'in a moment.' };
  }

  try {
    const sheet = minMeetTab();
    const all = readMinutes();

    let meeting = null;
    for (let i = 0; i < all.length; i++) {
      if (all[i].id === id) { meeting = all[i]; break; }
    }
    if (!meeting) return { ok: false, error: 'That meeting is no longer there.' };

    if (!minMayRemove(me, meeting.section)) {
      return { ok: false, error: 'Only the section head, the head of EAS or ' +
                                 'an admin can delete a meeting.' };
    }

    sheet.deleteRow(meeting.row);
    return { ok: true, id: id,
             data: minPayload(me, meeting.section, '') };
  } finally {
    try { lock.releaseLock(); } catch (e) { /* released anyway */ }
  }
}


function minStamp() {
  return Utilities.formatDate(new Date(), minZone(), 'yyyy-MM-dd HH:mm');
}


// ---------------------------------------------------------------------------
// SETUP AND HEALTH
// ---------------------------------------------------------------------------

/**
 * Create the tab. Run once from the editor.
 *
 * Creates no meetings. The first meeting of each section is started from the
 * page, where it picks up its seed - so that the person who starts it is
 * recorded as having started it.
 */
function setupMinutesTabs() {
  const sheet = minMeetTab();
  sheet.setColumnWidth(1, 150);
  sheet.setColumnWidth(2, 80);
  sheet.setColumnWidth(8, 420);
  Logger.log('Minutes: %s is ready, %s meeting(s) in it.',
             minTabName('MIN_MEET'), Math.max(0, sheet.getLastRow() - 1));
  return true;
}


/**
 * What is wrong, in order of how much it matters. Run from the editor.
 */
function checkMinutes() {
  const lines = [];
  const all = readMinutes();

  lines.push(all.length + ' meeting(s) on ' + minTabName('MIN_MEET') + '.');

  const counts = {};
  MIN_SECTIONS.forEach(function (s) { counts[s.code] = 0; });

  const strays = [];
  const unreadable = [];
  const big = [];

  all.forEach(function (m) {
    if (counts[m.section] === undefined) { strays.push(m.id); return; }
    counts[m.section]++;
    if (m.body && !m.body.trim()) return;
    if (m.body) {
      try { JSON.parse(m.body); }
      catch (e) { unreadable.push(m.id); }
      if (m.body.length > MIN_BODY_MAX * 0.8) {
        big.push(m.id + ' (' + m.body.length + ')');
      }
    }
  });

  MIN_SECTIONS.forEach(function (s) {
    lines.push('  ' + s.code + '  ' + counts[s.code] + '  ' +
               minSubOf(s));
  });

  if (unreadable.length) {
    lines.push('UNREADABLE BODY, these meetings will open empty: ' +
               unreadable.join(', '));
  }
  if (strays.length) {
    lines.push('SECTION NOT RECOGNISED, these meetings show nowhere: ' +
               strays.join(', '));
  }
  if (big.length) {
    lines.push('CLOSE TO THE CELL LIMIT: ' + big.join(', '));
  }

  let faults = unreadable.length + strays.length + big.length;

  /*
    The directory join is the thing most likely to be quietly wrong: a
    Sub-Department spelt differently from the organogram costs that person
    their write button and says nothing about why.
  */
  try {
    const team = readTeam();
    const names = (team.sections || []).map(function (sec) { return sec.name; });

    /*
      WHAT THE DIRECTORY ACTUALLY SAYS, printed every time rather than only
      on a fault. The first version named the section that had not matched
      and stopped there, which tells you something is wrong and not what to
      type - and the thing it was failing against, 'Sales & Customer
      Applications' against a seeded 'Sales Applications', is invisible
      unless both strings are in front of you.
    */
    lines.push('Sub-Departments on the TEAM tab, and what each resolves to:');
    names.forEach(function (name) {
      const code = minSectionOfSub(name);
      lines.push('  ' + (code || '--  ') + '  ' + name +
                 (code ? '' : '   (not one of the four meeting sections)'));
    });

    const matched = {};
    names.forEach(function (name) {
      const code = minSectionOfSub(name);
      if (code) matched[code] = true;
    });
    const missing = MIN_SECTIONS.filter(function (sec) {
      return !matched[sec.code];
    });
    if (missing.length) {
      faults += missing.length;
      lines.push('NO DIRECTORY SECTION MATCHES, so nobody in it can write: ' +
                 missing.map(minSubOf).join(', '));
      lines.push('  Fix the Sub-Department cell on TEAM, or add the spelling ' +
                 'it uses to that section\'s `subs` in Minutes.gs.');
    }
  } catch (e) {
    faults++;
    lines.push('The team directory could not be read, so the section join ' +
               'was not checked.');
  }

  // Counted rather than re-derived from the three lists above: a check added
  // later that forgot to join that sum would print its own fault and then
  // 'Nothing wrong found' underneath it.
  if (!faults) lines.push('Nothing wrong found.');

  Logger.log(lines.join('\n'));
  return lines.join('\n');
}
