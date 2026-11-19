-- ===========================================================================
-- 07-import-objectives.sql - OBJ_PLAN and OBJ_TASK, from the sheet.
-- ===========================================================================
--
-- Same shape as 05-import-team.sql, and for the same reasons: stage into
-- tables with no rules, LOOK at what arrived, then clean on the way across.
--
-- RUN IT IN PARTS. Parts 2 and 4 are pgAdmin dialogs, not SQL.
--
--   PART 1  make the two staging tables
--   PART 2  load OBJ_PLAN.csv            (pgAdmin Import)
--   PART 3  make the second staging table - already done in PART 1
--   PART 4  load OBJ_TASK.csv            (pgAdmin Import)
--   PART 5  look at what arrived         (before changing anything)
--   PART 6  clean it and move it across
--   PART 7  check it
--
-- EXPORTING THE TWO TABS
--   Google Sheet -> click the OBJ_PLAN tab
--   File -> Download -> Comma Separated Values (.csv)
--   Rename to OBJ_PLAN.csv, put it in E:\Projects\SAP-HRMS-Engine\data\
--   Repeat for OBJ_TASK -> OBJ_TASK.csv
--
-- .gitignore blocks *.csv and the whole data\ folder, so neither file can
-- reach the public repository. This SQL is safe to commit; the CSVs are
-- not.
-- ===========================================================================


-- ===========================================================================
-- PART 1 - the staging tables. Run this block.
-- ===========================================================================
-- Every column text, nothing required, columns in the SHEET'S order so the
-- importer lines them up by position.

DROP TABLE IF EXISTS obj_plan_import;
DROP TABLE IF EXISTS obj_task_import;

CREATE TABLE obj_plan_import (
  milestone_id     text,   -- 'Milestone ID'
  row_id           text,   -- 'Row ID'
  category         text,   -- 'Category'
  weight           text,   -- 'Weight'
  objective        text,   -- 'Objective'
  milestone        text,   -- 'Milestone'
  expected_outcome text,   -- 'Expected Outcome'
  count_type       text,   -- 'Count Type'
  target           text,   -- 'Target'
  per              text,   -- 'Per'
  owner            text,   -- 'Owner'
  auto_source      text    -- 'Auto Source'
);

CREATE TABLE obj_task_import (
  objective_id     text,   -- 'Objective ID'
  category         text,   -- 'Category'
  objective_name   text,   -- 'Objective name'
  grp              text,   -- 'Group'
  area             text,   -- 'Area'
  kpi              text,   -- 'KPI'              Yes / No
  description      text,   -- 'Objective / Description'
  target           text,   -- 'Target'
  method           text,   -- 'Measurement Method'
  frequency        text,   -- 'Frequency'
  owner            text,   -- 'Responsible Person'
  remarks          text    -- 'Remarks / Outcome'
);


-- ===========================================================================
-- PARTS 2 and 4 - load the CSVs. NOT SQL. In pgAdmin:
-- ===========================================================================
--   1. Left panel -> tvl_eas -> Schemas -> public -> Tables
--      Right-click Tables -> REFRESH first, or the new ones will not show.
--   2. Right-click obj_plan_import -> Import/Export Data...
--   3. Import. Filename: data\OBJ_PLAN.csv. Format csv. Encoding UTF8.
--   4. Options tab: Header ON. Delimiter , . Quote " . ESCAPE " (not ').
--   5. OK.
--   6. The same again for obj_task_import with OBJ_TASK.csv.
--
-- ESCAPE MUST BE A DOUBLE QUOTE. With an apostrophe there, a field
-- containing doubled quotes loses them silently - no error, just missing
-- characters. These two tabs are full of free text, so it matters here
-- more than it did for TEAM.


-- ===========================================================================
-- PART 5 - LOOK BEFORE YOU TOUCH. Run each separately.
-- ===========================================================================

-- 5a. How many rows arrived. Expect 29 and 90.
SELECT 'obj_plan_import' AS staged, count(*) AS rows FROM obj_plan_import
UNION ALL
SELECT 'obj_task_import', count(*) FROM obj_task_import;


-- 5b. THE PROBLEM REPORT.
SELECT 'plan: blank Milestone ID (SKIPPED)' AS problem, count(*) AS how_many
  FROM obj_plan_import WHERE coalesce(trim(milestone_id), '') = ''
UNION ALL
SELECT 'plan: duplicate Milestone ID (first kept)', count(*) FROM (
  SELECT trim(milestone_id) FROM obj_plan_import
   WHERE coalesce(trim(milestone_id), '') <> ''
   GROUP BY 1 HAVING count(*) > 1) d
UNION ALL
SELECT 'plan: Count Type not PERCENT/NUMBER/DONE', count(*)
  FROM obj_plan_import
 WHERE coalesce(trim(milestone_id), '') <> ''
   AND upper(coalesce(trim(count_type), '')) NOT IN ('PERCENT','NUMBER','DONE')
UNION ALL
SELECT 'plan: Per not MONTH/PERIOD', count(*)
  FROM obj_plan_import
 WHERE coalesce(trim(milestone_id), '') <> ''
   AND upper(coalesce(trim(per), '')) NOT IN ('MONTH','PERIOD')
UNION ALL
SELECT 'task: blank Objective ID or name (SKIPPED)', count(*)
  FROM obj_task_import
 WHERE coalesce(trim(objective_id), '') = ''
    OR coalesce(trim(objective_name), '') = ''
UNION ALL
SELECT 'task: duplicate Objective ID (first kept)', count(*) FROM (
  SELECT trim(objective_id) FROM obj_task_import
   WHERE coalesce(trim(objective_id), '') <> ''
   GROUP BY 1 HAVING count(*) > 1) d2
UNION ALL
SELECT 'task: marked KPI (expect 4)', count(*)
  FROM obj_task_import WHERE trim(kpi) ~* '^y'
UNION ALL
SELECT 'task: Frequency blank (becomes Monthly)', count(*)
  FROM obj_task_import
 WHERE coalesce(trim(objective_id), '') <> ''
   AND coalesce(trim(frequency), '') = '';


-- 5c. Which rows have an unexpected Count Type or Per, by name.
SELECT trim(milestone_id) AS id, trim(count_type) AS count_type, trim(per) AS per
  FROM obj_plan_import
 WHERE coalesce(trim(milestone_id), '') <> ''
   AND (upper(coalesce(trim(count_type), '')) NOT IN ('PERCENT','NUMBER','DONE')
     OR upper(coalesce(trim(per), ''))        NOT IN ('MONTH','PERIOD'));


-- 5d. The Auto Source values in use. Objective.gs knows UNIQUE_ROLES,
--     KNOWLEDGE and LEARN; anything else scores from what was typed.
SELECT coalesce(nullif(trim(auto_source), ''), '(none)') AS auto_source,
       count(*) AS milestones
  FROM obj_plan_import
 WHERE coalesce(trim(milestone_id), '') <> ''
 GROUP BY 1 ORDER BY 2 DESC;


-- ===========================================================================
-- PART 6 - clean it and move it across. Run the whole block.
-- ===========================================================================

DELETE FROM obj_plan;
DELETE FROM obj_task;

INSERT INTO obj_plan
  (milestone_id, row_id, category, weight, objective, milestone,
   expected_outcome, count_type, target, per, owner, auto_source)
SELECT
  trim(milestone_id),
  nullif(trim(row_id),           ''),
  nullif(trim(category),         ''),
  -- A blank Weight or Target is NULL, not 0. Zero is a real weight that
  -- means "counts for nothing"; blank means nobody said. The regexp
  -- guards against a stray character making the cast throw and taking the
  -- whole import with it.
  CASE WHEN trim(weight) ~ '^-?[0-9]+(\.[0-9]+)?$'
       THEN trim(weight)::numeric END,
  nullif(trim(objective),        ''),
  nullif(trim(milestone),        ''),
  nullif(trim(expected_outcome), ''),
  -- Upper-cased because objMilestoneScore compares against 'PERCENT',
  -- 'DONE' and falls through to NUMBER. A cell reading "Percent" would
  -- silently take the NUMBER path and score against the wrong target.
  nullif(upper(trim(count_type)), ''),
  CASE WHEN trim(target) ~ '^-?[0-9]+(\.[0-9]+)?$'
       THEN trim(target)::numeric END,
  nullif(upper(trim(per)),        ''),
  nullif(trim(owner),             ''),
  nullif(trim(auto_source),       '')
FROM (
  /*
    ORDER BY ctid, AND NOT BY THE ID - which is what the first version did
    and it was wrong. Both rows of a duplicate share the same id, so
    ordering by it leaves "first" to chance: the test kept the SECOND row
    and said it had kept the first.

    ctid is the physical position of the row. On a staging table that was
    just COPYd and never updated it is the order of the file, which is the
    order of the sheet - so "the first one wins" means the one nearer the
    top of the tab, which is what somebody looking at the sheet expects.

    It is only trustworthy BECAUSE this table is write-once. ctid moves
    when a row is updated, so this would be the wrong tool on obj_plan
    itself.
  */
  SELECT *, row_number() OVER (PARTITION BY trim(milestone_id)
                               ORDER BY ctid) AS dup
    FROM obj_plan_import
   WHERE coalesce(trim(milestone_id), '') <> ''
) p
WHERE dup = 1;


INSERT INTO obj_task
  (objective_id, category, objective_name, grp, area, kpi,
   description, target, method, frequency, owner, remarks)
SELECT
  trim(objective_id),
  nullif(trim(category),       ''),
  trim(objective_name),
  -- Objective.gs: String(r[3] || '').trim() || 'Unassigned'
  coalesce(nullif(trim(grp), ''), 'Unassigned'),
  nullif(trim(area),           ''),
  /*
    THE SAME TEST AS Objective.gs, WHICH IS kpi: /^y/i.test(...)

    Not kpi = 'Yes'. The sheet is filled by hand and "Y", "yes" and "YES"
    all mean the same thing to the person typing. ~* is PostgreSQL's
    case-insensitive regular expression match, so '^y' here is exactly
    /^y/i there.
  */
  coalesce(trim(kpi) ~* '^y', false),
  nullif(trim(description),    ''),
  nullif(trim(target),         ''),
  nullif(trim(method),         ''),
  -- Objective.gs: String(r[9] || 'Monthly').trim() - a blank cell is
  -- Monthly, and objSlotCount treats anything unrecognised as Monthly too.
  coalesce(nullif(trim(frequency), ''), 'Monthly'),
  nullif(trim(owner),          ''),
  nullif(trim(remarks),        '')
FROM (
  SELECT *, row_number() OVER (PARTITION BY trim(objective_id)
                               ORDER BY ctid) AS dup      -- see the note above
    FROM obj_task_import
   -- Objective.gs skips a row with no id OR no name: if (!id || !name) return;
   WHERE coalesce(trim(objective_id),   '') <> ''
     AND coalesce(trim(objective_name), '') <> ''
) t
WHERE dup = 1;


-- ===========================================================================
-- PART 7 - check it. Run each separately.
-- ===========================================================================

-- 7a. The two numbers the whole objectives page rests on.
--     29 milestones, and 86 EAS objectives out of 90.
SELECT (SELECT count(*) FROM obj_plan)                     AS milestones,
       (SELECT count(*) FROM obj_task)                     AS objectives_all,
       (SELECT count(*) FROM obj_task WHERE kpi)           AS kpis,
       (SELECT count(*) FROM obj_task WHERE NOT kpi)       AS eas_counted;

-- 7b. The rows of the SMART sheet, and how many milestones each holds.
SELECT row_id, count(*) AS milestones, sum(weight) AS weight
  FROM obj_plan GROUP BY row_id ORDER BY row_id;

-- 7c. How the squares will be shared out across frequencies.
SELECT frequency, count(*) AS objectives
  FROM obj_task WHERE NOT kpi GROUP BY frequency ORDER BY 2 DESC;

-- 7d. The four KPIs, by name - these are the ones nobody ticks.
SELECT objective_id, objective_name, frequency
  FROM obj_task WHERE kpi ORDER BY objective_id;

-- 7e. ONLY when 7a reads 29 / 90 / 4 / 86:
-- DROP TABLE obj_plan_import;
-- DROP TABLE obj_task_import;
--
-- Left commented. Keep staging for a week - it is the only record of
-- exactly what the sheets said on import day.
-- ===========================================================================
