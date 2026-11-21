-- ===========================================================================
-- 11-tickets.sql - the TICKETS tab as a table. KPI 1 is scored from this.
-- ===========================================================================
--
-- HOW TO RUN: all of it, in one go. Press F5. Safe to run again.
--
-- NO REAL TICKETS IN THIS FILE. They carry requestors' names, titles and
-- details of what went wrong in somebody's plant. They are imported
-- separately and they do not belong in a public repository.
--
-- All 25 columns of the tab, in the tab's order, with the sheet header
-- beside each one. Nothing dropped, nothing invented.
-- ===========================================================================

DROP TABLE IF EXISTS ticket;


CREATE TABLE ticket (
  ticket_id       text PRIMARY KEY,        -- 'Ticket ID'
  affiliate       text NOT NULL DEFAULT '',-- 'Affiliate'
  service         text NOT NULL DEFAULT '',-- 'Service'
  part            text NOT NULL DEFAULT '',-- 'Part'
  process         text NOT NULL DEFAULT '',-- 'Process'
  category        text NOT NULL DEFAULT '',-- 'Category'
  sub_category    text NOT NULL DEFAULT '',-- 'Sub Category'
  title           text NOT NULL DEFAULT '',-- 'Title'
  details         text NOT NULL DEFAULT '',-- 'Details'
  request_date    timestamptz,             -- 'Request Date'
  requestor       text NOT NULL DEFAULT '',-- 'Requestor'
  current_activity        text NOT NULL DEFAULT '',  -- 'Current Activity'
  current_activity_date   timestamptz,               -- 'Current Activity Date'
  in_charge       text NOT NULL DEFAULT '',-- 'Current Activity In Charge'
  due_date        timestamptz,             -- 'Due date'
  completion_date timestamptz,             -- 'Completion Date'
  lead_time       numeric,                 -- 'Lead-time'
  delay_days      numeric,                 -- 'Delay Days'
  status          text NOT NULL DEFAULT '',-- 'Status'
  cts_number      text NOT NULL DEFAULT '',-- 'CTS Number'
  remarks         text NOT NULL DEFAULT '',-- 'Remarks'
  acceptance_mh   numeric,                 -- 'Acceptance M/H (Level1)'
  processing_mh   numeric,                 -- 'Processing M/H (Level1)'
  man_hour        numeric,                 -- 'Man*Hour'

  -- ---- our own provenance columns, the last five of the tab ----
  department      text NOT NULL DEFAULT '',-- 'Department'
  in_overall      boolean NOT NULL DEFAULT false,  -- 'In Overall Report'
  in_dept         boolean NOT NULL DEFAULT false,  -- 'In Dept Report'
  source_files    text NOT NULL DEFAULT '',-- 'Source Files'
  last_updated    timestamptz NOT NULL DEFAULT now()  -- 'Last Updated'
);

/*
  completion_date IS NULLABLE, AND THAT NULL IS THE KPI.

    Total Completed        = tickets with a real Completion Date
    Completed with Delay   = completed AND Delay Days > 0
    Completed Successfully = Total Completed - Completed with Delay

  A ticket with no completion date is open, and `open` is never stored -
  Kpi.gs derives it as received minus completed so that it "cannot drift
  away from the two numbers it sits between".

  AND WHITESPACE IS NOT A DATE. Kpi.gs carries a warning worth repeating:

    "Two rows in the August export carry a Completion Date consisting of
     nothing but whitespace. The ITSM counts those as incomplete - they are
     the '1 incomplete' showing against Account and CO on its own report.
     Treating them as complete throws the figure off by one, and one ticket
     is the entire margin this KPI runs on."

  In a spreadsheet that is a real hazard, because a cell holds text. In a
  timestamptz column it cannot happen: ' ' is not a timestamp and the
  import refuses it. The import must turn blank-ish values into NULL rather
  than into a date, which is the same decision isCompleted() makes, moved
  one step earlier. The port keeps isCompleted anyway, because rows also
  arrive from the sheet during the changeover.

  delay_days IS numeric, NOT integer. Kpi.gs: "Delay Days arrives as int 0
  in one export and float 0.0 in another." Rounding at import would throw
  away a distinction the source makes; numeric keeps whatever came.

  WHY in_overall AND in_dept ARE BOTH KEPT, and why that is not redundant.
  Kpi.gs, in the file header:

    "The four department exports are the accurate scope. The overall
     Service/Part report is wider - it also contains work by engineers who
     belong to no EAS department (9 tickets across 6 people in August 2026),
     so scoring EAS on it credits the department with work it did not do.
     But you may upload only the overall report, or only department files,
     or both. So the engine scores whichever population it has and records
     WHICH."

  Two booleans, because a ticket can be in one report, the other, or both,
  and which it is decides whether it counts towards EAS. One column could
  not say "both".

  NO FOREIGN KEY FROM in_charge TO team. The in-charge name is whatever the
  ITSM exported, including people who have left and people who were never
  EAS at all - the nine above are exactly that. A foreign key would refuse
  the import of a real ticket because of who happened to handle it, and the
  dashboard's job is to report what the ITSM says, not to correct it.
*/

/*
  THE MONTH IS DERIVED, NOT STORED - one less column to keep in step with
  the date beside it. Two things had to be learned the hard way about how
  to index that, and both are worth writing down.

  FIRST: NAMING THE TIMEZONE IS A CORRECTNESS FIX, NOT A STYLE CHOICE.

      to_char(request_date, 'YYYY-MM')

  renders a timestamptz in the CONNECTION'S timezone. Run against the same
  row from two sessions (verified, not assumed):

      ticket raised 2026-09-01 00:30 +06
        session on UTC     -> 2026-08
        session on Dhaka   -> 2026-09

  The same ticket, two different months, decided by who happened to be
  asking. `AT TIME ZONE 'Asia/Dhaka'` pins it, and both sessions then
  answer 2026-09. Asia/Dhaka because that is the dashboard's own clock -
  appsscript.json sets it, the ITSM exports are local time, and "which
  month is this ticket in" is a question about the working month in
  Bangladesh.

  SECOND: NEITHER VERSION CAN BE INDEXED, and the reason is not the one it
  looks like. PostgreSQL refuses both with

      functions in index expression must be marked IMMUTABLE

  and the obvious suspect is the timezone conversion. It is not:

      timezone(text, timestamp with time zone) -> IMMUTABLE
      to_char(timestamp without time zone, text) -> STABLE

  to_char is the stable one, in every form, because its output depends on
  locale settings. So no to_char expression can go in an index at all, and
  pinning the zone does not rescue it.

  THEREFORE: INDEX THE TIMESTAMP, FILTER BY RANGE. A month is a half-open
  interval, so the port asks for

      request_date >= '2026-09-01 00:00+06'
        AND request_date <  '2026-10-01 00:00+06'

  which a plain btree index on request_date answers directly, with no
  function in sight and no locale in the answer. Grouping rows by month
  still uses to_char with the zone named - that runs over rows already
  selected, where being STABLE costs nothing.
*/
CREATE INDEX ticket_request_date_idx ON ticket (request_date);

CREATE INDEX ticket_in_charge_idx ON ticket (in_charge);
CREATE INDEX ticket_affiliate_idx ON ticket (affiliate);
CREATE INDEX ticket_scope_idx     ON ticket (in_overall, in_dept);

-- Completed-ness is asked of every row on every screen, and the answer is
-- "is this column null". A partial index on the open ones is small and
-- answers the count directly.
CREATE INDEX ticket_open_idx ON ticket (request_date)
  WHERE completion_date IS NULL;


-- ===========================================================================
SELECT 'ticket' AS table_name, count(*) AS rows FROM ticket;
-- Zero. The tickets are imported separately.
-- ===========================================================================
