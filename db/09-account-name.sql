-- ===========================================================================
-- 09-account-name.sql - the one ACCOUNTS column the messenger needs.
-- ===========================================================================
--
-- HOW TO RUN: all of it, in one go. Press F5. Safe to run again.
--
-- THIS DOES NOT TOUCH YOUR DATA. It adds one column to a table that is
-- already there. Nothing is dropped and nothing is rewritten - which is why
-- it is its own file rather than a change to 01-schema.sql, which you have
-- already run and which starts by dropping its tables.
--
-- (01-schema.sql has been updated too, so a fresh install on another machine
-- gets the column from the start and never needs this file.)
--
-- WHY IT IS NEEDED
--
-- The ACCOUNTS tab has twelve columns and this port carried six of them. One
-- of the six left behind is 'Name', and the messenger depends on it:
--
--   Messenger.gs sendMessage -> "A name typed by somebody whose account has
--   none is kept ON THE ACCOUNT, which is what stops the panel asking again
--   tomorrow."
--
--   messengerBoot -> "The panel asks for a name only while this is false - a
--   box that keeps asking for something already answered is how the same
--   person ends up stored three different ways."
--
-- Without the column, accountNameOf() can only ever answer '', so the panel
-- would ask every single person for their name on every single page load,
-- for ever, and store a fresh copy each time they obliged.
--
-- WHY NOT JUST USE team.full_name
--
-- Because they are not the same fact and the original keeps them apart.
-- nameOf() reads the ACCOUNT first and then falls back to the person's own
-- conversations; it never reads TEAM. team.full_name is the directory entry
-- HR owns - "MD. RUDRA DAS" as it appears in SAP. account.full_name is what
-- somebody asked to be called in a message panel. Pointing one at the other
-- would let a person editing their chat name rewrite the staff directory,
-- or let a directory correction silently rename them mid-conversation.
--
-- THE OTHER FIVE MISSING COLUMNS are Password Set, Sign Ins, Note and Email,
-- plus Salt - and Salt is not coming back: this port's hashes carry their own
-- salt and parameters inside the hash string, which is why there is no salt
-- column to carry. The other four belong to the Accounts screen and are
-- listed as outstanding in PORT-INVENTORY.md. They are not added here
-- because nothing reads them yet, and a column nothing reads is a column
-- nobody maintains.
-- ===========================================================================

ALTER TABLE account ADD COLUMN IF NOT EXISTS full_name text;

COMMENT ON COLUMN account.full_name IS
  'ACCOUNTS tab, column 11 (Name). What this person asked to be called in '
  'the message panel. Blank means never asked - which is what the panel '
  'treats as "ask once", not as an error. Not the same as team.full_name, '
  'which is the HR directory entry.';


-- ===========================================================================
SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_name = 'account'
 ORDER BY ordinal_position;
-- full_name should be in that list. Everything else is unchanged.
-- ===========================================================================
