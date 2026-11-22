-- ===========================================================================
-- 13-roster-module.sql - the module a person works in, when it is not their
--                        section's usual one.
-- ===========================================================================
--
-- HOW TO RUN: all of it, in one go. Press F5. Safe to run again.
-- Then refill the roster:   node api/import-roster.js
--
-- THIS DOES NOT TOUCH YOUR DATA. It adds one nullable column to a table
-- that is already there. Nothing is dropped and nothing is rewritten -
-- which is why it is its own file rather than a change to 12-roster.sql,
-- which starts by dropping its table.
--
-- (12-roster.sql has been updated too, so a fresh install elsewhere gets
-- the column from the start and never needs this file.)
--
-- NO NAMES HERE EITHER. The six exceptions are read from CONFIG.PERSON_MODULES
-- in src/Config.gs by the importer, exactly as the chart itself is.
-- ===========================================================================

ALTER TABLE roster ADD COLUMN IF NOT EXISTS module text;

COMMENT ON COLUMN roster.module IS
  'CONFIG.PERSON_MODULES. The module this person works in when it is not '
  'their section''s usual one. NULL for everybody else, who take '
  'SECTION_MODULES instead.';

/*
  WHY THIS IS A COLUMN ON roster AND NOT A TABLE OF ITS OWN.

  It is a fact about a person, and roster is already the table of facts
  about people that tickets are attributed by. All six of the exceptions
  in CONFIG.PERSON_MODULES are on the org chart, so there is no row this
  could need that roster does not already have. (The importer checks that
  rather than assuming it, and says so if somebody is ever added to
  PERSON_MODULES who is not on the chart - that exception would otherwise
  be silently dropped.)

  A MODULE ROLE AND A SECTION ARE NOT THE SAME THING, which is the whole
  reason the column exists. Config.gs: somebody can sit in Financial and
  work CO, or sit in Supply Chain and work PP. Reading the module off the
  section would file their tickets under the wrong one every month.

  AND THE HEAD OF EAS SITS IN NO SECTION AT ALL. Config.gs records what
  that cost: his Sub-Department is ALL, SECTION_MODULES has no entry for
  ALL - correctly, it is not a section - so a ticket of his that the Part
  column could not place had nothing to fall back on and landed in
  '(unassigned)'.

  NULL MEANS "no exception", not "no module". Everybody without one takes
  their section's usual module, which lives in the code because four
  section names mapped to four module names is not personal data and is
  not something anybody edits from a screen.
*/


-- ===========================================================================
SELECT count(*)::int AS people,
       count(module)::int AS "with a module of their own"
  FROM roster;
-- The second number is 0 until you run: node api/import-roster.js
-- ===========================================================================
