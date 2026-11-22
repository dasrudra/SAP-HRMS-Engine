/**
 * modules.js - which SAP module a ticket belongs to.
 * ===========================================================================
 *
 * Ported from src/Config.gs: moduleForTicket, moduleFromPart,
 * moduleForPerson, ticketModulePatterns. Proved identical by
 * module-equivalence-test.js.
 *
 * THREE SOURCES, IN THIS ORDER, and the order is the whole design:
 *
 *   1. The ITSM's Part column, when it names one of the modules EAS
 *      actually reports on. THAT LIST IS CLOSED. The Part column also
 *      carries things that are not modules at all - Account, Monitoring,
 *      Groupware, PC/Monitor, Others, FRP, TexManager, WMIS - and letting
 *      those through "produced a table of fifteen rows, half of which no
 *      one reports against".
 *
 *   2. Otherwise the person in Current Activity In Charge. Whoever handled
 *      the ticket, it belongs to their module - "which is the rule the team
 *      works to, and the only thing that can place a ticket the Part column
 *      mislabels."
 *
 *   3. Failing both, '(unassigned)', so it is visible rather than guessed.
 *
 * Resolved when the figures are computed, from the ticket's own columns, so
 * correcting somebody's module re-files every affected ticket with nothing
 * to re-upload.
 */

const roster = require('./roster');

/*
  Config.gs TICKET_MODULES. Part-column patterns, in two kinds.

  CODES are abbreviations and are matched before WORDS, whatever their
  length. A code is what the ITSM writes in a Part cell on purpose; a word
  is a guess at what a prose Part might mean, and a guess must never beat
  a deliberate label.

  Not personal data - eight module names and the spellings the Part column
  uses for them - so it stays in the code, where the original keeps it.
*/
const TICKET_MODULES = [
  { name: 'Account',      codes: ['account'] },
  { name: 'E-Accounting', codes: ['e-accounting', 'e accounting', 'eaccounting'] },
  /*
    FI, TR AND FI/TR ARE ONE MODULE. Config.gs: "The ITSM's Part column
    spells it both ways - 1,441 tickets as 'FI/TR' and 7 as 'FI' - and
    splitting them made two rows out of one team's work, the smaller of
    which read as a rounding error rather than as the same thing written
    differently."
  */
  { name: 'FI/TR',        codes: ['fi/tr', 'fi_tr', 'fi-tr', 'fitr', 'fi tr', 'fi', 'tr'] },
  // 'mm purchase' is deliberately absent: 'mm' is a code and catches it
  // first, which is what that phrase existed to force back when everything
  // was sorted together by length.
  { name: 'MM',           codes: ['mm', 'mcd'],
                          words: ['purchase', 'inventory'] },
  { name: 'MD',           codes: ['md'] },
  { name: 'PP',           codes: ['pp', 'ypl'],
                          words: ['production'] },
  { name: 'SD',           codes: ['sd'],
                          words: ['development', 'export', 'shipping'] },
  { name: 'CO',           codes: ['co'] }
];

/*
  Config.gs SECTION_MODULES. The module each section usually handles, for
  somebody with no entry of their own.

  'FI/TR', not 'FI' - the same name the Part column resolves to, so a
  Financial person's fallback lands in the row their own tickets are in.
*/
const SECTION_MODULES = {
  'Financial Applications':     'FI/TR',
  'Sales Applications':         'SD',
  'Supply Chain Applications':  'MM',
  'Manufacturing Applications': 'PP'
};

const UNASSIGNED = '(unassigned)';


/**
 * Every Part pattern, compiled once: all CODES, then all WORDS.
 *
 * LONGEST FIRST WITHIN EACH KIND, so 'fi/tr' is not claimed by the shorter
 * 'fi', and the boundary in the regex is what stops 'co' firing inside
 * 'Accounting'.
 *
 * `pattern` is kept beside each one so a match can say WHICH pattern caught
 * a ticket - "filed under PP because the Part column contains 'production'"
 * is the only form of that answer anybody can check.
 */
let PATTERNS = null;

/**
 * @param list  only for testing - see below. Omit for the real modules.
 *
 * THE LIST IS A PARAMETER ONLY SO THE ESCAPING CAN BE TESTED.
 *
 *     const safe = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
 *
 * Not one of the twenty-four Part patterns in use contains a character
 * that line changes, so against the real list it is a no-op and deleting
 * it alters no answer - a deliberate break of it survived every other
 * comparison in module-equivalence-test.js.
 *
 * It is not pointless, though. The day somebody adds a Part spelling with
 * a dot or a plus in it - 'c.o', 'fi+tr' - an unescaped pattern stops
 * being a literal and starts matching things nobody intended: '.' would
 * match any character, so 'c.o' would claim 'cao' and 'c-o' alike. That
 * is a silent mis-filing of a whole module's tickets.
 *
 * So the guard stays and a synthetic list reaches it, rather than leaving
 * a line no test can defend.
 */
function ticketModulePatterns(list) {
  if (list) return compilePatterns(list);
  if (PATTERNS) return PATTERNS;
  PATTERNS = compilePatterns(TICKET_MODULES);
  return PATTERNS;
}

/** The compile step, shared by the real list and a test's own. */
function compilePatterns(source) {
  const codes = [];
  const words = [];

  const compile = function (module, pattern, kind) {
    const safe = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return {
      name: module.name,
      pattern: pattern,
      kind: kind,
      length: pattern.length,
      re: new RegExp('(^|[^a-z0-9])' + safe + '([^a-z0-9]|$)')
    };
  };

  source.forEach(function (module) {
    // `match` is the shape this list had before codes and words were told
    // apart. Accepted as codes so a half-updated config still scores
    // tickets rather than filing every one of them as unassigned.
    (module.codes || module.match || []).forEach(function (p) {
      codes.push(compile(module, p, 'code'));
    });
    (module.words || []).forEach(function (p) {
      words.push(compile(module, p, 'word'));
    });
  });

  const longestFirst = function (a, b) { return b.length - a.length; };
  codes.sort(longestFirst);
  words.sort(longestFirst);

  return codes.concat(words);
}


/**
 * A module read out of the Part column - and only one EAS reports on.
 *
 * @return {string} module name, or '' when the Part names none
 */
function moduleFromPart(part) {
  const text = String(part || '').toLowerCase().trim();
  if (!text) return '';

  const patterns = ticketModulePatterns();
  for (let i = 0; i < patterns.length; i++) {
    if (patterns[i].re.test(text)) return patterns[i].name;
  }
  return '';
}


/**
 * Which module does this person work in?
 *
 * THEIR OWN ENTRY FIRST, because a module role and a section are not the
 * same thing - somebody can sit in Financial and work CO. Only then the
 * section's usual module.
 *
 * THE SECTION IS READ AT TODAY'S NAMES, never the pre-split ones, and that
 * is deliberate: 'Functional Applications' covered three modules at once
 * and cannot name just one. So this passes null for the month even when
 * scoring an old ticket.
 *
 * @param index  from roster.buildIndex, with `module` carried on each row
 */
function moduleForPerson(index, name, month) {
  const key = roster.matchPerson(name);
  if (!key) return '';

  const own = index.module && index.module[key];
  if (own) return own;

  const section = roster.sectionFor(index, name, null, '');
  return SECTION_MODULES[section] || '';
}


/** Part first, then the person, then visible as unassigned. */
function moduleForTicket(index, part, inCharge, month) {
  return moduleFromPart(part) ||
         moduleForPerson(index, inCharge, month) ||
         UNASSIGNED;
}


/**
 * Why a ticket is in the module it is in.   [Kpi.gs:1207 whyModule]
 *
 * Not used by the figures. It exists because "filed under PP because the
 * Part column contains 'production'" is the only form of that answer
 * anybody can check, and the first question asked of any module table is
 * why a particular ticket is in the wrong row.
 */
function whyModule(index, part, inCharge, month) {
  const text = String(part || '').toLowerCase().trim();
  if (text) {
    const patterns = ticketModulePatterns();
    for (let i = 0; i < patterns.length; i++) {
      if (patterns[i].re.test(text)) {
        return { module: patterns[i].name, how: patterns[i].kind,
                 detail: patterns[i].pattern };
      }
    }
  }

  const key = roster.matchPerson(inCharge);
  const own = key && index.module && index.module[key];
  if (own) return { module: own, how: 'person', detail: inCharge };

  const section = roster.sectionFor(index, inCharge, null, '');
  const theirs = SECTION_MODULES[section];
  if (theirs) return { module: theirs, how: 'section', detail: section };

  return { module: UNASSIGNED, how: 'nothing', detail: '' };
}


module.exports = {
  TICKET_MODULES, SECTION_MODULES, UNASSIGNED,
  ticketModulePatterns, moduleFromPart, moduleForPerson, moduleForTicket,
  whyModule
};
