-- ===========================================================================
-- 14-backup.sql - the record of what has been backed up.
-- ===========================================================================
--
-- WHY A TABLE AND NOT A LOG FILE
--
-- Backup.gs in the Apps Script system keeps two facts in Script Properties:
-- when the last copy finished, and what it was called. The Summary screen
-- reads them through backupHealth() and says "last backup: 2am today" or
-- starts complaining. Script Properties have no equivalent here, so the two
-- facts need somewhere to live, and the API already has a place that every
-- screen can read from.
--
-- One row per run, rather than overwriting a single row, because the two
-- questions people actually ask are "did it run last night" and "has it been
-- running all month", and the second one needs history. One row a day is
-- about 365 a year; this table will still be measured in kilobytes when the
-- ticket table is measured in hundreds of megabytes.
--
-- WHAT IT IS NOT
--
-- IT IS NOT THE BACKUP. The backup is a .dump file written by pg_dump to
-- somewhere that is not this machine. This table only records that one was
-- made. If the disk dies, this table dies with everything else - which is
-- exactly why the thing it describes has to be kept elsewhere.
--
-- A row is written AFTER the dump has been taken and checked, so a row in
-- here with ok = true means a file existed and pg_restore could read its
-- table of contents. A row with ok = false means the attempt was made and
-- failed, and that is worth keeping: a Summary screen that says "last
-- backup failed" is doing its job.
--
-- PERMISSIONS
--
-- None are granted here. 04-api-user.sql ran ALTER DEFAULT PRIVILEGES, so
-- any table postgres creates in schema public already arrives with SELECT,
-- INSERT, UPDATE, DELETE for tvl_api, and sequences with USAGE, SELECT. The
-- other table files since 06 have relied on the same thing. If a query here
-- ever says "permission denied", that default is what to go and look at.
-- ===========================================================================


CREATE TABLE IF NOT EXISTS backup_run (
  id           bigserial     PRIMARY KEY,

  -- When pg_dump was started and when the whole run finished. Two columns
  -- and not one: the gap between them is how long a backup takes, and that
  -- number is the one that decides whether a nightly job is still nightly
  -- a year from now.
  started_at   timestamptz   NOT NULL DEFAULT now(),
  finished_at  timestamptz,

  -- The file name only, never a full path. A path is a fact about one
  -- machine, and this row outlives machines - it gets restored onto the next
  -- one. The folder is configuration; see BACKUP_DIR in api/.env.
  file_name    text          NOT NULL DEFAULT '',

  -- Size of the finished file. A dump that is suddenly a tenth of the size
  -- it was yesterday is the single clearest sign that something is wrong,
  -- and nobody will notice unless the number is written down.
  bytes        bigint        NOT NULL DEFAULT 0,

  -- How many tables pg_restore could see in the finished file, and how many
  -- rows were in the database when the dump started. Together they are the
  -- cheap sanity check: 15 tables yesterday and 3 today means something
  -- dropped twelve tables and the backup faithfully recorded the damage.
  tables       integer       NOT NULL DEFAULT 0,
  rows_total   bigint        NOT NULL DEFAULT 0,

  -- Row count per table at the moment of the dump, as {"ticket": 26414}.
  -- jsonb and not a second table because nothing ever joins against it -
  -- it is read back whole, by a person, on the day they are comparing a
  -- restored database against what it should contain.
  counts       jsonb         NOT NULL DEFAULT '{}'::jsonb,

  -- How many .dump files were left in the folder after pruning. Same
  -- meaning as the return value of pruneBackups() in Backup.gs.
  kept         integer       NOT NULL DEFAULT 0,

  ok           boolean       NOT NULL DEFAULT false,

  -- Empty when ok. The failure in one sentence when not - which is read by
  -- a person at 9am, so it says what went wrong and not a stack trace.
  message      text          NOT NULL DEFAULT ''
);


-- Every question asked of this table is "the most recent ones", so the
-- index is on started_at descending. backupHealth() reads exactly one row
-- through it.
CREATE INDEX IF NOT EXISTS backup_run_started_idx
  ON backup_run (started_at DESC);


-- ===========================================================================
-- WHAT THIS FILE DELIBERATELY DOES NOT DO
-- ===========================================================================
--
-- It does not keep a copy of the dump inside the database. PostgreSQL would
-- let you - a bytea column holds a gigabyte - and it would be worthless: a
-- backup stored inside the thing it is a backup of is lost at exactly the
-- moment it is needed.
--
-- It does not prune itself. One row a day is nothing, and the day somebody
-- is working out when backups stopped, a year of history is the only thing
-- that answers it. If it ever does need pruning, the rule belongs beside
-- CONFIG.AUTH_LOG_DAYS and not here.
-- ===========================================================================
