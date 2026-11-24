-- ===========================================================================
-- 17-trainer-module.sql - a trainer's usual module, for files that name none.
-- ===========================================================================
--
-- CONFIG.TRAINER_MODULES. Three rows today.
--
-- WHY IT IS A TABLE AND NOT A CONSTANT IN api/kpi2.js
--
-- Because it is three colleagues' names, and this repository is public. The
-- org chart went the same way for the same reason - see db/12-roster.sql -
-- and the rule is the one in PORT-INVENTORY.md: no personal data in the
-- repository, ever, including in a lookup table that looks harmless.
--
-- Filled by `node api/import-roster.js`, which lifts it out of src/Config.gs
-- at run time. Nothing in the committed code ever holds a name.
--
--
-- WHAT IT IS FOR, AND WHY IT IS ONLY A FALLBACK
--
-- A training feedback file usually names its module: 'Trainee Feedback-
-- E-Accounting_<trainer>.xlsx'. When it does, moduleFor reads it off the
-- filename and this table is never consulted.
--
-- Only a file that names NO module at all falls through to here, and then
-- the trainer's usual module answers. Config.gs is explicit about why the
-- order matters that way round: one trainer runs sessions in two different
-- modules, so taking the trainer first would file her E-Accounting sessions
-- under her usual module and quietly move a whole course between rows of
-- the Department Summary.
--
--
-- PERMISSIONS: none granted here. See the note in 14-backup.sql.
-- ===========================================================================


CREATE TABLE IF NOT EXISTS trainer_module (
  /*
    The text matched against the filename, lower case. A fragment of a name
    rather than a whole one, because that is what the filenames carry: a
    first name, not a full name.

    Matched at a word boundary by moduleForResponse, so a short fragment
    cannot fire inside a longer word.
  */
  match_key  text  PRIMARY KEY,

  -- The module that trainer usually runs. Not a foreign key to anything:
  -- TRAINING_MODULES is a list in code, and a module with no training this
  -- year still needs to be nameable here.
  module     text  NOT NULL,

  loaded_at  timestamptz NOT NULL DEFAULT now()
);


-- ===========================================================================
-- WHAT IS NOT HERE
-- ===========================================================================
--
-- No link to `team` or `roster`. A trainer is not necessarily on the EAS org
-- chart, and this match is a fragment of a filename rather than a person's
-- key. Joining the two would make the lookup fail for an outside trainer,
-- which is the case it most needs to handle.
--
-- No ordering column. moduleForResponse walks the list and the first match
-- wins, so order would matter if two fragments could both match one
-- filename. They cannot today, and if they ever can, the fix is a longer
-- fragment rather than a tie-break nobody can see.
-- ===========================================================================
