-- ===========================================================================
-- 06-objectives.sql - the three objective tabs as tables.
-- ===========================================================================
--
-- HOW TO RUN: all of it, in one go. Press F5. Safe to run again.
--
-- A FAITHFUL PORT of OBJ_PLAN, OBJ_TASK and OBJ_LOG from the spreadsheet.
-- Every column of every tab is here, in the tab's own order, with the sheet
-- header written beside it so the two can be checked against each other by
-- eye. Nothing is dropped and nothing is invented.
--
-- NO REAL DATA IN THIS FILE. The objectives content lives in the
-- spreadsheet and stays there - it is not for a public repository. This
-- file creates empty tables; 07 will import.
-- ===========================================================================

DROP TABLE IF EXISTS obj_log;
DROP TABLE IF EXISTS obj_task;
DROP TABLE IF EXISTS obj_plan;


-- ---------------------------------------------------------------------------
-- obj_plan - the SMART objectives. OBJ_PLAN, 12 columns.
-- ---------------------------------------------------------------------------
CREATE TABLE obj_plan (
  milestone_id     text PRIMARY KEY,       -- 'Milestone ID'
  row_id           text,                   -- 'Row ID'
  category         text,                   -- 'Category'
  weight           numeric,                -- 'Weight'
  objective        text,                   -- 'Objective'
  milestone        text,                   -- 'Milestone'
  expected_outcome text,                   -- 'Expected Outcome'
  count_type       text,                   -- 'Count Type'
  target           numeric,                -- 'Target'
  per              text,                   -- 'Per'
  owner            text,                   -- 'Owner'
  auto_source      text,                   -- 'Auto Source'
  created_at       timestamptz NOT NULL DEFAULT now()
);


-- ---------------------------------------------------------------------------
-- obj_task - the Unique Roles sheet. OBJ_TASK, 12 columns.
-- ---------------------------------------------------------------------------
CREATE TABLE obj_task (
  objective_id     text PRIMARY KEY,       -- 'Objective ID'
  category         text,                   -- 'Category'
  objective_name   text,                   -- 'Objective name'
  grp              text,                   -- 'Group'  (GROUP is a reserved word)
  area             text,                   -- 'Area'
  kpi              text,                   -- 'KPI'
  description      text,                   -- 'Objective / Description'
  target           text,                   -- 'Target'
  method           text,                   -- 'Measurement Method'
  frequency        text NOT NULL DEFAULT 'Monthly',   -- 'Frequency'
  owner            text,                   -- 'Responsible Person'
  remarks          text,                   -- 'Remarks / Outcome'
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- WHY grp AND NOT group: GROUP is a reserved SQL word. A column called
-- "group" is legal only when quoted every single time it is used, and the
-- first unquoted one is a syntax error pointing at the wrong line. The
-- sheet header stays 'Group'; only the column name differs, and the mapping
-- is written above so nobody has to guess.
--
-- WHY frequency HAS A DEFAULT: objSlotCount() treats anything it does not
-- recognise as Monthly, and Objective.gs reads the cell as
-- String(r[9] || 'Monthly'). A blank cell must mean Monthly here too, or a
-- row with an empty Frequency would get a different number of squares after
-- the move than before it.
--
-- WHY target IS text HERE AND numeric IN obj_plan: because that is what the
-- two sheets hold. The Unique Roles Target column contains things like
-- "100%" and "As required"; the SMART Target column is a number. Forcing
-- either into the other's type would lose data on import.


-- ---------------------------------------------------------------------------
-- obj_log - one row per objective per month. OBJ_LOG, 13 columns.
-- ---------------------------------------------------------------------------
CREATE TABLE obj_log (
  period     text NOT NULL,                -- 'Period'   '2026-11'
  kind       text NOT NULL,                -- 'Kind'     milestone | task
  ref_id     text NOT NULL,                -- 'Ref ID'
  marks      text    NOT NULL DEFAULT '',  -- 'Marks'
  value      numeric,                      -- 'Value'
  status     text    NOT NULL DEFAULT '',  -- 'Status'
  note       text    NOT NULL DEFAULT '',  -- 'Note'    one note for the month
  by_name    text    NOT NULL DEFAULT '',  -- 'By'
  by_id      text,                         -- 'By ID'
  at         timestamptz,                  -- 'At'
  history    jsonb   NOT NULL DEFAULT '[]'::jsonb,  -- 'History'
  marked_at  jsonb   NOT NULL DEFAULT '{}'::jsonb,  -- 'Marked'
  notes      jsonb   NOT NULL DEFAULT '{}'::jsonb,  -- 'Notes'  one per period

  -- One row per objective per month, updated in place. This is objLogKey()
  -- in Objective.gs - period + kind + ref - written down as a constraint
  -- instead of as a convention the code has to remember.
  PRIMARY KEY (period, kind, ref_id)
);

-- NOTE AND NOTES ARE DIFFERENT COLUMNS, and the near-identical names are
-- deliberate, copied from the sheet. Objective.gs explains it:
--
--   'Note' was one note for the whole month, which is what the page had
--   when a month was the only unit it knew. 'Notes' is one per PERIOD THAT
--   COUNTS - a note against the 3rd, another against the 9th.
--
-- Both are kept. Dropping the older one would lose every note written
-- before the per-period version existed.

-- THE PERIOD COLUMN IS text, AND THAT IS THE WHOLE POINT.
--
-- Objective.gs carries a warning about this: '2026-11' written into a
-- General cell in Sheets is parsed as a DATE, and that is what made
-- recording silently do nothing. PostgreSQL will not silently convert a
-- text column, so the bug cannot recur here - but the column must stay
-- text. Changing it to date would reintroduce the same class of fault and
-- would also be wrong: '2026-11' is a month, not a day.

CREATE INDEX obj_log_period_idx ON obj_log (period);
CREATE INDEX obj_log_kind_ref_idx ON obj_log (kind, ref_id);

-- Two indexes, and only two, because there are exactly two questions this
-- table is asked: everything in one month (drawing a page) and one
-- objective across months (drawing its row of squares). An index for a
-- question nobody asks is write cost for nothing.


-- ===========================================================================
-- What is here now
-- ===========================================================================
SELECT 'obj_plan' AS table_name, count(*) AS rows FROM obj_plan
UNION ALL SELECT 'obj_task', count(*) FROM obj_task
UNION ALL SELECT 'obj_log',  count(*) FROM obj_log;

-- All zero. The content comes from the spreadsheet in the next step, and it
-- is not in this repository because it is not public.
-- ===========================================================================
