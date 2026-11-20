-- ===========================================================================
-- 08-messenger.sql - the THREADS and MESSAGES tabs as tables.
-- ===========================================================================
--
-- HOW TO RUN: all of it, in one go. Press F5. Safe to run again.
--
-- Every column of both tabs, in the tab's order, with the sheet header
-- beside it. Nothing dropped, nothing invented.
--
-- NO REAL MESSAGES IN THIS FILE. The conversations live in the spreadsheet
-- and are people's own words - they are not for a public repository. This
-- creates empty tables.
-- ===========================================================================

DROP TABLE IF EXISTS msg_line;
DROP TABLE IF EXISTS msg_thread;


-- ---------------------------------------------------------------------------
-- msg_thread - one conversation. THREADS, 11 columns.
-- ---------------------------------------------------------------------------
CREATE TABLE msg_thread (
  thread_id         text PRIMARY KEY,          -- 'Thread ID'
  person            text NOT NULL,             -- 'Person'   employee ID as typed
  verified          boolean NOT NULL DEFAULT false,  -- 'Verified'  YES / NO
  started           timestamptz,               -- 'Started'
  topic             text,                      -- 'Topic'
  last_message_at   timestamptz,               -- 'Last Message At'
  last_message_by   text,                      -- 'Last Message By'  USER | TEAM
  status            text NOT NULL DEFAULT 'OPEN'
                      CHECK (status IN ('OPEN', 'CLOSED')),   -- 'Status'
  waiting_for_team  integer NOT NULL DEFAULT 0, -- 'Waiting For Team'
  unread_by_person  integer NOT NULL DEFAULT 0, -- 'Unread By Person'
  name              text,                      -- 'Name'
  created_at        timestamptz NOT NULL DEFAULT now()
);

/*
  THERE IS NO FOREIGN KEY FROM person TO team, AND THAT IS DELIBERATE.

  Messenger.gs carries a warning worth repeating in full:

    "sendUnverifiedMessage() accepts any employee ID and answers identically
     whether or not it exists. Checking, and saying so, would turn the
     sign-in page into a list of everybody who works here for anyone who
     cared to try numbers at it."

  A foreign key would do exactly that checking, in the database, and refuse
  the insert - so a stranger typing numbers at the sign-in page would learn
  which ones are real from which ones were accepted. The whole point of an
  unverified thread is that it records what somebody TYPED, not who they
  are. The accompanying warning is equally worth keeping:

    "AN UNVERIFIED MESSAGE IS NOT EVIDENCE OF ANYTHING. It says somebody
     typed an employee ID into a box on a public web page. Never reset a
     password, change a role or say anything confidential on the strength
     of one."

  WHY verified IS boolean AND NOT THE WORDS: the sheet stores 'YES' or 'NO'
  and every reader compares against the string. Two values with one
  meaning, so it is the answer and not the words - the same decision as
  obj_task.kpi, and for the same reason: a truthy "NO" is a security bug
  waiting to happen.

  THE TWO COUNTERS ARE A RUNNING TALLY, NOT A TOTAL.

    waiting_for_team   counts up on a USER line, and a TEAM line CLEARS it
    unread_by_person   counts up on a TEAM line, and a USER line CLEARS it

  That is why they are plain integers that get overwritten rather than
  incremented in place: writing a message sets the other side's counter to
  zero, because the act of replying IS having read it.
*/

CREATE INDEX msg_thread_person_idx ON msg_thread (person);
-- The team's inbox asks for open threads with somebody waiting, newest
-- first. Those three columns, in that order, answer it without a sort.
CREATE INDEX msg_thread_inbox_idx
  ON msg_thread (status, waiting_for_team, last_message_at DESC);


-- ---------------------------------------------------------------------------
-- msg_line - every line anybody has typed. MESSAGES, 8 columns.
-- ---------------------------------------------------------------------------
CREATE TABLE msg_line (
  message_id   text PRIMARY KEY,               -- 'Message ID'
  thread_id    text NOT NULL
                 REFERENCES msg_thread(thread_id) ON DELETE CASCADE,
  at           timestamptz NOT NULL,           -- 'At'
  side         text NOT NULL CHECK (side IN ('USER', 'TEAM')),  -- 'Side'
  author       text,                           -- 'Author'      employee ID
  body         text NOT NULL,                  -- 'Text'
  author_name  text,                           -- 'Author Name'
  files        jsonb NOT NULL DEFAULT '[]'::jsonb  -- 'Files'
);

/*
  WHY body AND NOT text: `text` is PostgreSQL's own type name. A column
  called text is legal and reads terribly - `SELECT text FROM msg_line`
  looks like a mistake every time. The sheet header stays 'Text'; only the
  column name differs, and the mapping is written above. Same decision as
  obj_task.grp for 'Group'.

  WHY author IS KEPT ON A TEAM LINE. Messenger.gs: "somebody asking a
  question should be able to see who answered them, and the next admin to
  open the inbox should be able to see that a colleague has already dealt
  with it."

  THE FOREIGN KEY HERE IS TO THE THREAD, NOT TO A PERSON - and ON DELETE
  CASCADE, so deleting a conversation takes its lines with it rather than
  leaving them orphaned under an id nothing points to.

  files IS AN INDEX, NOT THE FILES. The images live in a PRIVATE Drive
  folder and are served through the script, never by a shared link. This
  column holds id, name, type and size only.
*/

CREATE INDEX msg_line_thread_idx ON msg_line (thread_id, at);


-- ===========================================================================
SELECT 'msg_thread' AS table_name, count(*) AS rows FROM msg_thread
UNION ALL SELECT 'msg_line', count(*) FROM msg_line;
-- Both zero. The conversations are imported separately and are not in this
-- repository.
-- ===========================================================================
