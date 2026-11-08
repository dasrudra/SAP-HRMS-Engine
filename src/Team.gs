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
    // The whole department ('EAS'), as distinct from the section. Only the
    // department head's card uses it - see moduleLabel below.
    dept:    find(['department']),
    office:  find(['officelocation', 'office']),
    ext:     find(['ext', 'extension', 'extno']),
    phone:   find(['whatappcellno', 'whatsappcellno', 'cellno', 'mobile', 'phone']),
    email:   find(['mailaddress', 'email', 'mail']),
    // Blood group. On the card because the one time anybody needs it is an
    // emergency, and an emergency is not the moment to go looking for the
    // spreadsheet it is kept in.
    blood:   find(['bloodgroup', 'blood']),
    head:    find(['head', 'sectionhead']),
    photo:   find(['photo', 'photourl', 'image']),
    note:    find(['note'])
  };
}


/**
 * The Drive file id inside whatever somebody pasted into the Photo cell.
 *
 * The address people copy out of Drive is a VIEWER page, not an image, so
 * putting it straight into an <img> yields a broken icon. The id inside it
 * is the part that matters, and a bare id is accepted too.
 */
function teamPhotoId(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  const drive = /drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?id=|thumbnail\?id=)([A-Za-z0-9_-]{20,})/.exec(value) ||
                /lh3\.googleusercontent\.com\/d\/([A-Za-z0-9_-]{20,})/.exec(value);
  if (drive) return drive[1];
  return /^[A-Za-z0-9_-]{25,}$/.test(value) ? value : '';
}


/**
 * Turns whatever is in the Photo cell into something an <img> can load.
 *
 * NOT drive.google.com/thumbnail, WHICH IS WHY THE FACES WERE SOFT. That
 * endpoint takes an sz= hint and is free to ignore it: for a file whose
 * thumbnail Drive generated once and cached, it hands back that cached
 * thumbnail whatever you ask for, and some of them are 128px. Raising sz=
 * from 320 to 512 changed the address and not one pixel of what came back,
 * which is exactly what it looked like.
 *
 * lh3.googleusercontent.com/d/<id>=w600 is Google's image CDN resizing the
 * actual file, and it honours the width given. 600 covers the largest
 * avatar here - 88px on the lead card - at three device pixels to the CSS
 * pixel, with room over; a 600px-wide photograph of a head is tens of
 * kilobytes, fetched once and cached after that.
 *
 * Anything already http(s) and not Drive is passed through untouched.
 */
function teamPhotoUrl(raw) {
  const id = teamPhotoId(raw);
  if (id) return 'https://lh3.googleusercontent.com/d/' + id + '=w600';
  const value = String(raw || '').trim();
  return /^https?:\/\//.test(value) ? value : '';
}


/**
 * The same picture by the older route, for an <img> whose src did not load.
 *
 * ONE CDN, ONE POINT OF FAILURE. lh3 is the sharper address and it is also
 * the less documented one: if Google ever changes it, or a particular file
 * will not serve from it, every face on the page becomes a broken icon at
 * once. drive.google.com/thumbnail is the address that has been working all
 * along, so it is kept as the thing to fall back to rather than deleted for
 * tidiness. The page wires it up on error - see wireTeamFaces().
 *
 * Empty when there is nothing to fall back to, which is the case for a
 * photograph hosted somewhere that is not Drive: there is no second address
 * for it and pretending otherwise would just be a second broken request.
 */
function teamPhotoAltUrl(raw) {
  const id = teamPhotoId(raw);
  return id ? 'https://drive.google.com/thumbnail?id=' + id + '&sz=w600' : '';
}


/**
 * Which TEAM row a photograph belongs to, worked out from its filename.
 *
 * Thirty-six photographs pasted into thirty-six cells by hand is twenty
 * minutes of clerical work and one transposition away from a card carrying
 * somebody else's face - and the one on the card beside it carrying theirs,
 * with neither mistake visible to the person who made it. So the matching is
 * done here, where it can be tested, and the Drive half of the job is kept
 * in the function below that calls this one.
 *
 * Three rules, strictest first:
 *
 *   1. AN EMPLOYEE ID IN THE FILENAME. Eight digits that are somebody's ID
 *      is not a coincidence, and it survives any amount of creative naming
 *      around it: "20990021.jpg", "IMG_20990021 (1).png", "EAS/20990021 -
 *      Utpal.jpeg" all land on the same row.
 *   2. THE WHOLE NAME. matchPerson() is the key the roster is already
 *      compared on, so "Md. Ashraful Islam.jpg", "md ashraful islam.JPG"
 *      and "Mohammad Ashraful Islam.png" are one person - and Ashraful
 *      Karim, who differs only in the surname, stays a different one.
 *   3. THE NAME INSIDE A LONGER FILENAME, for "Utpal Biswas - EAS.jpg".
 *
 * AMBIGUITY IS NOT RESOLVED, IT IS REPORTED. If a filename answers to two
 * rows the file is skipped and named in the log. A fifty-fifty guess about
 * whose face goes on whose card is not a guess worth making silently.
 *
 * @param {string} filename  the Drive file's name
 * @param {Array}  people    [{ id, name, row }]
 * @return {Object} { person } or { ambiguous: [names] } or {}
 */
function photoRowFor(filename, people) {
  const text = String(filename || '').replace(/\.[A-Za-z0-9]+$/, '');

  // ---- 1. an employee ID ----
  const digits = text.match(/\d{6,}/g) || [];
  const byId = people.filter(function (p) {
    return p.id && digits.indexOf(String(p.id)) !== -1;
  });
  if (byId.length === 1) return { person: byId[0] };
  if (byId.length > 1) {
    return { ambiguous: byId.map(function (p) { return p.name; }) };
  }

  const key = matchPerson(text);
  if (!key) return {};

  // ---- 2. the whole name ----
  const exact = people.filter(function (p) { return matchPerson(p.name) === key; });
  if (exact.length === 1) return { person: exact[0] };
  if (exact.length > 1) {
    return { ambiguous: exact.map(function (p) { return p.name; }) };
  }

  // ---- 3. the name inside a longer filename ----
  //
  // A FLOOR ON HOW SHORT A NAME MAY BE TO BE FOUND THIS WAY. Rules 1 and 2
  // need the whole thing and are safe at any length; this one asks whether
  // a name appears ANYWHERE inside a filename, and a short key turns up
  // inside words it has nothing to do with.
  //
  // Six, not eight. The shortest name on this team squashes to exactly
  // eight characters - "Rudra Das" - so a floor of eight was sitting on the
  // boundary it was meant to be clear of, and the first colleague to join
  // with a shorter name would simply have stopped matching, silently and
  // only by this rule. Six leaves room and still refuses the keys worth
  // refusing.
  //
  // The trade is deliberate and it is the right way round: a photograph
  // that matches nobody is printed in the log as unmatched, and a
  // photograph that matches the wrong person is printed on their card.
  const inside = people.filter(function (p) {
    const name = matchPerson(p.name);
    return name.length >= 6 && key.indexOf(name) !== -1;
  });
  if (inside.length === 1) return { person: inside[0] };
  if (inside.length > 1) {
    return { ambiguous: inside.map(function (p) { return p.name; }) };
  }

  return {};
}


/**
 * Where the team photographs live, for the two functions below.
 *
 * THE RUN BUTTON CANNOT PASS AN ARGUMENT. Pick a function from the editor's
 * dropdown, press Run, and it is called with nothing - so a function whose
 * only input is a parameter cannot be run from the editor at all. The first
 * version of these two took the folder link as an argument, which made them
 * unrunnable by the one person who needs to run them, and said so with
 * "That does not look like a Drive folder link or id: null".
 *
 * So the link lives in a SCRIPT PROPERTY, set once in Project Settings, and
 * both functions take no arguments. A property rather than a constant in
 * this file for two reasons: this file gets replaced wholesale every time
 * the project is updated, and a constant would have to be retyped each
 * time; and the folder holds photographs of thirty-six people, so its
 * address does not belong in a repository that anybody can read.
 *
 * An argument still works when one is given, so the functions can be called
 * from other code.
 */
const TEAM_PHOTO_FOLDER_KEY = 'TEAM_PHOTO_FOLDER';


function teamPhotoFolder(given) {
  const said = String(given || '').trim();
  if (said) return said;
  try {
    return String(PropertiesService.getScriptProperties()
                    .getProperty(TEAM_PHOTO_FOLDER_KEY) || '').trim();
  } catch (e) {
    return '';
  }
}


/**
 * What to do when there is no folder to work from.
 *
 * Printed rather than thrown, and printed as instructions rather than as a
 * complaint: the person reading this log is the person who has to fix it,
 * and "not a valid folder id" tells them nothing they can act on.
 */
function teamPhotoFolderHelp(link) {
  if (link) {
    Logger.log('That does not look like a Drive folder link or id:');
    Logger.log('  %s', link);
    Logger.log('Open the folder in Drive and copy the address out of the ' +
               'browser bar. It looks like');
    Logger.log('  https://drive.google.com/drive/folders/1yfTgtc...');
    return;
  }
  Logger.log('No photo folder is set yet. Set it once and these two ' +
             'functions will find it every time:');
  Logger.log('  1. In this editor, click the gear - Project Settings - on ' +
             'the left.');
  Logger.log('  2. Scroll to Script Properties and click Add script property.');
  Logger.log('  3. Property:  %s', TEAM_PHOTO_FOLDER_KEY);
  Logger.log('  4. Value:     the folder address from Drive, which looks ' +
             'like https://drive.google.com/drive/folders/1yfTgtc...');
  Logger.log('  5. Save script properties, come back here and press Run again.');
}


/*
  driveFolderId() WAS HERE and now lives in Config.gs.

  It was written for the photo import and stayed in this file while that
  was the only thing that needed it. Learn.gs, Knowledge.gs and the chat
  screenshots all read a Drive folder now, so a helper about Drive links
  sitting in the file about the team directory meant three files quietly
  depending on this one - which only showed up when a test suite loaded
  Messenger.gs without it and got "driveFolderId is not defined".
*/


/**
 * Fills the Photo column from a Drive folder of photographs.
 *
 * Run it from the editor: pick importTeamPhotos in the dropdown beside Run
 * and press Run. It takes no arguments - the Run button cannot pass one -
 * and reads the folder from the TEAM_PHOTO_FOLDER script property. If that
 * is not set yet, the log says how to set it.
 *
 * It writes a file id into the Photo cell of every row it can match and
 * leaves everything else alone. In particular:
 *
 *   A CELL THAT ALREADY HAS SOMETHING IN IT IS NOT TOUCHED. Somebody who
 *   pasted one photograph by hand, or pointed a row at an address that is
 *   not in Drive at all, should not have that quietly replaced by a file
 *   that happened to be named similarly. Pass true as the second argument
 *   to overwrite on purpose.
 *
 *   NOTHING IS SHARED. Writing an id here does not make the picture
 *   readable, and a picture the portal cannot read is a broken image on
 *   somebody's card. The log says which files are still private;
 *   shareTeamPhotos() below is the deliberate step that opens them, and it
 *   is separate because it is the half that changes who can see what.
 *
 * @param {string}  folderLink  optional; the script property is used without it
 * @param {boolean} overwrite   replace Photo cells that already have a value
 */
function importTeamPhotos(folderLink, overwrite) {
  const link = teamPhotoFolder(folderLink);
  const id = driveFolderId(link);
  if (!id) { teamPhotoFolderHelp(link); return; }
  Logger.log('Reading %s', link);

  const sheet = teamTab();
  const headers = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(),
                                                   TEAM_COLUMNS.length)).getValues()[0];
  const at = teamColumnIndex(headers);
  if (at.photo === -1) {
    Logger.log('The TEAM tab has no Photo column. Run setupTeamTab first.');
    return;
  }

  const last = sheet.getLastRow();
  if (last < 2) { Logger.log('The TEAM tab has no people in it yet.'); return; }

  const width = Math.max(sheet.getLastColumn(), TEAM_COLUMNS.length);
  const rows = sheet.getRange(2, 1, last - 1, width).getValues();
  const people = [];
  rows.forEach(function (row, i) {
    const name = String(row[at.name] || '').trim();
    if (!name) return;
    people.push({
      name: name,
      id: String(row[at.id] || '').trim().replace(/\.0$/, ''),
      row: i + 2,
      had: String(row[at.photo] || '').trim()
    });
  });

  const files = DriveApp.getFolderById(id).getFiles();
  const done = [], skipped = [], unmatched = [], unshared = [];
  const taken = {};
  let same = 0;

  while (files.hasNext()) {
    const file = files.next();
    const type = String(file.getMimeType() || '');
    if (type.indexOf('image/') !== 0) continue;

    const hit = photoRowFor(file.getName(), people);
    if (hit.ambiguous) {
      skipped.push(file.getName() + ' -> ' + hit.ambiguous.join(' or '));
      continue;
    }
    if (!hit.person) { unmatched.push(file.getName()); continue; }

    // TWO FILES FOR ONE PERSON. The second would overwrite the first and
    // neither the log nor the card would say which one won.
    if (taken[hit.person.row]) {
      skipped.push(file.getName() + ' -> ' + hit.person.name +
                   ', already taken by ' + taken[hit.person.row]);
      continue;
    }
    if (hit.person.had && !overwrite) {
      skipped.push(file.getName() + ' -> ' + hit.person.name +
                   ', whose Photo cell is already filled');
      continue;
    }

    // ALREADY RIGHT IS NOT A CHANGE. This runs on a schedule, so most of
    // what it finds every hour is what it wrote the hour before; writing
    // all thirty-six cells back unchanged is thirty-six edits on a shared
    // spreadsheet and thirty-six lines of log saying nothing happened.
    if (hit.person.had === file.getId()) {
      taken[hit.person.row] = file.getName();
      same++;
      continue;
    }

    sheet.getRange(hit.person.row, at.photo + 1).setValue(file.getId());
    taken[hit.person.row] = file.getName();
    done.push(hit.person.name + ' <- ' + file.getName());

    try {
      if (file.getSharingAccess() !== DriveApp.Access.ANYONE_WITH_LINK) {
        unshared.push(file.getName());
      }
    } catch (e) {
      unshared.push(file.getName() + ' (could not read its sharing)');
    }
  }

  Logger.log('%s photograph(s) linked, %s already pointing at the right file.',
             done.length, same);
  done.forEach(function (line) { Logger.log('  %s', line); });

  if (skipped.length) {
    Logger.log('%s skipped, on purpose:', skipped.length);
    skipped.forEach(function (line) { Logger.log('  %s', line); });
  }
  if (unmatched.length) {
    Logger.log('%s file(s) matched nobody - rename them to the employee ID ' +
               'or the full name:', unmatched.length);
    unmatched.forEach(function (name) { Logger.log('  %s', name); });
  }

  const without = people.filter(function (p) { return !taken[p.row] && !p.had; });
  if (without.length) {
    Logger.log('%s person/people still have no photograph:', without.length);
    without.forEach(function (p) { Logger.log('  %s (%s)', p.name, p.id); });
  }

  if (unshared.length) {
    Logger.log('--');
    Logger.log('%s of these files are NOT readable by link, so they will ' +
               'show as broken images on the cards.', unshared.length);
    Logger.log('Run shareTeamPhotos with the same folder link to open them, ' +
               'or set the folder to "Anyone with the link - Viewer" in Drive.');
  }
}


/**
 * Re-reads every photograph, replacing the ones already linked.
 *
 * importTeamPhotos leaves a filled Photo cell alone, which is right for a
 * second run over a folder somebody has added two faces to - and wrong for
 * the case that actually came up. Somebody replaced one person's photograph
 * in Drive. The new file has a new id; the cell still held the old one; the
 * import skipped the row as already filled and said so in the log, and the
 * page went on drawing the old picture.
 *
 * The overwrite was always possible - importTeamPhotos takes it as a second
 * argument - and that was no use to anybody, because the editor's Run
 * button cannot pass one. A separate function with no arguments is the
 * version that can actually be run.
 *
 * Separate rather than the default, because it is the destructive one: a
 * row pointed by hand at a photograph that is not in this folder loses that
 * pointer here, and nothing remembers what it was.
 */
function reimportTeamPhotos() {
  Logger.log('Replacing every linked photograph, including the ones already ' +
             'set. Use importTeamPhotos to fill only the empty ones.');
  importTeamPhotos('', true);
}


/**
 * Keeps the Photo column in step with the Drive folder, hourly, by itself.
 *
 * THE POINT OF ALL OF THIS IS THAT NOBODY SHOULD HAVE TO REMEMBER.
 * Everything else on the EAS Team page is read from the TEAM tab on every
 * page load, so a correction typed into the spreadsheet is on the screen
 * the moment somebody reloads. Photographs were the exception: the cell
 * holds a Drive FILE ID, a replaced photograph is a new file with a new
 * id, and the page went on drawing the old one until somebody ran an
 * import by hand - which is exactly the kind of step that gets forgotten
 * and then disbelieved.
 *
 * An hourly trigger closes that. Replace a face in Drive, give it the hour,
 * and the page has it. reimportTeamPhotos() is still there for when the
 * hour is too long to wait.
 *
 * Run this ONCE. Running it again replaces the trigger rather than adding a
 * second one, because two of these would do the same work twice and the
 * second would find nothing to do - which is harmless and still wrong.
 */
function installPhotoSync() {
  const folder = teamPhotoFolder('');
  if (!driveFolderId(folder)) { teamPhotoFolderHelp(folder); return; }

  removePhotoSync();
  ScriptApp.newTrigger('syncTeamPhotos').timeBased().everyHours(1).create();

  Logger.log('The Photo column will now follow the Drive folder, once an hour.');
  Logger.log('Replace a photograph in %s and the page has it within the hour.',
             folder);
  Logger.log('Run reimportTeamPhotos to pick one up straight away, or ' +
             'removePhotoSync to stop this.');
}


/** Stops the hourly sync. Removes every copy, in case one was ever doubled. */
function removePhotoSync() {
  let gone = 0;
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'syncTeamPhotos') {
      ScriptApp.deleteTrigger(trigger);
      gone++;
    }
  });
  Logger.log('%s photo sync trigger(s) removed.', gone);
}


/**
 * What the hourly trigger runs. Not meant to be pressed.
 *
 * Wrapped in a try/catch because a trigger that throws sends the owner a
 * failure email every hour until somebody notices, and the thing it is
 * most likely to throw on - a folder renamed, unshared or moved to the bin
 * - is not an emergency. It is written to the log, where checkTeamPhotos
 * and the next person to look will find it.
 */
function syncTeamPhotos() {
  try {
    importTeamPhotos('', true);
  } catch (e) {
    Logger.log('Hourly photo sync could not run: %s', e.message);
  }
}


/**
 * What size image the page is actually being served, per person.
 *
 * WRITTEN BECAUSE THE FACES KEPT COMING BACK SOFT AND EVERY FIX WAS A
 * GUESS. The addresses are built here, the images are fetched by a browser
 * on somebody's desk, and in between sits a Google CDN whose sizing rules
 * are documented loosely and behave differently per file. From outside that
 * loop the only honest statement is "it should be 600 pixels wide". This
 * asks.
 *
 * It fetches each photograph exactly as the page would, reads the width and
 * height out of the first few bytes - a PNG says so at byte 16, a JPEG in
 * its first SOFn marker - and prints what came back beside what the card
 * needs. Anything under about 230 pixels is being upscaled on a 76px avatar
 * at 3x, and that is what soft looks like.
 *
 * Run it from the dropdown like the other two. It is read-only: it changes
 * no cell and no sharing.
 */
function checkTeamPhotos() {
  const sheet = teamTab();
  const wide = Math.max(sheet.getLastColumn(), TEAM_COLUMNS.length);
  const headers = sheet.getRange(1, 1, 1, wide).getValues()[0];
  const at = teamColumnIndex(headers);
  const last = sheet.getLastRow();
  if (at.photo === -1 || last < 2) {
    Logger.log('No Photo column, or nobody in the tab yet.');
    return;
  }

  const rows = sheet.getRange(2, 1, last - 1, wide).getValues();
  let checked = 0, small = 0, missing = 0;

  Logger.log('What the page is actually served, by both addresses it can use.');
  Logger.log('Avatars draw at 88px, so on a high-resolution screen anything');
  Logger.log('under about 230 pixels is being upscaled - which is what soft');
  Logger.log('looks like. CDN is the one the page prefers.');
  Logger.log('--');

  rows.forEach(function (row) {
    const name = String(row[at.name] || '').trim();
    const cell = String(row[at.photo] || '').trim();
    if (!name) return;
    if (!cell) { missing++; return; }

    checked++;
    // BOTH ADDRESSES, because which one is answering is the open question.
    // The page asks the CDN first and falls back to the old Drive
    // thumbnail if that will not load - and if it has been falling back
    // all along, the fix that was supposed to sharpen these never took
    // effect and nothing on the page says so.
    const main = photoPixelSize(teamPhotoUrl(cell));
    const alt = photoPixelSize(teamPhotoAltUrl(cell));

    if (!main && !alt) {
      Logger.log('  %s - neither address would load. Not shared, or not an image.',
                 name);
      small++;
      return;
    }
    const best = main || alt;
    const soft = Math.min(best.w, best.h) < 230;
    if (soft) small++;
    Logger.log('  %s - CDN %s, Drive %s%s', name,
               main ? main.w + 'x' + main.h : 'no answer',
               alt ? alt.w + 'x' + alt.h : 'no answer',
               soft ? '   <-- small' : '');
  });

  Logger.log('--');
  Logger.log('%s checked, %s smaller than the cards want, %s with no photograph.',
             checked, small, missing);
  if (small) {
    Logger.log('Read the two columns against each other:');
    Logger.log('  both large  - the page has the pixels; the softness is the');
    Logger.log('                original photograph or the crop, not the size.');
    Logger.log('  CDN small   - it is ignoring the width asked for.');
    Logger.log('  CDN absent  - the page is falling back to Drive every time.');
    Logger.log('  both small  - the file in Drive is small to begin with.');
  }
}


/**
 * The pixel dimensions of an image, from its header.
 *
 * Only the two formats that come out of a phone or a scanner. Returns null
 * rather than throwing for anything it cannot read - a fetch that failed, a
 * file that is not an image, a format nobody here uses - because this is a
 * diagnostic and a diagnostic that dies halfway through tells you less than
 * one that says "could not read this one" and carries on.
 */
function photoPixelSize(url) {
  if (!url) return null;
  let bytes;
  try {
    const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true,
                                              followRedirects: true });
    if (response.getResponseCode() !== 200) return null;
    bytes = response.getBlob().getBytes();
  } catch (e) {
    return null;
  }
  return imageSizeFromBytes(bytes);
}


/**
 * Width and height out of PNG and JPEG bytes. Pure, so it can be tested.
 *
 * PNG: an 8-byte signature, then an IHDR chunk whose width and height are
 * big-endian 32-bit at offsets 16 and 20. Fixed, always.
 *
 * JPEG: a chain of markers, and the size lives in whichever SOFn comes
 * first. SOF0 through SOF15, skipping SOF4, SOF8 and SOF12, which are not
 * frame headers at all - DHT, reserved and DAC wear those numbers. Walking
 * past them is the difference between reading a height and reading two
 * bytes of a Huffman table as one.
 */
function imageSizeFromBytes(bytes) {
  const b = bytes || [];
  const at = function (i) { return b[i] < 0 ? b[i] + 256 : b[i]; };

  // ---- PNG ----
  if (b.length > 24 && at(0) === 0x89 && at(1) === 0x50 &&
      at(2) === 0x4E && at(3) === 0x47) {
    const read = function (i) {
      return (at(i) << 24) + (at(i + 1) << 16) + (at(i + 2) << 8) + at(i + 3);
    };
    return { w: read(16), h: read(20) };
  }

  // ---- JPEG ----
  if (b.length > 4 && at(0) === 0xFF && at(1) === 0xD8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (at(i) !== 0xFF) { i++; continue; }
      const marker = at(i + 1);
      if (marker === 0xFF) { i++; continue; }
      // Markers that carry no length: padding, RSTn, SOI, EOI.
      if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD9)) { i += 2; continue; }
      const length = (at(i + 2) << 8) + at(i + 3);
      const isFrame = marker >= 0xC0 && marker <= 0xCF &&
                      marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC;
      if (isFrame) {
        return { h: (at(i + 5) << 8) + at(i + 6),
                 w: (at(i + 7) << 8) + at(i + 8) };
      }
      if (length < 2) return null;
      i += 2 + length;
    }
  }

  return null;
}


/**
 * Opens a folder of team photographs to anyone holding the link.
 *
 * SEPARATE FROM THE IMPORT, AND DELIBERATELY SO. This is the step that
 * changes who can see these pictures: after it, anybody with a file's
 * address can open it without signing in, which is what lets the portal
 * draw them for a colleague who is not in the folder's share list. That is
 * a decision about photographs of thirty-six people and it should be taken
 * by a person on purpose, not as a side effect of filling in a column.
 *
 * It is the folder's own files that are opened, nothing else, and it prints
 * every one it changed.
 *
 * Run from the dropdown like the one above, and reads the same script
 * property.
 *
 * @param {string} folderLink  optional; the script property is used without it
 */
function shareTeamPhotos(folderLink) {
  const link = teamPhotoFolder(folderLink);
  const id = driveFolderId(link);
  if (!id) { teamPhotoFolderHelp(link); return; }
  Logger.log('Opening the images in %s', link);

  const files = DriveApp.getFolderById(id).getFiles();
  let opened = 0, already = 0;
  const failed = [];

  while (files.hasNext()) {
    const file = files.next();
    if (String(file.getMimeType() || '').indexOf('image/') !== 0) continue;
    try {
      if (file.getSharingAccess() === DriveApp.Access.ANYONE_WITH_LINK) {
        already++;
        continue;
      }
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      Logger.log('  opened: %s', file.getName());
      opened++;
    } catch (e) {
      failed.push(file.getName() + ' - ' + e.message);
    }
  }

  Logger.log('%s file(s) opened to anyone with the link, %s already were.',
             opened, already);
  if (failed.length) {
    Logger.log('%s could not be changed:', failed.length);
    failed.forEach(function (line) { Logger.log('  %s', line); });
  }
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
      // An employee ID is a number in the sheet, so it arrives as 20990021 or
      // as 20990021.0 depending on how the cell was filled. Neither is a
      // string anybody wants to read.
      id: cell(row, at.id).replace(/\.0$/, ''),
      title: cell(row, at.title),
      module: cell(row, at.module),
      section: cell(row, at.section) || 'Unassigned',
      dept: cell(row, at.dept),
      office: cell(row, at.office),
      ext: cell(row, at.ext),
      phone: cell(row, at.phone),
      email: cell(row, at.email),
      blood: cell(row, at.blood),
      photo: teamPhotoUrl(cell(row, at.photo)),
      // The same picture by the older address, for the page to fall back
      // to if the first one will not load. See teamPhotoAltUrl().
      photoAlt: teamPhotoAltUrl(cell(row, at.photo)),
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

  // WHAT TO PRINT BESIDE A DESIGNATION: everybody's module, the department
  // head included.
  //
  // His used to be overridden to the DEPARTMENT, on the reasoning that he
  // heads all of it and belongs to no one module. On the page that came out
  // as "Senior Manager - Enterprise Application Service" sitting in a row of
  // section heads reading "Manager - SD", "Manager - PP", "Manager - FI/CO":
  // the one card in four that did not answer the question the line is there
  // to answer. He does own modules, and the Module cell is where the sheet
  // says which - so the cell is now what the card prints, like everyone
  // else's. The big Department Head card above the chart still names the
  // department in full, which is where that belongs.
  people.forEach(function (p) { p.moduleLabel = p.module; });
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

    // WHO LEADS THIS SECTION, in three steps.
    //
    //   1  somebody's Head cell names this section by name
    //   2  somebody in this section says Yes
    //   3  nobody does, so it falls to the department head
    //
    // Step 3 is the one that matters, and it is why nothing has to be typed
    // into a spreadsheet to describe the arrangement the team is actually in.
    // Supply Chain has no head of its own; the head of EAS covers it. That is
    // not a fact somebody has to remember to record - it is what an unled
    // section MEANS when there is a department head above it, and the day
    // somebody is appointed to it their Yes takes over at step 2 without
    // anybody having to come back and undo anything here.
    //
    // What is NOT done is picking by seniority. Financial Applications has
    // two Managers; rank would choose between them, confidently, and might
    // choose wrong. An unled section says so, or says who is covering it.
    const claimed = people.filter(function (p) {
      if (!p.leads) return false;
      if (yes(p.leads)) return p.section === name;
      return String(p.leads).trim().toLowerCase() === String(name).trim().toLowerCase();
    })[0] || null;

    const head = claimed || lead || null;

    const under = members.filter(function (p) { return !head || p.name !== head.name; });

    // IN THE ORDER THE CHART PUTS THEM IN, not the order the rows happen to
    // sit in the tab. CONFIG.ROSTER carries that sequence - see
    // rosterOrderFor() - and somebody the roster does not name keeps their
    // place at the end rather than being dropped or sorted to the front.
    // The drift notice below already says who those people are.
    //
    // sort() is stable in this runtime, so the unnamed keep sheet order
    // among themselves rather than being shuffled by a tie.
    const order = rosterOrderFor(name);
    if (order.length) {
      const rank = function (person) {
        const at = order.indexOf(matchPerson(person.name));
        return at === -1 ? order.length : at;
      };
      under.sort(function (a, b) { return rank(a) - rank(b); });
    }

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
  const team = readTeam();

  // The tab has just been read, so this is the cheapest moment there will
  // ever be to refresh the list presence keys its dots by. It matters because
  // that key comes out of the row: filling in a missing employee ID changes
  // it, and a cached roster would go on looking for that person under their
  // name for hours afterwards and show them grey at their own desk.
  //
  // Wrapped, because a directory nobody can read is a worse failure than a
  // dot that is briefly out of date. Presence is the garnish on this page.
  try { presenceRosterFrom(team); } catch (e) { /* dots can wait */ }

  return team;
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
