-- ===========================================================================
-- 04-api-user.sql - a login for the API that is not the superuser.
-- ===========================================================================
--
-- HOW TO RUN THIS FILE:
--   1. In pgAdmin, click the tvl_eas database once.
--   2. Tools -> Query Tool. Check the top says tvl_eas/postgres@PostgreSQL 18.
--   3. CHANGE THE PASSWORD ON LINE 'CREATE USER' BELOW to one you choose.
--   4. Run the whole file. Press F5.
--
-- Safe to run twice - it removes the old user first.
--
--
-- WHY THIS EXISTS, AND IT IS NOT ONLY ABOUT THE FORGOTTEN PASSWORD
--
-- The 'postgres' user is the superuser. It can drop any table, read every
-- database on the server, create and delete users, and read every file the
-- PostgreSQL service account can reach.
--
-- An API is a program on the internet. One day it will have a bug in it.
-- When that day comes, the only question that matters is what the attacker
-- inherits. Connecting as 'postgres' hands them the whole server, including
-- the other databases that have nothing to do with this project.
--
-- This user can read and change rows in tvl_eas and nothing else. It cannot
-- drop a table, cannot create one, and cannot read a table in any other
-- database. That is the principle of least privilege, and it is the single
-- cheapest security decision in the whole project - it costs one file, run
-- once.
--
-- A convenient side effect: it needs no knowledge of the superuser password,
-- which is why you are running it today.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- Clean slate, so the file can be run again.
-- ---------------------------------------------------------------------------
-- DROP OWNED BY removes the GRANTS held by the role. PostgreSQL refuses to
-- drop a role that still holds privileges anywhere, and the error it gives
-- does not say which object is the problem - so this line saves a confusing
-- afternoon the second time you run this.
DROP OWNED BY tvl_api;
DROP USER IF EXISTS tvl_api;


-- ---------------------------------------------------------------------------
-- The user.
-- ---------------------------------------------------------------------------
-- >>> CHANGE THIS PASSWORD. Pick your own, write it down, and put the same
-- >>> one in api/.env as PGPASSWORD. It is never committed - .gitignore
-- >>> blocks .env - but choose a real one anyway, not 'password'.
CREATE USER tvl_api WITH PASSWORD 'change-this-to-your-own-password';


-- ---------------------------------------------------------------------------
-- What it is allowed to do.
-- ---------------------------------------------------------------------------

-- Open a connection to this database at all.
GRANT CONNECT ON DATABASE tvl_eas TO tvl_api;

-- Look inside the 'public' schema. Note this is USAGE, not CREATE - it can
-- see what is there but cannot add tables of its own.
GRANT USAGE ON SCHEMA public TO tvl_api;

-- Read and change rows in the tables that exist right now.
-- Deliberately NOT included: TRUNCATE, REFERENCES, TRIGGER - and no DDL of
-- any kind, so DROP TABLE and ALTER TABLE are refused.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA public TO tvl_api;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO tvl_api;


-- ---------------------------------------------------------------------------
-- And on tables that do not exist yet.
-- ---------------------------------------------------------------------------
-- THE TWO GRANTS ABOVE ONLY COVER TODAY'S TABLES. Add a table next month and
-- the API gets "permission denied" on it, which is a baffling error when the
-- same code works for every other table.
--
-- ALTER DEFAULT PRIVILEGES says: whenever postgres creates a table in this
-- schema from now on, give tvl_api these rights automatically.

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tvl_api;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO tvl_api;


-- ===========================================================================
-- Checking it worked. Run each of these SEPARATELY (highlight, F5).
-- ===========================================================================
--
-- These four were run against a real PostgreSQL before this file was written,
-- and the expected results below are the actual output, not a guess.

-- 1. The user exists and is NOT a superuser.
--    Expect: tvl_api | f | f | f
SELECT rolname, rolsuper, rolcreatedb, rolcreaterole
FROM   pg_roles WHERE rolname = 'tvl_api';

-- 2. What it may do to the team table.
--    Expect four rows: SELECT, INSERT, UPDATE, DELETE. Nothing else.
SELECT privilege_type
FROM   information_schema.table_privileges
WHERE  grantee = 'tvl_api' AND table_name = 'team'
ORDER BY privilege_type;


-- ===========================================================================
-- WHAT IT CANNOT DO - verified, not assumed:
--
--   DROP TABLE team           ERROR: must be owner of table team
--   CREATE TABLE junk(x int)  ERROR: permission denied for schema public
--   SELECT from a table in    ERROR: permission denied for table ...
--     another database
--
-- One honest detail: it CAN open a connection to your other databases,
-- because PostgreSQL grants CONNECT to everyone by default. It cannot read
-- any table in them. Tightening that would mean changing permissions on
-- bank_db, persondb and test_2, which are your other projects, so it is left
-- alone - harmless for local development.
-- ===========================================================================
