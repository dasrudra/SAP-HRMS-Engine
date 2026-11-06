/**
 * Knowledge.gs - the Knowledge Share portal.
 * ==========================================
 *
 * WHAT THIS IS AND HOW IT DIFFERS FROM LEARNINGS
 * Learnings is the library: approved SOPs, policies and user guidelines,
 * written by the people who own the process, named to a convention, filed
 * in a Drive tree somebody maintains. It is READ-ONLY from the page, and
 * that is correct - an SOP anybody can edit from a browser is not an SOP.
 *
 * This is the opposite half, and the team needs both. It is for the thing
 * somebody worked out at four in the afternoon and would otherwise tell one
 * colleague: the screenshot of the transaction that finally worked, the
 * note about which field the plant actually fills in, the photograph of a
 * whiteboard. ANYBODY SIGNED IN CAN POST, there is no approval step, and
 * there is no naming convention to get wrong.
 *
 * So the two pages look alike on purpose - the same tree, preview and
 * attachment panes - and behave nothing alike. The Knowledge pane is in its
 * own colour throughout so that nobody mistakes a colleague's note for an
 * approved document.
 *
 * WHERE A SHARE LIVES
 * The words are a row in the KNOWLEDGE tab: title, body, tags, who wrote it
 * and when. The ATTACHMENTS are in Drive, like everything else big in this
 * project, and the row carries a small JSON index of them - id, name, type,
 * size - so that drawing the page costs one sheet read and no Drive calls at
 * all.
 *
 * WHY THE UPLOAD IS IN PIECES
 * google.script.run will not carry a 20MB argument. A PowerPoint of
 * screenshots is routinely bigger than anything it will take in one call,
 * and "that file is too big" is how a sharing tool stops being used.
 *
 * So the browser cuts the file into chunks and sends them one at a time.
 * Each chunk is written to its own temporary file in Drive, because an Apps
 * Script call cannot hold anything between invocations - CacheService caps
 * at 100KB a key and Properties at 9KB, so there is nowhere else to put
 * four megabytes while the next four arrive. The last chunk reads the parts
 * back in order, joins them, writes the real file and deletes the parts.
 *
 * That costs twice the file's size in Drive traffic and is the cheapest
 * correct way to do it here. The alternative - appending each chunk to a
 * growing file - re-reads everything already uploaded on every chunk, which
 * is quadratic and times out on exactly the large files this exists for.
 */


/**
 * Column layout of the KNOWLEDGE tab.
 *
 * Ours, not a copy of anybody's spreadsheet, so they are read by position.
 * Files is last because it holds JSON nobody is meant to read by eye.
 */
const KNOWLEDGE_COLUMNS = [
  'ID', 'Title', 'Body', 'Tags', 'Author', 'Author ID',
  'Created', 'Updated', 'Files'
];


/** The script property naming the Drive folder attachments are kept in. */
const KNOWLEDGE_FOLDER_KEY = 'KNOWLEDGE_FOLDER';

/**
 * What one call will carry, and what one share may hold in total.
 *
 * CHUNK is the raw byte count per call. base64 inflates by a third, so 4MB
 * leaves the encoded payload around 5.5MB - comfortably inside what
 * google.script.run accepts, with room for the rest of the arguments.
 *
 * MAX_FILE is what the browser refuses before it starts. Twenty megabytes
 * is five chunks, and the join at the end has to hold the whole thing in
 * memory at once; past this the script's own heap becomes the limit and the
 * failure arrives at the END of a long upload, which is the worst possible
 * moment for it.
 */
const KNOWLEDGE_CHUNK = 4 * 1024 * 1024;
const KNOWLEDGE_MAX_FILE = 20 * 1024 * 1024;
const KNOWLEDGE_MAX_FILES = 10;


function knowledgeTab() {
  return sheetWithHeaders(CONFIG.SHEETS.KNOWLEDGE, KNOWLEDGE_COLUMNS);
}


/**
 * The Drive folder attachments are written into.
 *
 * Same arrangement as the Learnings folder: the argument when there is one,
 * the script property otherwise, so every tool here runs from the Run
 * button - which cannot pass an argument.
 */
function knowledgeFolder(given) {
  const passed = String(given || '').trim();
  if (passed) {
    PropertiesService.getScriptProperties()
      .setProperty(KNOWLEDGE_FOLDER_KEY, passed);
    return passed;
  }
  return String(
    PropertiesService.getScriptProperties().getProperty(KNOWLEDGE_FOLDER_KEY) || ''
  ).trim();
}


function knowledgeFolderHelp(link) {
  if (link) {
    Logger.log('That is not a Drive folder link: %s', link);
  } else {
    Logger.log('No Drive folder is set for Knowledge Share attachments yet.');
  }
  Logger.log('');
  Logger.log('Make a folder for it - NOT the Learnings folder, which is the');
  Logger.log('approved library and should not collect whatever people attach.');
  Logger.log('Then:');
  Logger.log('  1  Open the new folder in Drive, copy the address.');
  Logger.log('  2  Project Settings (the cog on the left).');
  Logger.log('  3  Script Properties > Add script property.');
  Logger.log('  4  Property: %s', KNOWLEDGE_FOLDER_KEY);
  Logger.log('     Value:    the address you copied');
  Logger.log('  5  Save, then run shareKnowledgeFolder so the page can show');
  Logger.log('     what people attach.');
}


/**
 * An id for a new share.
 *
 * The timestamp makes it sortable and tells you when it was made from the
 * id alone; the random tail stops two people posting in the same second
 * from colliding. Not a row number - rows move when somebody sorts the tab.
 */
function newKnowledgeId() {
  return 'K' + Utilities.formatDate(new Date(), CONFIG_TZ(), 'yyyyMMddHHmmss') +
    '-' + Math.random().toString(36).slice(2, 7).toUpperCase();
}


/**
 * Who is posting, by name where we can find one.
 *
 * The session carries an employee ID and nothing else. A page of notes
 * signed with an eight-digit number is a page nobody reads as written by a
 * person, so the ID
 * is looked up in the TEAM tab - which is read anyway for the directory and
 * is the only place names live.
 *
 * Wrapped, because a share that cannot be posted because the directory is
 * mid-edit is a worse failure than a share signed with a number.
 */
function knowledgeAuthor(token) {
  const session = currentSession(token);
  const id = session ? String(session.u || '') : '';
  if (!id) return { id: '', name: 'Unknown' };

  try {
    const team = readTeam();
    const all = [];
    if (team.lead) all.push(team.lead);
    (team.sections || []).forEach(function (s) {
      if (s.head) all.push(s.head);
      (s.members || []).forEach(function (m) { all.push(m); });
    });
    for (let i = 0; i < all.length; i++) {
      if (String(all[i].id || '') === id) {
        return { id: id, name: all[i].name };
      }
    }
  } catch (e) { /* a name is a courtesy; the id is the fact */ }

  return { id: id, name: id };
}


/**
 * The attachment index in a row, parsed.
 *
 * Stored as JSON in one cell rather than as a comma-separated list of file
 * ids, because the page needs a name, a type and a size per attachment and
 * fetching those from Drive would be one API call per attachment per page
 * load. Bad JSON comes back as no attachments rather than as an exception -
 * a share whose index somebody broke by editing the cell should still show
 * its words.
 */
function parseKnowledgeFiles(cell) {
  const text = String(cell || '').trim();
  if (!text) return [];
  try {
    const list = JSON.parse(text);
    if (!list || !list.length) return [];
    return list.filter(function (f) { return f && f.id; }).map(function (f) {
      return {
        id: String(f.id),
        name: String(f.name || 'Attachment'),
        mime: String(f.mime || ''),
        size: Number(f.size) || 0,
        kind: learnKind(f.mime, f.name),
        sizeText: learnSize(Number(f.size) || 0),
        preview: 'https://drive.google.com/file/d/' + f.id + '/preview',
        open: 'https://drive.google.com/file/d/' + f.id + '/view',
        download: 'https://drive.google.com/uc?export=download&id=' + f.id
      };
    });
  } catch (e) {
    return [];
  }
}


/**
 * Every share, newest first.
 *
 * Newest first and not oldest: this is a feed of what colleagues have
 * worked out lately, and the useful end of it is the recent end. Learnings
 * is the other way round - a library is ordered by where a thing belongs,
 * not by when it arrived.
 */
function readKnowledge() {
  const sheet = knowledgeTab();
  const last = sheet.getLastRow();

  if (last < 2) return { shares: [], count: 0, filled: true };

  const rows = sheet.getRange(2, 1, last - 1, KNOWLEDGE_COLUMNS.length).getValues();
  const shares = [];

  rows.forEach(function (row) {
    const id = String(row[0] || '').trim();
    const title = String(row[1] || '').trim();
    if (!id || !title) return;

    const created = row[6] instanceof Date ? row[6] : null;
    const updated = row[7] instanceof Date ? row[7] : null;

    shares.push({
      id: id,
      title: title,
      body: String(row[2] || ''),
      tags: String(row[3] || '').split(',')
              .map(function (t) { return t.trim(); })
              .filter(Boolean),
      author: String(row[4] || '').trim() || 'Unknown',
      authorId: String(row[5] || '').trim(),
      created: created
        ? Utilities.formatDate(created, CONFIG_TZ(), 'd MMM yyyy') : '',
      stamp: created ? created.getTime() : 0,
      edited: updated && created && updated.getTime() - created.getTime() > 60000,
      files: parseKnowledgeFiles(row[8])
    });
  });

  shares.sort(function (a, b) { return b.stamp - a.stamp; });
  return { shares: shares, count: shares.length, filled: true };
}


/** The row number a share is on, or -1. */
function knowledgeRowOf(sheet, id) {
  const last = sheet.getLastRow();
  if (last < 2) return -1;
  const ids = sheet.getRange(2, 1, last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0] || '').trim() === String(id).trim()) return i + 2;
  }
  return -1;
}


// ---------------------------------------------------------------------------
// WHAT THE PAGE CALLS
// ---------------------------------------------------------------------------

/**
 * Every share, for the Knowledge Share page.
 *
 * NOT CACHED, unlike the Learnings library. That one is a mirror of a Drive
 * folder that changes a few times a month, so ten minutes of staleness
 * costs nothing. This changes the moment somebody posts, and a colleague
 * who shares something and cannot see it is a colleague who posts it twice.
 */
function getKnowledge(token) {
  requireSignedIn(token);
  const data = readKnowledge();
  const me = currentSession(token);

  // WHO IS LOOKING, so the page knows whose Remove button to draw. Decided
  // here and not in the browser: a page that works out its own permissions
  // is a page that can be told it has different ones from a console.
  //
  // No admin flag goes with it, and that is deliberate - see
  // deleteKnowledge. Removing is the author's and nobody else's.
  data.me = me ? String(me.u || '') : '';
  data.maxFile = KNOWLEDGE_MAX_FILE;
  data.maxFiles = KNOWLEDGE_MAX_FILES;
  data.chunk = KNOWLEDGE_CHUNK;
  return data;
}


/**
 * Posts a share. The words only - attachments follow, one call each.
 *
 * Returns the whole share rather than just its id, so the page can draw it
 * without a second round trip and without inventing a local copy that might
 * differ from what was actually stored.
 */
function createKnowledge(token, draft) {
  requireSignedIn(token);

  const d = draft || {};
  const title = String(d.title || '').trim();
  const body = String(d.body || '').trim();

  if (!title) throw new Error('A share needs a title.');
  if (title.length > 200) throw new Error('That title is too long - 200 characters at most.');
  // Generous, and still a limit. The body goes in one spreadsheet cell and
  // a cell holds 50,000 characters; past that the write fails with a
  // message about cell contents that explains nothing to the person typing.
  if (body.length > 20000) {
    throw new Error('That is longer than a share should be - 20,000 characters ' +
                    'at most. Anything bigger belongs in a document, attached.');
  }

  const who = knowledgeAuthor(token);
  const now = new Date();
  const id = newKnowledgeId();

  const tags = String(d.tags || '').split(',')
    .map(function (t) { return t.trim(); })
    .filter(Boolean).slice(0, 8).join(', ');

  knowledgeTab().appendRow([
    id, title, body, tags, who.name, who.id, now, now, '[]'
  ]);

  return {
    id: id, title: title, body: body,
    tags: tags ? tags.split(', ') : [],
    author: who.name, authorId: who.id,
    created: Utilities.formatDate(now, CONFIG_TZ(), 'd MMM yyyy'),
    stamp: now.getTime(), edited: false, files: []
  };
}


/**
 * One chunk of one attachment.
 *
 * Called once per chunk by the browser, in order. Every call but the last
 * writes a temporary part and returns; the last joins them into the real
 * file, deletes the parts and writes the attachment into the share's index.
 *
 * ORDER IS NOT ASSUMED TO HOLD. The parts are read back by INDEX from their
 * names rather than by whatever order Drive's iterator hands them over,
 * because that order is not documented to be anything and a file assembled
 * out of order is corrupt in a way nobody would think to check for.
 *
 * @param {string} token
 * @param {string} shareId
 * @param {{uploadId, name, mime, index, total, size, data}} part
 * @return {?Object} the finished attachment on the last chunk, else null
 */
function addKnowledgeChunk(token, shareId, part) {
  requireSignedIn(token);

  const p = part || {};
  const folderId = driveFolderId(knowledgeFolder(''));
  if (!folderId) {
    throw new Error('No Drive folder is set for attachments. An admin needs to ' +
                    'set the ' + KNOWLEDGE_FOLDER_KEY + ' script property.');
  }

  const total = Number(p.total) || 1;
  const index = Number(p.index) || 0;
  const uploadId = String(p.uploadId || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!uploadId) throw new Error('That upload is missing its id.');

  if (Number(p.size) > KNOWLEDGE_MAX_FILE) {
    throw new Error('That file is larger than the ' +
      learnSize(KNOWLEDGE_MAX_FILE) + ' limit.');
  }

  const sheet = knowledgeTab();
  const row = knowledgeRowOf(sheet, shareId);
  if (row === -1) throw new Error('That share no longer exists.');

  // Only the person who posted it, or an admin, may add to it.
  // THE AUTHOR'S, AND NOBODY ELSE'S - an admin included. See
  // deleteKnowledge for why the rank is not consulted here either.
  const me = currentSession(token);
  const owner = String(sheet.getRange(row, 6).getValue() || '').trim();
  if (owner && owner !== String(me && me.u || '')) {
    throw new Error('That share belongs to somebody else.');
  }

  const folder = DriveApp.getFolderById(folderId);
  const bytes = Utilities.base64Decode(String(p.data || ''));

  // ---- not the last chunk: park it and come back ----
  if (index < total - 1) {
    folder.createFile(Utilities.newBlob(
      bytes, 'application/octet-stream', knowledgePartName(uploadId, index)));
    return null;
  }

  // ---- the last chunk: join everything and write the real file ----
  let joined = bytes;
  if (total > 1) {
    const parts = {};
    const files = folder.getFiles();
    while (files.hasNext()) {
      const f = files.next();
      const hit = /^__part_([A-Za-z0-9_-]+)_(\d+)$/.exec(f.getName());
      if (hit && hit[1] === uploadId) parts[Number(hit[2])] = f;
    }

    const missing = [];
    for (let i = 0; i < total - 1; i++) if (!parts[i]) missing.push(i);
    if (missing.length) {
      // Clean up what did arrive rather than leaving it in the folder for
      // ever. A half-uploaded file is rubbish; a half-uploaded file nobody
      // can identify is rubbish that accumulates.
      Object.keys(parts).forEach(function (k) { parts[k].setTrashed(true); });
      throw new Error('That upload lost ' + missing.length + ' of its ' +
                      total + ' pieces. Try attaching it again.');
    }

    joined = [];
    for (let i = 0; i < total - 1; i++) {
      const chunk = parts[i].getBlob().getBytes();
      for (let j = 0; j < chunk.length; j++) joined.push(chunk[j]);
    }
    for (let j = 0; j < bytes.length; j++) joined.push(bytes[j]);

    for (let i = 0; i < total - 1; i++) parts[i].setTrashed(true);
  }

  const name = String(p.name || 'attachment').slice(0, 120);
  const mime = String(p.mime || '') || 'application/octet-stream';
  const file = folder.createFile(Utilities.newBlob(joined, mime, name));

  const record = {
    id: file.getId(), name: name, mime: mime, size: joined.length
  };

  const have = parseKnowledgeFiles(sheet.getRange(row, 9).getValue());
  if (have.length >= KNOWLEDGE_MAX_FILES) {
    file.setTrashed(true);
    throw new Error('That share already has ' + KNOWLEDGE_MAX_FILES +
                    ' attachments, which is the limit.');
  }

  const index2 = have.map(function (f) {
    return { id: f.id, name: f.name, mime: f.mime, size: f.size };
  });
  index2.push(record);

  sheet.getRange(row, 9).setValue(JSON.stringify(index2));
  sheet.getRange(row, 8).setValue(new Date());

  return parseKnowledgeFiles(JSON.stringify([record]))[0];
}


/** What a parked chunk is called in Drive. One place, so both ends agree. */
function knowledgePartName(uploadId, index) {
  return '__part_' + uploadId + '_' + index;
}


/**
 * Removes a share, and the files attached to it.
 *
 * THE AUTHOR ONLY. Not an admin, which is unusual in this project and is
 * the point: everywhere else an admin can do what a viewer cannot, because
 * everywhere else the data belongs to the department. A share belongs to
 * the person who wrote it, and a note that somebody senior can quietly take
 * down is a note people stop writing. That is the whole asset here.
 *
 * WHAT THIS COSTS, said plainly because it is a real cost: if something is
 * posted that must come off and its author has left, there is no button for
 * it. The row is deleted from the KNOWLEDGE tab in the spreadsheet instead,
 * which the people who hold that sheet can do. That is a deliberate trade -
 * the awkward case is rare and the chilling effect would be constant.
 *
 * The attachments go to the Drive bin rather than being destroyed, which is
 * recoverable for thirty days and is the right amount of caution for a
 * button on a web page.
 */
function deleteKnowledge(token, id) {
  requireSignedIn(token);

  const sheet = knowledgeTab();
  const row = knowledgeRowOf(sheet, id);
  if (row === -1) throw new Error('That share no longer exists.');

  const me = currentSession(token);
  const owner = String(sheet.getRange(row, 6).getValue() || '').trim();
  if (owner !== String(me && me.u || '')) {
    throw new Error('Only the person who shared this can remove it.');
  }

  parseKnowledgeFiles(sheet.getRange(row, 9).getValue()).forEach(function (f) {
    try { DriveApp.getFileById(f.id).setTrashed(true); } catch (e) { /* already gone */ }
  });

  sheet.deleteRow(row);
  return { ok: true };
}


// ---------------------------------------------------------------------------
// RUN FROM THE EDITOR
// ---------------------------------------------------------------------------

/** Creates the KNOWLEDGE tab. Safe to run twice. */
function setupKnowledgeTab() {
  const sheet = knowledgeTab();
  Logger.log('Tab "%s" is ready, with %s column(s).',
             sheet.getName(), KNOWLEDGE_COLUMNS.length);
  Logger.log('Nothing is typed into it by hand - the page writes it.');
}


/**
 * Opens the attachments folder, so the page can show what people attach.
 *
 * Separate from everything else, like shareLearnFiles, because it is the
 * step that changes who can see what.
 */
function shareKnowledgeFolder() {
  const link = knowledgeFolder('');
  const id = driveFolderId(link);
  if (!id) { knowledgeFolderHelp(link); return; }

  try {
    const folder = DriveApp.getFolderById(id);
    folder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    Logger.log('"%s" is now readable by anyone with the link.', folder.getName());
    Logger.log('Everything people attach from the page is covered, including');
    Logger.log('anything attached later.');
    Logger.log('');
    Logger.log('WHAT THIS MEANS: a person holding one of these addresses can');
    Logger.log('open the attachment without signing in to the portal. Say so');
    Logger.log('to the team - this is a place colleagues post screenshots, and');
    Logger.log('they should know what a screenshot here is visible to.');
  } catch (e) {
    Logger.log('Sharing could not be changed: %s', e.message);
  }
}


/**
 * What is in the folder, and what should not be.
 *
 * Mostly a check for abandoned chunks: an upload that fails halfway leaves
 * its parked parts behind, and nothing else ever looks at them.
 */
function checkKnowledgeFolder() {
  const link = knowledgeFolder('');
  const id = driveFolderId(link);
  if (!id) { knowledgeFolderHelp(link); return; }

  let folder;
  try {
    folder = DriveApp.getFolderById(id);
  } catch (e) {
    Logger.log('That folder could not be opened: %s', e.message);
    return;
  }

  let live = 0, orphan = 0, bytes = 0;
  const stale = [];
  const files = folder.getFiles();
  while (files.hasNext()) {
    const f = files.next();
    if (f.isTrashed()) continue;
    if (/^__part_/.test(f.getName())) {
      orphan++;
      stale.push(f);
    } else {
      live++;
      bytes += f.getSize();
    }
  }

  Logger.log('%s attachment(s), %s in all.', live, learnSize(bytes));

  const data = readKnowledge();
  Logger.log('%s share(s) in the %s tab.', data.count, CONFIG.SHEETS.KNOWLEDGE);

  if (!orphan) {
    Logger.log('No abandoned upload pieces. Nothing to clean up.');
    return;
  }

  Logger.log('');
  Logger.log('%s ABANDONED UPLOAD PIECE(S) - from uploads that failed partway:',
             orphan);
  stale.forEach(function (f) { Logger.log('  %s', f.getName()); });
  Logger.log('Run cleanKnowledgeParts to bin them.');
}


/** Bins the leftovers checkKnowledgeFolder found. */
function cleanKnowledgeParts() {
  const id = driveFolderId(knowledgeFolder(''));
  if (!id) { knowledgeFolderHelp(''); return; }

  let gone = 0;
  const files = DriveApp.getFolderById(id).getFiles();
  while (files.hasNext()) {
    const f = files.next();
    if (!f.isTrashed() && /^__part_/.test(f.getName())) {
      f.setTrashed(true);
      gone++;
    }
  }
  Logger.log('%s abandoned upload piece(s) binned.', gone);
}
