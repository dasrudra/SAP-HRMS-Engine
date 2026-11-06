// Knowledge.gs - the Knowledge Share portal, on the server.
//
// WHY THIS EXISTS
// Unlike every other page in this project, this one WRITES. Learnings reads
// a folder, the KPI screens read a cache, the directory reads a tab - all of
// them are wrong in ways somebody notices and nobody loses anything over.
// This takes what a colleague typed and the file they attached and has to
// not lose either, and it decides who may delete whose work.
//
// WHAT IT GUARDS, worst first:
//
//   chunks reassembled by INDEX     Drive's folder iterator is not
//                                   documented to return anything in any
//                                   order. A file joined in iterator order
//                                   is corrupt in a way nothing checks and
//                                   nobody discovers until they open it
//   a part that never arrived       must fail loudly, not write a file
//                                   that is quietly missing four megabytes
//   whose share it is               the author or an admin, and nobody
//                                   else - a note a stranger can delete is
//                                   a note nobody posts
//   the words before the files      a share is saved before anything is
//                                   uploaded, so a failed attachment loses
//                                   an attachment and not ten minutes of
//                                   typing
//   a broken Files cell             shows the share without its
//                                   attachments, rather than throwing and
//                                   taking the whole feed down
//
//   node tests/knowledge-test.js
const fs = require('fs'), vm = require('vm'), path = require('path');
const SRC = process.env.EAS_SRC || path.join(__dirname, '..', 'src');

const out = [];
const check = (n, ok, d) => {
  out.push(ok);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (d ? '   [' + d + ']' : ''));
};

// ---------------------------------------------------------------------------
// a spreadsheet just real enough
// ---------------------------------------------------------------------------
function makeSheet() {
  const all = [[
    'ID', 'Title', 'Body', 'Tags', 'Author', 'Author ID',
    'Created', 'Updated', 'Files'
  ]];
  return {
    rows: all,
    getName: () => 'KNOWLEDGE',
    getLastRow: () => all.length,
    getLastColumn: () => all[0].length,
    appendRow: function (row) { all.push(row.slice()); },
    deleteRow: function (r) { all.splice(r - 1, 1); },
    getRange: function (r, c, n, w) {
      return {
        getValue: function () {
          return (all[r - 1] || [])[c - 1];
        },
        setValue: function (v) {
          if (!all[r - 1]) all[r - 1] = [];
          all[r - 1][c - 1] = v;
        },
        getValues: function () {
          const got = [];
          for (let i = 0; i < (n === undefined ? 1 : n); i++) {
            got.push((all[r - 1 + i] || []).slice(c - 1, c - 1 + (w || 1)));
          }
          return got;
        },
        setValues: function (vals) {
          for (let i = 0; i < vals.length; i++) all[r - 1 + i] = vals[i].slice();
          return { setFontWeight: () => ({ setBackground: () => ({ setFontColor: () => {} }) }) };
        }
      };
    }
  };
}

// ---------------------------------------------------------------------------
// a Drive just real enough
// ---------------------------------------------------------------------------
// Files are kept as byte ARRAYS, not strings, because the thing most worth
// proving here is that a file split into pieces comes back byte for byte.
function makeDrive(opts) {
  const o = opts || {};
  let seq = 0;
  const files = {};               // id -> {name, mime, bytes, trashed}

  const handle = (id) => ({
    getId: () => id,
    getName: () => files[id].name,
    getSize: () => files[id].bytes.length,
    getMimeType: () => files[id].mime,
    isTrashed: () => files[id].trashed,
    setTrashed: function (v) { files[id].trashed = v; },
    getBlob: () => ({ getBytes: () => files[id].bytes.slice() })
  });

  const iterOf = (list) => {
    let i = 0;
    return { hasNext: () => i < list.length, next: () => list[i++] };
  };

  const folder = {
    getName: () => 'Knowledge',
    createFile: function (blob) {
      const id = 'f' + (++seq);
      files[id] = { name: blob.__name, mime: blob.__mime,
                    bytes: blob.__bytes.slice(), trashed: false };
      return handle(id);
    },
    getFiles: function () {
      let live = Object.keys(files).filter((id) => !files[id].trashed);
      // THE ITERATOR HANDS THEM BACK IN NO PARTICULAR ORDER, and the real
      // one makes no promise either. Reversed here so that any code which
      // assumes insertion order is wrong on every single run rather than
      // on an unlucky one.
      if (o.shuffle !== false) live = live.reverse();
      return iterOf(live.map(handle));
    },
    setSharing: function (a, p) { folder.__shared = [a, p]; }
  };

  return {
    __files: files,
    __folder: folder,
    getFolderById: function () {
      if (o.badFolder) throw new Error('No item with the given ID could be found');
      return folder;
    },
    getFileById: function (id) {
      if (!files[id]) throw new Error('No item with the given ID could be found');
      return handle(id);
    },
    Access: { ANYONE_WITH_LINK: 'ANYONE_WITH_LINK' },
    Permission: { VIEW: 'VIEW' }
  };
}

// ---------------------------------------------------------------------------
// the context
// ---------------------------------------------------------------------------
const FOLDER = 'https://drive.google.com/drive/folders/1kNowLeDgE000000000000000';

function load(opts) {
  const o = opts || {};
  const logs = [];
  const sheet = makeSheet();
  const drive = makeDrive(o);
  const session = o.session || { u: '20000003', r: 'USER' };

  const ctx = {
    console: console,
    Logger: {
      log: function (fmt) {
        const args = Array.prototype.slice.call(arguments, 1);
        let i = 0;
        logs.push(String(fmt).replace(/%s/g, () =>
          (i < args.length ? String(args[i++]) : '%s')));
      }
    },
    DriveApp: drive,
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (o.props && k in o.props ? o.props[k] : null),
        setProperty: (k, v) => { (o.props = o.props || {})[k] = v; }
      })
    },
    Utilities: {
      formatDate: (d, tz, fmt) => (fmt === 'd MMM yyyy'
        ? d.getUTCDate() + ' Nov ' + d.getUTCFullYear()
        : 'STAMP'),
      // Byte arrays in and out, so a round trip through these is lossless
      // and the suite can compare what went in with what came back.
      base64Encode: (bytes) => Buffer.from(bytes).toString('base64'),
      base64Decode: (text) => Array.from(Buffer.from(String(text), 'base64')),
      newBlob: (bytes, mime, name) => ({
        __bytes: Array.isArray(bytes) ? bytes : Array.from(bytes),
        __mime: mime, __name: name
      })
    },
    SpreadsheetApp: {}
  };

  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(SRC, 'Config.gs'), 'utf8'), ctx);

  // The helpers Knowledge.gs leans on from elsewhere. learnKind and
  // learnSize are REAL - loaded out of Learn.gs - because an attachment's
  // icon and size on the page come from them and a stub would let them
  // drift. The rest are stubs: Auth.gs would need a whole session store
  // and decides nothing this suite is about.
  ctx.sheetWithHeaders = () => sheet;
  ctx.__sheet = sheet;
  ctx.__logs = logs;
  ctx.__drive = drive;
  ctx.CONFIG_TZ = () => 'Asia/Dhaka';
  ctx.currentSession = () => session;
  ctx.rankOf = (r) => ({ USER: 1, ADMIN: 2, MASTER: 3 }[r] || 0);
  ctx.ROLE_ADMIN = 'ADMIN';
  ctx.requireSignedIn = () => {};
  ctx.readTeam = () => o.team || {
    lead: { name: 'Utpal Biswas', id: '20000000' },
    sections: [{ head: { name: 'Ayesha Rahman', id: '20000001' },
                 members: [{ name: 'Bilal Hossain', id: '20000003' }] }]
  };

  const learn = fs.readFileSync(path.join(SRC, 'Learn.gs'), 'utf8');
  ['learnKind', 'learnSize', 'driveFolderId'].forEach(function (name) {
    const src = name === 'driveFolderId'
      ? fs.readFileSync(path.join(SRC, 'Team.gs'), 'utf8')
      : learn;
    const hit = new RegExp('function ' + name + '\\([\\s\\S]*?\\n}\\n').exec(src);
    if (!hit) throw new Error('could not lift ' + name);
    vm.runInContext(hit[0], ctx);
  });

  vm.runInContext(fs.readFileSync(path.join(SRC, 'Knowledge.gs'), 'utf8'), ctx);
  return ctx;
}

const base = { props: { KNOWLEDGE_FOLDER: FOLDER } };

// ===========================================================================
// 1. posting
// ===========================================================================
{
  const ctx = load(base);
  const share = ctx.createKnowledge('t', {
    title: '  GRN posts with no material document  ',
    body: 'Set the plant before the movement type.',
    tags: ' MM , GRN ,, MM '
  });

  check('a share comes back whole, not just as an id',
    share.id && share.title === 'GRN posts with no material document' &&
    share.body === 'Set the plant before the movement type.',
    share.id + ' / "' + share.title + '"');

  check('and is written to the tab',
    ctx.__sheet.rows.length === 2 &&
    ctx.__sheet.rows[1][1] === 'GRN posts with no material document',
    (ctx.__sheet.rows.length - 1) + ' row(s)');

  check('the author is looked up by employee id, not left as a number',
    share.author === 'Bilal Hossain' && share.authorId === '20000003',
    share.author + ' (' + share.authorId + ')');

  check('tags are trimmed and the empties dropped',
    share.tags.join('|') === 'MM|GRN|MM', share.tags.join('|'));

  let threw = '';
  try { ctx.createKnowledge('t', { title: '   ', body: 'x' }); }
  catch (e) { threw = e.message; }
  check('a share with no title is refused', /needs a title/i.test(threw), threw);

  threw = '';
  try {
    ctx.createKnowledge('t', { title: 'x', body: new Array(20002).join('ab') });
  } catch (e) { threw = e.message; }
  check('and one longer than a spreadsheet cell holds is refused before the write',
    /20,000 characters/.test(threw), threw.slice(0, 60));

  check('the refused shares left nothing behind',
    ctx.__sheet.rows.length === 2, (ctx.__sheet.rows.length - 1) + ' row(s)');
}

// ===========================================================================
// 2. reading the feed back
// ===========================================================================
{
  const ctx = load(base);
  ctx.createKnowledge('t', { title: 'First', body: 'a' });
  ctx.createKnowledge('t', { title: 'Second', body: 'b' });
  ctx.createKnowledge('t', { title: 'Third', body: 'c' });

  // Written a second apart would be a slow test, so the stamps are forced.
  //
  // WITH THE vm'S OWN Date CONSTRUCTOR, which is not optional. readKnowledge
  // asks `row[6] instanceof Date`, and instanceof compares against the Date
  // of the realm doing the asking - a vm context is its own realm, so a Date
  // built out here with Node's constructor is not one of them. The first run
  // of this had every share come back with no date at all and the feed in
  // sheet order, and the product code was right: the fixture was handing it
  // foreign objects. Apps Script has one realm, so this is a fact about
  // testing in a vm and not about Knowledge.gs.
  const VmDate = vm.runInContext('Date', ctx);
  ctx.__sheet.rows[1][6] = new VmDate(Date.UTC(2026, 10, 1));
  ctx.__sheet.rows[2][6] = new VmDate(Date.UTC(2026, 10, 5));
  ctx.__sheet.rows[3][6] = new VmDate(Date.UTC(2026, 10, 3));

  const feed = ctx.readKnowledge();
  check('the feed comes back newest first, not in sheet order',
    feed.shares.map((s) => s.title).join(' ') === 'Second Third First',
    feed.shares.map((s) => s.title).join(' '));

  // A row somebody half-deleted by clearing the title.
  ctx.__sheet.rows.push(['K9', '', 'orphan', '', '', '', new Date(), new Date(), '[]']);
  check('a row with no title is skipped rather than drawn blank',
    ctx.readKnowledge().count === 3, String(ctx.readKnowledge().count));

  // A Files cell somebody broke by editing it.
  ctx.__sheet.rows[1][8] = '{not json at all';
  const after = ctx.readKnowledge();
  check('a broken attachment index costs the attachments, not the whole feed',
    after.count === 3 &&
    after.shares.filter((s) => s.title === 'First')[0].files.length === 0,
    after.count + ' shares still readable');
}

// ===========================================================================
// 3. attachments, in one piece and in several
// ===========================================================================
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const bytesOf = (n, seed) => {
  const a = [];
  for (let i = 0; i < n; i++) a.push((i * 7 + (seed || 0)) & 0xff);
  return a;
};

{
  const ctx = load(base);
  const share = ctx.createKnowledge('t', { title: 'With a file', body: '' });

  const one = bytesOf(50, 3);
  const made = ctx.addKnowledgeChunk('t', share.id, {
    uploadId: 'U1', name: 'note.pdf', mime: 'application/pdf',
    size: one.length, index: 0, total: 1, data: b64(one)
  });

  check('a single-chunk attachment comes back described',
    made && made.name === 'note.pdf' && made.kind === 'pdf' && made.size === 50,
    made ? made.name + ' / ' + made.kind + ' / ' + made.size : '(nothing)');

  check('and is in the share when it is read back',
    ctx.readKnowledge().shares[0].files.length === 1,
    String(ctx.readKnowledge().shares[0].files.length));

  check('with addresses the page can actually use',
    /\/preview$/.test(made.preview) && /\/view$/.test(made.open) &&
    /export=download/.test(made.download), made.preview);

  const stored = ctx.__drive.__files[made.id];
  check('the bytes in Drive are the bytes that were sent',
    stored && stored.bytes.join(',') === one.join(','),
    stored ? stored.bytes.length + ' bytes' : '(no file)');
}

// THE ONE THAT MATTERS. Five pieces, reassembled, byte for byte - against a
// Drive whose iterator deliberately hands the parts back in reverse.
{
  const ctx = load(base);
  const share = ctx.createKnowledge('t', { title: 'Big one', body: '' });

  const whole = bytesOf(500, 11);
  const size = 100;
  const total = 5;
  let made = null;
  for (let i = 0; i < total; i++) {
    made = ctx.addKnowledgeChunk('t', share.id, {
      uploadId: 'U2', name: 'deck.pptx',
      mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      size: whole.length, index: i, total: total,
      data: b64(whole.slice(i * size, (i + 1) * size))
    });
    if (i < total - 1) {
      check('chunk ' + i + ' parks and returns nothing', made === null,
        made === null ? 'parked' : 'returned something');
    }
  }

  check('the finished file is the five pieces joined, in order',
    made && ctx.__drive.__files[made.id].bytes.join(',') === whole.join(','),
    made ? 'got ' + ctx.__drive.__files[made.id].bytes.length + ' of ' +
           whole.length + ' bytes' : '(nothing)');

  check('and it is typed as a presentation',
    made.kind === 'slide', made.kind);

  // Every __part_ file has to be gone, or the folder silently fills up with
  // the pieces of every upload ever made.
  const left = Object.keys(ctx.__drive.__files).filter(function (id) {
    return !ctx.__drive.__files[id].trashed &&
           /^__part_/.test(ctx.__drive.__files[id].name);
  });
  check('the temporary pieces are cleaned up afterwards',
    left.length === 0, left.length + ' left behind');
}

// A piece that never arrives must fail, not write a short file.
{
  const ctx = load(base);
  const share = ctx.createKnowledge('t', { title: 'Lossy', body: '' });
  const part = (i, total) => ({
    uploadId: 'U3', name: 'x.bin', mime: '', size: 300,
    index: i, total: total, data: b64(bytesOf(100, i))
  });

  ctx.addKnowledgeChunk('t', share.id, part(0, 3));
  // chunk 1 is dropped, as a flaky connection would drop it
  let threw = '';
  try { ctx.addKnowledgeChunk('t', share.id, part(2, 3)); }
  catch (e) { threw = e.message; }

  check('an upload that lost a piece fails loudly rather than writing a short file',
    /lost 1 of its 3 pieces/.test(threw), threw);

  check('and the share gets no attachment out of it',
    ctx.readKnowledge().shares[0].files.length === 0,
    String(ctx.readKnowledge().shares[0].files.length));

  const live = Object.keys(ctx.__drive.__files)
    .filter((id) => !ctx.__drive.__files[id].trashed);
  check('the pieces that did arrive are binned, not left in the folder',
    live.length === 0, live.length + ' file(s) left');
}

// ===========================================================================
// 4. the limits
// ===========================================================================
{
  const ctx = load(base);
  const share = ctx.createKnowledge('t', { title: 'Limits', body: '' });

  let threw = '';
  try {
    ctx.addKnowledgeChunk('t', share.id, {
      uploadId: 'U4', name: 'huge.zip', mime: '',
      size: 40 * 1024 * 1024, index: 0, total: 1, data: b64([1, 2, 3])
    });
  } catch (e) { threw = e.message; }
  check('a file over the limit is refused by the server, not only the browser',
    /larger than the/.test(threw), threw);

  const cap = vm.runInContext('KNOWLEDGE_MAX_FILES', ctx);
  for (let i = 0; i < cap; i++) {
    ctx.addKnowledgeChunk('t', share.id, {
      uploadId: 'U5' + i, name: 'f' + i + '.png', mime: 'image/png',
      size: 4, index: 0, total: 1, data: b64([1, 2, 3, 4])
    });
  }
  threw = '';
  try {
    ctx.addKnowledgeChunk('t', share.id, {
      uploadId: 'U6', name: 'one.too.many.png', mime: 'image/png',
      size: 4, index: 0, total: 1, data: b64([1, 2, 3, 4])
    });
  } catch (e) { threw = e.message; }
  check('the attachment cap is enforced', /is the limit/.test(threw), threw);

  check('and the refused file does not stay in Drive',
    Object.keys(ctx.__drive.__files)
      .filter((id) => !ctx.__drive.__files[id].trashed).length === cap,
    Object.keys(ctx.__drive.__files)
      .filter((id) => !ctx.__drive.__files[id].trashed).length + ' of ' + cap);
}

// ===========================================================================
// 5. whose share it is
// ===========================================================================
{
  const mine = load(base);
  const share = mine.createKnowledge('t', { title: 'Bilal wrote this', body: 'x' });
  mine.addKnowledgeChunk('t', share.id, {
    uploadId: 'U7', name: 'a.png', mime: 'image/png',
    size: 3, index: 0, total: 1, data: b64([9, 9, 9])
  });

  // Somebody else, signed in as a plain user.
  const rows = mine.__sheet.rows;
  const other = load(Object.assign({}, base,
    { session: { u: '20000099', r: 'USER' } }));
  other.__sheet.rows.length = 0;
  rows.forEach((r) => other.__sheet.rows.push(r.slice()));

  let threw = '';
  try { other.deleteKnowledge('t', share.id); } catch (e) { threw = e.message; }
  check('a colleague cannot remove somebody else\'s share',
    /Only the person who shared this/.test(threw), threw);

  threw = '';
  try {
    other.addKnowledgeChunk('t', share.id, {
      uploadId: 'U8', name: 'b.png', mime: 'image/png',
      size: 3, index: 0, total: 1, data: b64([1])
    });
  } catch (e) { threw = e.message; }
  check('nor attach anything to it',
    /belongs to somebody else/.test(threw), threw);

  check('and the share is untouched',
    other.readKnowledge().count === 1, String(other.readKnowledge().count));

  // NOR CAN AN ADMIN, which is the unusual part and the point of it.
  //
  // Everywhere else in this project an admin can do what a viewer cannot,
  // because everywhere else the data belongs to the department. A share
  // belongs to the person who wrote it, and a note somebody senior can
  // quietly take down is a note people stop writing - which is the whole
  // asset here.
  const admin = load(Object.assign({}, base,
    { session: { u: '20000099', r: 'ADMIN' } }));
  admin.__sheet.rows.length = 0;
  rows.forEach((r) => admin.__sheet.rows.push(r.slice()));
  let adminThrew = '';
  try { admin.deleteKnowledge('t', share.id); } catch (e) { adminThrew = e.message; }
  check('an admin cannot remove it either, which is deliberate',
    /Only the person who shared this/.test(adminThrew) &&
    admin.readKnowledge().count === 1,
    adminThrew || 'IT WAS REMOVED');

  const master = load(Object.assign({}, base,
    { session: { u: '20000099', r: 'MASTER' } }));
  master.__sheet.rows.length = 0;
  rows.forEach((r) => master.__sheet.rows.push(r.slice()));
  let masterThrew = '';
  try { master.deleteKnowledge('t', share.id); } catch (e) { masterThrew = e.message; }
  check('and neither can a MASTER - the rank is not consulted at all',
    /Only the person who shared this/.test(masterThrew) &&
    master.readKnowledge().count === 1,
    masterThrew || 'IT WAS REMOVED');

  // The same rule on attaching, or somebody could add to a note that goes
  // out under another person's name.
  let attachThrew = '';
  try {
    admin.addKnowledgeChunk('t', share.id, {
      uploadId: 'UA', name: 'c.png', mime: 'image/png',
      size: 3, index: 0, total: 1, data: b64([7])
    });
  } catch (e) { attachThrew = e.message; }
  check('an admin cannot attach to somebody else\'s share either',
    /belongs to somebody else/.test(attachThrew), attachThrew);

  // The author can, and the attachments go with it.
  const author = load(base);
  author.__sheet.rows.length = 0;
  rows.forEach((r) => author.__sheet.rows.push(r.slice()));
  Object.keys(mine.__drive.__files).forEach(function (id) {
    author.__drive.__files[id] = JSON.parse(JSON.stringify(mine.__drive.__files[id]));
  });
  author.deleteKnowledge('t', share.id);

  check('the author can remove their own',
    author.readKnowledge().count === 0, String(author.readKnowledge().count));

  check('and its attachments go to the bin with it',
    Object.keys(author.__drive.__files)
      .every((id) => author.__drive.__files[id].trashed),
    Object.keys(author.__drive.__files)
      .filter((id) => !author.__drive.__files[id].trashed).length + ' left live');
}

// ===========================================================================
// 6. what the page is told
// ===========================================================================
{
  const ctx = load(base);
  ctx.createKnowledge('t', { title: 'One', body: 'x' });
  const served = ctx.getKnowledge('t');

  check('the page is told who is looking, so it knows whose Remove to draw',
    served.me === '20000003', 'me=' + served.me);

  // NO ADMIN FLAG GOES DOWN AT ALL. It used to, and the page drew Remove
  // on anything when it was set. Sending a permission the server no
  // longer honours is how a page comes to offer a button that fails.
  check('and is told nothing about rank, because rank decides nothing here',
    !('admin' in served),
    'admin' in served ? 'still sent: ' + served.admin : 'not sent');

  check('the upload limits come from the server, not from a number in the page',
    served.chunk > 0 && served.maxFile > served.chunk && served.maxFiles > 0,
    'chunk ' + served.chunk + ', max ' + served.maxFile +
      ', files ' + served.maxFiles);
}

// ===========================================================================
// 7. the folder is not set, or is wrong
// ===========================================================================
{
  const bare = load({ props: {} });
  const share = bare.createKnowledge('t', { title: 'No folder', body: 'x' });
  let threw = '';
  try {
    bare.addKnowledgeChunk('t', share.id, {
      uploadId: 'U9', name: 'a.png', mime: '', size: 1,
      index: 0, total: 1, data: b64([1])
    });
  } catch (e) { threw = e.message; }
  check('with no attachments folder set, the message names the property',
    /KNOWLEDGE_FOLDER/.test(threw), threw);

  check('but the words were still saved - the share is not lost with the file',
    bare.readKnowledge().count === 1, String(bare.readKnowledge().count));

  bare.checkKnowledgeFolder();
  check('and the diagnostic says how to set it',
    /Script Properties/.test(bare.__logs.join('\n')),
    bare.__logs.join(' | ').slice(0, 60));
}

// ===========================================================================
// 8. the editor tools
// ===========================================================================
{
  const ctx = load(base);
  const share = ctx.createKnowledge('t', { title: 'Leftovers', body: '' });
  // An upload that died partway leaves its parts behind.
  ctx.addKnowledgeChunk('t', share.id, {
    uploadId: 'UX', name: 'x.bin', mime: '', size: 300,
    index: 0, total: 3, data: b64(bytesOf(100, 1))
  });

  ctx.checkKnowledgeFolder();
  check('checkKnowledgeFolder notices abandoned upload pieces',
    /ABANDONED UPLOAD PIECE/.test(ctx.__logs.join('\n')),
    (ctx.__logs.join('\n').match(/\d+ ABANDONED[^\n]*/) || ['(none)'])[0]);

  ctx.cleanKnowledgeParts();
  const live = Object.keys(ctx.__drive.__files)
    .filter((id) => !ctx.__drive.__files[id].trashed);
  check('and cleanKnowledgeParts bins them',
    live.length === 0, live.length + ' left');

  const share2 = load(base);
  share2.shareKnowledgeFolder();
  const log = share2.__logs.join('\n');
  check('shareKnowledgeFolder says plainly who can then see an attachment',
    /anyone with the link/i.test(log) && /without signing in/.test(log),
    log.split('\n').filter((l) => /sign/.test(l))[0] || '(not said)');
}

// NO WIDTH SPECIFIERS. Apps Script's Logger substitutes a bare %s and
// nothing else; a %-10s prints literally AND shifts every argument after it.
check('no Logger format string in Knowledge.gs uses a width specifier',
  !/%-?\d+s/.test(fs.readFileSync(path.join(SRC, 'Knowledge.gs'), 'utf8')),
  (fs.readFileSync(path.join(SRC, 'Knowledge.gs'), 'utf8')
    .match(/%-?\d+s/g) || []).join(' '));

// ---------------------------------------------------------------------------
const passed = out.filter(Boolean).length;
console.log('\n' + passed + '/' + out.length + ' passed');
process.exit(passed === out.length ? 0 : 1);
