-- ===========================================================================
-- 19-learn-archive.sql - the Previous Version shelf for the Learnings library
-- ===========================================================================
--
-- HOW TO RUN: all of it, in one go. Press F5.
-- IN pgAdmin, SIGNED IN AS postgres.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS IS FOR
-- ---------------------------------------------------------------------------
--
-- An SOP gets replaced. Today the old one is deleted or quietly moved and
-- there is no way to read what the process used to say - which matters when
-- somebody asks why a step changed, or when a plant is still working to last
-- quarter's version.
--
-- So replaced documents go on a shelf instead of into the bin, and the
-- Learnings page grows a Previous Version tab that reads it.
--
-- ---------------------------------------------------------------------------
-- THE FOLDER IS STILL THE AUTHORITY, AND THAT DECIDES THE SHAPE OF THIS
-- ---------------------------------------------------------------------------
--
-- Learn.gs is emphatic about it: the LEARN tab "is a CACHE OF THE FOLDER and
-- is rewritten whole on every scan - editing a cell in it is pointless,
-- because the next scan overwrites it. The folder is the authority."
--
-- That rule survives here, and it is why `archived` is NOT a flag anybody
-- sets. It records WHICH OF THE TWO DRIVE ROOTS the scanner found the file
-- under:
--
--     TVL-EAS_SOP-Policy-User Guideline/           -> archived = false
--     TVL-EAS_SOP-Policy-User Guideline _Archive/  -> archived = true
--
-- Archiving a document is therefore one thing and not two: the file moves in
-- Drive, and the next scan says so. Nothing can get into the state where the
-- database calls a document archived and Drive still has it in the live tree,
-- because the database is not what decides.
--
-- THE ARCHIVE FOLDER IS A SIBLING OF THE LIVE ONE, NOT A CHILD. walkLearnFolder
-- takes every non-trashed file under the root it is given and has no skip
-- list, so an _Archive folder inside the tree would put every superseded SOP
-- back on the shelf it was taken off, filed as Common with no business. A
-- sibling is invisible to the live scan.
--
-- ---------------------------------------------------------------------------
-- THE TWO COLUMNS THAT ARE NOT DERIVED
-- ---------------------------------------------------------------------------
--
-- `archived_at` and `archived_by` cannot be read off Drive - a file's
-- modifiedTime is when its CONTENT last changed, not when somebody shelved
-- it, and Drive does not record who moved a file in a way this can read. The
-- endpoint that performs the move writes them.
--
-- SO THEY CAN BE EMPTY ON AN ARCHIVED ROW, and that is a real state rather
-- than a fault: it means the file was moved in Drive by hand instead of
-- through the button. The page says "archived" either way and only names a
-- person when it knows one. Inventing "unknown" would read as a person.
-- ===========================================================================

BEGIN;

ALTER TABLE learn
  ADD COLUMN IF NOT EXISTS archived     boolean      NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS archived_at  timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by  text         NOT NULL DEFAULT '';

/*
  THE LIBRARY READS THIS ON EVERY PAGE LOAD and asks for one side or the
  other every time, so the shelf never has to be stepped over to find a
  current document. Small table, but it is read on every open of the
  Learnings page by everybody.
*/
CREATE INDEX IF NOT EXISTS learn_archived_idx ON learn (archived, module, title);

/*
  WHO PUT IT THERE IS NOT A FOREIGN KEY TO account, on purpose, and for the
  same reason auth_log has none: an employee ID whose login is later removed
  must not take the history of what they archived with it. The row is a
  record of something that happened. See db/18-accounts.sql.
*/

COMMENT ON COLUMN learn.archived IS
  'Found under the archive root rather than the live one. Derived by the '
  'scanner from WHICH Drive folder the file is in - never set by hand, '
  'because the folder is the authority.';
COMMENT ON COLUMN learn.archived_at IS
  'When the archive button moved it. Empty when the file was moved in Drive '
  'by hand, which is a real state and not a fault.';
COMMENT ON COLUMN learn.archived_by IS
  'Employee ID of whoever pressed Archive. Empty for a file moved by hand. '
  'Not a foreign key: removing somebody''s login must not erase what they did.';

COMMIT;


-- ---------------------------------------------------------------------------
-- WHAT YOU SHOULD SEE
-- ---------------------------------------------------------------------------
--
--   ALTER TABLE
--   CREATE INDEX
--   COMMENT  x3
--   COMMIT
--
-- Run this to check, and expect every row to read false until the first scan
-- of the archive folder:
--
--   SELECT archived, count(*) FROM learn GROUP BY archived;
-- ---------------------------------------------------------------------------
