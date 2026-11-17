-- ===========================================================================
-- 03-what-a-sheet-cannot-do.sql
-- ===========================================================================
--
-- EVERY STATEMENT IN THIS FILE IS SUPPOSED TO FAIL.
-- A red error message here is the file working correctly.
--
-- HOW TO RUN IT: ONE STATEMENT AT A TIME.
--   Select the lines of one statement, press F5, read the error, move on.
--
-- WHY ONE AT A TIME, AND THIS MATTERS:
-- When you send pgAdmin several statements together it wraps them in a
-- single transaction. If any one of them fails, PostgreSQL throws away
-- EVERYTHING in that batch - including the ones that already worked. Run
-- this whole file at once and you will get one error and no idea which
-- statement caused it.
--
-- That is also why the failures live in their own file instead of at the
-- bottom of 01-schema.sql: there, one deliberate error would have rolled
-- back your tables and left you with an empty database.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. An account for somebody who does not exist.
-- ---------------------------------------------------------------------------
-- 20991234 is not in the team table. The foreign key refuses it.
--
-- EXPECTED ERROR:
--   insert or update on table "account" violates foreign key constraint
--   "account_employee_id_fkey"

INSERT INTO account (employee_id, password_hash)
VALUES ('20991234', 'placeholder-not-a-real-hash');

-- Think about what this prevents. Somebody creates a login for an employee
-- ID with a typo in it. On the sheet that login exists for ever, belongs to
-- nobody, and will never be found. Here it cannot be created at all.


-- ---------------------------------------------------------------------------
-- 2. A role somebody typed by hand.
-- ---------------------------------------------------------------------------
-- 'Admn' is a typo for 'ADMIN'. The CHECK constraint refuses it.
--
-- EXPECTED ERROR:
--   new row for relation "account" violates check constraint
--   "account_role_check"

INSERT INTO account (employee_id, password_hash, role)
VALUES ('20990003', 'placeholder-not-a-real-hash', 'Admn');

-- On the sheet this row would sit there looking fine. The code would read
-- 'Admn', not recognise it, and treat that person as an ordinary user - or,
-- depending on how the check was written, as an admin. Either way nobody
-- finds out until it matters.


-- ---------------------------------------------------------------------------
-- 3. The same person twice.
-- ---------------------------------------------------------------------------
-- 20990001 is already in team. The primary key refuses the second one.
--
-- EXPECTED ERROR:
--   duplicate key value violates unique constraint "team_pkey"

INSERT INTO team (employee_id, full_name)
VALUES ('20990001', 'Somebody Pasted This Twice');

-- This is how your directory grew duplicates. A paste that overlapped by a
-- few rows, and nothing anywhere to object.


-- ---------------------------------------------------------------------------
-- 4. A person with no name.
-- ---------------------------------------------------------------------------
-- EXPECTED ERROR:
--   null value in column "full_name" of relation "team" violates not-null
--   constraint

INSERT INTO team (employee_id)
VALUES ('20990077');

-- Team.gs has a line in it that skips rows with no name, because nameless
-- rows were getting into the sheet. That line is a workaround for a problem
-- the database simply does not allow to happen.


-- ---------------------------------------------------------------------------
-- 5. Deleting somebody who still has a login - and what DOES happen.
-- ---------------------------------------------------------------------------
-- This one does NOT fail. Run it and then look at what it did.

DELETE FROM team WHERE employee_id = '20990002';

-- Now run this. Person Two's account is gone too, without you asking:
--
--   SELECT * FROM account;
--
-- That is ON DELETE CASCADE doing its job. The alternative - a login left
-- behind for a person who no longer exists - is a security problem, and on
-- a spreadsheet it is the normal outcome of somebody leaving the company.
--
-- Put the test data back by running 01-schema.sql again.


-- ===========================================================================
-- THE POINT OF THIS FILE
-- ===========================================================================
-- None of the five rules above is enforced by a person remembering.
-- None of them can be switched off by a tired edit at 11pm.
-- None of them needs a single line of JavaScript.
--
-- You wrote them once, in CREATE TABLE, and they hold for ever - for your
-- code, for the next developer's code, and for anybody typing SQL by hand.
--
-- That is the argument for this whole move, and it is worth more than the
-- speed. The speed is just the part your director will notice first.
-- ===========================================================================
