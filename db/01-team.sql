-- ===========================================================================
-- 01-team.sql - the first real table of the new TVL-EAS database.
-- ===========================================================================
--
-- WHAT THIS IS
-- The TEAM tab of the Google Sheet, written as a proper database table. Run
-- it top to bottom in pgAdmin or psql against a database called tvl_eas.
-- Nothing here touches the live portal. This is your own machine.
--
-- HOW TO READ IT
-- Every block has a comment saying WHY it is written that way. The SQL is the
-- easy part and you will have it in a week. The reasons are the part that
-- makes the difference between a database and a spreadsheet with extra steps.
--
-- NO REAL PEOPLE ARE IN THIS FILE. Every employee ID below is inside the
-- reserved test blocks (200000xx, 2090xxxx, 2099xxxx) and every name, phone
-- number and address is invented. That rule holds for every file in this
-- repository, because the repository is public.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- STEP 1: a clean slate, so you can run this file as many times as you like.
-- ---------------------------------------------------------------------------
-- DROP ... IF EXISTS is what makes a script re-runnable. You will edit this
-- file, run it again, edit it again. A script that only works on an empty
-- database is a script you end up afraid of.

DROP TABLE IF EXISTS team;


-- ---------------------------------------------------------------------------
-- STEP 2: the table.
-- ---------------------------------------------------------------------------
CREATE TABLE team (

  -- The identity of a row. The sheet has no such thing, and that is exactly
  -- how the directory ended up with people in it twice.
  --
  -- WHY text AND NOT integer, which is the question everybody asks:
  -- an employee ID is a label, not a quantity. You will never add two of
  -- them together or take an average of them. Store it as a number and the
  -- database will happily drop a leading zero, and the day HR issues
  -- "20990021-A" the column has to be rebuilt. text costs nothing here.
  employee_id     text PRIMARY KEY,

  -- NOT NULL means the database refuses a row with no name. The sheet
  -- cannot refuse anything; Team.gs has a line that skips nameless rows
  -- because bad rows were getting in. This moves that rule to where it
  -- belongs - one place, enforced always, not in every file that reads.
  full_name       text NOT NULL,

  designation     text,
  module          text,
  department      text,
  sub_department  text,
  blood_group     text,
  computer_name   text,
  office          text,
  extension       text,
  mobile          text,
  email           text,

  -- The sheet stores the word "Yes" here, and every reader has to know that
  -- "Yes", "yes" and "YES" mean the same thing and anything else means no.
  -- boolean is true or false and there is no third answer to handle.
  is_head         boolean NOT NULL DEFAULT false,

  photo_file_id   text,
  note            text,

  -- WHY timestamptz AND NOT timestamp: timestamptz records the moment,
  -- stored in UTC, and shows it back in whatever timezone you ask for.
  -- Plain timestamp records a wall-clock reading with no idea which clock,
  -- which is a bug waiting for the first person outside Dhaka to read it.
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- NOTE ON WHAT IS NOT HERE
-- The sheet's "SL#" column is gone. Row order is not information - it is an
-- artefact of how the rows were pasted. Ask the database for people in any
-- order you like with ORDER BY; do not store the order.


-- ---------------------------------------------------------------------------
-- STEP 3: fake people, so there is something to query.
-- ---------------------------------------------------------------------------
INSERT INTO team
  (employee_id, full_name, designation, module, department, sub_department,
   blood_group, office, extension, mobile, email, is_head)
VALUES
  ('20990001', 'Test Lead One',   'Senior Manager',  'MM',    'EAS', 'Supply Chain Applications', 'A+',  'TVL HQ', '9001', '01700000001', 'lead.one@example.test',  true),
  ('20990002', 'Test Person Two', 'Senior Officer',  'SD',    'EAS', 'Supply Chain Applications', 'B+',  'TVL HQ', '9002', '01700000002', 'person.two@example.test', false),
  ('20990003', 'Test Person Three', 'Officer',      'FI',    'EAS', 'Finance Applications',      'O+',  'YCL',    '9003', '01700000003', 'person.three@example.test', false),
  ('20990004', 'Test Person Four', 'Officer',        'ABAP',  'EAS', 'Development',               'AB+', 'TVL HQ', '9004', '01700000004', 'person.four@example.test', false),
  ('20990005', 'Test Lead Five',  'Manager',         'ABAP',  'EAS', 'Development',               'A-',  'TVL HQ', '9005', '01700000005', 'lead.five@example.test',  true),
  ('20900011', 'Test Person Six', 'Junior Officer',  'BASIS', 'EAS', 'Infrastructure',            'O-',  'YCL',    '9006', '01700000006', 'person.six@example.test', false);


-- ===========================================================================
-- STEP 4: your first queries. Run them one at a time.
-- ===========================================================================
-- In pgAdmin: select the lines of ONE query, then press F5.
-- In psql: paste one query, ending with the semicolon, then Enter.


-- 4a. Everything. The equivalent of looking at the tab.
SELECT * FROM team;


-- 4b. Only the columns you want, only the rows you want.
-- This is the sheet's filter, except it is written down and repeatable.
SELECT full_name, designation, extension
FROM   team
WHERE  module = 'ABAP';


-- 4c. In an order you choose, decided when you ask, not when you pasted.
SELECT full_name, module, office
FROM   team
ORDER BY module, full_name;


-- 4d. Counting. THIS IS THE ONE WORTH LOOKING AT TWICE.
-- Your portal works out "how many people per section" in JavaScript today:
-- read every row out of the sheet, loop over them, add up. That is Apps
-- Script doing arithmetic the database does in one line, and it is a large
-- part of why the EAS Team page takes seconds.
SELECT sub_department,
       COUNT(*)                        AS people,
       COUNT(*) FILTER (WHERE is_head) AS heads
FROM   team
GROUP BY sub_department
ORDER BY people DESC;


-- 4e. The check a spreadsheet cannot do for you: who is missing an extension.
-- Data quality as a query instead of as a person scrolling.
SELECT employee_id, full_name
FROM   team
WHERE  extension IS NULL OR extension = '';


-- 4f. Section leads, by name.
SELECT full_name, designation, sub_department
FROM   team
WHERE  is_head
ORDER BY sub_department;


-- ===========================================================================
-- STEP 5: the point of all of it.
-- ===========================================================================
-- Run this. It will FAIL, and the error is the entire reason for moving off
-- the sheet.
--
--   ERROR:  duplicate key value violates unique constraint "team_pkey"
--
-- The database will not let the same employee ID in twice. Not "warns you",
-- not "highlights it red" - refuses. Nobody can paste a duplicate into it at
-- 11pm and leave you to find out from the directory page a week later.
--
-- A spreadsheet has no opinion about what is valid. A database does, and you
-- write that opinion once.

INSERT INTO team (employee_id, full_name)
VALUES ('20990001', 'Somebody Pasted This Twice');


-- And this fails too, for the other reason - no name:
--   ERROR:  null value in column "full_name" violates not-null constraint

INSERT INTO team (employee_id)
VALUES ('20990099');


-- ===========================================================================
-- WHAT YOU HAVE LEARNED, IF THE ABOVE ALL RAN
-- ===========================================================================
--   CREATE TABLE      defining what a row is allowed to be
--   PRIMARY KEY       identity, and refusing duplicates
--   NOT NULL          refusing incomplete rows
--   INSERT            putting data in
--   SELECT / WHERE    asking for some of it
--   ORDER BY          asking for it in an order
--   COUNT / GROUP BY  asking a question instead of looping in JavaScript
--
-- That is most of the SQL you need for this whole project. The rest is
-- joins, which is the next file.
-- ===========================================================================
