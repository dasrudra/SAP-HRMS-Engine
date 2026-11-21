-- ===========================================================================
-- 10-content.sql - the FAQ, By-Weekly, Knowledge and Learn tabs as tables.
-- ===========================================================================
--
-- HOW TO RUN: all of it, in one go. Press F5. Safe to run again.
--
-- Four screens that are all the same shape underneath - a list somebody
-- reads - so they share one file rather than four.
--
-- NO REAL CONTENT IN THIS FILE.
--
--   * the FAQ starts empty on purpose. See the note on it below.
--   * BY_WEEKLY gets its four section rows with EMPTY links, exactly as
--     setupByWeeklyTab() writes them. The addresses are personal OneDrive
--     links that carry their owner's work email inside the path, and this
--     repository is public - tests/wiring-test.js refuses that pattern
--     anywhere in the project. You paste them in yourself.
--   * KNOWLEDGE and LEARN are colleagues' own notes and the document
--     library. Both are imported separately, neither belongs here.
-- ===========================================================================

DROP TABLE IF EXISTS faq;
DROP TABLE IF EXISTS by_weekly;
DROP TABLE IF EXISTS knowledge;
DROP TABLE IF EXISTS learn;


-- ---------------------------------------------------------------------------
-- faq - the published questions. FAQ, 4 columns.
-- ---------------------------------------------------------------------------
CREATE TABLE faq (
  id        integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ord       integer NOT NULL DEFAULT 0,   -- 'Order'
  question  text NOT NULL CHECK (btrim(question) <> ''),
  answer    text NOT NULL CHECK (btrim(answer) <> ''),
  updated   timestamptz
);

/*
  WHY ord AND NOT order: ORDER is a reserved word in SQL. A column called
  "order" is legal but has to be quoted every single time it is mentioned,
  and the first query that forgets reads as a syntax error a long way from
  the cause. The sheet header stays 'Order'. Same decision as obj_task.grp
  for 'Group' and msg_line.body for 'Text'.

  WHY THERE IS A SURROGATE id: two questions can share an order number -
  nothing in the sheet stops it - and the port sorts by ord and leaves
  equal ones in the order they were written. A primary key on ord would
  refuse the second one.

  THIS TABLE STARTS EMPTY, AND THAT IS NOT AN OVERSIGHT.

  faqEntries() reads the tab and FALLS BACK to CONFIG.FAQ_SEED when the tab
  has nothing usable in it - "so a fresh database still has something to
  show". The port keeps the seed in the code, exactly where the original
  keeps it, and this table overrides it the moment there is a row in it.

  So: empty table, seven seeded questions on the page. Put a row in here
  and the seed stops being used entirely - it is an override, not a merge,
  which is what the original does and is the only version that lets you
  delete a seeded question.

  A row with a blank question or answer is refused rather than silently
  skipped. The original filters those out on read, which means a typo in
  the tab quietly removes an entry from the page and nothing says so.
  Refusing the write says it at the moment somebody can still fix it.
*/

CREATE INDEX faq_order_idx ON faq (ord, id);


-- ---------------------------------------------------------------------------
-- by_weekly - where each section keeps its meeting deck. BY_WEEKLY, 2 columns.
-- ---------------------------------------------------------------------------
CREATE TABLE by_weekly (
  section    text PRIMARY KEY,            -- 'Section'
  link       text NOT NULL DEFAULT '',    -- 'Link'
  updated_at timestamptz NOT NULL DEFAULT now()
);

/*
  THE KEY IS THE SECTION'S DISPLAYED NAME, NOT ITS SHORT CODE, because that
  is what getByWeeklyLinks matches on:

      found[String(row[0]).trim().toUpperCase()] = url
      ...
      url: byWeeklySafe(found[s.name.toUpperCase()] || '')

  s.name is 'Supply Chain', not 'SCA'. Keying this table on SCA/SDMM/PP/FICO
  would look tidier and would match nothing.

  THE FOUR NAMES AND THEIR ORDER ARE IN THE CODE, not here - ByWeekly.gs
  says why: "a tab whose first column could be typed wrong is a tab that
  silently loses a button". The rows below exist so there is somewhere to
  paste the address; the port draws the four buttons whether or not these
  rows exist, and a section with no address comes back greyed out rather
  than disappearing.

  A LINK IS ONLY USED IF IT STARTS http:// OR https://. byWeeklySafe does
  that check and the port keeps it: this value reaches an anchor's href,
  and `javascript:` in an href runs when somebody clicks it. The check is
  in the code rather than a CHECK constraint here so that a half-typed
  address can still be saved and corrected rather than rejected outright.
*/

INSERT INTO by_weekly (section, link) VALUES
  ('Supply Chain',     ''),
  ('Sales & Customer', ''),
  ('Manufacturing',    ''),
  ('Financial',        '');


-- ---------------------------------------------------------------------------
-- knowledge - what colleagues have worked out. KNOWLEDGE, 9 columns.
-- ---------------------------------------------------------------------------
CREATE TABLE knowledge (
  share_id   text PRIMARY KEY,                       -- 'ID'
  title      text NOT NULL CHECK (btrim(title) <> '' AND length(title) <= 200),
  body       text NOT NULL DEFAULT ''
               CHECK (length(body) <= 20000),        -- 'Body'
  tags       text NOT NULL DEFAULT '',               -- 'Tags'  comma separated
  author     text NOT NULL DEFAULT 'Unknown',        -- 'Author'
  author_id  text NOT NULL DEFAULT '',               -- 'Author ID'
  created    timestamptz NOT NULL DEFAULT now(),
  updated    timestamptz NOT NULL DEFAULT now(),
  files      jsonb NOT NULL DEFAULT '[]'::jsonb      -- 'Files'
);

/*
  THE LIMITS ARE IN THE TABLE AS WELL AS IN THE CODE. createKnowledge
  checks 200 and 20,000 and throws a sentence somebody can act on; these
  CHECKs catch anything that reaches the table another way. The 20,000 is
  not arbitrary - Knowledge.gs: "the body goes in one spreadsheet cell and
  a cell holds 50,000 characters; past that the write fails with a message
  about cell contents that explains nothing to the person typing." A
  PostgreSQL text column has no such limit, so the rule is kept here
  deliberately rather than inherited: it is a limit on what a reader will
  sit through, and "anything bigger belongs in a document, attached".

  NO FOREIGN KEY FROM author_id TO team, on purpose. Somebody who leaves
  does not take their notes with them - that is the whole point of writing
  a thing down instead of telling one colleague. A foreign key with ON
  DELETE CASCADE would delete the lot the day their row goes; one with
  RESTRICT would stop them being removed from the directory at all.

  author AND author_id ARE BOTH STORED, and the name is not looked up at
  read time. It is stamped when the share is posted, as the original does.
  A name is a courtesy and the id is the fact, so the id is what the
  Remove button is checked against - see the port's deleteKnowledge.

  files IS AN INDEX, NOT THE FILES, same as msg_line.files: id, name, type
  and size, so that drawing the page costs one query and no file-store
  calls at all.
*/

CREATE INDEX knowledge_newest_idx ON knowledge (created DESC);
CREATE INDEX knowledge_author_idx ON knowledge (author_id);


-- ---------------------------------------------------------------------------
-- learn - the approved document library. LEARN, 9 columns.
-- ---------------------------------------------------------------------------
CREATE TABLE learn (
  file_id   text PRIMARY KEY,              -- 'File ID'
  title     text NOT NULL CHECK (btrim(title) <> ''),
  type      text NOT NULL DEFAULT '',      -- 'Type'      SOP, Policy, ...
  module    text NOT NULL DEFAULT '',      -- 'Module'    MM, SD, PP, FI-CO
  business  text NOT NULL DEFAULT '',      -- 'Business'  RMG or MG
  kind      text NOT NULL DEFAULT 'file',  -- 'Kind'      pdf, video, slide...
  size      text NOT NULL DEFAULT '',      -- 'Size'
  updated   timestamptz,                   -- 'Updated'
  path      text NOT NULL DEFAULT ''       -- 'Path'
);

/*
  size IS text, NOT A NUMBER, and that is what the tab holds. The scanner
  works the byte count into '27.7 MB' once, when it walks the folder, and
  the page prints it. Storing bytes here and formatting on read would be
  the better design for a table being built from scratch - but the column
  this mirrors already holds the printed string, the importer would have to
  parse it back, and parsing '27.7 MB' into a byte count loses the original
  number anyway. It stays as the tab has it. learnSize() is ported all the
  same, because the Knowledge attachments need it.

  THE PRIMARY KEY IS THE FILE ID because that is what identifies a document
  for its whole life. A title changes, a path changes when somebody
  reorganises the folders, and both of those should update a row rather
  than add one.

  WHAT IS NOT HERE: the Drive scan that fills this table. walkLearnFolder,
  scanLearnFolder, syncLearnFolder and the hourly trigger all talk to Drive,
  which this port has not replaced yet. The READ side - what the Learnings
  page shows - is ported and is what this table serves. See
  PORT-INVENTORY.md.

  type, module AND business ARE PLAIN text, NOT CHECKed against a list.
  CONFIG.LEARN holds the recognised names and the port returns them for the
  page's chips, but a document whose folder nobody has added to that list
  still has to be storable - it lands under the fallback type and shows up
  in the library rather than failing an import nobody is watching.
*/

CREATE INDEX learn_module_idx ON learn (module, business);
CREATE INDEX learn_newest_idx ON learn (updated DESC NULLS LAST);


-- ===========================================================================
SELECT 'faq' AS table_name, count(*) AS rows FROM faq
UNION ALL SELECT 'by_weekly', count(*) FROM by_weekly
UNION ALL SELECT 'knowledge', count(*) FROM knowledge
UNION ALL SELECT 'learn',     count(*) FROM learn
ORDER BY table_name;
-- by_weekly has 4 - the four sections, with no addresses yet.
-- The other three are 0.
-- ===========================================================================
