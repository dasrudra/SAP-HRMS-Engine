-- ===========================================================================
-- 05-import-team.sql - your real TEAM tab, from the Google Sheet into
--                      PostgreSQL.
-- ===========================================================================
--
-- READ THE EXPORT STEPS IN THE CHAT FIRST. This file assumes you already
-- have TEAM.csv saved somewhere on your PC.
--
-- RUN IT IN FOUR PARTS, in order, each one separately (highlight, F5).
-- PART 2 is not SQL you can run from this file - it is a pgAdmin dialog.
--
--   PART 1  make the staging table
--   PART 2  load TEAM.csv into it          (pgAdmin Import dialog)
--   PART 3  look at what arrived           (before changing anything)
--   PART 4  clean it and move it into team
--
--
-- WHY A STAGING TABLE INSTEAD OF IMPORTING STRAIGHT INTO team
--
-- The CSV has sixteen columns with the sheet's own names, numbers stored as
-- text, "Yes" where a boolean belongs, stray spaces, blank rows and at least
-- one duplicate. team has rules - NOT NULL, UNIQUE, CHECK - and it is
-- supposed to reject all of that.
--
-- Import straight into team and the first bad row stops everything, with no
-- record of what else was wrong. Import into a table with NO rules at all,
-- and every row arrives; then you can LOOK at it, decide, and move the good
-- rows across in one controlled step. That is what staging means, and it is
-- how data migration is done everywhere.
--
--
-- THE CSV ITSELF HAS REAL NAMES, IDS, EMAILS AND PHONE NUMBERS IN IT.
-- Keep it out of the repository. Put it in your OLD data folder, or in a
-- folder called data\ inside the project - .gitignore blocks *.csv and
-- data\ already. Never commit it. This file is safe to commit; the CSV is
-- not.
-- ===========================================================================


-- ===========================================================================
-- PART 1 - the staging table. Run this block.
-- ===========================================================================
-- EVERY COLUMN IS text AND NOTHING IS REQUIRED. That is deliberate. Staging
-- exists to accept whatever the sheet actually contains, not to judge it.
-- The judging happens in PART 4.
--
-- The column order must match the CSV's column order exactly, because that
-- is how the importer lines them up.

DROP TABLE IF EXISTS team_import;

CREATE TABLE team_import (
  sl               text,   -- SL#
  employee_name    text,   -- Employee Name
  employee_id      text,   -- Employee ID
  designation      text,   -- Designation
  module           text,   -- Module
  department       text,   -- Department
  sub_department   text,   -- Sub-Department
  blood_group      text,   -- Blood Group
  computer_name    text,   -- Computer Name
  office_location  text,   -- Office Location
  ext              text,   -- Ext#
  cell             text,   -- WhatApp/Cell No.
  mail             text,   -- Mail Address
  head             text,   -- Head
  photo            text,   -- Photo
  note             text    -- Note
);


-- ===========================================================================
-- PART 2 - load the CSV. NOT SQL. Do this in pgAdmin:
-- ===========================================================================
--   1. Left panel: tvl_eas -> Schemas -> public -> Tables
--   2. Right-click team_import -> Import/Export Data...
--   3. Set Import/Export to  Import
--   4. Filename: browse to your TEAM.csv
--   5. Format: csv      Encoding: UTF8
--   6. Click the Options tab:  Header = ON    Delimiter = ,
--   7. OK
--
-- It should say "Import successful". Then come back here for PART 3.


-- ===========================================================================
-- PART 3 - LOOK BEFORE YOU TOUCH. Run each query separately.
-- ===========================================================================

-- 3a. How many rows arrived? Compare against the sheet with your own eyes.
SELECT count(*) AS rows_in_staging FROM team_import;


-- 3b. THE PROBLEM REPORT. This is the important one.
--     It tells you what the sheet actually contains before anything is
--     cleaned, so nothing is "fixed" behind your back.
SELECT 'blank name (row will be SKIPPED)'      AS problem,
       count(*) AS how_many
  FROM team_import WHERE coalesce(trim(employee_name), '') = ''
UNION ALL
SELECT 'no employee ID (kept, ID left empty)',
       count(*)
  FROM team_import
 WHERE coalesce(trim(employee_name), '') <> ''
   AND coalesce(trim(employee_id),   '') = ''
UNION ALL
SELECT 'ID stored as a number, e.g. 20990021.0',
       count(*)
  FROM team_import WHERE employee_id LIKE '%.0'
UNION ALL
SELECT 'duplicate employee ID (only FIRST kept)',
       count(*)
  FROM (SELECT regexp_replace(trim(employee_id), '\.0$', '') AS id
          FROM team_import
         WHERE coalesce(trim(employee_id), '') <> ''
         GROUP BY 1 HAVING count(*) > 1) d;


-- 3c. Name the duplicates, so you can fix the sheet afterwards.
SELECT regexp_replace(trim(employee_id), '\.0$', '') AS employee_id,
       string_agg(trim(employee_name), '  |  ')      AS people_sharing_it
  FROM team_import
 WHERE coalesce(trim(employee_id), '') <> ''
 GROUP BY 1
HAVING count(*) > 1;


-- 3d. Name the people with no employee ID. These are KEPT - they belong in
--     the directory - but they cannot have a login until HR issues an ID.
SELECT trim(employee_name) AS person, trim(sub_department) AS section
  FROM team_import
 WHERE coalesce(trim(employee_name), '') <> ''
   AND coalesce(trim(employee_id),   '') = '';


-- ===========================================================================
-- PART 4 - clean it and move it into team. Run this whole block at once.
-- ===========================================================================
-- Nothing here touches team_import. If the result is wrong you can empty
-- team and run PART 4 again without re-importing the CSV.

DELETE FROM team;   -- clears the six fake test people

INSERT INTO team (
  employee_id, full_name, designation, module, department, sub_department,
  blood_group, computer_name, office, extension, mobile, email,
  is_head, photo_file_id, note)
SELECT
  -- EVERY FIELD GETS trim(). Spreadsheet cells collect spaces nobody can
  -- see, and ' 20990002' never matches '20990002'.
  --
  -- regexp_replace strips a trailing '.0'. Sheets stores an employee ID as
  -- a number, and exporting it gives 20990002.0 about half the time.
  --
  -- nullif(..., '') turns an empty cell into NULL. Without it the column
  -- holds '' - and since employee_id is UNIQUE, a second empty one would be
  -- rejected as a duplicate of the first.
  nullif(regexp_replace(trim(employee_id), '\.0$', ''), ''),
  trim(employee_name),
  nullif(trim(designation),      ''),
  nullif(trim(module),           ''),
  nullif(trim(department),       ''),
  nullif(trim(sub_department),   ''),
  nullif(trim(blood_group),      ''),
  nullif(trim(computer_name),    ''),
  nullif(trim(office_location),  ''),
  nullif(trim(ext),              ''),
  nullif(trim(cell),             ''),
  nullif(trim(mail),             ''),

  -- 'Yes', 'yes', 'YES' and 'Y' all mean the same thing to a person and
  -- four different things to a computer. lower() settles it here, once,
  -- and the column is boolean from then on.
  lower(coalesce(trim(head), '')) IN ('yes', 'y', 'true', '1'),

  nullif(trim(photo), ''),
  nullif(trim(note),  '')

FROM (
  SELECT *,
         -- Numbers the rows that share an employee ID, so only the first of
         -- each set is taken. Without this the whole INSERT fails on the
         -- first duplicate and nothing at all is imported.
         row_number() OVER (
           PARTITION BY nullif(regexp_replace(trim(employee_id), '\.0$', ''), '')
           ORDER BY sl::int NULLS LAST
         ) AS dup_rank
    FROM team_import
   -- Rows with no name are dropped. A directory entry with no name is not a
   -- person, it is a leftover blank row from the bottom of the sheet.
   WHERE coalesce(trim(employee_name), '') <> ''
) ranked
-- Keep the first of each duplicated ID, and keep EVERY row that has no ID
-- at all (they are all dup_rank 1 within their own NULL partition, but the
-- condition is spelled out so the intent is readable).
WHERE dup_rank = 1
   OR nullif(regexp_replace(trim(employee_id), '\.0$', ''), '') IS NULL;


-- ===========================================================================
-- PART 5 - check it, then throw the staging table away.
-- ===========================================================================

-- 5a. How many people made it, and how many still need an employee ID.
SELECT count(*)                                        AS people,
       count(employee_id)                              AS with_id,
       count(*) - count(employee_id)                   AS without_id,
       count(*) FILTER (WHERE is_head)                 AS heads
  FROM team;

-- 5b. Eyeball the result. Does it look like your team?
SELECT employee_id, full_name, designation, sub_department, extension, is_head
  FROM team
 ORDER BY sub_department NULLS LAST, full_name;

-- 5c. Anybody whose section is blank - worth fixing in the sheet.
SELECT employee_id, full_name
  FROM team WHERE sub_department IS NULL;

-- 5d. ONLY when 5a and 5b look right:
-- DROP TABLE team_import;
--
-- Left commented on purpose. Keep staging until you are satisfied; it is
-- the only copy of exactly what the sheet said on import day, and it costs
-- nothing to keep for a week.
-- ===========================================================================
