/**
 * Learn.gs - the Learnings library, and why nobody types anything into it.
 * ========================================================================
 *
 * WHAT THIS SERVES
 * The Learnings page: every SOP, policy, user guideline and training file
 * the EAS team has written, grouped by module and by business, searchable,
 * and readable without leaving the portal.
 *
 * WHERE THE DOCUMENTS ARE
 * In one Drive folder, in the tree the team already keeps them in:
 *
 *     TVL-EAS_SOP-Policy-User Guideline/
 *         Common/                      (not split - these apply to both)
 *         FI-CO Module/    MG/  RMG/
 *         MM Module/       MG/  RMG/
 *         PP Module/       MG/  RMG/
 *         SD Module/       MG/  RMG/
 *
 * They stay there. Nothing is copied into the spreadsheet, nothing is
 * uploaded to the script, and the page does not serve a single byte of any
 * document - the largest is 27MB and Apps Script has neither the quota nor
 * the patience for that. Drive serves the file; this serves the index.
 *
 * WHY THERE IS NO FORM TO FILL IN
 * The obvious build is a tab with a row per document - title, type, module,
 * business, link - that somebody maintains. That tab would be wrong within a
 * month. Every document added is a row somebody has to remember to add, and
 * the person adding documents is not the person who built the page.
 *
 * So the classification is not entered anywhere. It is READ OFF THE FILE
 * ITSELF, because the team's naming convention already carries all of it:
 *
 *     [User Guideline] RMG_SAP_S4HANA_MM Process.pdf
 *      ^^^^^^^^^^^^^^  ^^^ ^^^^^^^^^^^^^^^^^^^^^^^^
 *      type            biz  subject
 *     ---------------------------------------------
 *     MM Module / RMG / that file
 *      ^^                ^^^
 *      module            business, confirmed
 *
 * The bracket gives the type. The folder gives the module and the business.
 * The rest of the filename, with the business prefix and the extension
 * taken off, is the title. A file dropped into the right folder with the
 * name the team already gives it is fully classified the moment it lands,
 * and the only thing anybody does is drop it in the folder.
 *
 * WHAT THE LEARN TAB IS FOR, THEN
 * Speed, and nothing else. Walking a Drive tree of a hundred files takes
 * seconds, which is fine once an hour and unacceptable on every page load.
 * scanLearnFolder() does the walk and writes what it found into the LEARN
 * tab; the page reads the tab. The tab is a CACHE OF THE FOLDER and is
 * rewritten whole on every scan - editing a cell in it is pointless, because
 * the next scan overwrites it. The folder is the authority.
 *
 * WHAT HAPPENS TO A BADLY NAMED FILE
 * It appears anyway, typed as Document, in the right module and business
 * because the folder still says. It is not hidden: a document nobody can
 * find because its name was wrong is worse than a document with a dull
 * badge. checkLearnFolder() lists every one of them with the reason, so the
 * names can be fixed in a batch rather than discovered one complaint at a
 * time.
 */


/**
 * Column layout of the LEARN tab.
 *
 * Written by scanLearnFolder() and read by readLearn(). Unlike the TEAM tab
 * these headers are ours, not a copy of somebody's spreadsheet, so they are
 * matched by position - there is no human in the loop to reorder them.
 *
 * File ID is last and Path second to last on purpose: they are the two
 * nobody reads, and a tab whose first screenful is the useful columns is
 * one somebody can actually check at a glance.
 */
const LEARN_COLUMNS = [
  'Title', 'Type', 'Module', 'Business', 'Kind',
  'Size', 'Updated', 'Path', 'File ID'
];


/** The script property holding the Drive folder the library is read from. */
const LEARN_FOLDER_KEY = 'LEARN_FOLDER';


function learnTab() {
  return sheetWithHeaders(CONFIG.SHEETS.LEARN, LEARN_COLUMNS);
}


/**
 * Squashed to lower-case letters and digits, for matching.
 *
 * The same idea as teamColumnIndex()'s flattening and for the same reason:
 * 'FI-CO Module', 'FI CO', 'fico' and 'FICO Module' are one module, and
 * comparing the raw strings would make them four.
 */
function learnFlat(value) {
  return String(value === null || value === undefined ? '' : value)
    .toLowerCase().replace(/[^a-z0-9]/g, '');
}


/**
 * The folder the library is read from.
 *
 * Takes the link as an argument when there is one, and otherwise reads the
 * script property - which is what makes every tool in this file runnable
 * from the Run button, since that button cannot pass an argument. The same
 * arrangement teamPhotoFolder() uses, for the same reason.
 */
function learnFolder(given) {
  const passed = String(given || '').trim();
  if (passed) {
    PropertiesService.getScriptProperties().setProperty(LEARN_FOLDER_KEY, passed);
    return passed;
  }
  return String(
    PropertiesService.getScriptProperties().getProperty(LEARN_FOLDER_KEY) || ''
  ).trim();
}


/** What to do when there is no folder set yet, or the link is not one. */
function learnFolderHelp(link) {
  if (link) {
    Logger.log('That is not a Drive folder link: %s', link);
  } else {
    Logger.log('No Drive folder is set for the Learnings library yet.');
  }
  Logger.log('');
  Logger.log('Set it once, then every tool in this file works from the Run button:');
  Logger.log('  1  Open the folder in Drive and copy the address from the bar.');
  Logger.log('  2  In the editor: Project Settings (the cog on the left).');
  Logger.log('  3  Script Properties > Add script property.');
  Logger.log('  4  Property: %s', LEARN_FOLDER_KEY);
  Logger.log('     Value:    the address you copied');
  Logger.log('  5  Save script properties, come back here and Run again.');
}


// ---------------------------------------------------------------------------
// READING A FILE'S CLASSIFICATION OFF ITS NAME AND ITS FOLDER
// ---------------------------------------------------------------------------

/**
 * The type, the title and the business, read out of one filename.
 *
 * The convention is "[Type] BUSINESS_Subject.ext" and all three parts are
 * optional in practice, so each is taken if it is there and skipped if it
 * is not. A file called nothing but "Leftover.pdf" comes back as a Document
 * titled Leftover, which is the right answer - it is still a document and
 * it is still in a module's folder.
 *
 * WHY THE BUSINESS IS READ HERE AS WELL AS FROM THE FOLDER. The folder is
 * the authority and this is the corroboration. A file named RMG_... sitting
 * in the MG folder is one or the other being wrong, and checkLearnFolder()
 * is the only part of the system that can notice. Nothing is silently
 * corrected: the folder wins, and the disagreement is reported.
 *
 * @param  {string} filename
 * @return {{type: string, typed: boolean, title: string, biz: string,
 *           ext: string}}
 */
function parseLearnName(filename) {
  let name = String(filename || '').trim();

  // ---- the extension, off the end ----
  let ext = '';
  const dot = /\.([A-Za-z0-9]{1,5})$/.exec(name);
  if (dot) { ext = dot[1].toLowerCase(); name = name.slice(0, dot.index); }

  // ---- the type, out of the leading bracket ----
  // Square or round, because both have been used, and only at the FRONT:
  // "Amortization (RMG).pdf" has a bracket in it that is not a type, and
  // matching anywhere would turn that file into a type called RMG.
  let type = (CONFIG.LEARN && CONFIG.LEARN.FALLBACK_TYPE) || 'Document';
  let typed = false;

  const bracket = /^[\s]*[\[\(]([^\]\)]{1,40})[\]\)]\s*/.exec(name);
  if (bracket) {
    const flat = learnFlat(bracket[1]);
    const types = (CONFIG.LEARN && CONFIG.LEARN.TYPES) || [];
    for (let i = 0; i < types.length; i++) {
      if (flat.indexOf(types[i].match) !== -1) {
        type = types[i].name;
        typed = true;
        break;
      }
    }
    // The bracket is taken off the title whether or not it was recognised.
    // It is a label, not part of what the document is called, and leaving
    // an unrecognised one on produces "[Checklist] Monthly Close" sitting
    // in a list beside "Monthly Close" - two titles for one kind of thing.
    name = name.slice(bracket[0].length);
  }

  // ---- the business, off the front of what is left ----
  let biz = '';
  const list = (CONFIG.LEARN && CONFIG.LEARN.BUSINESS) || [];
  for (let i = 0; i < list.length; i++) {
    // Followed by a separator, not by a letter. Without the boundary 'MG'
    // matches the front of 'MGT Report' and eats three letters of a title.
    const at = new RegExp('^' + list[i] + '(?=[\\s_\\-]+)', 'i').exec(name);
    if (at) {
      biz = list[i];
      name = name.slice(at[0].length).replace(/^[\s_\-]+/, '');
      break;
    }
  }

  return {
    type: type,
    typed: typed,
    title: learnTitle(name),
    biz: biz,
    ext: ext
  };
}


/**
 * What is left of a filename, made readable.
 *
 * Underscores become spaces and runs of whitespace collapse, because
 * "SAP_S4HANA_Leftover  Declaration" is a filename and "SAP S4HANA Leftover
 * Declaration" is a title. Nothing is capitalised and nothing is
 * title-cased: the team writes these names deliberately and SAP's own
 * spelling of its products is not something to improve on.
 *
 * An empty result falls back to the word Document rather than rendering a
 * card with no title on it.
 */
function learnTitle(value) {
  const out = String(value || '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-]+|[\s\-]+$/g, '');
  return out || 'Document';
}


/**
 * Which module a top-level folder name is, or null when it is not one.
 *
 * @param  {string} folderName
 * @return {?{name: string, accent: number}}
 */
function learnModule(folderName) {
  // A LEADING NUMBER IS DROPPED FIRST, so that renaming the folders to
  // "1. Common", "2. MM Module" to force an order in Drive does not stop
  // any of them being recognised. That is a thing people do to Drive
  // folders and it should not break the page.
  const flat = learnFlat(folderName).replace(/^[0-9]+/, '');
  if (!flat) return null;

  const list = (CONFIG.LEARN && CONFIG.LEARN.MODULES) || [];
  for (let i = 0; i < list.length; i++) {
    // AT THE START, not anywhere in the name. 'mm' appears inside
    // 'common' - c-o-M-M-o-n - so a substring test files the Common
    // folder as MM, and the only reason it does not today is that Common
    // happens to be listed first. That is not a property to rely on: the
    // next person to alphabetise CONFIG.LEARN.MODULES would silently move
    // every shared document into MM.
    if (flat.indexOf(list[i].match) === 0) {
      return { name: list[i].name, accent: list[i].accent };
    }
  }
  return null;
}


/**
 * Whether a folder name is one of the two businesses.
 *
 * Exact after squashing, not a substring: 'MG' appears inside 'RMG', and a
 * substring test in the wrong order would file every RMG document as MG.
 */
function learnBusiness(folderName) {
  const flat = learnFlat(folderName);
  const list = (CONFIG.LEARN && CONFIG.LEARN.BUSINESS) || [];
  for (let i = 0; i < list.length; i++) {
    if (flat === learnFlat(list[i])) return list[i];
  }
  return '';
}


/**
 * What sort of thing a file is, for the icon and for whether it can be
 * previewed in the page.
 *
 * Decided from the MIME type first and the extension second. Drive knows
 * the MIME type of everything it holds, but a file uploaded with no
 * extension and an unhelpful type comes back as application/octet-stream,
 * and the name is then the only evidence there is.
 *
 * The kinds the page cares about are pdf (previewable, and most of the
 * library), video (previewable, different icon, no page count) and the
 * Google and Office document families. Everything else is 'file' and gets
 * a plain icon and a download button.
 */
function learnKind(mime, filename) {
  const type = String(mime || '').toLowerCase();
  const ext = (/\.([A-Za-z0-9]{1,5})$/.exec(String(filename || '')) || ['', ''])[1]
    .toLowerCase();

  if (type.indexOf('pdf') !== -1 || ext === 'pdf') return 'pdf';
  if (type.indexOf('video') === 0) return 'video';
  if (['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'wmv'].indexOf(ext) !== -1) return 'video';

  if (type.indexOf('presentation') !== -1 ||
      ['ppt', 'pptx'].indexOf(ext) !== -1) return 'slide';
  if (type.indexOf('spreadsheet') !== -1 ||
      ['xls', 'xlsx', 'csv'].indexOf(ext) !== -1) return 'sheet';
  if (type.indexOf('document') !== -1 || type.indexOf('word') !== -1 ||
      ['doc', 'docx', 'rtf', 'txt'].indexOf(ext) !== -1) return 'doc';
  if (type.indexOf('image') === 0 ||
      ['png', 'jpg', 'jpeg', 'gif', 'webp'].indexOf(ext) !== -1) return 'image';

  return 'file';
}


/**
 * A byte count as the page should print it.
 *
 * One decimal under 100, none above, because "27.7 MB" and "915 KB" are
 * both the right amount of precision and "1024.0 KB" is not. Bytes below a
 * kilobyte are printed as bytes rather than "0.0 KB".
 */
function learnSize(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '';
  if (n < 1024) return n + ' B';

  const units = ['KB', 'MB', 'GB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }

  const shown = value >= 100 ? String(Math.round(value))
                             : String(Math.round(value * 10) / 10);
  return shown + ' ' + units[unit];
}


// ---------------------------------------------------------------------------
// THE SCAN
// ---------------------------------------------------------------------------

/**
 * Walks the Drive folder and returns everything in it, classified.
 *
 * The walk itself, with no spreadsheet and no logging, so that the scan,
 * the diagnostic and the tests can all use it without any of them having to
 * fake the other two's output.
 *
 * DEPTH IS CAPPED. The tree is module/business/file and goes no deeper, but
 * a folder somebody drops a shortcut into can make a Drive walk unbounded,
 * and an hourly trigger that walks a shared drive forever is a quota bill
 * rather than an error anybody sees.
 *
 * @param  {string} folderId
 * @return {{docs: Array<Object>, folders: number, skipped: Array<Object>}}
 */
function walkLearnFolder(folderId) {
  const root = DriveApp.getFolderById(folderId);
  const max = (CONFIG.LEARN && CONFIG.LEARN.MAX_DEPTH) || 4;

  const docs = [];
  const skipped = [];
  let folders = 0;

  // Iterative rather than recursive, because Apps Script's stack is shallow
  // and a folder loop - which a Drive shortcut can make - overflows it with
  // an error that names nothing useful. A queue just stops at the depth cap.
  const queue = [{ folder: root, trail: [], depth: 0 }];

  while (queue.length) {
    const here = queue.shift();
    folders++;

    // ---- the files at this level ----
    const files = here.folder.getFiles();
    while (files.hasNext()) {
      const file = files.next();
      const name = file.getName();

      // Drive keeps a trashed file reachable through its parent folder's
      // iterator. A document somebody deleted last week should not still
      // be on the page.
      if (file.isTrashed()) continue;

      const parsed = parseLearnName(name);

      // THE FOLDER DECIDES THE MODULE AND THE BUSINESS, not the filename.
      // trail[0] is the top-level folder, trail[1] the one under it. A file
      // sitting loose in the root has neither, which is a real state and
      // not an error - it goes in as Common with no business, and the
      // diagnostic says where it is.
      const mod = here.trail.length ? learnModule(here.trail[0]) : null;
      const biz = here.trail.length > 1 ? learnBusiness(here.trail[1]) : '';

      docs.push({
        title: parsed.title,
        type: parsed.type,
        typed: parsed.typed,
        module: mod ? mod.name : '',
        business: biz,
        // What the filename claimed, kept so checkLearnFolder() can compare
        // it with the folder. Not written to the tab and not sent to the
        // page - the folder is what either of those gets.
        namedBiz: parsed.biz,
        kind: learnKind(file.getMimeType(), name),
        bytes: file.getSize(),
        updated: file.getLastUpdated(),
        id: file.getId(),
        file: name,
        path: here.trail.join(' / ')
      });
    }

    // ---- the folders under it ----
    if (here.depth >= max) {
      skipped.push({ path: here.trail.join(' / '), why: 'deeper than ' + max });
      continue;
    }
    const subs = here.folder.getFolders();
    while (subs.hasNext()) {
      const sub = subs.next();
      queue.push({
        folder: sub,
        trail: here.trail.concat([sub.getName()]),
        depth: here.depth + 1
      });
    }
  }

  return { docs: docs, folders: folders, skipped: skipped };
}


/**
 * The order the page lists documents in, applied before they are written.
 *
 * Module order from CONFIG, then business with RMG before MG, then type,
 * then title. Sorted here rather than in the browser so that the tab a
 * person opens reads the same way the page does - a tab sorted by whatever
 * order Drive's iterator happened to use is one nobody can check.
 */
function sortLearnDocs(docs) {
  const modules = (CONFIG.LEARN && CONFIG.LEARN.MODULES) || [];
  const order = {};
  modules.forEach(function (m, i) { order[m.name] = i; });

  const biz = (CONFIG.LEARN && CONFIG.LEARN.BUSINESS) || [];
  const bizOrder = {};
  biz.forEach(function (b, i) { bizOrder[b] = i; });

  return docs.slice().sort(function (a, b) {
    const ma = a.module in order ? order[a.module] : modules.length;
    const mb = b.module in order ? order[b.module] : modules.length;
    if (ma !== mb) return ma - mb;

    const ba = a.business in bizOrder ? bizOrder[a.business] : biz.length;
    const bb = b.business in bizOrder ? bizOrder[b.business] : biz.length;
    if (ba !== bb) return ba - bb;

    if (a.type !== b.type) return a.type < b.type ? -1 : 1;
    return a.title.toLowerCase() < b.title.toLowerCase() ? -1 : 1;
  });
}


/**
 * Rebuilds the LEARN tab from the Drive folder.
 *
 * Run it from the editor: pick scanLearnFolder beside Run and press Run. It
 * takes no arguments - the Run button cannot pass one - and reads the
 * folder from the LEARN_FOLDER script property.
 *
 * THE TAB IS REWRITTEN WHOLE. Not merged, not appended to. The folder is
 * the authority and the tab is a cache of it, so a document deleted from
 * Drive has to disappear from the tab, and the only way to be sure of that
 * is to stop trying to be clever about which rows changed.
 *
 * Nothing is shared by this. Writing a file id into a tab does not make the
 * file readable, and a document the portal cannot open is a dead link on
 * somebody's screen. shareLearnFiles() is the separate, deliberate step -
 * separate because it is the half that changes who can see what.
 *
 * @param {string} folderLink  optional; the script property is used without it
 */
function scanLearnFolder(folderLink) {
  const link = learnFolder(folderLink);
  const id = driveFolderId(link);
  if (!id) { learnFolderHelp(link); return; }

  Logger.log('Reading %s', link);

  let found;
  try {
    found = walkLearnFolder(id);
  } catch (e) {
    Logger.log('That folder could not be read: %s', e.message);
    Logger.log('Check the address, and that this account can open it.');
    return;
  }

  const docs = sortLearnDocs(found.docs);

  const sheet = learnTab();
  const last = sheet.getLastRow();
  if (last > 1) sheet.getRange(2, 1, last - 1, LEARN_COLUMNS.length).clearContent();

  if (docs.length) {
    const rows = docs.map(function (d) {
      return [
        d.title, d.type, d.module, d.business, d.kind,
        learnSize(d.bytes), d.updated, d.path, d.id
      ];
    });
    sheet.getRange(2, 1, rows.length, LEARN_COLUMNS.length).setValues(rows);
  }

  // The page reads the tab, and it caches what it read. A scan that does
  // not clear that cache publishes nothing until the cache expires on its
  // own, which looks exactly like a scan that did not work.
  try { CacheService.getScriptCache().remove('learn.library'); } catch (e) { /* no cache, no problem */ }

  const untyped = docs.filter(function (d) { return !d.typed; }).length;
  const homeless = docs.filter(function (d) { return !d.module; }).length;

  Logger.log('');
  Logger.log('%s document(s) in %s folder(s), written to the %s tab.',
             docs.length, found.folders, CONFIG.SHEETS.LEARN);
  if (untyped) {
    Logger.log('%s of them have no [Type] in the filename - they show as "%s".',
               untyped, (CONFIG.LEARN && CONFIG.LEARN.FALLBACK_TYPE) || 'Document');
  }
  if (homeless) {
    Logger.log('%s are not under one of the module folders.', homeless);
  }
  if (untyped || homeless) {
    Logger.log('Run checkLearnFolder to see exactly which, and why.');
  }
  Logger.log('Run shareLearnFiles next, or the page will not be able to open them.');
}


/** The same scan, under the name the hourly trigger calls. Not meant to be pressed. */
function syncLearnFolder() {
  try {
    scanLearnFolder('');
  } catch (e) {
    // A trigger that throws emails the owner every hour until somebody
    // notices, and the likeliest cause - a folder renamed, unshared or
    // binned - is not an emergency. It goes in the log, where
    // checkLearnFolder and the next person to look will find it.
    Logger.log('Hourly Learnings sync could not run: %s', e.message);
  }
}


/**
 * Makes the library readable by anyone who has the link.
 *
 * SEPARATE FROM THE SCAN ON PURPOSE. This is the step that changes who can
 * see what, and a tool that quietly opens up a folder of internal documents
 * as a side effect of building an index is a tool nobody should trust.
 *
 * It shares the FOLDER, not the files one at a time. A folder shared as
 * view-anyone-with-the-link passes that down to everything inside it,
 * including everything added afterwards - which is the whole point, because
 * the alternative is remembering to run this after every upload.
 */
function shareLearnFiles() {
  const link = learnFolder('');
  const id = driveFolderId(link);
  if (!id) { learnFolderHelp(link); return; }

  let folder;
  try {
    folder = DriveApp.getFolderById(id);
  } catch (e) {
    Logger.log('That folder could not be opened: %s', e.message);
    return;
  }

  try {
    folder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    Logger.log('"%s" is now readable by anyone with the link.', folder.getName());
    Logger.log('Everything in it, including anything added later, is covered.');
    Logger.log('');
    Logger.log('WHAT THIS MEANS: a person who has one of these addresses can');
    Logger.log('open the document without signing in to the portal. The portal');
    Logger.log('asks people to sign in; Drive does not check that they did.');
    Logger.log('Nothing confidential should be in this folder.');
  } catch (e) {
    Logger.log('Sharing could not be changed: %s', e.message);
    Logger.log('This usually means the folder belongs to somebody else, or');
    Logger.log('Youngone policy blocks link sharing outside the organisation.');
  }
}


/**
 * Puts the scan on an hourly trigger.
 *
 * After this, a document dropped into the Drive folder is on the page
 * within the hour and nobody touches the spreadsheet or the script.
 */
function installLearnSync() {
  const link = learnFolder('');
  if (!driveFolderId(link)) { learnFolderHelp(link); return; }

  removeLearnSync();
  ScriptApp.newTrigger('syncLearnFolder').timeBased().everyHours(1).create();

  Logger.log('The Learnings library will now follow the Drive folder, once an hour.');
  Logger.log('Drop a document into %s and the page has it within the hour.', link);
  Logger.log('Run scanLearnFolder to pick one up straight away, or ' +
             'removeLearnSync to stop this.');
}


/** Stops the hourly sync. Removes every copy, in case one was ever doubled. */
function removeLearnSync() {
  let gone = 0;
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'syncLearnFolder') {
      ScriptApp.deleteTrigger(trigger);
      gone++;
    }
  });
  Logger.log('%s Learnings sync trigger(s) removed.', gone);
}


/**
 * What the scan can see, what it classified, and what it could not.
 *
 * The tool to run when a document is missing from the page or is filed
 * under the wrong heading. It reads the folder - not the tab - so it
 * answers the question "what is actually in Drive", which is the question
 * worth asking when the tab and the page disagree.
 *
 * It changes nothing.
 */
function checkLearnFolder() {
  const link = learnFolder('');
  const id = driveFolderId(link);
  if (!id) { learnFolderHelp(link); return; }

  Logger.log('Reading %s', link);
  Logger.log('');

  let found;
  try {
    found = walkLearnFolder(id);
  } catch (e) {
    Logger.log('That folder could not be read: %s', e.message);
    return;
  }

  const docs = sortLearnDocs(found.docs);
  if (!docs.length) {
    Logger.log('The folder has no files in it at any level.');
    return;
  }

  // ---- what it found, as the page will group it ----
  // padTo's third argument is left-align. Without it every column is
  // right-aligned against its own width, which for a table of words reads
  // as a ragged left edge and is harder to scan than no padding at all.
  Logger.log('%s  %s  %s  %s',
             padTo('MODULE', 10, true), padTo('BIZ', 5, true),
             padTo('TYPE', 16, true), 'TITLE');
  Logger.log('%s', new Array(79).join('-'));

  docs.forEach(function (d) {
    Logger.log('%s  %s  %s  %s',
               padTo(d.module || '(none)', 10, true),
               padTo(d.business || '-', 5, true),
               padTo(d.type, 16, true),
               d.title);
  });

  // ---- the counts the page will print ----
  const byType = {};
  const byModule = {};
  docs.forEach(function (d) {
    byType[d.type] = (byType[d.type] || 0) + 1;
    const key = d.module || '(none)';
    byModule[key] = (byModule[key] || 0) + 1;
  });

  Logger.log('');
  Logger.log('%s document(s) in %s folder(s).', docs.length, found.folders);
  Logger.log('By type:   %s', Object.keys(byType).map(function (k) {
    return k + ' ' + byType[k];
  }).join(', '));
  Logger.log('By module: %s', Object.keys(byModule).map(function (k) {
    return k + ' ' + byModule[k];
  }).join(', '));

  // ---- and everything that needs a human ----
  const untyped = docs.filter(function (d) { return !d.typed; });
  const homeless = docs.filter(function (d) { return !d.module; });
  const argued = docs.filter(function (d) {
    return d.namedBiz && d.business && d.namedBiz !== d.business;
  });

  if (!untyped.length && !homeless.length && !argued.length && !found.skipped.length) {
    Logger.log('');
    Logger.log('Every file is classified. Nothing needs renaming.');
    return;
  }

  if (untyped.length) {
    Logger.log('');
    Logger.log('NO [Type] IN THE FILENAME - these show as "%s":',
               (CONFIG.LEARN && CONFIG.LEARN.FALLBACK_TYPE) || 'Document');
    untyped.forEach(function (d) {
      Logger.log('  %s / %s', d.path || '(root)', d.file);
    });
    Logger.log('Rename them to start with one of: %s',
               learnTypeNames().join(', '));
  }

  if (homeless.length) {
    Logger.log('');
    Logger.log('NOT UNDER A MODULE FOLDER - the page cannot group these:');
    homeless.forEach(function (d) {
      Logger.log('  %s / %s', d.path || '(root)', d.file);
    });
    Logger.log('Move them into one of: %s', learnModuleNames().join(', '));
  }

  if (argued.length) {
    Logger.log('');
    Logger.log('THE NAME AND THE FOLDER DISAGREE - the folder is what counts:');
    argued.forEach(function (d) {
      Logger.log('  %s / %s  - named %s, filed under %s',
                 d.path, d.file, d.namedBiz, d.business);
    });
  }

  if (found.skipped.length) {
    Logger.log('');
    Logger.log('NOT WALKED - deeper than the scan goes:');
    found.skipped.forEach(function (s) {
      Logger.log('  %s  (%s)', s.path, s.why);
    });
  }
}


/**
 * The distinct types, in order, each with the accent that badges it.
 *
 * DISTINCT, because CONFIG.LEARN.TYPES is a match table and not a list -
 * 'userguideline', 'guideline' and 'manual' all resolve to User Guideline
 * so that any of the three spellings is recognised, and handing that
 * straight to the page would draw three identical chips.
 *
 * @return {Array<{name: string, accent: number}>}
 */
function learnTypeList() {
  const out = [];
  const seen = {};
  ((CONFIG.LEARN && CONFIG.LEARN.TYPES) || []).forEach(function (t) {
    if (seen[t.name]) return;
    seen[t.name] = true;
    out.push({ name: t.name, accent: t.accent });
  });

  // The catch-all is a real type on the page - it gets a chip and a count
  // like any other - so that the number under "All" is always the number
  // of files in the folder. It goes last because it is the absence of a
  // type rather than one of them.
  const fallback = (CONFIG.LEARN && CONFIG.LEARN.FALLBACK_TYPE) || 'Document';
  if (!seen[fallback]) out.push({ name: fallback, accent: 3 });

  return out;
}


/** Just the names, for a log line or a sentence of help text. */
function learnTypeNames() {
  return learnTypeList().map(function (t) { return t.name; });
}


/**
 * The modules, in the order the page lists them, with their accents.
 *
 * `split` says whether the module has MG and RMG folders under it. Common
 * does not - its documents apply to both businesses - and a tree that
 * draws two empty sub-folders under it is a tree that invites somebody to
 * go looking for documents that were never there.
 *
 * @return {Array<{name: string, accent: number, split: boolean}>}
 */
function learnModuleList() {
  return ((CONFIG.LEARN && CONFIG.LEARN.MODULES) || []).map(function (m) {
    return { name: m.name, accent: m.accent, split: m.match !== 'common' };
  });
}


/** The module names, in the order the page lists them. */
function learnModuleNames() {
  return learnModuleList().map(function (m) { return m.name; });
}


// ---------------------------------------------------------------------------
// WHAT THE PAGE READS
// ---------------------------------------------------------------------------

/**
 * The library, from the LEARN tab, in the shape the Learnings page wants.
 *
 * The TAB and not the folder: this runs on a page load and a Drive walk
 * takes seconds. scanLearnFolder() keeps the tab current.
 *
 * Addresses are built here rather than in the browser so that the way a
 * document is opened is one decision in one place:
 *
 *   `preview`  the /preview form, which is what an iframe can show. A plain
 *              /view URL refuses to be framed and renders as a grey box.
 *   `open`     the normal Drive page, for the Open full document button.
 *   `download` the direct-download form.
 *
 * @return {{docs: Array, types: Array, modules: Array, count: number,
 *           quarter: number, filled: boolean}}
 */
function readLearn() {
  const sheet = learnTab();
  const last = sheet.getLastRow();

  if (last < 2) {
    return { docs: [], types: [], modules: [], count: 0, quarter: 0,
             filled: false };
  }

  const rows = sheet.getRange(2, 1, last - 1, LEARN_COLUMNS.length).getValues();

  // Ninety days, not a calendar quarter. The tile says "this quarter" and
  // means "recently"; a calendar quarter makes that number collapse to zero
  // every January and read as a library nobody has touched.
  const fresh = new Date().getTime() - (90 * 24 * 60 * 60 * 1000);
  let quarter = 0;

  const docs = [];
  rows.forEach(function (row) {
    const title = String(row[0] || '').trim();
    const id = String(row[8] || '').trim();
    if (!title || !id) return;

    const updated = row[6] instanceof Date ? row[6] : null;
    if (updated && updated.getTime() >= fresh) quarter++;

    docs.push({
      title: title,
      type: String(row[1] || '').trim() ||
            ((CONFIG.LEARN && CONFIG.LEARN.FALLBACK_TYPE) || 'Document'),
      module: String(row[2] || '').trim(),
      business: String(row[3] || '').trim(),
      kind: String(row[4] || '').trim() || 'file',
      size: String(row[5] || '').trim(),
      updated: updated
        ? Utilities.formatDate(updated, CONFIG_TZ(), 'd MMM yyyy')
        : '',
      // Sortable, and not shown. The page orders by recency on the All
      // view, and '1 Nov 2026' sorts before '2 Oct 2026' as text.
      stamp: updated ? updated.getTime() : 0,
      path: String(row[7] || '').trim(),
      id: id,
      preview: 'https://drive.google.com/file/d/' + id + '/preview',
      open: 'https://drive.google.com/file/d/' + id + '/view',
      download: 'https://drive.google.com/uc?export=download&id=' + id
    });
  });

  return {
    docs: docs,
    types: learnTypeList(),
    modules: learnModuleList(),
    businesses: (CONFIG.LEARN && CONFIG.LEARN.BUSINESS) || [],
    count: docs.length,
    quarter: quarter,
    filled: true
  };
}


/**
 * The Learnings page's one server call.
 *
 * Cached for ten minutes. The tab changes once an hour at most - that is
 * what the trigger does - so reading it on every page load is a spreadsheet
 * round trip bought for nothing. scanLearnFolder() clears this, so a manual
 * scan is visible immediately rather than up to ten minutes later.
 */
function getLearning(token) {
  requireSignedIn(token);

  const cache = CacheService.getScriptCache();
  try {
    const hit = cache.get('learn.library');
    if (hit) return JSON.parse(hit);
  } catch (e) { /* a bad cache entry is not worth failing the page over */ }

  const library = readLearn();

  try {
    cache.put('learn.library', JSON.stringify(library), 600);
  } catch (e) {
    // Over 100KB and the cache refuses. The page still works; it just pays
    // for the tab read every time. Worth knowing, not worth throwing.
    Logger.log('The Learnings library is too big to cache: %s', e.message);
  }

  return library;
}


// ---------------------------------------------------------------------------
// RUN FROM THE EDITOR
// ---------------------------------------------------------------------------

/**
 * Creates the LEARN tab. Safe to run twice.
 *
 * Rarely needed on its own - scanLearnFolder() makes the tab if it is
 * missing - but it exists so the tab can be looked at before there is
 * anything to put in it.
 */
function setupLearnTab() {
  const sheet = learnTab();
  Logger.log('Tab "%s" is ready, with %s column(s).',
             sheet.getName(), LEARN_COLUMNS.length);
  Logger.log('Nothing is typed into it by hand - scanLearnFolder() fills it.');
}
