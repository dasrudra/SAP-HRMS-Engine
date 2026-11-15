/**
 * Links.gs - the addresses on the Links page that cannot live in this file.
 * =========================================================================
 *
 * WHAT THIS IS
 * Most of the Links page is in portalLinks() in Config.gs, written out in
 * the order it appears, and that is where a link belongs. This is for the
 * few that cannot be written down here.
 *
 * WHY ANY OF THEM CANNOT
 * THIS REPOSITORY IS PUBLIC. A SharePoint address for a file in somebody's
 * personal OneDrive carries two things that have no business on the open
 * internet: the owner's work email, spelled out in the path as
 * firstname_company_com_bd, and the sharing token that was issued with the
 * link. Writing one here publishes both, and publishes them in the git
 * history as well, so deleting it afterwards does not take it back.
 *
 * It is the same reason the four section decks are on the BY_WEEKLY tab
 * rather than in ByWeekly.gs, and this is the general form of it.
 *
 * WHAT IT IS NOT FOR
 * Not for secrets. A sheet anybody in the team can open is not a safe place
 * for a password or an API key, and nothing here pretends otherwise. It is
 * for addresses that are fine for colleagues to see and wrong to publish.
 *
 * THE SECOND REASON TO KEEP THEM HERE
 * SharePoint reissues share links. When somebody re-shares the deck the old
 * address stops working, and the fix is then one cell on a tab rather than
 * a code change and a deployment.
 */


/** The tab, and the one column anybody edits. */
const LINKS_COLUMNS = ['Name', 'Link'];


/**
 * The entries portalLinks() asks this file for, by name.
 *
 * `name` is matched against the tab's first column and is also what the
 * button says, so the two cannot drift apart. `why` is not read by anything
 * - it is here so that the next person to look at the tab can see why an
 * address that could obviously have been typed into Config.gs was not.
 */
const PRIVATE_LINKS = [
  { name: 'TVL Daily Connect',
    why: 'a file in a personal OneDrive, so the address carries the ' +
         'owner work email and a sharing token' }
];


function linksTab() {
  const sheets = (typeof CONFIG !== 'undefined' && CONFIG && CONFIG.SHEETS) || {};
  return sheetWithHeaders(sheets.LINKS || 'LINKS', LINKS_COLUMNS);
}


/**
 * Create the tab with a row per private link. Run once from the editor.
 *
 * Rows already there are left alone, so running it again after adding an
 * entry to PRIVATE_LINKS is safe and running it twice costs nothing.
 */
function setupLinksTab() {
  const sheet = linksTab();
  const last = sheet.getLastRow();
  const had = {};

  if (last >= 2) {
    sheet.getRange(2, 1, last - 1, 2).getValues().forEach(function (row) {
      had[String(row[0] || '').trim().toUpperCase()] = true;
    });
  }

  const add = PRIVATE_LINKS
    .filter(function (l) { return !had[l.name.toUpperCase()]; })
    .map(function (l) { return [l.name, '']; });

  if (add.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, add.length, 2).setValues(add);
  }
  sheet.setColumnWidth(1, 220);
  sheet.setColumnWidth(2, 620);

  Logger.log('LINKS is ready. %s row(s) added, %s already there.\n' +
             'Paste each address into the Link column, then run ' +
             'refreshLinks().',
             add.length, Object.keys(had).length);
  return true;
}


/**
 * Every private address, by name, as a plain object.
 *
 * Cached for an hour. portalLinks() is called once on every page load, so
 * an uncached whole-tab read here would put a Sheets round trip in front of
 * every single page in the portal - which is exactly the cost the Objective
 * and Minutes pages were slow for.
 *
 * A name with no address comes back absent rather than empty, and
 * portalLinks() drops the entry. A link-shaped thing that goes nowhere is
 * something people press once and then stop trusting the page.
 */
function linkStore() {
  return linksCached('links.private', 3600, function () {
    const found = {};
    try {
      const sheet = linksTab();
      const last = sheet.getLastRow();
      if (last >= 2) {
        sheet.getRange(2, 1, last - 1, 2).getValues().forEach(function (row) {
          const name = String(row[0] || '').trim();
          const url = linkSafe(row[1]);
          if (name && url) found[name] = url;
        });
      }
    } catch (e) { /* no tab yet; every private link reads as unset */ }
    return found;
  });
}


/**
 * An address the page may put in an href, or ''.
 *
 * ONLY http AND https. A cell on a shared tab reaches an anchor's href from
 * here, and `javascript:` in an href runs when somebody clicks it. Nobody is
 * expected to do that on purpose; the check costs one line and means the tab
 * cannot become a way in.
 */
function linkSafe(url) {
  const text = String(url || '').trim();
  return /^https?:\/\//i.test(text) ? text : '';
}


/** Small cache, never fatal. The twin of byWeeklyCached. */
function linksCached(key, seconds, build) {
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
    catch (e) { /* unavailable; it still works, just slower */ }
  }
  return made;
}


/** Forget the cached addresses, after editing the tab. Run from the editor. */
function refreshLinks() {
  try { CacheService.getScriptCache().remove('links.private'); }
  catch (e) { /* nothing cached */ }
  Logger.log('Cleared. The next page load reads the tab again.');
  return true;
}


/** What is set and what is not. Run from the editor. */
function checkLinks() {
  const lines = [];
  let missing = 0;

  try {
    const sheet = linksTab();
    const last = sheet.getLastRow();
    const found = {};
    if (last >= 2) {
      sheet.getRange(2, 1, last - 1, 2).getValues().forEach(function (row) {
        found[String(row[0] || '').trim().toUpperCase()] =
          String(row[1] || '').trim();
      });
    }

    PRIVATE_LINKS.forEach(function (l) {
      const raw = found[l.name.toUpperCase()];
      if (raw === undefined) {
        missing++;
        lines.push('  ' + l.name + '  NO ROW - run setupLinksTab()');
      } else if (!raw) {
        missing++;
        lines.push('  ' + l.name + '  no address yet, so it is not shown');
      } else if (!linkSafe(raw)) {
        missing++;
        lines.push('  ' + l.name + '  not an http address, so it is ignored: ' +
                   raw.slice(0, 60));
      } else {
        lines.push('  ' + l.name + '  ok');
      }
    });

    const extra = Object.keys(found).filter(function (name) {
      return !PRIVATE_LINKS.some(function (l) {
        return l.name.toUpperCase() === name;
      });
    });
    if (extra.length) {
      lines.push('Rows nothing reads, so nothing shows them: ' +
                 extra.join(', '));
    }
  } catch (e) {
    lines.push('The LINKS tab could not be read: ' + e.message);
    missing = PRIVATE_LINKS.length;
  }

  lines.unshift(missing
    ? missing + ' of ' + PRIVATE_LINKS.length + ' private links have no ' +
      'address, so they are not on the page.'
    : 'All ' + PRIVATE_LINKS.length + ' private links are set.');

  Logger.log(lines.join('\n'));
  return lines.join('\n');
}
