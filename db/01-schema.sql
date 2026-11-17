-- ===========================================================================
-- 01-schema.sql - the real TVL-EAS schema. Core three tables.
-- ===========================================================================
--
-- Run against a database called tvl_eas. Re-runnable: it drops first.
--
-- You know SQL already, so the comments here are about DESIGN, not syntax -
-- why the tables are split this way, and which rules the database enforces
-- that the Google Sheet never could.
--
-- NO REAL PEOPLE. Every employee ID is inside the reserved test blocks
-- (200000xx, 2090xxxx, 2099xxxx). This repository is public.
-- ===========================================================================

DROP TABLE IF EXISTS presence;
DROP TABLE IF EXISTS account;
DROP TABLE IF EXISTS team;
-- Dropped children first. Once foreign keys exist, the order matters.


-- ---------------------------------------------------------------------------
-- team - the directory. One row per person.
-- ---------------------------------------------------------------------------
CREATE TABLE team (
  employee_id     text PRIMARY KEY,
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
  is_head         boolean NOT NULL DEFAULT false,
  photo_file_id   text,
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- WHY employee_id IS text AND NOT integer, since your employees table used
-- integer: an employee ID is a label, not a quantity. You will never add two
-- together or average them. As integer, a leading zero is silently lost, and
-- the day HR issues "20990021-A" the column has to be rebuilt and every
-- foreign key with it. text costs nothing and never has that problem.
--
-- WHY timestamptz AND NOT timestamp: timestamptz stores the moment in UTC and
-- renders it in whatever timezone you ask for. Plain timestamp stores a
-- wall-clock reading with no record of which clock - fine until the first
-- person reads it from outside Dhaka.
--
-- The sheet's "SL#" column is deliberately absent. Row order is an artefact
-- of how rows were pasted, not information. Use ORDER BY.


-- ---------------------------------------------------------------------------
-- account - who can sign in. Separate from team ON PURPOSE.
-- ---------------------------------------------------------------------------
CREATE TABLE account (
  employee_id     text PRIMARY KEY
                    REFERENCES team(employee_id) ON DELETE CASCADE,
  password_hash   text NOT NULL,
  role            text NOT NULL DEFAULT 'USER'
                    CHECK (role IN ('USER', 'ADMIN')),
  must_change     boolean NOT NULL DEFAULT true,
  last_login_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- WHY NOT just add password_hash as a column on team:
--
--   1. Not everyone in the directory has a login. A column would force a
--      NULL password on most rows, and "NULL means no account" is a rule
--      living in your head instead of in the database.
--   2. A password hash needs different handling from a phone number. One
--      day you will want the API to read the directory without the
--      credentials coming anywhere near it. Separate tables make that a
--      permission; one table makes it a promise.
--   3. You can empty and rebuild every account without touching the
--      directory.
--
-- REFERENCES team(employee_id) is the line that matters. The database will
-- now REFUSE an account for somebody who is not in the directory. Apps
-- Script cannot do this at any price - it checks in code, in one place,
-- and only while somebody remembers to call the checker.
--
-- ON DELETE CASCADE: remove a person and their account goes with them. No
-- orphan logins left behind for somebody who left the company.
--
-- CHECK (role IN ...) stops 'Admn', 'admin', 'Administrator' and every other
-- near-miss a human can type.


-- ---------------------------------------------------------------------------
-- presence - who is at their desk.
-- ---------------------------------------------------------------------------
CREATE TABLE presence (
  employee_id     text PRIMARY KEY
                    REFERENCES team(employee_id) ON DELETE CASCADE,
  state           text NOT NULL CHECK (state IN ('ACTIVE', 'AWAY')),
  seen_at         timestamptz NOT NULL DEFAULT now()
);

-- NOTE THERE IS NO 'OFFLINE' STATE, and this is the good part.
--
-- Offline is not something a browser can report - a laptop that is shut does
-- not send anything. So offline is not stored; it is DERIVED: a row whose
-- seen_at has gone stale. Your current code already thinks this way (it has
-- a freshness window), but on Apps Script it is spread across the client,
-- the cache and the server. Here it is one CASE expression, below.
--
-- An index on seen_at is NOT added yet. With 36 people the planner will scan
-- the table and be right to. Add indexes when a real query is measurably
-- slow, not in advance - an unused index is write cost for nothing.


-- ===========================================================================
-- Fake data
-- ===========================================================================
INSERT INTO team
  (employee_id, full_name, designation, module, department, sub_department,
   blood_group, office, extension, mobile, email, is_head)
VALUES
  ('20990001', 'Test Lead One',     'Senior Manager', 'MM',    'EAS', 'Supply Chain Applications', 'A+',  'TVL HQ', '9001', '01700000001', 'one@example.test',   true),
  ('20990002', 'Test Person Two',   'Senior Officer', 'SD',    'EAS', 'Supply Chain Applications', 'B+',  'TVL HQ', '9002', '01700000002', 'two@example.test',   false),
  ('20990003', 'Test Person Three', 'Officer',        'FI',    'EAS', 'Finance Applications',      'O+',  'YCL',    '9003', '01700000003', 'three@example.test', false),
  ('20990004', 'Test Person Four',  'Officer',        'ABAP',  'EAS', 'Development',               'AB+', 'TVL HQ', '9004', '01700000004', 'four@example.test',  false),
  ('20990005', 'Test Lead Five',    'Manager',        'ABAP',  'EAS', 'Development',               'A-',  'TVL HQ', '9005', '01700000005', 'five@example.test',  true),
  ('20900011', 'Test Person Six',   'Junior Officer', 'BASIS', 'EAS', 'Infrastructure',            'O-',  'YCL',    '9006', '01700000006', 'six@example.test',   false);

-- Only three of the six have logins. That is the normal case, and it is why
-- the next query needs a LEFT JOIN rather than a plain one.
INSERT INTO account (employee_id, password_hash, role, must_change) VALUES
  ('20990001', 'argon2id$placeholder$not-a-real-hash', 'ADMIN', false),
  ('20990002', 'argon2id$placeholder$not-a-real-hash', 'USER',  false),
  ('20990004', 'argon2id$placeholder$not-a-real-hash', 'USER',  true);

-- Two people beat recently, one beat an hour ago.
INSERT INTO presence (employee_id, state, seen_at) VALUES
  ('20990001', 'ACTIVE', now()),
  ('20990002', 'AWAY',   now() - interval '2 minutes'),
  ('20990004', 'ACTIVE', now() - interval '1 hour');


-- ===========================================================================
-- THE QUERY. This is the one to study.
-- ===========================================================================
-- Your EAS Team page today does roughly this:
--
--   1. ask Apps Script for the directory      (reads the whole TEAM tab)
--   2. ask Apps Script for presence           (second round trip)
--   3. join the two in JavaScript in the browser
--   4. work out who is stale, in JavaScript
--
-- Four steps, two network round trips, and the join logic duplicated between
-- the server and the browser - which is precisely where the bug came from
-- where you showed ACTIVE on the server and grey on your own screen.
--
-- Here it is as one statement. The database does the join, and staleness is
-- decided in exactly one place:

SELECT t.employee_id,
       t.full_name,
       t.sub_department,
       t.extension,
       t.is_head,
       COALESCE(a.role, '-')              AS role,
       CASE
         WHEN p.seen_at IS NULL                          THEN 'OFFLINE'
         WHEN p.seen_at > now() - interval '8 minutes'   THEN p.state
         ELSE                                                 'OFFLINE'
       END                                AS presence
FROM       team     t
LEFT JOIN  account  a ON a.employee_id = t.employee_id
LEFT JOIN  presence p ON p.employee_id = t.employee_id
ORDER BY   t.sub_department, t.full_name;

-- WHY LEFT JOIN AND NOT JOIN: a plain JOIN returns only rows that match on
-- BOTH sides, so the three people with no account would vanish from your
-- directory. LEFT JOIN keeps every row of team and fills NULL where there is
-- no match. Getting this wrong is the single most common SQL bug there is,
-- and it is silent - the page just quietly shows fewer people.
--
-- COALESCE(a.role, '-') turns that NULL into something printable.
--
-- Expected: six rows. Lead One ACTIVE, Person Two AWAY, Person Four OFFLINE
-- (beat an hour ago, outside the window), the other three OFFLINE.


-- ---------------------------------------------------------------------------
-- Counting, which your portal does in JavaScript today
-- ---------------------------------------------------------------------------
SELECT t.sub_department,
       COUNT(*)                                        AS people,
       COUNT(a.employee_id)                            AS with_login,
       COUNT(*) FILTER (WHERE t.is_head)               AS heads
FROM       team    t
LEFT JOIN  account a ON a.employee_id = t.employee_id
GROUP BY   t.sub_department
ORDER BY   people DESC;

-- COUNT(*) counts rows. COUNT(a.employee_id) counts rows where that column
-- is NOT NULL. That difference is how you count matches inside a LEFT JOIN,
-- and it is worth remembering.


-- ===========================================================================
-- The two rules the database enforces. Both of these FAIL on purpose.
-- ===========================================================================

-- 1. An account for somebody who is not in the directory.
--    ERROR: insert or update on table "account" violates foreign key
--           constraint "account_employee_id_fkey"
INSERT INTO account (employee_id, password_hash)
VALUES ('20991234', 'argon2id$placeholder$not-a-real-hash');

-- 2. A role somebody typed by hand.
--    ERROR: new row for relation "account" violates check constraint
--           "account_role_check"
INSERT INTO account (employee_id, password_hash, role)
VALUES ('20990003', 'argon2id$placeholder$not-a-real-hash', 'Admn');

-- Neither of these is a warning. Neither depends on anybody remembering to
-- call a validator. That is the whole argument for this move, in two
-- statements.
-- ===========================================================================
