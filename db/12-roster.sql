-- ===========================================================================
-- 12-roster.sql - who belongs to which section. KPI 1 is attributed by this.
-- ===========================================================================
--
-- HOW TO RUN: all of it, in one go. Press F5. Safe to run again.
-- Then fill it:   node api/import-roster.js
--
-- NO NAMES IN THIS FILE. They are colleagues' names and this repository is
-- public. The table is created empty and filled by the importer, which
-- reads them from src/Config.gs - where they already are, and where moving
-- somebody between sections is already a one-line edit.
-- ===========================================================================

DROP TABLE IF EXISTS roster;


CREATE TABLE roster (
  person_key   text PRIMARY KEY,
  display_name text NOT NULL CHECK (btrim(display_name) <> ''),
  section      text NOT NULL CHECK (btrim(section) <> ''),
  is_former    boolean NOT NULL DEFAULT false,
  loaded_at    timestamptz NOT NULL DEFAULT now()
);

/*
  THE KEY IS A NORMALISED NAME, NOT AN EMPLOYEE ID, and it has to be.

  A ticket carries 'Current Activity In Charge' - a name typed by the ITSM -
  and nothing else that identifies who handled it. There is no employee ID
  on a ticket to join to. So attribution is by name, and the name has to be
  squashed first, because the same person is written several ways:

      the honorific run straight into the first name with no space, and
      the ITSM spelling it out in full where the org chart abbreviates it.
      Config.gs has the real examples; both resolve.

  person_key is matchPerson() of the name: lower-cased, everything but
  letters removed, and the four spellings of the honorific folded into one.
  display_name keeps whatever was written, because a key nobody can read is
  a key nobody can check.

  WHY NOT JUST USE team.sub_department. Two reasons, and both would be
  silent if ignored.

  First, they are different lists. CONFIG.ROSTER is the authority for
  attribution - Config.gs says so in capitals - and it spells sections
  differently from the TEAM tab on purpose: 'Sales Applications' here,
  'Sales and Customer Applications' there. Scoring on one and labelling
  with the other would produce two sets of section names that look like
  six sections where there are four.

  Second, and worse: PEOPLE WHO HAVE LEFT ARE NOT IN team. CONFIG.FORMER
  exists for exactly that -

      "they are off the chart and out of the drift check, but their tickets
       are still in every month they worked, and those months have to keep
       totalling the same number tomorrow as they did yesterday."

  Build the index from the directory and every leaver's tickets fall into
  '(unassigned)' the day their row goes, and a month that balanced last
  week stops balancing. is_former keeps them here and out of the team page.

  WHAT IS NOT STORED HERE: the bare-name fallback and the clash list.
  rosterIndex() derives both from this same set of names - a second key with
  the honorific dropped, so a ticket raised against somebody's name
  without it still finds the person listed with it, and any bare form
  two different people share is
  dropped rather than guessed at. Storing them would be storing something
  that must agree with person_key, and two things that must agree are one
  thing that can disagree.
*/

CREATE INDEX roster_section_idx ON roster (section);


-- ===========================================================================
SELECT 'roster' AS table_name, count(*) AS rows FROM roster;
-- Zero. Run: node api/import-roster.js
-- ===========================================================================
