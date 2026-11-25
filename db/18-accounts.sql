-- ===========================================================================
-- 18-accounts.sql - the four columns the Accounts screen needs, and the log.
-- ===========================================================================
--
-- The ACCOUNTS tab in the spreadsheet has twelve columns and `account` has
-- carried seven of them. The missing four were left out on purpose, and
-- PORT-INVENTORY.md says why: "a column nothing reads is a column nobody
-- maintains." The Accounts screen reads all four, so they arrive now.
--
-- Salt is the fifth missing column and it is not coming. The scrypt hash in
-- password_hash carries its own salt and its own cost parameters inside the
-- string, so there is nothing left to keep in a column of its own. Auth.gs
-- needed one because its hashOf() took the salt as a separate argument.
--
-- AUTH_LOG is the second half of this file: every sign-in, every role
-- change, every reset, with no foreign key to the accounts it talks about.
-- That is deliberate and the reason is below.
--
-- PERMISSIONS: none granted here. See the note in 14-backup.sql - the
-- ALTER DEFAULT PRIVILEGES in 04-api-user.sql already covers anything
-- postgres creates in schema public.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- The four columns
-- ---------------------------------------------------------------------------
--
-- ADD COLUMN IF NOT EXISTS only ever adds. Like 09-account-name.sql, this
-- file can be run against a live database with everybody's accounts in it
-- and the worst it can do is nothing.

/*
  WHEN THE PASSWORD WAS LAST SET, which is not the same question as when the
  account was created and not the same as when they last signed in.

  It is what tells "has never had a password of their own" apart from "chose
  one eighteen months ago", and those two people need different things said
  to them. NULL means never - an ID written down by a master before its
  owner has ever arrived.
*/
ALTER TABLE account ADD COLUMN IF NOT EXISTS password_set timestamptz;

/*
  HOW MANY TIMES THEY HAVE SIGNED IN.

  Not a vanity figure. An account created nine months ago with sign_ins at 0
  is a login nobody is using, and the Accounts screen is where somebody
  decides whether to remove it. last_login_at alone cannot tell you that -
  it says when, never how often, so one curious sign-in in March looks
  exactly like daily use.
*/
ALTER TABLE account ADD COLUMN IF NOT EXISTS sign_ins integer NOT NULL DEFAULT 0;

/*
  WHY THIS ACCOUNT EXISTS, in the words of whoever made it.

  Written by the system rather than typed: "added by 20990001 before they
  signed up". The one thing that is genuinely hard to reconstruct later is
  why an employee ID nobody recognises has admin on it, and this is where
  that answer lives.
*/
ALTER TABLE account ADD COLUMN IF NOT EXISTS note text NOT NULL DEFAULT '';

/*
  WHERE THIS PERSON'S ALERTS GO.

  Not their company address, which is a fact about the organisation and
  belongs in `team`. This is where a new query is emailed, and only ADMIN
  and MASTER accounts are written to - so an address on a viewer is stored
  and quietly unused. The screen says which, rather than leaving somebody
  waiting for emails that were never going to come.

  NOT NULL DEFAULT '' rather than nullable: there is no useful difference
  between "no address" and "an address that is nothing", and one of the two
  always ends up being the one a query forgets to handle.
*/
ALTER TABLE account ADD COLUMN IF NOT EXISTS email text NOT NULL DEFAULT '';


-- ---------------------------------------------------------------------------
-- The sign-in log
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS auth_log (
  id          bigserial    PRIMARY KEY,

  at          timestamptz  NOT NULL DEFAULT now(),

  /*
    WHO THIS ROW IS ABOUT, and NOT a foreign key to account.employee_id.

    Three reasons, any one of which is enough:

      a REMOVED row is written about an account that no longer exists, so a
        foreign key would refuse the one row most worth keeping;
      a row can be about nobody in particular - '-' for a system event;
      an account can be deleted and the same employee ID enrolled again
        later, and the rows from before belong to the first one.

    The log is evidence. Evidence that disappears when the thing it is
    evidence about disappears is not evidence.
  */
  employee_id text         NOT NULL DEFAULT '',

  /*
    SIGNIN, SIGNUP, ROLE, RESET, PASSWORD, REMOVED, INVITED, DETAILS.

    Stored as the bare word rather than a sentence, and turned into English
    by the screen. A sentence stored here would be a sentence written in
    2026 that nobody can reword in 2028 without rewriting history.
  */
  event       text         NOT NULL DEFAULT '',

  -- The role at the time, which is the half of a ROLE row that matters.
  role        text         NOT NULL DEFAULT '',

  -- 'by 20990001', 'with an email', 'changed by the account holder'.
  detail      text         NOT NULL DEFAULT ''
);

/*
  THE ONLY WAY THIS TABLE IS EVER READ is newest first, and pruning walks it
  oldest first. One index answers both, because an index is as good
  backwards as forwards.
*/
CREATE INDEX IF NOT EXISTS auth_log_at_idx ON auth_log (at DESC);


-- ===========================================================================
-- WHAT IS NOT HERE
-- ===========================================================================
--
-- NO SETTINGS TABLE FOR THE SIGN-UPS SWITCH.
--
-- Auth.gs keeps a script property that says whether anybody who reaches the
-- URL may create a login for an employee ID that has none. It governs
-- registerAccount(), and registerAccount() is not ported: in this system the
-- only way an account comes into being is a master writing an employee ID
-- down on the Accounts screen. A switch governing a door that does not exist
-- would be a control that does nothing, and the screen says so instead.
--
-- It arrives with the sign-up flow, or not at all - there is a reasonable
-- argument that a system where the master adds everybody never needs it.
--
-- NO SALT COLUMN. See the note at the top.
--
-- NO auth_log PRUNE JOB IN SQL. CONFIG.AUTH_LOG_DAYS is 30 and the pruning
-- is pruneAuthLog() in api/accounts.js, called from backupNow() as
-- Backup.gs calls it. Doing it in SQL would mean a second place that has to
-- agree about the window.
-- ===========================================================================
