/**
 * learn-scan.js - reading the Learnings library off the Drive folders.
 * ===========================================================================
 *
 * Ported from src/Learn.gs: parseLearnName, learnTitle, learnModule,
 * learnBusiness, learnFlat, walkLearnFolder and scanLearnFolder.
 *
 * WHY NOBODY TYPES ANYTHING INTO THE LIBRARY, which is the whole design and
 * is worth repeating where the code is. Learn.gs:
 *
 *     "The obvious build is a tab with a row per document - title, type,
 *      module, business, link - that somebody maintains. That tab would be
 *      wrong within a month. Every document added is a row somebody has to
 *      remember to add, and the person adding documents is not the person
 *      who built the page.
 *
 *      So the classification is not entered anywhere. It is READ OFF THE
 *      FILE ITSELF, because the team's naming convention already carries
 *      all of it."
 *
 *         [User Guideline] RMG_SAP_S4HANA_MM Process.pdf
 *          ^^^^^^^^^^^^^^  ^^^ ^^^^^^^^^^^^^^^^^^^^^^^^
 *          type            biz  subject
 *
 *     the bracket gives the type, the folder gives the module and the
 *     business, and the rest is the title.
 *
 * THE `learn` TABLE IS A CACHE OF THE FOLDER, exactly as the LEARN tab was:
 * rewritten on every scan, with the folder remaining the authority. Editing
 * a row is pointless, because the next scan overwrites it.
 *
 * ---------------------------------------------------------------------------
 * TWO ROOTS NOW, AND THAT IS THE ONLY STRUCTURAL CHANGE
 * ---------------------------------------------------------------------------
 *
 *     TVL-EAS_SOP-Policy-User Guideline/           the library
 *     TVL-EAS_SOP-Policy-User Guideline _Archive/  what it replaced
 *
 * `archived` is which of the two a file was found under, and nothing else -
 * see the long note in db/19-learn-archive.sql. So archiving a document is
 * one action and not two: the file moves in Drive, and the next scan agrees.
 *
 * THE ARCHIVE ROOT IS A SIBLING, NOT A CHILD, and that is not a preference.
 * walk() below takes every non-trashed file under the root it is given and
 * has no skip list - the same as walkLearnFolder - so an _Archive folder
 * inside the live tree would put every superseded SOP straight back into the
 * library, filed as Common with no business.
 *
 * ---------------------------------------------------------------------------
 * NOTHING HERE TALKS TO DRIVE
 * ---------------------------------------------------------------------------
 *
 * walk() takes a `lister` - something that, given a folder id, answers with
 * its files and subfolders. api/drive.js supplies the real one. That is not
 * indirection for its own sake: the classification below is the part that
 * can be wrong, it is proved identical to Learn.gs by
 * learn-equivalence-test.js, and a test that needed Google credentials to
 * run would not be run.
 */

const db = require('./db');
const content = require('./content');


/** How deep the walk goes. CONFIG.LEARN.MAX_DEPTH. */
const MAX_DEPTH = 4;


/**
 * Squashed to lower-case letters and digits, for matching.
 *
 * Learn.gs: "'FI-CO Module', 'FI CO', 'fico' and 'FICO Module' are one
 * module, and comparing the raw strings would make them four."
 */
function learnFlat(value) {
  return String(value === null || value === undefined ? '' : value)
    .toLowerCase().replace(/[^a-z0-9]/g, '');
}


/**
 * What is left of a filename, made readable.
 *
 * Underscores become spaces and runs of whitespace collapse. Nothing is
 * capitalised and nothing is title-cased: Learn.gs is explicit that "the
 * team writes these names deliberately and SAP's own spelling of its
 * products is not something to improve on."
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
 * A LEADING NUMBER IS DROPPED FIRST, so that renaming the folders to
 * "1. Common", "2. MM Module" to force an order in Drive does not stop any
 * of them being recognised. People do that to Drive folders.
 *
 * MATCHED AT THE START, not anywhere in the name, and Learn.gs explains why
 * at length: "'mm' appears inside 'common' - c-o-M-M-o-n - so a substring
 * test files the Common folder as MM, and the only reason it does not today
 * is that Common happens to be listed first. That is not a property to rely
 * on: the next person to alphabetise CONFIG.LEARN.MODULES would silently
 * move every Common document into MM."
 */
function learnModule(folderName) {
  const flat = learnFlat(folderName).replace(/^[0-9]+/, '');
  if (!flat) return null;

  const list = content.LEARN_MODULES || [];
  for (let i = 0; i < list.length; i++) {
    if (flat.indexOf(list[i].match) === 0) {
      return { name: list[i].name, accent: list[i].accent };
    }
  }
  return null;
}


/** Which business a second-level folder name is, or '' when it is neither. */
function learnBusiness(folderName) {
  const flat = learnFlat(folderName);
  const list = content.LEARN_BUSINESS || [];
  for (let i = 0; i < list.length; i++) {
    if (flat === learnFlat(list[i])) return list[i];
  }
  return '';
}


/**
 * Type, title, business and extension, out of one filename.
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

  /*
    ---- the type, out of the leading bracket ----
    Square or round, because both have been used, and only at the FRONT:
    "Amortization (RMG).pdf" has a bracket in it that is not a type, and
    matching anywhere would turn that file into a type called RMG.
  */
  let type = content.LEARN_FALLBACK_TYPE;
  let typed = false;

  const bracket = /^[\s]*[\[\(]([^\]\)]{1,40})[\]\)]\s*/.exec(name);
  if (bracket) {
    const flat = learnFlat(bracket[1]);
    const types = content.LEARN_TYPES || [];
    for (let i = 0; i < types.length; i++) {
      if (flat.indexOf(types[i].match) !== -1) {
        type = types[i].name;
        typed = true;
        break;
      }
    }
    /*
      The bracket is taken off the title whether or not it was recognised.
      Learn.gs: "It is a label, not part of what the document is called, and
      leaving an unrecognised one on produces '[Checklist] Monthly Close'
      sitting in a list beside 'Monthly Close' - two titles for one kind of
      thing."
    */
    name = name.slice(bracket[0].length);
  }

  // ---- the business, off the front of what is left ----
  let biz = '';
  const list = content.LEARN_BUSINESS || [];
  for (let i = 0; i < list.length; i++) {
    /*
      Followed by a separator, not by a letter. Without the boundary 'MG'
      matches the front of 'MGT Report' and eats three letters of a title.
    */
    const at = new RegExp('^' + list[i] + '(?=[\\s_\\-]+)', 'i').exec(name);
    if (at) {
      biz = list[i];
      name = name.slice(at[0].length).replace(/^[\s_\-]+/, '');
      break;
    }
  }

  return { type: type, typed: typed, title: learnTitle(name), biz: biz,
           ext: ext };
}


/**
 * One document, from a Drive file and where it was found.
 *
 * THE FOLDER DECIDES THE MODULE AND THE BUSINESS, not the filename. trail[0]
 * is the top-level folder, trail[1] the one under it. A file sitting loose
 * in the root has neither, which Learn.gs calls "a real state and not an
 * error".
 */
function documentFrom(file, trail) {
  const parsed = parseLearnName(file.name);
  const mod = trail.length ? learnModule(trail[0]) : null;
  const biz = trail.length > 1 ? learnBusiness(trail[1]) : '';

  return {
    id: file.id,
    title: parsed.title,
    type: parsed.type,
    typed: parsed.typed,
    module: mod ? mod.name : '',
    business: biz,
    // What the filename claimed, so a check can compare it with the folder.
    claimed: parsed.biz,
    kind: content.learnKind(file.mimeType, file.name),
    bytes: Number(file.size) || 0,
    updated: file.modifiedTime || null,
    path: trail.concat([file.name]).join(' / ')
  };
}


/**
 * Every document under one root.
 *
 * ITERATIVE RATHER THAN RECURSIVE, which Learn.gs chose for a reason worth
 * keeping even though Node's stack is deeper than Apps Script's: "a folder
 * loop - which a Drive shortcut can make - overflows it with an error that
 * names nothing useful. A queue just stops at the depth cap."
 *
 * @param {Object} lister  { list(folderId) -> { files, folders } }
 * @param {string} rootId
 */
async function walk(lister, rootId) {
  const docs = [];
  let folders = 0;

  const queue = [{ id: rootId, trail: [], depth: 0 }];

  while (queue.length) {
    const here = queue.shift();
    folders++;

    const got = await lister.list(here.id);

    (got.files || []).forEach(function (file) {
      /*
        Drive keeps a trashed file reachable through its parent folder's
        iterator. A document somebody deleted last week should not still be
        on the page.
      */
      if (file.trashed) return;
      docs.push(documentFrom(file, here.trail));
    });

    if (here.depth >= MAX_DEPTH) continue;
    (got.folders || []).forEach(function (folder) {
      if (folder.trashed) return;
      queue.push({ id: folder.id, trail: here.trail.concat([folder.name]),
                   depth: here.depth + 1 });
    });
  }

  return { docs: docs, folders: folders };
}


/**
 * Reads both roots and rewrites the `learn` table from what it found.
 *
 * WHOLE, IN ONE TRANSACTION, because this is a cache of the folders and a
 * half-written cache is worse than a stale one: a scan that fell over
 * between the delete and the insert would leave the Learnings page empty
 * and nothing would say why.
 *
 * `archived_at` and `archived_by` SURVIVE THE REWRITE. They are the only two
 * facts here that Drive does not hold - see db/19-learn-archive.sql - so the
 * rewrite carries them across by file id rather than dropping them. Without
 * that, who archived a document would be forgotten an hour later by the
 * scan that noticed it had been archived.
 *
 * @param {Object} lister  the Drive lister, or any stand-in
 * @param {Object} roots   { live: folderId, archive: folderId }
 */
async function scanInto(lister, roots) {
  const live = roots.live ? await walk(lister, roots.live)
                          : { docs: [], folders: 0 };
  const archive = roots.archive ? await walk(lister, roots.archive)
                                : { docs: [], folders: 0 };

  live.docs.forEach(function (d) { d.archived = false; });
  archive.docs.forEach(function (d) { d.archived = true; });

  /*
    A FILE IN BOTH ROOTS IS COUNTED ONCE, as archived. It should not happen -
    moving a file is not copying it - but a shortcut, or somebody who
    duplicated rather than moved, can produce it, and the shelf is the safer
    of the two answers: a document that has been superseded must not go on
    being served as current because a stray copy was left behind.
  */
  const seen = {};
  const all = [];
  archive.docs.concat(live.docs).forEach(function (d) {
    if (seen[d.id]) return;
    seen[d.id] = true;
    all.push(d);
  });

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const kept = {};
    const was = await client.query(
      'SELECT file_id, archived_at, archived_by FROM learn');
    was.rows.forEach(function (r) { kept[r.file_id] = r; });

    await client.query('DELETE FROM learn');

    for (const d of all) {
      const before = kept[d.id] || {};
      await client.query(
        `INSERT INTO learn (file_id, title, type, module, business, kind,
                            size, updated, path, archived, archived_at,
                            archived_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [d.id, d.title, d.type, d.module, d.business, d.kind,
         content.learnSize(d.bytes), d.updated, d.path, d.archived,
         d.archived ? (before.archived_at || null) : null,
         d.archived ? (before.archived_by || '') : '']);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return {
    documents: all.length,
    live: live.docs.length,
    archived: archive.docs.length,
    folders: live.folders + archive.folders,
    /* What checkLearnFolder reports: the ones the convention did not fit. */
    untyped: all.filter(function (d) { return !d.typed; }).length,
    homeless: all.filter(function (d) { return !d.module; }).length,
    /*
      A filename that names a business the folder disagrees with. The folder
      wins - see documentFrom - and the disagreement is worth reporting
      rather than silently resolving.
    */
    disputed: all.filter(function (d) {
      return d.claimed && d.business && d.claimed !== d.business;
    }).length
  };
}


module.exports = {
  MAX_DEPTH,
  learnFlat, learnTitle, learnModule, learnBusiness, parseLearnName,
  documentFrom, walk, scanInto
};
