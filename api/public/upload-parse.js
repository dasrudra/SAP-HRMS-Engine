/**
 * TURNING A DROPPED .xlsx INTO ROWS THE API WILL ACCEPT.
 *
 * Ported from the parsing half of src/App.html, which did this work inside
 * the dashboard's one big script block. Nothing about WHAT it does has
 * changed. What changed is that it is a file on its own, so that:
 *
 *   - the browser loads it with a <script> tag, as before;
 *   - Node can require() it, which means api/upload-parse-test.js can run
 *     the real functions against the originals lifted out of App.html and
 *     prove the two give the same answer, cell for cell;
 *   - nothing in here touches the DOM, the network or a global. The one
 *     function that must read a File object (readWorkbook) stayed in the
 *     page, and hands its grid to gridToFile() here.
 *
 * WHY THAT MATTERS MORE HERE THAN ANYWHERE ELSE IN THE PORT.
 * This is the only code in the system that reads a file somebody else's
 * software wrote. Every other input is one of ours. The ITSM writes dates
 * as text; the Microsoft Forms export writes them as real date cells; the
 * attendee types a third date into a text box and Excel reinterprets it on
 * the way past. A mistake in here is not an error on screen - it is a
 * number in a monthly report that is quietly wrong, and no screen will ever
 * say so.
 *
 * THE CONFIGURATION IS PASSED IN, NOT READ.
 * In App.html these functions reached into `state.boot` for the module
 * patterns, the section patterns and the column lists. They take them as
 * arguments now. That is the only change to any signature, it is what makes
 * them testable, and the page supplies exactly what the server sent it.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.uploadParse = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /*
    A Details cell longer than this is cut.

    From App.html, where it has been 300 since the import of a ticket whose
    Details field held a pasted email thread. The cap is in the browser and
    not the database on purpose: the cell is cut before it is ever sent, so
    a 40,000-character paste cannot make a batch too big to upload.
  */
  const DETAILS_LIMIT = 300;


  /* Feedback is filled in at the session, not years later. */
  const FEEDBACK_DATE_TOLERANCE_DAYS = 120;


  /**
   * Which columns are the seven scored questions?
   *
   * Matched on a distinctive phrase rather than on position or exact text.
   * The forms carry a Bangla translation inside brackets and the wording has
   * drifted between batches, so 'How would you rate the overall training
   * session? [...]' has to resolve on 'overall training session' alone.
   * Order follows the survey, not the spreadsheet.
   */
  const FEEDBACK_QUESTIONS = [
    { key: 'Q1', needle: 'overall training session' },
    { key: 'Q2', needle: 'relevant and useful for your job' },
    { key: 'Q3', needle: 'knowledge and expertise' },
    { key: 'Q4', needle: 'explain concepts' },
    { key: 'Q5', needle: 'training materials' },
    { key: 'Q6', needle: 'more confident' },
    { key: 'Q7', needle: 'duration and pace' }
  ];


  /** Is this value effectively empty? */
  /*
    The trim is the whole point. Some Completion Date cells in the ITSM
    export hold a single space. Testing only for '' treats that space as
    real, the merge keeps it, and the genuine date from the other report
    never replaces it - one ticket silently becomes incomplete.
  */
  function isBlank(value) {
    return value === null || value === undefined || String(value).trim() === '';
  }


  /** Date -> 'YYYY-MM-DD HH:MM:SS', matching how the ITSM writes them. */
  function formatDate(d) {
    function pad(n) { return String(n).padStart(2, '0'); }
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
           ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }


  /**
   * A sheet read as a grid, turned into the shape everything here expects.
   *
   * The page does the reading - FileReader and SheetJS, which only exist in
   * a browser - and hands the grid straight here. Splitting it this way is
   * what lets the whole of the rest be tested without one.
   *
   * header:1 gives arrays instead of objects. The two ITSM reports order
   * their columns differently, so everything downstream maps by header NAME
   * and never by index.
   */
  function gridToFile(fileName, grid) {
    if (!grid || !grid.length) throw new Error(fileName + ' looks empty');

    return {
      fileName: fileName,
      headers: grid[0].map(function (h) { return String(h == null ? '' : h).trim(); }),
      rows: grid.slice(1)
    };
  }


  function findFeedbackQuestions(headers) {
    const lower = (headers || []).map(function (h) {
      return String(h || '').toLowerCase();
    });

    return FEEDBACK_QUESTIONS.map(function (q) {
      let at = -1;
      for (let i = 0; i < lower.length; i++) {
        if (lower[i].indexOf(q.needle) !== -1) { at = i; break; }
      }
      return { key: q.key, at: at };
    }).filter(function (q) { return q.at !== -1; });
  }


  /**
   * What kind of file is this?
   *
   * Decided from the HEADERS, never the filename. A file can be renamed;
   * its columns are what it is.
   *
   *   FEEDBACK   - a training feedback form export. Routed to KPI 2.
   *   INDIVIDUAL - an ITSM Individual Performance export. KPI 1, with the
   *                per-engineer man-hour columns.
   *   OVERALL    - the ITSM Service/Part export. KPI 1, no man-hours.
   *
   * FEEDBACK is tested first because it shares nothing with either ITSM
   * export: no Ticket ID, and its questions are unmistakable.
   */
  function detectReportType(headers) {
    if (findFeedbackQuestions(headers).length >= 4) return 'FEEDBACK';
    return (headers || []).indexOf('Man*Hour') !== -1 ? 'INDIVIDUAL' : 'OVERALL';
  }


  /**
   * Pulls the module, session title and trainer out of a filename.
   *
   * The feedback form has no field for any of the three, so the filename is
   * the only source. Everything before the first separator is dropped as
   * boilerplate ('Trainee Feedback'), the trailing extension goes, and what
   * is left is split on the last underscore or dash into title and trainer.
   *
   * A guess, and labelled as one on screen - the stored Session Title lets a
   * human check it against the real training record.
   */
  function describeFeedbackFile(fileName) {
    let text = String(fileName || '').replace(/\.(xlsx|xlsm|csv)$/i, '');

    // Drop the 'Trainee Feedback' / 'Training Feedback' prefix and whatever
    // punctuation follows it.
    text = text.replace(/^\s*train(ee|ing)[ _-]*feedback[ _\u2013\u2014-]*/i, '').trim();
    text = text.replace(/^[_\-\u2013\u2014\s]+/, '').trim();

    // The trainer tends to sit last, after an underscore or a dash.
    let title = text;
    let trainer = '';
    const split = text.match(/^(.*?)[ _]*[-\u2013\u2014_][ _]*([A-Za-z .&']{2,40})$/);
    if (split) {
      title = split[1].trim();
      trainer = split[2].trim();
    }

    return {
      title: title || String(fileName || ''),
      trainer: trainer,
      fileName: String(fileName || '')
    };
  }


  /**
   * Which SAP module, from the filename? Mirrors moduleFor() in Config.gs.
   *
   * Kept in the browser rather than round-tripped to the server: the parse
   * needs it per file, and a server call per file would add a round trip to
   * every upload for a string match.
   *
   * @param {string} fileName
   * @param {Array}  modules  [{ name, match: [string] }] - boot.trainingModules
   * @param {Array}  trainers [{ name, match: string }]   - boot.trainerModules
   */
  function detectModule(fileName, modules, trainers) {
    const text = String(fileName || '').toLowerCase();
    const list = modules || [];

    for (let i = 0; i < list.length; i++) {
      const patterns = list[i].match || [];
      for (let j = 0; j < patterns.length; j++) {
        const pattern = String(patterns[j]).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp('(^|[^a-z0-9])' + pattern + '([^a-z0-9]|$)').test(text)) {
          return list[i].name;
        }
      }
    }

    // Last resort: some files are named only after the trainer who ran the
    // session. Mirrors moduleForResponse in Config.gs - this copy exists only
    // so the upload summary can name the module while parsing, without a
    // round trip to the server per file.
    const byTrainer = trainers || [];
    for (let i = 0; i < byTrainer.length; i++) {
      if (new RegExp('(^|[^a-z0-9])' + byTrainer[i].match + '([^a-z0-9]|$)').test(text)) {
        return byTrainer[i].name;
      }
    }
    return '';
  }


  /**
   * Guesses a section from the filename.
   *
   * A hint, not the answer - the section that ends up on the dashboard comes
   * from the roster, keyed on who handled each ticket. This only matters for
   * an individual the org chart does not list, where the filename is the last
   * thing left to go on.
   *
   * Returns '' for a combined export, which is expected and fine.
   *
   * @param {Array} sections [{ name, match }] - boot.departments
   */
  function detectSection(fileName, sections) {
    const lower = String(fileName).toLowerCase();
    const list = sections || [];

    // Matched at a word boundary, not as a bare substring: 'eas' is three
    // letters and sits inside 'release', 'measure' and plenty more. Longest
    // match wins too, so 'Financial_...' cannot be claimed by a shorter
    // pattern that happens to appear inside it.
    let best = '';
    let bestLength = 0;
    list.forEach(function (s) {
      if (!s.match || s.match.length <= bestLength) return;
      const bounded = new RegExp('(^|[^a-z])' + s.match + '([^a-z]|$)');
      if (bounded.test(lower)) {
        best = s.name;
        bestLength = s.match.length;
      }
    });
    return best;
  }


  /** A cell as 'YYYY-MM-DD...', whether it arrived as a Date or as text. */
  function asDate(value) {
    if (value instanceof Date) return formatDate(value);
    const text = String(value === null || value === undefined ? '' : value).trim();
    return /^\d{4}-\d{2}-\d{2}/.test(text) ? text : '';
  }


  /**
   * When did this attendee's session run?
   *
   * TWO SOURCES, AND ONLY ONE OF THEM IS TRUSTWORTHY ON ITS OWN.
   * 'Date & Time' is typed by the attendee, so it carries whatever they wrote
   * and whatever Excel then made of it - a session held in June 2026 came
   * through as January 1974, June 1984, March 1993 and September 2003 across
   * the real files, because a two-digit year typed into a text box is read as
   * a date by Excel when the sheet is opened and saved. 'Completion time' is
   * stamped by the form when the response is submitted and cannot be typed
   * wrong.
   *
   * So the typed date is used only when it agrees with the submission to
   * within FEEDBACK_DATE_TOLERANCE_DAYS - feedback is filled in at the session
   * or within days of it - and the submission timestamp is used otherwise.
   * That is self-calibrating: no hardcoded earliest year to maintain, and it
   * catches a date typed wrong in either direction.
   *
   * @return {Object} { date, submitted, corrected }
   */
  function feedbackDateParts(raw, position) {
    const typed = position.when !== undefined ? asDate(raw[position.when]) : '';
    const submitted = position.completed !== undefined
      ? asDate(raw[position.completed]) : '';

    if (!typed) return { date: submitted, submitted: submitted, corrected: false };
    if (!submitted) return { date: typed, submitted: '', corrected: false };

    const gap = Math.abs(Date.parse(typed.slice(0, 10)) - Date.parse(submitted.slice(0, 10)));
    const days = gap / 86400000;

    if (isFinite(days) && days > FEEDBACK_DATE_TOLERANCE_DAYS) {
      return { date: submitted, submitted: submitted, corrected: true };
    }
    return { date: typed, submitted: submitted, corrected: false };
  }


  function feedbackDate(raw, position) {
    return feedbackDateParts(raw, position).date;
  }


  /**
   * Which cell holds what, in a feedback export.
   *
   * Lifted out of normalizeFeedback so the header matching can be tested on
   * its own. The first column whose name contains the phrase wins, which is
   * why each test is guarded with `=== undefined`: a form with both 'Zone'
   * and 'Zone (if other)' must resolve to the first.
   */
  function feedbackPositions(headers) {
    const position = {};

    (headers || []).forEach(function (name, i) {
      const key = String(name || '').toLowerCase();
      if (key.indexOf('employee id') !== -1 && position.empId === undefined) position.empId = i;
      if (key.indexOf('employee name') !== -1 && position.empName === undefined) position.empName = i;
      if (key.indexOf('plant') !== -1 && position.plant === undefined) position.plant = i;
      // From this quarter the form asks which zone the training was held in,
      // and a Module question is being added the same way. Older exports have
      // neither column and simply leave them blank - which is the truth about
      // them, not a gap to be guessed at. Both are then resolved at scoring
      // time, so the filename remains a fallback and Config stays the place
      // where the mapping can be corrected.
      if (key.indexOf('zone') !== -1 && position.zone === undefined) position.zone = i;
      if (key.indexOf('module') !== -1 && position.module === undefined) position.module = i;
      if (key.indexOf('date') !== -1 && key.indexOf('time') !== -1 &&
          position.when === undefined) position.when = i;
      if (key === 'id' && position.rowId === undefined) position.rowId = i;
      if (key === 'completion time' && position.completed === undefined) position.completed = i;
    });

    return position;
  }


  /**
   * Turns a feedback export into TRAINING rows - one per respondent.
   *
   * The seven answers are stored as the RAW TEXT the attendee chose. Deciding
   * positive from average happens at scoring time, so the classification in
   * Config.gs can be corrected and everything re-scored without re-uploading
   * a single file.
   *
   * @param {Object} file     { fileName, headers, rows } from gridToFile
   * @param {Array}  columns  the 19 training headings, in order
   * @param {Array}  modules  boot.trainingModules, for the moduleFound flag
   * @param {Array}  trainers boot.trainerModules, likewise
   */
  function normalizeFeedback(file, columns, modules, trainers) {
    const found = findFeedbackQuestions(file.headers);
    if (found.length < 4) {
      throw new Error(file.fileName + ' looks like a feedback form but only ' +
                      found.length + ' of the 7 questions were recognised.');
    }

    const position = feedbackPositions(file.headers);
    const meta = describeFeedbackFile(file.fileName);
    const at = function (name) { return columns.indexOf(name); };
    const out = [];

    // ONE FILE MAY HOLD MANY SESSIONS.
    // A single session's export is all one date; a combined quarterly export
    // is not. Lumping a quarter under one session name would make the By
    // session table useless, so the dates are counted first and the date is
    // appended to the title only when there is more than one. A single-session
    // file keeps its plain name, so re-uploading one never changes its rows.
    const sessionDates = {};
    file.rows.forEach(function (raw) {
      const d = feedbackDate(raw, position);
      if (d) sessionDates[d.slice(0, 10)] = true;
    });
    const manySessions = Object.keys(sessionDates).length > 1;

    // Counted so the upload can report how many typed dates it had to
    // overrule, rather than silently rewriting them.
    let corrected = 0;

    file.rows.forEach(function (raw, index) {
      // A respondent is real if they answered at least one scored question.
      const answers = FEEDBACK_QUESTIONS.map(function (q) {
        const hit = found.filter(function (f) { return f.key === q.key; })[0];
        if (!hit) return '';
        const value = raw[hit.at];
        return value === null || value === undefined ? '' : String(value).trim();
      });
      if (!answers.some(function (a) { return a !== ''; })) return;

      const parts = feedbackDateParts(raw, position);
      const date = parts.date;
      if (parts.corrected) corrected++;
      const month = (date.match(/^(\d{4})-(\d{2})/) || []).slice(1, 3).join('-');
      const title = manySessions && date
        ? meta.title + ' \u00b7 ' + date.slice(0, 10)
        : meta.title;

      const rowId = position.rowId !== undefined && raw[position.rowId] !== undefined
        ? String(raw[position.rowId]).trim()
        : String(index + 1);

      const row = columns.map(function () { return ''; });
      row[at('Response ID')]   = meta.fileName + '#' + rowId;
      row[at('Session Date')]  = date.slice(0, 10);
      row[at('Month')]         = month;
      // ONLY what the form itself said. Left blank, the module is worked out
      // at scoring time from the filename and, failing that, the trainer -
      // which means a mapping fixed in Config re-files the responses already
      // stored. Writing a guess in here froze it, and a file the filename
      // could not place stayed '(unassigned)' for good.
      row[at('Module')]        = position.module !== undefined
        ? String(raw[position.module] || '').trim() : '';
      row[at('Session Title')] = title;
      row[at('Trainer')]       = meta.trainer;
      row[at('Plant')]         = position.plant !== undefined ? String(raw[position.plant] || '') : '';
      row[at('Employee ID')]   = position.empId !== undefined ? String(raw[position.empId] || '') : '';
      row[at('Employee Name')] = position.empName !== undefined ? String(raw[position.empName] || '') : '';

      const qCols = ['Q1 Overall', 'Q2 Relevance', 'Q3 Trainer Knowledge', 'Q4 Explanation',
                     'Q5 Materials', 'Q6 Confidence', 'Q7 Duration'];
      qCols.forEach(function (name, i) { row[at(name)] = answers[i]; });

      row[at('Source File')] = meta.fileName;
      row[at('Zone')] = position.zone !== undefined ? String(raw[position.zone] || '').trim() : '';
      out.push(row);
    });

    out.corrected = corrected;
    out.moduleFound = detectModule(file.fileName, modules, trainers) !== '';
    return out;
  }


  /**
   * Turns an ITSM export into TICKET rows.
   *
   * @param {Object} file    { fileName, headers, rows } from gridToFile
   * @param {string} type    'OVERALL' or 'INDIVIDUAL', from detectReportType
   * @param {string} section the section this file is for, or '' for a
   *                         combined export
   * @param {Array}  columns the 29 ticket headings, in order
   */
  function normalizeRows(file, type, section, columns) {
    const position = {};
    file.headers.forEach(function (name, i) {
      if (name && position[name] === undefined) position[name] = i;
    });

    const idIndex = position['Ticket ID'];
    if (idIndex === undefined) {
      throw new Error(file.fileName +
                      ' has no "Ticket ID" column \u2014 is it an ITSM export?');
    }

    const out = [];

    file.rows.forEach(function (raw) {
      const ticketId = String(raw[idIndex] == null ? '' : raw[idIndex]).trim();
      if (!ticketId) return;

      const row = columns.map(function (columnName) {
        switch (columnName) {
          case 'Department':        return type === 'INDIVIDUAL' ? section : '';
          case 'In Overall Report': return type === 'OVERALL';
          case 'In Dept Report':    return type === 'INDIVIDUAL';
          case 'Source Files':      return file.fileName;
          case 'Last Updated':      return '';
        }

        const at = position[columnName];
        if (at === undefined) return '';

        let value = raw[at];
        if (value === null || value === undefined) return '';

        if (columnName === 'Details') {
          value = String(value);
          return value.length > DETAILS_LIMIT
            ? value.slice(0, DETAILS_LIMIT) + '\u2026' : value;
        }
        if (value instanceof Date) return formatDate(value);

        return typeof value === 'number' ? value : String(value);
      });

      out.push(row);
    });

    return out;
  }


  /**
   * Collapses several files' rows into one row per ticket.
   *
   * THIS IS THE SAME MERGE THE SERVER DOES, DONE EARLIER.
   * api/ticket-merge.js merges what arrives against what is already stored;
   * this merges the dropped files against each other first, so that one
   * ticket appearing in the overall export and in its section's export is
   * sent once rather than twice. The two have to agree, and the equivalence
   * test checks that they do on the same inputs.
   */
  function mergeFiles(perFile, columns) {
    const idAt      = columns.indexOf('Ticket ID');
    const overallAt = columns.indexOf('In Overall Report');
    const deptAt    = columns.indexOf('In Dept Report');
    const sourceAt  = columns.indexOf('Source Files');
    const sectionAt = columns.indexOf('Department');

    const byId = {};
    const order = [];

    perFile.forEach(function (rows) {
      rows.forEach(function (row) {
        const id = row[idAt];

        if (!byId[id]) {
          byId[id] = row.slice();
          order.push(id);
          return;
        }

        const kept = byId[id];

        for (let i = 0; i < columns.length; i++) {
          if (i === overallAt || i === deptAt || i === sourceAt) continue;
          if (isBlank(kept[i]) && !isBlank(row[i])) kept[i] = row[i];
        }

        // A ticket can legitimately appear in both reports. OR the flags so
        // the ones appearing in only one stay countable.
        kept[overallAt] = Boolean(kept[overallAt]) || Boolean(row[overallAt]);
        kept[deptAt]    = Boolean(kept[deptAt])    || Boolean(row[deptAt]);

        // A section export is authoritative about which section owns it.
        if (isBlank(kept[sectionAt]) && !isBlank(row[sectionAt])) {
          kept[sectionAt] = row[sectionAt];
        }

        const sources = String(kept[sourceAt] || '').split(' | ')
          .concat(String(row[sourceAt] || '').split(' | '))
          .filter(function (s) { return s.trim() !== ''; });
        kept[sourceAt] = sources.filter(function (s, i) {
          return sources.indexOf(s) === i;
        }).join(' | ');
      });
    });

    return order.map(function (id) { return byId[id]; });
  }


  return {
    DETAILS_LIMIT: DETAILS_LIMIT,
    FEEDBACK_DATE_TOLERANCE_DAYS: FEEDBACK_DATE_TOLERANCE_DAYS,
    FEEDBACK_QUESTIONS: FEEDBACK_QUESTIONS,

    isBlank: isBlank,
    formatDate: formatDate,
    gridToFile: gridToFile,

    findFeedbackQuestions: findFeedbackQuestions,
    detectReportType: detectReportType,
    describeFeedbackFile: describeFeedbackFile,
    detectModule: detectModule,
    detectSection: detectSection,

    asDate: asDate,
    feedbackDateParts: feedbackDateParts,
    feedbackDate: feedbackDate,
    feedbackPositions: feedbackPositions,

    normalizeFeedback: normalizeFeedback,
    normalizeRows: normalizeRows,
    mergeFiles: mergeFiles
  };
}));
