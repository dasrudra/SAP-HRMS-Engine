/**
 * PRESENCE - who is at their desk right now.
 *
 * The question this answers is a practical one: the team sits across two
 * floors and most of what one person needs from another is a thirty-second
 * conversation on an extension. Ringing somebody who is not there, waiting,
 * then walking over to find an empty chair is the thing worth removing. A dot
 * beside a name on the EAS Team page says whether the call is worth making.
 *
 * THREE STATES, and only the first two are ever written down:
 *
 *   ACTIVE    signed in, page open, has not said otherwise
 *   AWAY      signed in, but said "not at my desk"
 *   OFFLINE   no entry in the cache, which is what everything else looks like
 *
 * WHY CacheService AND NOT THE SPREADSHEET.
 *
 * Three reasons, and the third is the important one.
 *
 *   It is the right shape. Presence is true for minutes. A spreadsheet is for
 *   things that are true until somebody changes them, and it would take a
 *   write per person per heartbeat - thirty-seven people against a six-minute
 *   write lock is a queue, not a feature.
 *
 *   Entries expiring is the behaviour we want, not a limitation to work
 *   around. Somebody who shuts their laptop never tells us anything. There is
 *   no event for that. The only honest way to show them as gone is for the
 *   thing that said they were here to stop being true on its own, which is
 *   exactly what a TTL does.
 *
 *   IT KEEPS NO HISTORY. Nothing here is logged, nothing accumulates, and
 *   nothing can be looked at later. A spreadsheet tab would quietly become a
 *   record of when each of thirty-seven people was at their desk, day after
 *   day, and that is a different product from the one that was asked for -
 *   one nobody consented to and somebody would eventually read. The cache
 *   cannot answer "where was he on Tuesday" because by Tuesday evening it has
 *   already forgotten Tuesday morning. That is a property worth choosing on
 *   purpose, not an accident of the storage.
 *
 * WHY THE SCRIPT CACHE AND NOT THE USER CACHE.
 *
 * getUserCache() is private to one signed-in Google account. Presence is the
 * one thing in this project that is deliberately shared: it is of no use to
 * me that I can see my own dot. getScriptCache() is one shared space for the
 * whole deployment, which is what a directory needs.
 */

// The entry outlives the window on purpose. The 30 minutes is only how long
// the cache bothers to hold the row; whether it still MEANS anything is
// decided at read time against PRESENCE_FRESH_MS. Separating the two means a
// clock skew or a slow poll degrades into "stale, so offline" rather than
// into a key that vanished mid-read.
const PRESENCE_ENTRY_TTL = 1800;

// How recent a heartbeat has to be to still count. The page beats every three
// minutes, so this is two missed beats of slack: a dropped poll on bad wifi
// does not blink somebody off the page, but a closed laptop is gone inside
// ten minutes.
const PRESENCE_FRESH_MS = 8 * 60 * 1000;

// Six hours is the documented ceiling for CacheService, and the roster is the
// one thing here worth holding that long - it changes when somebody joins the
// team, not when somebody stands up.
const PRESENCE_ROSTER_TTL = 21600;

const PRESENCE_ROSTER_KEY = 'pres:roster';

const PRESENCE_ACTIVE = 'ACTIVE';
const PRESENCE_AWAY = 'AWAY';
const PRESENCE_OFFLINE = 'OFFLINE';


/**
 * One cache key from one identifier.
 *
 * Lower-cased and stripped of spaces because the same person arrives spelled
 * differently depending on which end of the system is asking: a login typed
 * by hand, an employee ID that came out of a numeric cell, a name with two
 * spaces in it.
 */
function presenceKey(raw) {
  const flat = String(raw === null || raw === undefined ? '' : raw)
    .trim().toLowerCase().replace(/\s+/g, ' ');
  return flat ? 'pres:' + flat : '';
}


/**
 * Every key a signed-in username might be found under.
 *
 * THIS IS THE JOIN, and it is written as two keys rather than one because the
 * two ends of it were built by different people at different times and do not
 * have to agree.
 *
 * A login is whatever was typed when the account was created. It might be the
 * employee ID. It might be the person's name. The TEAM tab, meanwhile, knows
 * people by employee ID and by name and has never heard of a login. Rather
 * than decide which convention is in use - and be wrong about it the first
 * time somebody creates an account the other way - presence is written under
 * BOTH readings of the username, and read back under both readings of each
 * person in the directory. Whichever pair lines up, lines up.
 *
 * The second key goes through matchPerson() from Config.gs, the same function
 * the ticket ingest matches owners with, so a name this agrees about is a name
 * the rest of the project agrees about too. An employee ID squashes to the
 * empty string under it - there are no letters in 20536723 - which is why
 * there is a first key as well.
 */
function presenceWriteKeys(username) {
  const keys = [];
  const direct = presenceKey(username);
  if (direct) keys.push(direct);

  const byName = presenceKey(matchPerson(username));
  if (byName && keys.indexOf(byName) === -1) keys.push(byName);

  return keys;
}


/** The same two readings, from the directory's side. */
function presenceReadKeys(person) {
  const keys = [];
  if (!person) return keys;

  const byId = presenceKey(person.id);
  if (byId) keys.push(byId);

  const byName = presenceKey(matchPerson(person.name));
  if (byName && keys.indexOf(byName) === -1) keys.push(byName);

  return keys;
}


/**
 * How the page refers to one person when it asks about their dot.
 *
 * Employee ID when there is one, name when there is not. Both sides take this
 * from the same readTeam() output, so there is nothing to normalise: the
 * string the server emits is character-for-character the string the card
 * looks up. Normalising it on the client as well would be one more place for
 * the two to drift apart.
 */
function presenceIdOf(person) {
  if (!person) return '';
  return String(person.id || person.name || '').trim();
}


/**
 * Everybody a dot could be drawn for, out of a directory already in hand.
 *
 * Caches what it builds, which is why getTeam() calls it: opening the EAS
 * Team page is the moment the tab has just been read anyway, so it is a free
 * chance to put a fresh roster in the cache.
 *
 * THAT IS NOT AN OPTIMISATION, IT IS THE FIX FOR A REAL STALENESS BUG. The
 * key a person is found under is derived from their row - employee ID, or
 * their name when the ID cell is empty. So filling in a missing ID CHANGES
 * THEIR KEY, and until the cached roster caught up, their dot would have
 * looked for them under a name nothing was writing any more and shown them
 * grey while they sat at their desk. Six hours of that, after a correction
 * somebody made specifically to tidy the page up. Refreshing here means the
 * window is one visit to the directory instead.
 */
function presenceRosterFrom(team) {
  const roster = [];
  const seen = {};

  const add = function (person) {
    if (!person) return;
    const id = presenceIdOf(person);
    if (!id || seen[id]) return;
    seen[id] = true;
    roster.push({ id: person.id, name: person.name });
  };

  // The department head first, and separately, because he sits above the
  // sections rather than in one. Leaving him to the loop below would have
  // found him only on the days he happened to be covering a section.
  add(team && team.lead);
  ((team && team.sections) || []).forEach(function (section) {
    add(section.head);
    (section.members || []).forEach(add);
  });

  if (roster.length) {
    try {
      CacheService.getScriptCache()
        .put(PRESENCE_ROSTER_KEY, JSON.stringify(roster), PRESENCE_ROSTER_TTL);
    } catch (e) { /* the cache is a convenience here, not a dependency */ }
  }

  return roster;
}


/**
 * The directory, without reading the spreadsheet if it can be helped.
 *
 * A heartbeat must not cost a spreadsheet read - that is the whole reason the
 * beat is affordable at all - and neither should a page refresh. Names and
 * IDs change when somebody joins the team, so they are cached for hours and
 * rebuilt from the tab when the cache is cold.
 */
function presenceRoster() {
  let cache = null;
  try { cache = CacheService.getScriptCache(); } catch (e) { cache = null; }

  if (cache) {
    const raw = cache.get(PRESENCE_ROSTER_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.length) return parsed;
      } catch (e) {
        // A corrupt row is not worth an error on somebody's screen. Fall
        // through and rebuild it from the tab.
      }
    }
  }

  return presenceRosterFrom(readTeam());
}


/**
 * Everybody's state, keyed the way the cards ask for it.
 *
 * Unguarded on purpose, in the pattern the rest of this project uses: the
 * endpoint below checks the token, this does the work, and the editor
 * helpers can call it without inventing a session.
 */
function readPresence() {
  const roster = presenceRoster();
  const out = {};
  if (!roster.length) return out;

  let cache = null;
  try { cache = CacheService.getScriptCache(); } catch (e) { cache = null; }

  // Every key for every person, in one request. Thirty-seven people is up to
  // seventy-four keys; one getAll beats seventy-four gets by about two
  // orders of magnitude, and the page is waiting on it.
  const wanted = [];
  roster.forEach(function (person) {
    presenceReadKeys(person).forEach(function (key) {
      if (wanted.indexOf(key) === -1) wanted.push(key);
    });
  });

  let found = {};
  if (cache && wanted.length) {
    try { found = cache.getAll(wanted) || {}; } catch (e) { found = {}; }
  }

  const now = Date.now();

  roster.forEach(function (person) {
    const id = presenceIdOf(person);
    if (!id) return;

    out[id] = PRESENCE_OFFLINE;

    const keys = presenceReadKeys(person);
    for (let i = 0; i < keys.length; i++) {
      const raw = found[keys[i]];
      if (!raw) continue;

      const bits = String(raw).split('|');
      const when = Number(bits[1]) || 0;

      // Stale beats are not a state. Somebody whose last word was eleven
      // minutes ago has shut their laptop, whatever that word was.
      if (!when || now - when > PRESENCE_FRESH_MS) continue;

      out[id] = bits[0] === PRESENCE_AWAY ? PRESENCE_AWAY : PRESENCE_ACTIVE;
      break;
    }
  });

  return out;
}


/**
 * The heartbeat. Says the caller is here, and says whether they are at their
 * desk.
 *
 * WHOSE STATE THIS SETS IS NOT A PARAMETER. It comes out of the token and
 * nowhere else. The deployment is published to "Anyone" - it has to be, so
 * that people without a Google account on the domain can sign in - so every
 * global function in this project is a URL a stranger can POST to, and an
 * endpoint that took an employee ID would be a button for marking a colleague
 * away from the other side of the building. The only thing the caller gets to
 * say about themselves is the one bit below.
 *
 * It returns the caller's own state and nothing else. Painting the other
 * thirty-six dots is a separate call, made only by the page that draws them,
 * because most of the time this one is beating from a page that is showing a
 * dashboard and has no dots on it.
 *
 * @param {string} token    the session token
 * @param {boolean} away    true if the caller has said they are not at their desk
 * @return {{me: string}}
 */
function presenceTick(token, away) {
  const session = currentSession(token);
  if (!session) {
    throw new Error('Your session has ended. Reload the page and sign in again.');
  }

  const state = away ? PRESENCE_AWAY : PRESENCE_ACTIVE;
  const keys = presenceWriteKeys(session.u);
  if (!keys.length) return { me: state };

  const value = state + '|' + Date.now();
  const batch = {};
  keys.forEach(function (key) { batch[key] = value; });

  try {
    CacheService.getScriptCache().putAll(batch, PRESENCE_ENTRY_TTL);
  } catch (e) {
    // A dropped beat costs one dot for a few minutes. It is not worth a
    // dialog, and the next beat fixes it.
  }

  return { me: state };
}


/**
 * Stops saying the caller is here.
 *
 * Signing out should take the dot off the page now rather than in eight
 * minutes. Without this, the one person who tidies up after themselves looks
 * exactly like the one who walked away mid-session, which is the distinction
 * the whole feature exists to draw.
 */
function presenceClear(token) {
  const session = currentSession(token);
  if (!session) return { me: PRESENCE_OFFLINE };

  const keys = presenceWriteKeys(session.u);
  if (keys.length) {
    try { CacheService.getScriptCache().removeAll(keys); }
    catch (e) { /* it expires on its own soon enough */ }
  }

  return { me: PRESENCE_OFFLINE };
}


/**
 * The endpoint the EAS Team page polls while it is open.
 *
 * Guarded, though what it discloses is mild next to getTeam() next door -
 * thirty-seven states with no names attached that the caller cannot read
 * without the directory anyway. It is guarded for the same reason the
 * directory is: nothing about the team is public, and "mild" is not a
 * category this project has.
 */
function getPresence(token) {
  requireSignedIn(token);
  return readPresence();
}


// ---------------------------------------------------------------------------
// RUN FROM THE EDITOR
// ---------------------------------------------------------------------------

/**
 * Prints who the page currently thinks is at their desk.
 *
 * Useful for exactly one thing: telling "the dots are wrong" apart from "the
 * join is wrong". If this names somebody as ACTIVE and their card is grey,
 * the fault is in the page. If everybody is OFFLINE while people are plainly
 * signed in, the two halves of presenceWriteKeys / presenceReadKeys are not
 * meeting, and the roster line below says under which keys to look.
 */
function checkPresence() {
  const states = readPresence();
  const ids = Object.keys(states);

  if (!ids.length) {
    Logger.log('No directory to report on - the TEAM tab is empty.');
    return;
  }

  const here = ids.filter(function (id) { return states[id] === PRESENCE_ACTIVE; });
  const away = ids.filter(function (id) { return states[id] === PRESENCE_AWAY; });

  Logger.log('%s in the directory: %s active, %s away, %s offline.',
             ids.length, here.length, away.length,
             ids.length - here.length - away.length);

  presenceRoster().forEach(function (person) {
    const state = states[presenceIdOf(person)] || PRESENCE_OFFLINE;
    if (state === PRESENCE_OFFLINE) return;
    Logger.log('  %s - %s (keys: %s)', person.name, state,
               presenceReadKeys(person).join(', '));
  });
}
