// Which screen somebody was last on, and why it is not read from the URL.
//
// WHY THIS SUITE EXISTS
// Reloading the Objectives page showed the HOME page for twelve seconds and
// then jumped. The view was restored from google.script.url.getLocation -
// the only thing that can read the address bar from inside the Apps Script
// sandbox - and inside the Blogger embed that call was measured, off a
// screen recording, at twelve seconds. The page cannot wait that long to
// decide what to draw, so it drew Home and corrected itself later.
//
// So the screen is remembered on the server and comes down with the
// bootstrap, which the page is already waiting for. These are the three
// functions that do it, driven the way the page drives them.
//
//   node tests/view-memory-test.js
const fs = require('fs'), vm = require('vm'), path = require('path');
const SRC = process.env.EAS_SRC || path.join(__dirname, '..', 'src');

const out = [];
const check = (n, ok, d) => {
  out.push(ok);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (d ? '   [' + d + ']' : ''));
};

// ---------------------------------------------------------------------------
// a cache that caches, and a session that can be switched off
// ---------------------------------------------------------------------------
function load(opts) {
  const o = opts || {};
  const store = {};
  const puts = [];

  const sb = {
    console, Object, String, Number, Array, Math, JSON, RegExp, Date,
    isFinite, Boolean, Error, parseInt, parseFloat,
    CacheService: {
      getScriptCache: function () {
        return {
          get: function (k) {
            if (o.cacheThrows) throw new Error('cache unavailable');
            return Object.prototype.hasOwnProperty.call(store, k)
              ? store[k] : null;
          },
          put: function (k, v, sec) {
            if (o.cacheThrows) throw new Error('cache unavailable');
            puts.push({ key: k, value: v, seconds: sec });
            store[k] = v;
          }
        };
      }
    }
  };
  sb.globalThis = sb;
  vm.createContext(sb);

  // The real session guard's shape: a token is a session, nothing is not.
  vm.runInContext(
    'function currentSession(token) { return token ? { u: ' +
    JSON.stringify(o.user || '20000012') + ', r: "USER" } : null; }', sb);

  // Only the three functions under test, lifted from Code.gs rather than
  // copied here - a copy would pass while the real one was broken.
  const code = fs.readFileSync(path.join(SRC, 'Code.gs'), 'utf8');
  ['const VIEW_MEMORY_SECONDS = [\\s\\S]*?;',
   'function viewMemoryKey[\\s\\S]*?\\n}',
   'function lastViewOf[\\s\\S]*?\\n}',
   'function rememberView[\\s\\S]*?\\n}'].forEach(function (pattern) {
    const hit = new RegExp(pattern).exec(code);
    if (!hit) throw new Error('not found in Code.gs: ' + pattern);
    vm.runInContext(hit[0], sb);
  });

  sb.__store = store;
  sb.__puts = puts;
  return sb;
}

// ===========================================================================
// 1. it remembers, and it hands back what it remembered
// ===========================================================================
{
  const ctx = load();
  check('nothing is remembered for somebody who has not been anywhere',
    ctx.lastViewOf('20000012') === '');

  check('a view is accepted', ctx.rememberView('t', 'objective').ok === true);
  check('and read back for the same person',
    ctx.lastViewOf('20000012') === 'objective', ctx.lastViewOf('20000012'));
  check('and not for anybody else',
    ctx.lastViewOf('20990009') === '', ctx.lastViewOf('20990009'));

  ctx.rememberView('t', 'kpi1');
  check('the latest one wins', ctx.lastViewOf('20000012') === 'kpi1');

  /*
    IT HAS TO EXPIRE. This is a convenience, not a setting: somebody
    coming back the next morning wants the dashboard, not whatever screen
    they happened to close the laptop on.
  */
  check('and it is kept for hours rather than forever',
    ctx.__puts[0].seconds > 3600 && ctx.__puts[0].seconds <= 12 * 3600,
    ctx.__puts[0].seconds + ' seconds');
}

// ===========================================================================
// 2. what it refuses
// ===========================================================================
{
  const ctx = load();

  check('a request with no session is refused',
    ctx.rememberView('', 'objective').ok === false);
  check('and writes nothing', Object.keys(ctx.__store).length === 0,
    JSON.stringify(ctx.__store));

  /*
    A SHORT, KNOWN-SHAPED NAME. This goes nowhere near a query or a page,
    and a cache key is not a dangerous place to put a string - but a key
    built out of unchecked input is a habit worth not having, and the
    only thing that ever legitimately arrives here is a view id.
  */
  const bad = ['', '   ', 'a'.repeat(33), 'view name', '../../etc',
               'objective; drop', '<script>'];
  const refused = bad.filter(function (v) {
    return ctx.rememberView('t', v).ok === false;
  });
  check('and so is anything that is not a plain view name',
    refused.length === bad.length,
    bad.filter(function (v) { return ctx.rememberView('t', v).ok; })
      .join(' | ') || 'none got through');

  check('a name with a hyphen is fine, because view ids have them',
    ctx.rememberView('t', 'kpi-1').ok === true);
}

// ===========================================================================
// 3. the cache not being there is not a failure
// ===========================================================================
/*
  The bootstrap carries this, and the bootstrap is everything the page needs
  to draw at all. A cache that is briefly unavailable must cost somebody the
  convenience of landing where they were, and not the whole page.
*/
{
  const ctx = load({ cacheThrows: true });
  check('a cache that cannot be read reads as nothing remembered',
    ctx.lastViewOf('20000012') === '');
  check('and one that cannot be written says so rather than throwing',
    ctx.rememberView('t', 'objective').ok === false);
}

// ===========================================================================
console.log('');
const bad = out.filter((x) => !x).length;
console.log((out.length - bad) + '/' + out.length + ' passed' +
  (bad ? ', ' + bad + ' failed' : ''));
process.exit(bad ? 1 : 0);
