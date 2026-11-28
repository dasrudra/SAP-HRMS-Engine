/**
 * content.js - the FAQ, the meeting links, Knowledge Share, Learnings.
 * ===========================================================================
 *
 * Ported from src/Questions.gs (faqEntries), src/ByWeekly.gs
 * (getByWeeklyLinks, byWeeklySafe), src/Knowledge.gs (readKnowledge,
 * getKnowledge, createKnowledge, deleteKnowledge, newKnowledgeId,
 * parseKnowledgeFiles) and src/Learn.gs (readLearn, getLearning, learnKind,
 * learnSize, learnTypeList, learnModuleList).
 *
 * FOUR SCREENS IN ONE FILE because underneath they are one shape: a list
 * somebody reads. Only Knowledge is written to from the page.
 *
 * WHAT LEARNINGS AND KNOWLEDGE ARE, AND WHY THEY ARE NOT THE SAME SCREEN
 *
 * Knowledge.gs puts it better than a summary would:
 *
 *   "Learnings is the library: approved SOPs, policies and user guidelines,
 *    written by the people who own the process, named to a convention,
 *    filed in a Drive tree somebody maintains. It is READ-ONLY from the
 *    page, and that is correct - an SOP anybody can edit from a browser is
 *    not an SOP.
 *
 *    This is the opposite half, and the team needs both. It is for the
 *    thing somebody worked out at four in the afternoon and would otherwise
 *    tell one colleague ... ANYBODY SIGNED IN CAN POST, there is no
 *    approval step, and there is no naming convention to get wrong."
 *
 * They look alike on purpose and behave nothing alike. Keeping them in one
 * file is not a step towards merging them.
 */

const crypto = require('crypto');
const db = require('./db');

const TZ = 'Asia/Dhaka';                      // appsscript.json

// Knowledge.gs:77-79
const KNOWLEDGE_CHUNK = 4 * 1024 * 1024;
const KNOWLEDGE_MAX_FILE = 20 * 1024 * 1024;
const KNOWLEDGE_MAX_FILES = 10;
const KNOWLEDGE_TITLE_MAX = 200;
const KNOWLEDGE_BODY_MAX = 20000;
const KNOWLEDGE_TAGS_MAX = 8;

// Learn.gs, "ninety days, not a calendar quarter".
const LEARN_FRESH_DAYS = 90;


// ---------------------------------------------------------------------------
// Config.gs, carried across as constants
// ---------------------------------------------------------------------------
/*
  THESE LIVE IN THE CODE IN THE ORIGINAL AND SO THEY LIVE IN THE CODE HERE.

  It would be easy to put the section names, the document types and the
  modules in tables and call that tidier. It would also be wrong twice
  over. ByWeekly.gs says why for the sections - "a tab whose first column
  could be typed wrong is a tab that silently loses a button" - and the
  same argument covers the rest: these are not data somebody maintains,
  they are the shape of the page. The one thing that does change, the
  address of each deck, is the one thing in a table.
*/

/** ByWeekly.gs:44. `key` is never shown; the tab is matched on `name`. */
const BY_WEEKLY_SECTIONS = [
  { key: 'SCA',  name: 'Supply Chain',     accent: '#4cc9f0' },
  { key: 'SDMM', name: 'Sales & Customer', accent: '#5b9cf8' },
  { key: 'PP',   name: 'Manufacturing',    accent: '#9d7bef' },
  { key: 'FICO', name: 'Financial',        accent: '#7b86f0' }
];

/** Config.gs LEARN.TYPES, with the duplicates the page must not draw. */
const LEARN_TYPES = [
  { match: 'sop',           name: 'SOP',            accent: 0 },
  { match: 'userguideline', name: 'User Guideline', accent: 1 },
  { match: 'guideline',     name: 'User Guideline', accent: 1 },
  { match: 'policy',        name: 'Policy',         accent: 2 },
  { match: 'training',      name: 'Training',       accent: 3 },
  { match: 'manual',        name: 'User Guideline', accent: 1 },
  { match: 'presentation',  name: 'Training',       accent: 3 }
];
const LEARN_FALLBACK_TYPE = 'Document';

const LEARN_MODULES = [
  { match: 'common', name: 'Common', accent: 3 },
  { match: 'mm',     name: 'MM',     accent: 0 },
  { match: 'sd',     name: 'SD',     accent: 1 },
  { match: 'pp',     name: 'PP',     accent: 2 },
  { match: 'fico',   name: 'FI-CO',  accent: 3 }
];
const LEARN_BUSINESS = ['RMG', 'MG'];

/**
 * Config.gs portalLinks(). The Links screen, and the front page's buttons.
 *
 * ALL PUBLIC ADDRESSES, WHICH IS WHY THEY CAN BE WRITTEN DOWN - and the
 * one that cannot is not here. Config.gs makes the distinction explicitly
 * on the SharePoint entry: a SITE address is fine in a public file, but a
 * link to a file in somebody's own OneDrive "spells the owner's work email
 * out in the path", which is why the four meeting decks live in a table
 * and these do not.
 *
 * `view` instead of `url` means it does not leave the portal. By-Weekly
 * Meetings opens the page of four section buttons rather than a site, for
 * exactly that reason.
 *
 * NOTHING SORTS THIS LIST, so the order written here is the order on the
 * page - which is why a new one goes where it belongs rather than on the
 * end for convenience. `row` is which row of the front page a button sits
 * on; entries without one are Links-page only, because "four buttons under
 * the headline is already the most a front page can say without becoming a
 * menu".
 */
const SAP_APP_URL = 'https://sapuserhub.blogspot.com/';

const PORTAL_LINKS = [
  { name: 'SAP & HRMS UserHub', url: SAP_APP_URL,
    hero: 'Open SAP UserHub', row: 1 },
  { name: 'RMG PA Report', url: 'https://rmg-pa.blogspot.com/',
    hero: 'Open RMG PA Report', row: 2 },
  { name: 'Groupware & ITSM',
    url: 'https://gw2.youngone.com/covicore/login.do',
    hero: 'Open Groupware & ITSM', row: 2 },
  { name: 'By-Weekly Meetings', view: 'byweekly' },
  { name: 'TVL Knowledge Base',
    url: 'https://youngone0.sharepoint.com/sites/KnowledgeBase' },
  { name: 'YO PABX', url: 'https://www.youngonectg.com/' },
  { name: 'Tekvision', url: 'https://www.tekvision.com.bd/home' },
  { name: 'Microsoft Office account',
    url: 'https://myaccount.microsoft.com/?ref=MeControl' },
  { name: 'YO OneDrive / SharePoint',
    url: 'https://youngone0-my.sharepoint.com/' },
  { name: 'Microsoft Forms',
    url: 'https://forms.cloud.microsoft/Pages/DesignPagev2.aspx' },
  { name: 'LinkedIn', url: 'https://www.linkedin.com/' }
];

/** Config.gs FAQ_SEED. Used only while the faq table is empty. */
const FAQ_SEED = [
  ['How do I sign in for the first time?',
   'Use the starting login your team gave you. The dashboard will then ask ' +
   'you to set your own password against your employee ID, and you use that ' +
   'from the next time on.'],
  ['I forgot my password.',
   'Ask for a reset. Your password goes back to the starting one and the ' +
   'dashboard asks you to choose a new one the next time you sign in. ' +
   'Nobody can read your old password - it is not stored in a form anyone ' +
   'can read back.'],
  ['What do GREEN, YELLOW and RED mean?',
   'They are the ratings in the approved KPI policy. GREEN is at or above ' +
   'the target, YELLOW is below target and needs improvement, RED is ' +
   'critical. The exact figures for each indicator are on the Summary ' +
   'screen under KPI thresholds.'],
  ['Why does the By individuals table show somebody from another section?',
   'It does not any more. That table filters by section, and a section is ' +
   'where somebody sits. Earlier it filtered by module - what a ticket was ' +
   'about - and the two are not the same thing.'],
  ['What counts as an open ticket?',
   'A ticket with no completion date. It was received and has not been ' +
   'completed, so it is counted in Received and in Open but not in ' +
   'Completed, and it cannot be delayed yet.'],
  ['Can I download what is on screen?',
   'Yes. Every table has a download button in its corner, and it exports ' +
   'exactly what you are looking at - including any filters you have set.'],
  ['The figures look wrong for my section.',
   'Ask below with the month and the section, and say what you expected. ' +
   'Most of these turn out to be a ticket filed under a different section ' +
   'in the ITSM export, which we can check against the source.']
];


// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** 'd MMM yyyy' in the dashboard's own timezone, as Utilities.formatDate. */
function shortDate(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return '';
  const p = {};
  new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric'
  }).formatToParts(d).forEach(function (part) { p[part.type] = part.value; });
  return p.day + ' ' + p.month + ' ' + p.year;
}

/** 'yyyyMMddHHmmss' in the same timezone, for a sortable id. */
function idStamp(value) {
  const d = value || new Date();
  const p = {};
  new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(d).forEach(function (part) { p[part.type] = part.value; });
  const hh = p.hour === '24' ? '00' : p.hour;
  return p.year + p.month + p.day + hh + p.minute + p.second;
}


// ---------------------------------------------------------------------------
// FAQ
// ---------------------------------------------------------------------------
/**
 * The published FAQ, in order.   [Questions.gs:53]
 *
 * NO TOKEN. The FAQ is on the sign-in page, where nobody has one, and there
 * is nothing in it that is not already meant for everybody.
 *
 * THE SEED IS A FALLBACK, NOT A STARTING POINT. An empty table means the
 * seven questions in FAQ_SEED, "so a fresh database still has something to
 * show". One row in the table and the seed is not used at all - an
 * override rather than a merge, which is the only version that lets
 * somebody delete a seeded question.
 */
async function faqEntries() {
  try {
    const rows = await db.query(
      `SELECT ord, question, answer FROM faq
        WHERE btrim(question) <> '' AND btrim(answer) <> ''
        ORDER BY ord, id`);
    if (rows.length) {
      return rows.map(function (r) {
        return { order: Number(r.ord) || 0,
                 question: String(r.question).trim(),
                 answer: String(r.answer).trim() };
      });
    }
  } catch (err) {
    // The original wraps the whole read and falls through to the seed, so
    // a missing tab shows the FAQ rather than an error. A missing table
    // here is the same situation - somebody has not run 10-content.sql -
    // and a sign-in page that will not draw because of it would be a worse
    // outcome than a slightly out-of-date FAQ.
    console.error('  faq: ' + err.message + ' - showing the built-in list');
  }

  return FAQ_SEED.map(function (pair, i) {
    return { order: i + 1, question: pair[0], answer: pair[1] };
  });
}


// ---------------------------------------------------------------------------
// By-Weekly
// ---------------------------------------------------------------------------
/**
 * An address the page may put in an href, or ''.   [ByWeekly.gs:142]
 *
 * ONLY http AND https. A row on a shared table reaches an anchor's href
 * here, and `javascript:` in an href runs when somebody clicks it. Nobody
 * is expected to do that on purpose; the check costs one line and means
 * the table cannot become a way in.
 */
function byWeeklySafe(url) {
  const text = String(url || '').trim();
  return /^https?:\/\//i.test(text) ? text : '';
}

/**
 * The four sections, with whatever address each has.   [ByWeekly.gs:105]
 *
 * A section with no address still comes back - the page draws it greyed
 * out and says it has no link yet, which is a thing somebody can fix. A
 * button that silently disappeared would just look like the page was
 * wrong.
 *
 * NOT CACHED, unlike the original, which keeps it in CacheService for an
 * hour because "four short strings ... against a whole-tab read on a page
 * people open to press one button". A whole-tab read was the thing worth
 * avoiding; four rows on a primary key is not. The cache also had a cost
 * the comment admits - refreshByWeeklyLinks() exists only to clear it
 * after an edit - and a page that shows yesterday's address for an hour
 * after somebody fixed it is the bug that function was written to patch.
 */
async function byWeeklyLinks() {
  const found = {};
  try {
    const rows = await db.query('SELECT section, link FROM by_weekly');
    rows.forEach(function (r) {
      const name = String(r.section || '').trim().toUpperCase();
      const url = String(r.link || '').trim();
      if (name && url) found[name] = url;
    });
  } catch (err) {
    // No table yet; every link reads as missing, and the four buttons are
    // still drawn. Same as the original's empty catch.
    console.error('  by_weekly: ' + err.message);
  }

  return {
    ok: true,
    links: BY_WEEKLY_SECTIONS.map(function (s) {
      return { key: s.key, name: s.name, accent: s.accent,
               url: byWeeklySafe(found[s.name.toUpperCase()] || '') };
    })
  };
}

/** Saves one section's address. MASTER only - see the endpoint. */
async function setByWeeklyLink(sectionName, url) {
  const name = String(sectionName || '').trim();
  const known = BY_WEEKLY_SECTIONS.filter(function (s) {
    return s.name.toUpperCase() === name.toUpperCase();
  })[0];
  if (!known) return { ok: false, message: 'There is no section called that.' };

  const text = String(url || '').trim();
  // An empty address is how a link is removed, so it is allowed through.
  // Anything else has to be one the page could actually follow - saving a
  // `javascript:` URL and only refusing to render it later would leave it
  // sitting in the table looking saved.
  if (text && !byWeeklySafe(text)) {
    return { ok: false,
             message: 'That is not a web address - it has to start with ' +
                      'http:// or https://.' };
  }

  await db.query(
    `INSERT INTO by_weekly (section, link, updated_at) VALUES ($1,$2, now())
     ON CONFLICT (section) DO UPDATE
       SET link = EXCLUDED.link, updated_at = now()`,
    [known.name, text]);

  return { ok: true, message: text ? 'Saved.' : 'Address removed.' };
}


// ---------------------------------------------------------------------------
// Portal links
// ---------------------------------------------------------------------------
/**
 * The portal's own links.   [Config.gs:1772 portalLinks]
 *
 * The filter at the end of the original is kept: an entry with neither a
 * `url` nor a `view` is dropped rather than drawn as a button that does
 * nothing. It cannot happen with the list as written, and it is one line
 * standing between a half-finished edit and a dead button on the page.
 *
 * Every url goes through byWeeklySafe for the same reason the meeting
 * decks do - these reach an anchor's href too. The original does not check
 * them, because they are written in a file only a developer can edit; the
 * check costs nothing and means there is one rule for every address this
 * API hands a browser rather than two.
 */
function portalLinks(list) {
  /*
    The list is a parameter with a default ONLY so the guard below can be
    tested. It exists for an entry nobody has written yet - a half-finished
    edit, or an address a browser must not follow - so against the real
    list it is invisible, and a break that removes it changes nothing
    anybody can see. A guard no test can reach is a guard that quietly
    stops existing.

    ONE FILTER, AT THE END, AND IT USED TO BE TWO. The original filters
    before mapping; this also has to filter after, because byWeeklySafe
    can blank a url and leave an entry with no usable address. Mutation
    testing showed the first filter's (l.url || l.view) was then dead -
    removing it broke nothing, because the second one already covered it.
    Filtering once, after the map, does both jobs: a null entry and an
    entry whose address did not survive the check are the same outcome.
  */
  return (list || PORTAL_LINKS)
    .map(function (l) {
      if (!l) return null;
      const out = { name: l.name };
      if (l.url) out.url = byWeeklySafe(l.url);
      if (l.view) out.view = l.view;
      if (l.hero) out.hero = l.hero;
      if (l.row) out.row = l.row;
      return out;
    })
    .filter(function (l) { return l && (l.url || l.view); });
}


// ---------------------------------------------------------------------------
// Shared with Learnings: what a file is, and how big
// ---------------------------------------------------------------------------

/** What kind of document this is, for the icon.   [Learn.gs:304] */
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
 * A byte count as the page should print it.   [Learn.gs:333]
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
// Knowledge Share
// ---------------------------------------------------------------------------

/**
 * An id for a new share.   [Knowledge.gs:134]
 *
 * The timestamp makes it sortable and tells you when it was made from the
 * id alone; the random tail stops two people posting in the same second
 * from colliding. Not a row number - rows move when somebody sorts.
 */
function newKnowledgeId() {
  return 'K' + idStamp(new Date()) + '-' +
    crypto.randomBytes(4).toString('hex').slice(0, 5).toUpperCase();
}

/**
 * The attachment index on a share, in the shape the page wants.
 *
 * Bad JSON comes back as no attachments rather than as an exception - "a
 * share whose index somebody broke by editing the cell should still show
 * its words". jsonb cannot be broken that way, but a row imported from the
 * sheet can still carry a list of something other than attachments, so the
 * shape is still checked.
 *
 * THE preview / open / download ADDRESSES ARE NOT BUILT HERE and the
 * original builds three Drive URLs per file. This port has no file store
 * yet, so there is nowhere for them to point, and inventing a Drive link
 * for a file this system did not put in Drive would be a link that 404s.
 * `files` is empty on everything this port writes - see PORT-INVENTORY.md.
 */
function knowledgeFiles(cell) {
  let list = cell;
  if (typeof list === 'string') {
    try { list = JSON.parse(list || '[]'); } catch (e) { return []; }
  }
  if (!Array.isArray(list)) return [];

  return list.filter(function (f) { return f && f.id; }).map(function (f) {
    return {
      id: String(f.id),
      name: String(f.name || 'Attachment'),
      mime: String(f.mime || ''),
      size: Number(f.size) || 0,
      kind: learnKind(f.mime, f.name),
      sizeText: learnSize(Number(f.size) || 0)
    };
  });
}

/** One database row as the page reads it. */
function knowledgeShape(row) {
  const created = row.created ? new Date(row.created) : null;
  const updated = row.updated ? new Date(row.updated) : null;

  return {
    id: row.share_id,
    title: row.title,
    body: row.body || '',
    tags: String(row.tags || '').split(',')
            .map(function (t) { return t.trim(); })
            .filter(Boolean),
    author: String(row.author || '').trim() || 'Unknown',
    authorId: String(row.author_id || '').trim(),
    created: shortDate(created),
    stamp: created ? created.getTime() : 0,
    // A minute's grace, so that the two timestamps written together when a
    // share is posted do not make every share read as edited.
    edited: Boolean(updated && created &&
                    updated.getTime() - created.getTime() > 60000),
    files: knowledgeFiles(row.files)
  };
}

/**
 * Every share, newest first.   [Knowledge.gs:219]
 *
 * Newest first and not oldest: this is a feed of what colleagues have
 * worked out lately, and the useful end of it is the recent end. Learnings
 * is the other way round - a library is ordered by where a thing belongs,
 * not by when it arrived.
 */
async function readKnowledge() {
  const rows = await db.query(
    `SELECT share_id, title, body, tags, author, author_id,
            created, updated, files
       FROM knowledge
      WHERE btrim(title) <> ''
      ORDER BY created DESC, share_id DESC`);

  const shares = rows.map(knowledgeShape);
  return { shares: shares, count: shares.length, filled: true };
}

/**
 * Everything the Knowledge Share page needs.   [Knowledge.gs:282]
 *
 * NOT CACHED, unlike the Learnings library. That one is a mirror of a
 * folder that changes a few times a month, so ten minutes of staleness
 * costs nothing. This changes the moment somebody posts, and a colleague
 * who shares something and cannot see it is a colleague who posts it twice.
 *
 * WHO IS LOOKING goes with it, so the page knows whose Remove button to
 * draw. Decided here and not in the browser: a page that works out its own
 * permissions is a page that can be told it has different ones from a
 * console. No admin flag goes with it, and that is deliberate - see
 * deleteKnowledge. Removing is the author's and nobody else's.
 */
async function getKnowledge(employeeId) {
  const data = await readKnowledge();
  data.me = String(employeeId || '');
  data.maxFile = KNOWLEDGE_MAX_FILE;
  data.maxFiles = KNOWLEDGE_MAX_FILES;
  data.chunk = KNOWLEDGE_CHUNK;
  return data;
}

/**
 * Who is posting, by name where we can find one.   [Knowledge.gs:152]
 *
 * The session carries an employee ID and nothing else. A page of notes
 * signed with an eight-digit number is a page nobody reads as written by a
 * person, so the ID is looked up in the directory.
 *
 * Wrapped, because a share that cannot be posted because the directory is
 * mid-edit is a worse failure than a share signed with a number.
 */
async function knowledgeAuthor(employeeId) {
  const id = String(employeeId || '').trim();
  if (!id) return { id: '', name: 'Unknown' };
  try {
    const rows = await db.query(
      'SELECT full_name FROM team WHERE employee_id = $1', [id]);
    if (rows.length && String(rows[0].full_name || '').trim()) {
      return { id: id, name: String(rows[0].full_name).trim() };
    }
  } catch (err) { /* a name is a courtesy; the id is the fact */ }
  return { id: id, name: id };
}

/**
 * Posts a share. The words only - attachments would follow, one call each.
 *
 * Returns the whole share rather than just its id, so the page can draw it
 * without a second round trip and without inventing a local copy that
 * might differ from what was actually stored.
 */
async function createKnowledge(employeeId, draft) {
  const d = draft || {};
  const title = String(d.title || '').trim();
  const body = String(d.body || '').trim();

  if (!title) return { ok: false, message: 'A share needs a title.' };
  if (title.length > KNOWLEDGE_TITLE_MAX) {
    return { ok: false,
             message: 'That title is too long - ' + KNOWLEDGE_TITLE_MAX +
                      ' characters at most.' };
  }
  if (body.length > KNOWLEDGE_BODY_MAX) {
    return { ok: false,
             message: 'That is longer than a share should be - ' +
                      KNOWLEDGE_BODY_MAX.toLocaleString('en-GB') +
                      ' characters at most. Anything bigger belongs in a ' +
                      'document, attached.' };
  }

  const who = await knowledgeAuthor(employeeId);
  const tags = String(d.tags || '').split(',')
    .map(function (t) { return t.trim(); })
    .filter(Boolean).slice(0, KNOWLEDGE_TAGS_MAX).join(', ');

  const rows = await db.query(
    `INSERT INTO knowledge (share_id, title, body, tags, author, author_id)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING share_id, title, body, tags, author, author_id,
               created, updated, files`,
    [newKnowledgeId(), title, body, tags, who.name, who.id]);

  return { ok: true, share: knowledgeShape(rows[0]) };
}

/**
 * Removes a share.   [Knowledge.gs:491]
 *
 * THE AUTHOR'S AND NOBODY ELSE'S, not even a master's. Knowledge.gs
 * decided it that way on purpose: this is a page people post half-finished
 * thoughts to, and a note somebody else can delete is a note people think
 * twice about writing. The awkward case - a share whose author has left -
 * is rare, and the chilling effect would be constant.
 *
 * One statement, so a share cannot be read, checked and then deleted out
 * from under a concurrent change. Nothing comes back when the id is
 * unknown OR the caller is not the author, and the two are told apart
 * afterwards only to say something useful.
 */
async function deleteKnowledge(employeeId, shareId) {
  const id = String(shareId || '').trim();
  const me = String(employeeId || '');

  const gone = await db.query(
    'DELETE FROM knowledge WHERE share_id = $1 AND author_id = $2 RETURNING share_id',
    [id, me]);
  if (gone.length) return { ok: true };

  const exists = await db.query(
    'SELECT 1 FROM knowledge WHERE share_id = $1', [id]);
  return exists.length
    ? { ok: false, message: 'Only the person who shared this can remove it.' }
    : { ok: false, message: 'That share no longer exists.' };
}


// ---------------------------------------------------------------------------
// Learnings
// ---------------------------------------------------------------------------

/**
 * The document types, with the duplicates removed.   [Learn.gs:771]
 *
 * 'userguideline', 'guideline' and 'manual' all resolve to User Guideline
 * so that any of the three spellings is recognised, and handing that
 * straight to the page would draw three identical chips.
 */
function learnTypeList() {
  const out = [];
  const seen = {};
  LEARN_TYPES.forEach(function (t) {
    if (seen[t.name]) return;
    seen[t.name] = true;
    out.push({ name: t.name, accent: t.accent });
  });

  // The catch-all is a real type on the page - it gets a chip and a count
  // like any other - so that the number under "All" is always the number
  // of documents in the library. It goes last because it is the absence of
  // a type rather than one of them.
  if (!seen[LEARN_FALLBACK_TYPE]) {
    out.push({ name: LEARN_FALLBACK_TYPE, accent: 3 });
  }
  return out;
}

/**
 * The modules, in the order the page lists them.   [Learn.gs:807]
 *
 * `split` says whether the module has MG and RMG folders under it. Common
 * does not - its documents apply to both businesses - and a tree that
 * draws two empty sub-folders under it is a tree that invites somebody to
 * go looking for documents that were never there.
 */
function learnModuleList() {
  return LEARN_MODULES.map(function (m) {
    return { name: m.name, accent: m.accent, split: m.match !== 'common' };
  });
}

/**
 * The library, in the shape the Learnings page wants.   [Learn.gs:841]
 *
 * NOT CACHED. The original keeps it in CacheService for ten minutes
 * because the alternative was a whole-tab read on every page load, and
 * notes honestly that a library over 100KB is refused by the cache and
 * silently pays for the read anyway. A query on an indexed table is not
 * the thing that cache was protecting against, and dropping it means
 * scanLearnFolder no longer has to remember to clear anything.
 */
async function readLearn() {
  const rows = await db.query(
    `SELECT file_id, title, type, module, business, kind, size, updated, path
       FROM learn
      WHERE btrim(title) <> ''`);

  // Ninety days, not a calendar quarter. The tile says "this quarter" and
  // means "recently"; a calendar quarter makes that number collapse to
  // zero every January and read as a library nobody has touched.
  const fresh = Date.now() - (LEARN_FRESH_DAYS * 24 * 60 * 60 * 1000);
  let quarter = 0;

  const docs = rows.map(function (r) {
    const updated = r.updated ? new Date(r.updated) : null;
    if (updated && updated.getTime() >= fresh) quarter++;

    return {
      title: String(r.title).trim(),
      type: String(r.type || '').trim() || LEARN_FALLBACK_TYPE,
      module: String(r.module || '').trim(),
      business: String(r.business || '').trim(),
      kind: String(r.kind || '').trim() || 'file',
      size: String(r.size || '').trim(),
      updated: shortDate(updated),
      // Sortable, and not shown. The page orders by recency on the All
      // view, and '1 Nov 2026' sorts before '2 Oct 2026' as text.
      stamp: updated ? updated.getTime() : 0,
      path: String(r.path || '').trim(),
      id: r.file_id
    };
  });

  return {
    docs: docs,
    types: learnTypeList(),
    modules: learnModuleList(),
    businesses: LEARN_BUSINESS,
    count: docs.length,
    quarter: quarter,
    // The original answers filled:false for an empty tab, and the page
    // draws "nothing here yet, run a scan" rather than an empty library
    // that looks broken.
    filled: docs.length > 0
  };
}


module.exports = {
  BY_WEEKLY_SECTIONS, FAQ_SEED, PORTAL_LINKS, SAP_APP_URL, portalLinks,
  KNOWLEDGE_CHUNK, KNOWLEDGE_MAX_FILE, KNOWLEDGE_MAX_FILES,
  KNOWLEDGE_TITLE_MAX, KNOWLEDGE_BODY_MAX, KNOWLEDGE_TAGS_MAX,
  /*
    The three classification lists. LEARN_TYPES and LEARN_MODULES were not
    exported while only this file read them; learn-scan.js reads them now,
    and it must read THESE rather than keep a copy - the same rule the KPI
    definitions follow, for the same reason.
  */
  LEARN_TYPES, LEARN_MODULES,
  LEARN_BUSINESS, LEARN_FALLBACK_TYPE, LEARN_FRESH_DAYS,
  shortDate, idStamp,
  faqEntries,
  byWeeklySafe, byWeeklyLinks, setByWeeklyLink,
  learnKind, learnSize, learnTypeList, learnModuleList, readLearn,
  newKnowledgeId, knowledgeFiles, knowledgeShape, knowledgeAuthor,
  readKnowledge, getKnowledge, createKnowledge, deleteKnowledge
};
