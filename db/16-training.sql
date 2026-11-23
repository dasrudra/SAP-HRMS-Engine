-- ===========================================================================
-- 16-training.sql - the training feedback responses. KPI 2's data.
-- ===========================================================================
--
-- The TRAINING tab. One row per respondent per session: who attended, which
-- session, and their seven answers.
--
-- 32 sessions, 667 respondents and 4,669 answers at the time of writing.
--
--
-- THE ANSWERS ARE STORED AS THE RAW TEXT PEOPLE CHOSE, NOT AS A SCORE
--
-- This is the decision in this file, and Config.gs states it where the
-- columns are defined:
--
--   "The seven scored questions, stored as the RAW ANSWER TEXT. Classifying
--    at scoring time rather than at upload means FEEDBACK_ANSWERS can be
--    corrected and everything re-scored with nothing to re-upload."
--
-- It is the difference between a mistake that costs an afternoon and one
-- that costs the data. The forms changed wording between batches - 'Very
-- helpful' and 'Confident' appear only in some of them - so the map from
-- answer to tier is a thing that gets corrected. Store 'POSITIVE' and a
-- correction means finding and re-uploading 32 files. Store 'Extremely
-- helpful [gloss]' and a correction is one edit to api/kpi2.js and the
-- figures move on the next page load.
--
-- It also means an answer nobody anticipated is still THERE. It scores as
-- UNKNOWN, which depresses the rate and shows on screen - rather than
-- having been thrown away at upload with no record that it existed.
--
--
-- PERMISSIONS: none granted here. See the note in 14-backup.sql.
-- ===========================================================================


CREATE TABLE IF NOT EXISTS training (
  /*
    THE MERGE KEY, and it is not an employee or a session.

    'filename#rownumber' - the source file plus the form's own row id. Which
    means re-uploading the same export UPDATES its rows instead of doubling
    the respondent count, and that is the whole reason it is the key:
    Ingest.gs notes the same thing about appendFeedbackBatch.

    Not the employee ID: one person attends several sessions, and in the real
    data some rows have no employee ID at all.
  */
  response_id   text         PRIMARY KEY,

  session_date  timestamptz,

  /*
    'YYYY-MM', the period the KPI reports on. STORED, not derived from
    session_date, for two reasons: it is what the upload supplies, and it is
    what every KPI 2 query groups by. Deriving it per query would mean
    AT TIME ZONE arithmetic on every row of every page load to recover a
    string the uploader already knew.

    text rather than date for the same reason it is text in KPI 1's queries:
    a month is a label, and '2026-08' sorts and compares correctly as one.
  */
  month         text         NOT NULL DEFAULT ''
                CONSTRAINT training_month_shape
                CHECK (month = '' OR month ~ '^[0-9]{4}-[0-9]{2}$'),

  /*
    Which SAP module, worked out from the FILENAME - the feedback form itself
    has no module field. See moduleFor in api/kpi2.js, and note that the
    module is stored rather than recomputed: the filename that produced it
    can be deleted, and a report of last year's figures should not change
    because the module table was edited since.
  */
  module        text         NOT NULL DEFAULT '',

  session_title text         NOT NULL DEFAULT '',
  trainer       text         NOT NULL DEFAULT '',
  plant         text         NOT NULL DEFAULT '',

  -- Blank on plenty of real rows. Not a key, not a foreign key to team: a
  -- trainee is frequently not an EAS person, and most are not in `team` at
  -- all.
  employee_id   text         NOT NULL DEFAULT '',
  employee_name text         NOT NULL DEFAULT '',

  -- The seven questions, as text. See the note at the top of this file.
  q1_overall    text         NOT NULL DEFAULT '',
  q2_relevance  text         NOT NULL DEFAULT '',
  q3_knowledge  text         NOT NULL DEFAULT '',
  q4_explanation text        NOT NULL DEFAULT '',
  q5_materials  text         NOT NULL DEFAULT '',
  q6_confidence text         NOT NULL DEFAULT '',
  q7_duration   text         NOT NULL DEFAULT '',

  -- Which file this response arrived in. deleteUpload matches on it, the
  -- same way it matches ticket.source_files - one file here rather than a
  -- list, because "a response belongs to exactly one file, so there is no
  -- partial ownership to reason about".
  source_file   text         NOT NULL DEFAULT '',

  uploaded_at   timestamptz  NOT NULL DEFAULT now(),

  /*
    Added LAST in the spreadsheet, and Config.gs explains why it had to be:

      "Existing rows were written at the old width and are addressed by
       position, so a column inserted anywhere else would shift every value
       already stored."

    That constraint does not exist here. A PostgreSQL column is addressed by
    name, so this one is last because it was added last and for no other
    reason - and the next one can go wherever it reads best. Worth saying
    out loud, because a reader who knows the sheet will assume the position
    means something.
  */
  zone          text         NOT NULL DEFAULT ''
);


-- Every KPI 2 query groups by month, and most then group by module inside
-- it. One index, in that order.
CREATE INDEX IF NOT EXISTS training_month_module_idx
  ON training (month, module);

-- deleteUpload asks "which responses came in this file".
CREATE INDEX IF NOT EXISTS training_source_idx
  ON training (source_file);


-- ===========================================================================
-- WHAT IS NOT HERE
-- ===========================================================================
--
-- No tier column, no score column, no computed rate. See the top of this
-- file: the whole point is that the judgement is applied when the figure is
-- read, not when the row is written.
--
-- No foreign key to team. Trainees are SAP users across the group, not EAS
-- staff, and most of them are in no other table here.
--
-- No NOT NULL on session_date. Some real rows have no session date, and a
-- NOT NULL would have meant inventing one at upload to get the row in -
-- which is how a blank becomes a wrong value that looks right.
-- ===========================================================================
