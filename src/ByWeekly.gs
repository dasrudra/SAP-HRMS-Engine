/**
 * ByWeekly.gs - the four sections' meeting decks, where they actually live.
 * =========================================================================
 *
 * WHAT THIS IS
 * Four links. Each section keeps its bi-weekly meeting as a PowerPoint on
 * somebody's OneDrive, and this is the one place in the portal that knows
 * where all four are, so nobody has to ask which folder this fortnight's
 * deck is in.
 *
 * WHY THE ADDRESSES ARE NOT IN THIS FILE
 * They are personal OneDrive links. Every one of them carries the owner's
 * work email inside the path - aungshuman_das_tekvision_com_bd and so on -
 * and this repository is public. Written here they would be on the open
 * internet, and in the git history after any deletion, for four people who
 * were never asked.
 *
 * They are on the BY_WEEKLY tab instead, which also means a link can be
 * replaced when somebody reissues a share without a deployment. SharePoint
 * share links do get reissued.
 *
 * WHY THE SECTIONS ARE IN THIS FILE
 * The four names and their order are not private and not going to change,
 * and a tab whose first column could be typed wrong is a tab that silently
 * loses a button. setupByWeeklyTab() writes the four rows; the only thing
 * anybody fills in is the address.
 */


/** The tab, and the one column anybody edits. */
const BY_WEEKLY_COLUMNS = ['Section', 'Link'];

/**
 * The four, in the order they are shown.
 *
 * `key` is what the sheet is matched on and never shown. `name` is the
 * button. `accent` is its colour, and they are the four the EAS Team page
 * already gives these sections, so a section is one colour across the
 * portal rather than one per page.
 */
const BY_WEEKLY_SECTIONS = [
  { key: 'SCA',  name: 'Supply Chain',      accent: '#4cc9f0' },
  { key: 'SDMM', name: 'Sales & Customer',  accent: '#5b9cf8' },
  { key: 'PP',   name: 'Manufacturing',     accent: '#9d7bef' },
  { key: 'FICO', name: 'Financial',         accent: '#7b86f0' }
];


function byWeeklyTab() {
  const sheets = (typeof CONFIG !== 'undefined' && CONFIG && CONFIG.SHEETS) || {};
  return sheetWithHeaders(sheets.BY_WEEKLY || 'BY_WEEKLY', BY_WEEKLY_COLUMNS);
}


/**
 * Create the tab with its four rows. Run once from the editor.
 *
 * Rows that are already there are left alone, so running it again after
 * adding a section is safe and running it twice costs nothing.
 */
function setupByWeeklyTab() {
  const sheet = byWeeklyTab();
  const last = sheet.getLastRow();
  const had = {};

  if (last >= 2) {
    const rows = sheet.getRange(2, 1, last - 1, 2).getValues();
    rows.forEach(function (row) {
      had[String(row[0] || '').trim().toUpperCase()] = true;
    });
  }

  const add = BY_WEEKLY_SECTIONS
    .filter(function (s) { return !had[s.name.toUpperCase()]; })
    .map(function (s) { return [s.name, '']; });

  if (add.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, add.length, 2).setValues(add);
  }
  sheet.setColumnWidth(1, 180);
  sheet.setColumnWidth(2, 620);

  Logger.log('BY_WEEKLY is ready. %s row(s) added, %s already there.\n' +
             'Paste each section\'s OneDrive address into the Link column.',
             add.length, Object.keys(had).length);
  return true;
}


/**
 * The four, with whatever address each has.
 *
 * A section with no address still comes back - the page draws it greyed
 * out and says it has no link yet, which is a thing somebody can fix. A
 * button that silently disappeared would just look like the page was
 * wrong.
 *
 * Cached for an hour: four short strings that change about once a year,
 * against a whole-tab read on a page people open to press one button.
 */
function getByWeeklyLinks(token) {
  requireSignedIn(token);

  return byWeeklyCached('byweekly.links', 3600, function () {
    const found = {};
    try {
      const sheet = byWeeklyTab();
      const last = sheet.getLastRow();
      if (last >= 2) {
        const rows = sheet.getRange(2, 1, last - 1, 2).getValues();
        rows.forEach(function (row) {
          const name = String(row[0] || '').trim().toUpperCase();
          const url = String(row[1] || '').trim();
          if (name && url) found[name] = url;
        });
      }
    } catch (e) { /* no tab yet; every link reads as missing */ }

    return {
      ok: true,
      links: BY_WEEKLY_SECTIONS.map(function (s) {
        return { key: s.key, name: s.name, accent: s.accent,
                 url: byWeeklySafe(found[s.name.toUpperCase()] || '') };
      })
    };
  });
}


/**
 * An address the page may put in an href, or ''.
 *
 * ONLY http AND https. A cell on a shared tab reaches an anchor's href
 * here, and `javascript:` in an href runs when somebody clicks it. Nobody
 * is expected to do that on purpose; the check costs one line and means
 * the tab cannot become a way in.
 */
function byWeeklySafe(url) {
  const text = String(url || '').trim();
  return /^https?:\/\//i.test(text) ? text : '';
}


/** Small cache, never fatal. See minCached's twin in the objectives code. */
function byWeeklyCached(key, seconds, build) {
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
function refreshByWeeklyLinks() {
  try { CacheService.getScriptCache().remove('byweekly.links'); }
  catch (e) { /* nothing cached */ }
  Logger.log('Cleared. The next person to open the page reads the tab again.');
  return true;
}


/** What is set and what is not. Run from the editor. */
function checkByWeekly() {
  const lines = [];
  let missing = 0;

  try {
    const sheet = byWeeklyTab();
    const last = sheet.getLastRow();
    const found = {};
    if (last >= 2) {
      sheet.getRange(2, 1, last - 1, 2).getValues().forEach(function (row) {
        found[String(row[0] || '').trim().toUpperCase()] = String(row[1] || '').trim();
      });
    }

    BY_WEEKLY_SECTIONS.forEach(function (s) {
      const raw = found[s.name.toUpperCase()];
      if (raw === undefined) {
        missing++;
        lines.push('  ' + s.name + '  NO ROW - run setupByWeeklyTab()');
      } else if (!raw) {
        missing++;
        lines.push('  ' + s.name + '  no address yet');
      } else if (!byWeeklySafe(raw)) {
        missing++;
        lines.push('  ' + s.name + '  not an http address, so it is ignored: ' +
                   raw.slice(0, 60));
      } else {
        lines.push('  ' + s.name + '  ok');
      }
    });

    const extra = Object.keys(found).filter(function (name) {
      return !BY_WEEKLY_SECTIONS.some(function (s) {
        return s.name.toUpperCase() === name;
      });
    });
    if (extra.length) {
      lines.push('Rows nothing reads, so nothing shows them: ' + extra.join(', '));
    }
  } catch (e) {
    lines.push('The BY_WEEKLY tab could not be read: ' + e.message);
    missing = BY_WEEKLY_SECTIONS.length;
  }

  lines.unshift(missing
    ? missing + ' of ' + BY_WEEKLY_SECTIONS.length + ' sections have no link.'
    : 'All ' + BY_WEEKLY_SECTIONS.length + ' sections have a link.');

  Logger.log(lines.join('\n'));
  return lines.join('\n');
}
