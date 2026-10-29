/**
 * Team.gs - the EAS team directory, and why none of it is in this file.
 * ======================================================================
 *
 * WHAT THIS SERVES
 * The EAS Team page on the portal: every member grouped by section, with
 * designation, work email, extension and mobile number, and the four section
 * heads marked.
 *
 * WHY THE DATA LIVES IN THE SPREADSHEET AND NOT IN THE SOURCE
 * This repository is public. The team's NAMES are already in it - they have
 * to be, because Config.gs maps a ticket's owner to a section and that
 * mapping is the KPI engine. Names in an org chart are one thing.
 *
 * Personal mobile numbers are another thing entirely. Thirty-seven of them,
 * in a file anybody can read, in a git history that keeps them after they are
 * deleted, for people who were never asked. The .gitignore blocks the .xlsx
 * they arrived in; it would not have blocked an .html file holding the same
 * contents, and the protection would have been a filename.
 *
 * So the directory is a tab in the database, read when the page loads. The
 * same shape Questions.gs already uses for the FAQ, and it buys the same
 * second thing: correcting somebody's extension is an edit to a cell, not a
 * deployment.
 *
 * WHAT IS STILL IN CONFIG, AND WHY THAT IS NOT A SECOND SOURCE OF TRUTH
 * CONFIG.ROSTER says who sits in which section. It has to stay: Kpi.gs reads
 * it to decide whose ticket belongs to which section, and that is the
 * denominator of every figure this system reports. The TEAM tab is read for
 * CONTACT DETAILS. Where the two disagree about who exists, readTeam() says
 * so in `drift` rather than quietly preferring one - the same way the ingest
 * reports tickets that appear in only one of the two ITSM exports instead of
 * picking a winner.
 */


/**
 * Column layout of the TEAM tab.
 *
 * The first thirteen are the headers of the team's own spreadsheet, spelling
 * and all, so that keeping it up to date is a copy and a paste rather than a
 * retyping job. 'WhatApp/Cell No.' is missing its S in the source file; it is
 * reproduced here deliberately, and readTeam() matches headers loosely enough
 * that correcting it later breaks nothing.
 *
 * The last three are ours. Head marks the four section leads and the head of
 * EAS - it cannot be worked out from Designation, because Financial
 * Applications has two Managers and Supply Chain's lead is the head of EAS,
 * whose own section is 'ALL'. Photo is optional; without one a card shows
 * initials.
 */
const TEAM_COLUMNS = [
  'SL#', 'Employee Name', 'Employee ID', 'Designation', 'Module',
  'Department', 'Sub-Department', 'Blood Group', 'Computer Name',
  'Office Location', 'Ext#', 'WhatApp/Cell No.', 'Mail Address',
  'Head', 'Photo', 'Note'
];


function teamTab() {
  return sheetWithHeaders(CONFIG.SHEETS.TEAM, TEAM_COLUMNS);
}


/**
 * Finds a column by what it means rather than by where it is.
 *
 * The tab is filled by pasting from a spreadsheet somebody else maintains.
 * Columns get reordered, renamed from 'Ext#' to 'Extension', or have a stray
 * space put in front of them - the ITSM exports do exactly that and Ingest.gs
 * has carried a note about it since the beginning. Matching on a squashed,
 * lower-cased version of the header means none of that is a breakage.
 */
function teamColumnIndex(headers) {
  const flat = headers.map(function (h) {
    return String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  });

  const find = function (names) {
    for (let i = 0; i < names.length; i++) {
      const at = flat.indexOf(names[i]);
      if (at !== -1) return at;
    }
    return -1;
  };

  return {
    name:    find(['employeename', 'name']),
    id:      find(['employeeid', 'id']),
    title:   find(['designation', 'title']),
    module:  find(['module']),
    section: find(['subdepartment', 'section']),
    office:  find(['officelocation', 'office']),
    ext:     find(['ext', 'extension', 'extno']),
    phone:   find(['whatappcellno', 'whatsappcellno', 'cellno', 'mobile', 'phone']),
    email:   find(['mailaddress', 'email', 'mail']),
    head:    find(['head', 'sectionhead']),
    photo:   find(['photo', 'photourl', 'image']),
    note:    find(['note'])
  };
}


/**
 * Turns whatever is in the Photo cell into something an <img> can load.
 *
 * A Drive file shared with the team is the likely source, and the address
 * people copy out of Drive is a VIEWER page, not an image - putting it in an
 * <img> yields a broken icon. The id inside it is what matters, so both the
 * sharing link and a bare id are accepted and rewritten to the thumbnail
 * endpoint. Anything already http(s) and not Drive is passed through.
 */
function teamPhotoUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';

  const drive = /drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?id=|thumbnail\?id=)([A-Za-z0-9_-]{20,})/.exec(value);
  if (drive) return 'https://drive.google.com/thumbnail?id=' + drive[1] + '&sz=w320';

  if (/^[A-Za-z0-9_-]{25,}$/.test(value)) {
    return 'https://drive.google.com/thumbnail?id=' + value + '&sz=w320';
  }
  return /^https?:\/\//.test(value) ? value : '';
}


/** Everybody CONFIG.ROSTER knows about, flattened. */
function rosterNames() {
  const out = [];
  Object.keys(CONFIG.ROSTER).forEach(function (section) {
    CONFIG.ROSTER[section].forEach(function (name) { out.push(name); });
  });
  return out;
}


/**
 * The directory, grouped by section, heads first.
 *
 * Returns an empty team rather than throwing when the tab has not been filled
 * in yet: a page that says "nobody has filled this in" is useful, and a page
 * that fails to load is not.
 */
function readTeam() {
  const sheet = teamTab();
  const last = sheet.getLastRow();
  const wide = Math.max(sheet.getLastColumn(), TEAM_COLUMNS.length);

  if (last < 2) {
    return { sections: [], lead: null, count: 0,
             drift: { missing: [], unknown: [] }, filled: false };
  }

  const headers = sheet.getRange(1, 1, 1, wide).getValues()[0];
  const at = teamColumnIndex(headers);
  const rows = sheet.getRange(2, 1, last - 1, wide).getValues();

  const cell = function (row, index) {
    return index === -1 ? '' : String(row[index] === null || row[index] === undefined ? '' : row[index]).trim();
  };

  const people = [];
  rows.forEach(function (row) {
    const name = cell(row, at.name);
    if (!name) return;

    people.push({
      name: name,
      // An employee ID is a number in the sheet, so it arrives as 20217473 or
      // as 20217473.0 depending on how the cell was filled. Neither is a
      // string anybody wants to read.
      id: cell(row, at.id).replace(/\.0$/, ''),
      title: cell(row, at.title),
      module: cell(row, at.module),
      section: cell(row, at.section) || 'Unassigned',
      office: cell(row, at.office),
      ext: cell(row, at.ext),
      phone: cell(row, at.phone),
      email: cell(row, at.email),
      photo: teamPhotoUrl(cell(row, at.photo)),
      note: cell(row, at.note),

      // The Head cell says one of three things:
      //   empty            not a head
      //   Yes / true / 1   heads their own Sub-Department
      //   a section name   heads THAT section
      //
      // The third exists because the head of EAS covers Supply Chain on an
      // interim basis while sitting in no section himself. Putting the
      // section name in his Head cell says that in one cell, and the page
      // can tell it is interim because the section he leads is not the
      // section he is in.
      leads: cell(row, at.head)
    });
  });

  // ---- the department head comes out of the section list ----
  // He is above the sections on the organogram, not one of them. Left in, the
  // page reads "five sections" and one of them is a heading called ALL with a
  // single person under it.
  const isWholeDepartment = function (section) {
    return String(section).trim().toUpperCase() ===
           String(CONFIG.DEPARTMENT_SECTION).trim().toUpperCase();
  };

  const yes = function (value) { return /^(y|yes|true|1|head)$/i.test(String(value).trim()); };

  const lead = people.filter(function (p) { return isWholeDepartment(p.section); })[0] || null;
  const inSections = people.filter(function (p) { return !isWholeDepartment(p.section); });

  // ---- grouped ----
  const order = [];
  const byName = {};
  inSections.forEach(function (person) {
    if (!byName[person.section]) { byName[person.section] = []; order.push(person.section); }
    byName[person.section].push(person);
  });

  // Somebody may lead a section they are not in - that is what interim means
  // here - so the sections they name have to exist even before anyone is
  // grouped under them.
  people.forEach(function (person) {
    const named = person.leads;
    if (!named || yes(named) || isWholeDepartment(named)) return;
    if (!byName[named]) { byName[named] = []; order.push(named); }
  });

  // ---- in the organogram's order, with anything unnamed after it ----
  const rank = function (name) {
    const flat = String(name).toLowerCase();
    for (let i = 0; i < CONFIG.PORTAL_SECTION_ORDER.length; i++) {
      if (flat.indexOf(CONFIG.PORTAL_SECTION_ORDER[i]) !== -1) return i;
    }
    return CONFIG.PORTAL_SECTION_ORDER.length;
  };
  order.sort(function (a, b) {
    const ra = rank(a), rb = rank(b);
    return ra === rb ? order.indexOf(a) - order.indexOf(b) : ra - rb;
  });

  const sections = order.map(function (name) {
    const members = (byName[name] || []).slice();

    // Whoever names this section in their Head cell, or says Yes while
    // sitting in it.
    const head = people.filter(function (p) {
      if (!p.leads) return false;
      if (yes(p.leads)) return p.section === name;
      return String(p.leads).trim().toLowerCase() === String(name).trim().toLowerCase();
    })[0] || null;

    const under = members.filter(function (p) { return !head || p.name !== head.name; });

    return {
      name: name,
      // Everybody the section shows when it is opened, the head included.
      //
      // It has to equal what the grid draws or the card is lying: "1 member"
      // above a panel containing two people is the kind of small wrongness
      // that makes somebody distrust the rest of the page. The head is
      // counted here even when they sit in no section themselves - the
      // interim lead of Supply Chain is one of the people you find under
      // Supply Chain, which is the question the number answers.
      count: under.length + (head ? 1 : 0),
      head: head,
      // Leading a section you are not in. The organogram calls it
      // "Section Head (Interim)" and so does the page.
      interim: Boolean(head && head.section !== name),
      members: under
    };
  });

  // ---- where the sheet and CONFIG.ROSTER disagree ----
  // Reported, not resolved. The roster decides whose tickets count towards
  // which section, so a name in one and not the other is either somebody who
  // has joined and will not appear in the figures, or somebody who has left
  // and still does. Both are worth knowing and neither is this function's to
  // decide.
  // matchPerson() from Config.gs, not a squash of our own. It already knows
  // that md / md. / mohammad / muhammad / mohd are one honorific, which is
  // exactly the difference between these two lists: the directory says
  // 'Md. Abul Masum Siddique' and the roster says 'Muhammad Abul Masum
  // Siddique'. Comparing the raw strings reports that as two missing people
  // and sends somebody looking for a problem that is a spelling.
  //
  // It is the same function the ingest matches a ticket's owner with, so a
  // name this agrees about is a name the figures agree about too.
  const inSheet = people.map(function (p) { return p.name; });
  const inRoster = rosterNames();
  const sheetFlat = inSheet.map(matchPerson);
  const rosterFlat = inRoster.map(matchPerson);

  return {
    sections: sections,
    lead: lead,
    count: people.length,
    filled: true,
    drift: {
      missing: inRoster.filter(function (n, i) { return sheetFlat.indexOf(rosterFlat[i]) === -1; }),
      unknown: inSheet.filter(function (n, i) { return rosterFlat.indexOf(sheetFlat[i]) === -1; })
    }
  };
}


/**
 * The endpoint.
 *
 * Guarded, and that guard is the only thing between thirty-seven mobile
 * numbers and anybody who knows the /exec address. The deployment is
 * published to "Anyone" - it has to be, so that people without a Google
 * account on the domain can sign in - which means every global function in
 * this project can be called from a browser console by a stranger. This one
 * answers nothing until requireSignedIn has approved the token.
 */
function getTeam(token) {
  requireSignedIn(token);
  return readTeam();
}


// ---------------------------------------------------------------------------
// RUN FROM THE EDITOR
// ---------------------------------------------------------------------------

/**
 * Creates the TEAM tab, ready to paste into. Safe to run twice.
 */
function setupTeamTab() {
  const sheet = teamTab();
  Logger.log('TEAM tab ready: %s columns, %s row(s) of people.',
             sheet.getLastColumn(), Math.max(sheet.getLastRow() - 1, 0));
  Logger.log('Paste the team spreadsheet under the headers, then fill the');
  Logger.log('Head column with "Yes" for each section lead.');
}


/**
 * Prints what the portal will show, without opening the portal.
 *
 * Use it after pasting: it is the quickest way to see that the columns landed
 * where this file expects them, and it names anybody the roster and the sheet
 * disagree about.
 */
function checkTeamTab() {
  const team = readTeam();
  if (!team.filled) {
    Logger.log('The TEAM tab has headers but no people in it yet.');
    return;
  }

  Logger.log('%s people in %s section(s). Department head: %s',
             team.count, team.sections.length,
             team.lead ? team.lead.name : '(none - nobody is marked ' +
                                          CONFIG.DEPARTMENT_SECTION + ')');
  team.sections.forEach(function (section) {
    Logger.log('  %s - %s under %s%s', section.name, section.count,
               section.head ? section.head.name : '(nobody marked as head)',
               section.interim ? ' (interim)' : '');
  });

  if (team.drift.missing.length) {
    Logger.log('In CONFIG.ROSTER but NOT in the tab: %s',
               team.drift.missing.join(', '));
  }
  if (team.drift.unknown.length) {
    Logger.log('In the tab but NOT in CONFIG.ROSTER: %s',
               team.drift.unknown.join(', '));
  }
  if (!team.drift.missing.length && !team.drift.unknown.length) {
    Logger.log('The tab and CONFIG.ROSTER name the same people.');
  }
}
