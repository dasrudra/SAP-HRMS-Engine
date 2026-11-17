-- ===========================================================================
-- 02-queries.sql - asking the database questions.
-- ===========================================================================
--
-- HOW TO RUN THIS FILE: ONE QUERY AT A TIME, not all at once.
--
--   1. Click and drag to select the lines of ONE query, from its first word
--      down to its semicolon.
--   2. Press F5.
--
-- pgAdmin runs whatever you have selected. If nothing is selected it runs
-- the whole file and you only get the results of the last query, which
-- teaches you nothing.
--
-- Run 01-schema.sql first, or there will be no tables to ask about.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- QUERY 1. Everything in the directory.
-- ---------------------------------------------------------------------------
-- The equivalent of looking at the TEAM tab. Expect 6 rows.

SELECT * FROM team;


-- ---------------------------------------------------------------------------
-- QUERY 2. Some columns, some rows.
-- ---------------------------------------------------------------------------
-- This is the sheet's filter, except written down and repeatable.
-- Expect 2 rows - the two ABAP people.

SELECT full_name, designation, extension
FROM   team
WHERE  module = 'ABAP';


-- ---------------------------------------------------------------------------
-- QUERY 3. In an order you choose.
-- ---------------------------------------------------------------------------
-- The order is decided when you ASK, not when the rows were pasted.

SELECT full_name, module, office
FROM   team
ORDER BY module, full_name;


-- ===========================================================================
-- QUERY 4. THE IMPORTANT ONE. Read the notes under it.
-- ===========================================================================
--
-- WHAT YOUR EAS TEAM PAGE DOES TODAY:
--
--   step 1  ask Apps Script for the directory      (reads the whole TEAM tab)
--   step 2  ask Apps Script for presence           (a second round trip)
--   step 3  join the two lists together in JavaScript, in the browser
--   step 4  work out who has gone stale, also in JavaScript, in the browser
--
-- Four steps. Two network round trips. And the join logic written twice -
-- once on the server and once in the browser. That duplication is EXACTLY
-- where your bug came from: the server said you were ACTIVE and your own
-- screen showed you grey.
--
-- Here is all four steps as one statement. The database does the join, and
-- "stale" is decided in exactly one place.

SELECT t.employee_id,
       t.full_name,
       t.sub_department,
       t.extension,
       t.is_head,
       COALESCE(a.role, '-')              AS role,
       CASE
         WHEN p.seen_at IS NULL                        THEN 'OFFLINE'
         WHEN p.seen_at > now() - interval '8 minutes' THEN p.state
         ELSE                                               'OFFLINE'
       END                                AS presence
FROM       team     t
LEFT JOIN  account  a ON a.employee_id = t.employee_id
LEFT JOIN  presence p ON p.employee_id = t.employee_id
ORDER BY   t.sub_department, t.full_name;

-- WHAT YOU SHOULD SEE: six rows.
--
--   Test Lead One      ADMIN   ACTIVE     (beat just now)
--   Test Person Two    USER    AWAY       (beat 2 minutes ago)
--   Test Person Four   USER    OFFLINE    (beat an HOUR ago - too stale)
--   the other three    -       OFFLINE    (never beat at all)
--
-- If Person Four shows ACTIVE, the CASE is wrong. If you get fewer than six
-- rows, read the next note.
--
--
-- WHY LEFT JOIN AND NOT PLAIN JOIN - the most important thing in this file:
--
--   JOIN      returns only rows that match on BOTH sides.
--   LEFT JOIN keeps every row of the left table (team) and fills in NULL
--             where the right table has no match.
--
-- Only three people have an account and only three have ever sent a
-- heartbeat. Write plain JOIN here and the other three VANISH from your
-- directory - your page quietly shows fewer people and nothing reports an
-- error. This is the most common SQL bug there is and it is silent.
--
-- Try it: change both LEFT JOINs to plain JOINs, run it, and count the rows.
-- Then change them back. Seeing it happen once is worth more than the
-- paragraph above.
--
--
-- COALESCE(a.role, '-') means: use a.role, but if it is NULL use '-'
-- instead. The three people with no account have a NULL role, and NULL is
-- not something you want to print on a page.
--
--
-- THE t, a AND p: those are table aliases. "FROM team t" means "call it t
-- from here on". It saves writing team.employee_id every time. Purely for
-- readability - the query means the same without them.


-- ---------------------------------------------------------------------------
-- QUERY 5. Counting - which your portal does in JavaScript today.
-- ---------------------------------------------------------------------------
-- Your code currently reads every row out of the sheet, loops over them in
-- JavaScript and adds up. That is Apps Script doing arithmetic that the
-- database does in one line, and it is part of why the page is slow.

SELECT t.sub_department,
       COUNT(*)                          AS people,
       COUNT(a.employee_id)              AS with_login,
       COUNT(*) FILTER (WHERE t.is_head) AS heads
FROM       team    t
LEFT JOIN  account a ON a.employee_id = t.employee_id
GROUP BY   t.sub_department
ORDER BY   people DESC;

-- WORTH REMEMBERING:
--   COUNT(*)              counts rows.
--   COUNT(some_column)    counts rows where that column is NOT NULL.
--
-- That difference is how you count the matches inside a LEFT JOIN. Here,
-- "people" counts everyone and "with_login" counts only those who matched
-- an account row.
--
-- COUNT(*) FILTER (WHERE ...) counts only the rows meeting a condition.
-- It is a PostgreSQL feature and it is very useful.


-- ---------------------------------------------------------------------------
-- QUERY 6. A data-quality check, as a query instead of a person scrolling.
-- ---------------------------------------------------------------------------
-- Who is missing an extension number? On the sheet you find this by looking.
-- Here you ask.

SELECT employee_id, full_name, sub_department
FROM   team
WHERE  extension IS NULL OR extension = '';

-- Expect zero rows with the fake data - everybody has one. Good: an empty
-- result is a passing check. Try blanking one out and running it again:
--
--   UPDATE team SET extension = '' WHERE employee_id = '20990003';
--
-- NOTE: you must write "IS NULL", never "= NULL". In SQL, NULL is not equal
-- to anything, including itself. "extension = NULL" is never true and
-- returns nothing, silently. This catches everybody once.


-- ===========================================================================
-- Next: 03-what-a-sheet-cannot-do.sql
-- ===========================================================================
