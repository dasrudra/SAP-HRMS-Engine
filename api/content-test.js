/**
 * content-test.js - the FAQ, the meeting links, Knowledge Share, Learnings.
 * ===========================================================================
 *
 * NEEDS A RUNNING SERVER AND DATABASE.
 *
 *     terminal 3:   npm start
 *     terminal 2:   node content-test.js
 *
 * No password needed - it signs its own tokens, like messenger-write-test.js,
 * so it can check the USER / ADMIN / MASTER gates without anybody holding
 * three passwords.
 *
 * IT CREATES ITS OWN PEOPLE AND CLEANS UP. Employee IDs are in the reserved
 * 2099xxxx block and change every run; every row it writes is matched by
 * something only this test produces, and it sweeps at the start as well as
 * the end so a run that dies halfway does not poison the next one.
 *
 * THE BY-WEEKLY ADDRESSES ARE PUT BACK. That table is the only one here
 * with rows a person has to fill in by hand, and a test that left them
 * blank would quietly delete four links somebody pasted in. Whatever is in
 * it is read first and written back at the end.
 */

require('dotenv').config();

const http = require('http');
const { Client } = require('pg');
const auth = require('./auth');
const content = require('./content');

const PORT = Number(process.env.PORT || 3000);

const RUN = String(Math.floor(Math.random() * 90) + 10);
const id = function (n) { return '2099' + RUN + String(n).padStart(2, '0'); };

const MASTER = id(1);
const ADMIN  = id(2);
const USER   = id(3);
const OTHER  = id(4);

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '   ' + detail : '')); }
}

function call(method, path, token, body) {
  return new Promise(function (resolve, reject) {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    if (token) headers.Authorization = 'Bearer ' + token;
    const req = http.request(
      { host: 'localhost', port: PORT, path: path, method: method, headers: headers },
      function (res) {
        let buf = '';
        res.on('data', function (c) { buf += c; });
        res.on('end', function () {
          let parsed = {};
          try { parsed = JSON.parse(buf || '{}'); } catch (e) { parsed = { raw: buf }; }
          resolve({ code: res.statusCode, body: parsed });
        });
      });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}


async function main() {
  const db = new Client({
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER, password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE || 'tvl_eas'
  });
  await db.connect();

  // Whatever is really in by_weekly, so it can go back exactly as it was.
  const realLinks = (await db.query('SELECT section, link FROM by_weekly')).rows;

  async function wipe() {
    await db.query("DELETE FROM knowledge WHERE share_id LIKE 'K%' AND author LIKE 'Content Test %'");
    await db.query("DELETE FROM learn WHERE file_id LIKE 'TEST-L%'");
    await db.query("DELETE FROM faq WHERE question LIKE '[test]%'");
    await db.query("DELETE FROM team WHERE full_name LIKE 'Content Test %'");
  }
  await wipe();

  const noLogin = 'scrypt$65536$8$1$00$00';
  for (const [who, role] of [[MASTER, 'MASTER'], [ADMIN, 'ADMIN'],
                             [USER, 'USER'], [OTHER, 'USER']]) {
    await db.query('INSERT INTO team (employee_id, full_name) VALUES ($1,$2)',
                   [who, 'Content Test ' + who.slice(-2)]);
    await db.query(
      `INSERT INTO account (employee_id, password_hash, role, must_change)
       VALUES ($1,$2,$3,false)`, [who, noLogin, role]);
  }

  const tMaster = auth.signToken(MASTER, 'MASTER');
  const tAdmin  = auth.signToken(ADMIN,  'ADMIN');
  const tUser   = auth.signToken(USER,   'USER');
  const tOther  = auth.signToken(OTHER,  'USER');

  let r;
  console.log('');

  // =======================================================================
  console.log('  GET /api/faq');
  // =======================================================================
  await db.query("DELETE FROM faq");

  r = await call('GET', '/api/faq', null);
  check('the FAQ needs no sign-in - it is on the sign-in page',
        r.code === 200 && r.body.ok === true, 'got ' + r.code);
  check('an empty table shows the built-in questions',
        r.body.count === content.FAQ_SEED.length,
        'got ' + r.body.count + ' of ' + content.FAQ_SEED.length);
  check('and they are the ones from Config.gs',
        r.body.faq[0].question === content.FAQ_SEED[0][0],
        r.body.faq[0].question);

  await db.query(
    `INSERT INTO faq (ord, question, answer) VALUES
       (2,'[test] second question','Second answer.'),
       (1,'[test] first question','First answer.')`);
  r = await call('GET', '/api/faq', null);
  check('ONE ROW REPLACES THE SEED ENTIRELY, it does not merge',
        r.body.count === 2,
        'got ' + r.body.count + ' - a seeded question could never be deleted');
  check('and they come back in Order order, not insertion order',
        r.body.faq[0].question === '[test] first question',
        r.body.faq[0].question);

  await db.query(
    `INSERT INTO faq (ord, question, answer) VALUES
       (1,'[test] same order, written later','Third answer.')`);
  r = await call('GET', '/api/faq', null);
  check('two questions may share an order number',
        r.body.count === 3, 'got ' + r.body.count);
  check('and equal ones stay in the order they were written',
        r.body.faq[0].question === '[test] first question' &&
        r.body.faq[1].question === '[test] same order, written later',
        r.body.faq.map(function (f) { return f.order; }).join(','));

  let refused = false;
  try {
    await db.query("INSERT INTO faq (ord, question, answer) VALUES (9,'  ','x')");
  } catch (e) { refused = true; }
  check('a blank question is refused at the table, not silently skipped',
        refused, 'a typo would quietly remove an entry from the page');

  // The FAQ is also what the message panel draws on the sign-in page.
  r = await call('GET', '/api/messages/boot', tUser);
  check('the message panel gets the same FAQ',
        (r.body.faq || []).length === 3,
        'got ' + (r.body.faq || []).length + ' - boot used to send an empty list');

  await db.query("DELETE FROM faq WHERE question LIKE '[test]%'");

  // =======================================================================
  console.log('');
  console.log('  GET /api/byweekly');
  // =======================================================================
  r = await call('GET', '/api/byweekly', tUser);
  check('all four sections come back', (r.body.links || []).length === 4,
        'got ' + (r.body.links || []).length);
  check('in the order the page lists them',
        r.body.links.map(function (l) { return l.key; }).join(',') ===
        'SCA,SDMM,PP,FICO',
        r.body.links.map(function (l) { return l.key; }).join(','));
  check('each with its name and accent',
        r.body.links[0].name === 'Supply Chain' &&
        /^#[0-9a-f]{6}$/i.test(r.body.links[0].accent),
        JSON.stringify(r.body.links[0]));

  await db.query("UPDATE by_weekly SET link = '' WHERE section = 'Financial'");
  r = await call('GET', '/api/byweekly', tUser);
  const fin = r.body.links.filter(function (l) { return l.key === 'FICO'; })[0];
  check('A SECTION WITH NO ADDRESS STILL COMES BACK',
        Boolean(fin) && fin.url === '',
        'a button that disappeared would just look like the page was wrong');

  r = await call('GET', '/api/byweekly', null);
  check('but you have to be signed in to see the addresses',
        r.code === 401, 'got ' + r.code);

  // =======================================================================
  console.log('');
  console.log('  POST /api/byweekly');
  // =======================================================================
  r = await call('POST', '/api/byweekly', tMaster,
    { section: 'Financial', url: 'https://example.com/deck.pptx' });
  check('a master can set an address', r.body.ok === true, r.body.message);
  r = await call('GET', '/api/byweekly', tUser);
  check('and it comes back on the right section',
        r.body.links.filter(function (l) { return l.key === 'FICO'; })[0].url ===
        'https://example.com/deck.pptx');

  /*
    A CELL ON A SHARED TABLE REACHES AN ANCHOR'S href. `javascript:` in an
    href runs when somebody clicks it, so the address has to be one the
    page could actually follow - and it is refused at the point of saving,
    not just hidden at the point of drawing, so it cannot sit in the table
    looking saved.
  */
  r = await call('POST', '/api/byweekly', tMaster,
    { section: 'Financial', url: 'javascript:alert(1)' });
  check('A javascript: ADDRESS IS REFUSED', r.body.ok === false, r.body.message);
  r = await call('GET', '/api/byweekly', tUser);
  check('and the real one is untouched',
        r.body.links.filter(function (l) { return l.key === 'FICO'; })[0].url ===
        'https://example.com/deck.pptx');

  check('byWeeklySafe allows http and https only',
        content.byWeeklySafe('http://a.test') === 'http://a.test' &&
        content.byWeeklySafe('HTTPS://a.test') === 'HTTPS://a.test' &&
        content.byWeeklySafe('javascript:alert(1)') === '' &&
        content.byWeeklySafe('data:text/html,x') === '' &&
        content.byWeeklySafe('  ftp://a.test  ') === '');

  r = await call('POST', '/api/byweekly', tMaster,
    { section: 'Financial', url: '   ' });
  check('an empty address is how a link is removed', r.body.ok === true);
  r = await call('GET', '/api/byweekly', tUser);
  check('and it really went',
        r.body.links.filter(function (l) { return l.key === 'FICO'; })[0].url === '');

  r = await call('POST', '/api/byweekly', tMaster,
    { section: 'Marketing', url: 'https://example.com/x' });
  check('a section that does not exist is refused', r.body.ok === false);

  r = await call('POST', '/api/byweekly', tAdmin,
    { section: 'Financial', url: 'https://example.com/x' });
  check('an ADMIN cannot change an address', r.code === 403, 'got ' + r.code);
  r = await call('POST', '/api/byweekly', tUser,
    { section: 'Financial', url: 'https://example.com/x' });
  check('and neither can a USER', r.code === 403, 'got ' + r.code);

  // =======================================================================
  console.log('');
  console.log('  GET /api/links');
  // =======================================================================
  r = await call('GET', '/api/links', tUser);
  check('the portal links come back', r.body.ok === true && r.body.count > 0,
        JSON.stringify(r.body).slice(0, 80));
  const links = r.body.links;
  check('in the order they are written, because nothing sorts them',
        links[0].name === 'SAP & HRMS UserHub' &&
        links[1].name === 'RMG PA Report',
        links.slice(0, 2).map(function (l) { return l.name; }).join(','));
  check('the front-page ones carry a row and a hero label',
        links[0].row === 1 && Boolean(links[0].hero));
  check('and the Links-page-only ones carry neither',
        links.filter(function (l) { return l.name === 'LinkedIn'; })[0].row ===
          undefined);

  /*
    THE ONE ENTRY THAT DOES NOT LEAVE THE PORTAL. The four addresses behind
    By-Weekly Meetings are personal OneDrive links, so the button opens the
    page of section buttons rather than a site.
  */
  const bw = links.filter(function (l) { return l.name === 'By-Weekly Meetings'; })[0];
  check('By-Weekly Meetings is a view, not a URL',
        Boolean(bw) && bw.view === 'byweekly' && bw.url === undefined,
        JSON.stringify(bw));
  check('no entry carries an address the page could not follow',
        links.every(function (l) {
          return l.view || content.byWeeklySafe(l.url) === l.url;
        }),
        JSON.stringify(links.filter(function (l) {
          return !l.view && content.byWeeklySafe(l.url) !== l.url; })));
  check('and none of them is somebody\'s personal OneDrive file',
        links.every(function (l) {
          return !/-my\.sharepoint\.com\/personal\//i.test(String(l.url || ''));
        }),
        'that form of address spells the owner\'s work email out in the path');

  r = await call('GET', '/api/links', null);
  check('the links need a sign-in', r.code === 401, 'got ' + r.code);

  /*
    The two guards in portalLinks are for an entry nobody has written yet,
    so with the real list they cannot be observed at all. Fed a list of
    their own they can.
  */
  const guarded = content.portalLinks([
    { name: 'Fine', url: 'https://ok.test' },
    { name: 'Half-finished' },
    { name: 'Nasty', url: 'javascript:alert(1)' },
    { name: 'Inside', view: 'byweekly' },
    null
  ]);
  check('an entry with no address and no view is dropped',
        guarded.every(function (l) { return l.name !== 'Half-finished'; }),
        'it would draw as a button that does nothing');
  check('and so is one whose address a browser must not follow',
        guarded.every(function (l) { return l.name !== 'Nasty'; }),
        JSON.stringify(guarded));
  check('while the good ones come through',
        guarded.map(function (l) { return l.name; }).join(',') === 'Fine,Inside',
        guarded.map(function (l) { return l.name; }).join(','));

  // =======================================================================
  console.log('');
  console.log('  Knowledge Share');
  // =======================================================================
  r = await call('POST', '/api/knowledge', tUser,
    { title: 'MIGO posts with the wrong plant',
      body: 'Set the plant on the header first, not on the line.',
      tags: ' mm , migo ,, plant ' });
  check('anybody signed in can post - no approval step',
        r.body.ok === true, JSON.stringify(r.body.message));
  const share = r.body.share;
  check('the whole share comes back, not just an id',
        Boolean(share && share.id && share.title && share.created),
        JSON.stringify(share));
  check('tags are split, trimmed and the empty ones dropped',
        JSON.stringify(share.tags) === '["mm","migo","plant"]',
        JSON.stringify(share.tags));
  check('it is signed with the author\'s name, not their number',
        share.author === 'Content Test ' + USER.slice(-2), share.author);
  check('and carries their id, which is the fact',
        share.authorId === USER);
  check('a new share does not read as edited', share.edited === false);
  check('the id is sortable and says when it was made',
        /^K\d{14}-[0-9A-F]{5}$/.test(share.id), share.id);

  r = await call('GET', '/api/knowledge', tUser);
  check('it is in the feed at once - not cached',
        (r.body.shares || []).some(function (s) { return s.id === share.id; }),
        'a colleague who cannot see their own post posts it twice');
  check('the page is told who is looking', r.body.me === USER, r.body.me);
  check('and the upload limits, so it can refuse a file before sending it',
        r.body.maxFile === content.KNOWLEDGE_MAX_FILE &&
        r.body.maxFiles === content.KNOWLEDGE_MAX_FILES &&
        r.body.chunk === content.KNOWLEDGE_CHUNK);

  // Newest first - the useful end of a feed is the recent end.
  await call('POST', '/api/knowledge', tOther,
    { title: 'Posted second', body: 'Should sort above the first one.' });
  r = await call('GET', '/api/knowledge', tUser);
  const mine = (r.body.shares || []).filter(function (s) {
    return /Content Test /.test(s.author);
  });
  check('NEWEST FIRST, because a feed\'s useful end is the recent end',
        mine[0].title === 'Posted second', mine[0].title);

  /*
    400 AND A SENTENCE, NOT 500. The table carries the same limits as
    CHECK constraints, so dropping the check in the code still stops the
    row going in - but as a database error the person reads as "something
    went wrong". Asserting only ok === false cannot tell those apart,
    because the 500 body says ok:false as well. That is how a deliberate
    break was reported as caught when it was not.
  */
  r = await call('POST', '/api/knowledge', tUser, { title: '   ', body: 'x' });
  check('a share needs a title',
        r.code === 400 && /needs a title/.test(String(r.body.message)),
        r.code + ' ' + JSON.stringify(r.body.message));
  r = await call('POST', '/api/knowledge', tUser,
    { title: 'x'.repeat(content.KNOWLEDGE_TITLE_MAX + 1), body: 'x' });
  check('a title over 200 characters is refused with a sentence, not a 500',
        r.code === 400 && /title is too long/.test(String(r.body.message)),
        r.code + ' ' + JSON.stringify(r.body.message));
  r = await call('POST', '/api/knowledge', tUser,
    { title: 'Long one', body: 'y'.repeat(content.KNOWLEDGE_BODY_MAX + 1) });
  check('and a body over 20,000, the same way',
        r.code === 400, r.code + ' ' + JSON.stringify(r.body.message));
  check('the refusal says what to do instead',
        /belongs in a document/.test(String(r.body.message)), r.body.message);

  /*
    THE AUTHOR COMES FROM THE TOKEN AND FROM NOWHERE ELSE. Everything in
    the body was typed by the caller, so an employee_id in there is a
    suggestion, not a fact - and a share is signed with a name and an id
    that decide whose Remove button appears on it.
  */
  r = await call('POST', '/api/knowledge', tUser,
    { title: 'Posted as somebody else', body: 'Checking who this is filed under.',
      employee_id: OTHER, authorId: OTHER, author: 'Somebody Else' });
  check('an employee_id in the body is ignored', r.body.ok === true);
  check('AND THE SHARE IS FILED UNDER WHOEVER SIGNED IN',
        r.body.share.authorId === USER,
        'got ' + r.body.share.authorId + ' - anyone could post as a colleague');
  check('and signed with their name, not one sent in the body',
        r.body.share.author === 'Content Test ' + USER.slice(-2),
        r.body.share.author);

  r = await call('POST', '/api/knowledge', tUser,
    { title: 'Nine tags', body: 'Only eight are kept.',
      tags: 'a,b,c,d,e,f,g,h,i' });
  check('at most eight tags are kept',
        r.body.share.tags.length === content.KNOWLEDGE_TAGS_MAX,
        String(r.body.share.tags.length));

  r = await call('GET', '/api/knowledge', null);
  check('the feed needs a sign-in', r.code === 401, 'got ' + r.code);

  // =======================================================================
  console.log('');
  console.log('  Removing a share');
  // =======================================================================
  /*
    THE AUTHOR'S AND NOBODY ELSE'S, not even a master's. This is a page
    people post half-finished thoughts to, and a note somebody else can
    delete is a note people think twice about writing.
  */
  r = await call('POST', '/api/knowledge/delete', tOther, { id: share.id });
  check('A COLLEAGUE CANNOT REMOVE SOMEBODY ELSE\'S SHARE',
        r.body.ok === false, r.body.message);
  r = await call('POST', '/api/knowledge/delete', tAdmin, { id: share.id });
  check('nor can an ADMIN', r.body.ok === false, r.body.message);
  r = await call('POST', '/api/knowledge/delete', tMaster, { id: share.id });
  check('NOR CAN A MASTER - this is not about rank',
        r.body.ok === false,
        'a note a master can delete is a note people think twice about writing');

  check('and it is still there',
        (await db.query('SELECT 1 FROM knowledge WHERE share_id = $1',
                        [share.id])).rows.length === 1);

  r = await call('POST', '/api/knowledge/delete', tUser, { id: share.id });
  check('the author can', r.body.ok === true, r.body.message);
  check('and it is gone',
        (await db.query('SELECT 1 FROM knowledge WHERE share_id = $1',
                        [share.id])).rows.length === 0);

  r = await call('POST', '/api/knowledge/delete', tUser, { id: share.id });
  check('removing it twice says it is gone, not that it is not yours',
        r.body.ok === false && /no longer exists/.test(String(r.body.message)),
        r.body.message);

  // =======================================================================
  console.log('');
  console.log('  Learnings');
  // =======================================================================
  r = await call('GET', '/api/learn', tUser);
  check('an empty library answers filled:false',
        r.body.filled === false && r.body.count === 0,
        'the page draws "nothing here yet" rather than a broken library');
  check('but the chips are still there to draw',
        (r.body.types || []).length > 0 && (r.body.modules || []).length === 5);

  /*
    'userguideline', 'guideline' and 'manual' all resolve to User Guideline.
    Handing the raw list to the page would draw three identical chips.
  */
  const names = (r.body.types || []).map(function (t) { return t.name; });
  check('THE DUPLICATE TYPE NAMES ARE COLLAPSED',
        names.filter(function (n) { return n === 'User Guideline'; }).length === 1,
        names.join(','));
  check('and the catch-all is last, because it is the absence of a type',
        names[names.length - 1] === content.LEARN_FALLBACK_TYPE, names.join(','));
  check('Common does not split into businesses, the other four do',
        (r.body.modules || []).filter(function (m) { return !m.split; })
          .map(function (m) { return m.name; }).join(',') === 'Common',
        JSON.stringify((r.body.modules || []).map(function (m) {
          return m.name + ':' + m.split; })));

  const old = new Date(Date.now() - 200 * 24 * 3600 * 1000).toISOString();
  const recent = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
  await db.query(
    `INSERT INTO learn (file_id,title,type,module,business,kind,size,updated,path)
     VALUES ('TEST-L1','Goods receipt SOP','SOP','MM','RMG','pdf','1.2 MB',$1,'MM/RMG'),
            ('TEST-L2','Old policy','Policy','FI-CO','MG','doc','300 KB',$2,'FI-CO/MG'),
            ('TEST-L3','No type given','','Common','','file','',NULL,'Common')`,
    [recent, old]);

  r = await call('GET', '/api/learn', tUser);
  check('the library fills up', r.body.filled === true && r.body.count === 3,
        String(r.body.count));
  const byId = {};
  (r.body.docs || []).forEach(function (d) { byId[d.id] = d; });
  check('a document with no type gets the fallback, not a blank chip',
        byId['TEST-L3'].type === content.LEARN_FALLBACK_TYPE,
        byId['TEST-L3'].type);
  check('and no kind gets "file"', byId['TEST-L3'].kind === 'file');
  check('dates are printed for people',
        /^\d{1,2} \w{3} \d{4}$/.test(byId['TEST-L1'].updated),
        byId['TEST-L1'].updated);
  check('and a sortable stamp goes with them, because dates sort wrong as text',
        byId['TEST-L1'].stamp > byId['TEST-L2'].stamp);
  check('a document with no date does not pretend to have one',
        byId['TEST-L3'].updated === '' && byId['TEST-L3'].stamp === 0);

  /*
    Ninety days, not a calendar quarter: the tile says "this quarter" and
    means "recently". A calendar quarter makes the number collapse to zero
    every January and read as a library nobody has touched.
  */
  check('THE QUARTER COUNT IS 90 DAYS, NOT A CALENDAR QUARTER',
        r.body.quarter === 1,
        'got ' + r.body.quarter + ' - one of the three is 10 days old, ' +
        'one is 200, one has no date');

  r = await call('GET', '/api/learn', null);
  check('the library needs a sign-in', r.code === 401, 'got ' + r.code);

  // =======================================================================
  console.log('');
  console.log('  Functions');
  // =======================================================================
  check('a PDF is a pdf by type or by extension',
        content.learnKind('application/pdf', 'x') === 'pdf' &&
        content.learnKind('', 'notes.PDF') === 'pdf');
  check('a slide deck is a slide, by extension or by Google type',
        content.learnKind('', 'deck.pptx') === 'slide' &&
        content.learnKind('application/vnd.google-apps.presentation', '') === 'slide');
  /*
    AND A .ppt KNOWN ONLY BY ITS MIME TYPE IS NOT, in the original either:
    the test is `type.indexOf('presentation') !== -1`, and the real MIME
    type for an old PowerPoint is application/vnd.ms-powerpoint, which does
    not contain that word. It is not a live bug - learnKind is never called
    without a filename, and '.ppt' is in the extension list right beside it
    - but a port that "fixed" it would stop matching Learn.gs, and this
    test would then be the only record that the two had diverged.
  */
  check('a .ppt known only by its MIME type is a plain file, as in Learn.gs',
        content.learnKind('application/vnd.ms-powerpoint', '') === 'file' &&
        content.learnKind('application/vnd.ms-powerpoint', 'old.ppt') === 'slide');
  check('a video is a video by either',
        content.learnKind('video/mp4', '') === 'video' &&
        content.learnKind('', 'clip.mkv') === 'video');
  check('anything unrecognised is a plain file',
        content.learnKind('application/zip', 'a.zip') === 'file');
  check('a Google Doc counts as a document',
        content.learnKind('application/vnd.google-apps.document', '') === 'doc');

  check('bytes below a kilobyte are printed as bytes',
        content.learnSize(900) === '900 B');
  check('one decimal under 100', content.learnSize(1536) === '1.5 KB');
  check('and none above', content.learnSize(1024 * 1024 * 150) === '150 MB');
  /*
    150 MB exactly cannot tell the two rules apart - it prints as '150'
    either way - so the boundary needs a value with something after the
    point. 150.5 MB is '151 MB' rounded and '150.5 MB' not, and only one
    of those is the precision the comment asks for.
  */
  check('and really none above - 150.5 MB is 151 MB, not 150.5 MB',
        content.learnSize(Math.round(150.5 * 1024 * 1024)) === '151 MB',
        content.learnSize(Math.round(150.5 * 1024 * 1024)));
  check('while 99.5 KB keeps its decimal',
        content.learnSize(Math.round(99.5 * 1024)) === '99.5 KB',
        content.learnSize(Math.round(99.5 * 1024)));
  check('nothing at all for zero', content.learnSize(0) === '');
  check('1024 KB is shown as 1 MB, not 1024.0 KB',
        content.learnSize(1024 * 1024) === '1 MB', content.learnSize(1024 * 1024));

  check('a broken attachment index reads as no attachments',
        content.knowledgeFiles('not json at all').length === 0);
  check('and so does one that is not a list',
        content.knowledgeFiles('{"id":"x"}').length === 0);
  check('entries with no id are dropped',
        content.knowledgeFiles('[{"name":"x"},{"id":"a","name":"b"}]').length === 1);
  check('a stored attachment gets its kind and printed size',
        content.knowledgeFiles(
          '[{"id":"a","name":"n.pdf","mime":"application/pdf","size":2048}]'
        )[0].sizeText === '2 KB');

  check('shortDate reads the dashboard clock, not UTC',
        content.shortDate(new Date('2026-11-20T20:30:00Z')) === '21 Nov 2026',
        content.shortDate(new Date('2026-11-20T20:30:00Z')) + ' - Dhaka is UTC+6');
  check('and an empty date is empty, not "Invalid Date"',
        content.shortDate(null) === '' && content.shortDate('rubbish') === '');

  // =======================================================================
  await wipe();
  // Put the real addresses back exactly as they were.
  for (const row of realLinks) {
    await db.query(
      `INSERT INTO by_weekly (section, link) VALUES ($1,$2)
       ON CONFLICT (section) DO UPDATE SET link = EXCLUDED.link`,
      [row.section, row.link]);
  }
  await db.end();

  console.log('');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main().catch(function (err) {
  console.error('\n  Failed: ' + err.message + '\n' + err.stack + '\n');
  process.exit(1);
});
