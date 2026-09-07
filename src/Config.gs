/**
 * Config.gs — every setting the app has, in one file.
 *
 * WHY THIS FILE EXISTS
 * Nothing else in the project hardcodes a target, a threshold or a sheet name.
 * When the KPI Review Committee changes a target, you edit it here and nowhere
 * else. Policy TVL-KPI-001 §6 calls the current KPIs "illustrative... to be
 * finalized", so they WILL change.
 *
 * APPS SCRIPT NOTE
 * There are no `import` or `require` statements in Apps Script. Every .gs file
 * in the project shares one global namespace, so `CONFIG` declared here is
 * visible from Code.gs, Setup.gs and Kpi.gs automatically. File order does not
 * matter for constants like this.
 */

const CONFIG = {

  /**
   * Fallback spreadsheet ID.
   *
   * NORMALLY LEAVE THIS null. The real ID lives in Script Properties, outside
   * the code, so that replacing this file cannot disconnect the database —
   * which is exactly what used to happen every time a new Config.gs was
   * pasted in.
   *
   * This slot is only a bootstrap: put an ID here, run
   * saveSpreadsheetIdToProperties() once, and it moves into Script Properties
   * for good. After that this can go back to null and stay there.
   *
   * A spreadsheet ID is the long string in its URL:
   *   docs.google.com/spreadsheets/d/[[ THIS PART ]]/edit
   */
  SPREADSHEET_ID: null,

  /** Shown in the sidebar. Bump it when you deploy something meaningful. */
  APP_NAME: 'EAS KPI Engine',
  APP_VERSION: 'v0.1',

  /**
   * The four departments that make up Enterprise Application Services.
   *
   * This list is the definition of "EAS" for the whole system. It was derived
   * from the four Individual Performance exports, which partition cleanly —
   * no ticket appears in two departments.
   *
   * `match` is what we look for in an uploaded filename to auto-detect which
   * department a file belongs to (case-insensitive).
   */
  DEPARTMENTS: [
    { key: 'MFG', name: 'Manufacturing Applications', match: 'manufacturing' },
    { key: 'SLS', name: 'Sales Applications',         match: 'sales'         },
    { key: 'SCM', name: 'SCM Applications',           match: 'scm'           },
    { key: 'FIN', name: 'Financial Applications',     match: 'financial'     }
  ],

  /**
   * The four TVL-EAS KPIs, each from its own signed definition sheet.
   *
   * Every one shares the same shape:
   *   Actual Success Rate (%) = (numerator / denominator) x 100
   *   KPI Achievement (%)     = (Actual Rate / Target Rate) x 100
   *
   * The band boundaries look arbitrary and are not. Three of the four put the
   * yellow floor at exactly 90% achievement — 89.55/99.50 = 0.90, 81.00/90.00
   * = 0.90. Layer 1 is the exception and is far stricter: 99.50/99.90 = 0.996,
   * so its yellow floor is 99.60% achievement.
   *
   * `active` marks the ones with a working data pipeline. The others are
   * defined so the thresholds and layers are visible now; their ingest arrives
   * when the data does.
   */
  KPI: {
    RESOLUTION: {
      id: 'KPI1',
      name: 'Error/Issue Resolution Time',
      shortName: 'Resolution Time',
      layer: 3,
      slaLayer: 'Layer 3: Service Requests',
      formula: '(Completed Successfully ÷ Total Completed) × 100',
      target: 99.50,        // green at or above this
      yellowFloor: 89.55,   // below this is red
      unit: '%',
      period: 'monthly',
      active: true          // has a working ingest pipeline
    },

    FEEDBACK: {
      id: 'KPI2',
      name: 'SAP User Training Satisfaction & Feedback',
      shortName: 'Training Feedback',
      layer: 3,
      slaLayer: 'Layer 3: Service Requests',
      // Revised formula. The earlier policy text said Avg Score / Max Score;
      // the signed definition sheet replaces it with a positive-response ratio,
      // and resolves the old contradictory thresholds (<90 yellow AND <60 red)
      // into a clean 81.00–89.99 band.
      formula: '(Total Positive Responses ÷ Total Applicable Responses) × 100',
      target: 90.00,
      yellowFloor: 81.00,
      unit: '%',
      period: 'monthly',
      active: false         // waiting on the feedback data
    },

    INCIDENT: {
      id: 'KPI3',
      name: 'Incident & Emergency Management',
      shortName: 'Incident Mgmt',
      layer: 1,
      slaLayer: 'Layer 1: Incident & Emergency Management',
      formula: '(Incidents Resolved Within Target ÷ Total Incidents) × 100',
      // The strictest of the four: the yellow floor sits at 99.60%
      // achievement rather than the 90% the other three use.
      target: 99.90,
      yellowFloor: 99.50,
      unit: '%',
      period: 'monthly',
      active: false
    },

    AVAILABILITY: {
      id: 'KPI4',
      name: 'SAP Server Availability',
      shortName: 'Server Availability',
      layer: 2,
      slaLayer: 'Layer 2: Service Availability',
      formula: '(Scheduled Time − Unplanned Downtime) ÷ Scheduled Time × 100',
      target: 99.50,
      yellowFloor: 89.55,
      unit: '%',
      period: 'monthly',
      active: false
    }
  },

  /** Display order for the settings and comparison screens. */
  KPI_ORDER: ['RESOLUTION', 'FEEDBACK', 'INCIDENT', 'AVAILABILITY'],

  /** Tab names inside the spreadsheet. Change here, changes everywhere. */
  SHEETS: {
    TICKETS:   'TICKETS',
    KPI_MONTH: 'KPI_MONTHLY',
    TRAINING:  'TRAINING',
    UPLOADS:   'UPLOAD_LOG',
    CONFIG:    'KPI_CONFIG',
    OPERATORS: 'OPERATORS'
  },

  /**
   * Column layout of the TICKETS tab.
   *
   * The first 22 come straight from the ITSM export in its own order. The
   * Individual Performance report adds three man-hour columns. The last five
   * are ours — they record where each row came from, which matters because
   * policy §5.4 puts Internal Audit on our source data.
   *
   * Two traps baked in here on purpose:
   *   - The ITSM ships ' Category' and ' Sub Category' with a LEADING SPACE.
   *     We store them trimmed; the parser handles the mapping.
   *   - 'Man*Hour' contains an asterisk. It is a literal part of the header.
   */
  TICKET_COLUMNS: [
    'Ticket ID',            // primary key — unique across every export we have checked
    'Affiliate',
    'Service',
    'Part',
    'Process',
    'Category',
    'Sub Category',
    'Title',
    'Details',
    'Request Date',
    'Requestor',
    'Current Activity',
    'Current Activity Date',
    'Current Activity In Charge',
    'Due date',
    'Completion Date',
    'Lead-time',
    'Delay Days',
    'Status',
    'CTS Number',
    'Remarks',
    'Acceptance M/H (Level1)',
    'Processing M/H (Level1)',
    'Man*Hour',
    // ---- our own provenance columns ----
    'Department',           // which EAS department file this came from
    'In Overall Report',    // TRUE if the Service/Part export contained it
    'In Dept Report',       // TRUE if a department export contained it
    'Source Files',         // filenames that contributed to this row
    'Last Updated'          // when we last wrote this row
  ],

  /** Column layout of UPLOAD_LOG — the audit evidence trail. */
  UPLOAD_COLUMNS: [
    'Upload ID', 'Uploaded At', 'Uploaded By', 'File Name', 'Report Type',
    'Department', 'Rows In File', 'Rows Added', 'Rows Updated',
    'Date From', 'Date To', 'Notes'
  ],

  /** Column layout of KPI_MONTHLY — precomputed so the dashboard reads fast. */
  KPI_COLUMNS: [
    'Month', 'Scope Type', 'Scope Value', 'Received', 'Total Completed',
    'Completed With Delay', 'Completed Successfully', 'Success Rate',
    'KPI Achievement', 'Band', 'Headroom', 'Computed At'
  ],

  /** How many rows the browser sends per server call during an upload. */
  UPLOAD_BATCH_SIZE: 500
};


/** Script Property key the spreadsheet ID is stored under. */
const SPREADSHEET_ID_KEY = 'EAS_SPREADSHEET_ID';


/**
 * The spreadsheet this app uses.
 *
 * Script Properties first, CONFIG.SPREADSHEET_ID second. Properties belong to
 * the Apps Script project rather than to any file, so they survive every code
 * change — pasting a fresh Config.gs can no longer disconnect the database.
 *
 * @return {string|null}
 */
function getSpreadsheetId() {
  try {
    const stored = PropertiesService.getScriptProperties().getProperty(SPREADSHEET_ID_KEY);
    if (stored) return stored;
  } catch (e) { /* fall through to the config value */ }

  return CONFIG.SPREADSHEET_ID || null;
}


/**
 * Which band does a success rate fall into?
 *
 * Used by KPI 1 and KPI 2 both — they have different numbers but identical
 * shape (green at or above target, red below a floor, yellow between).
 *
 * @param {number} rate  the computed percentage
 * @param {Object} kpi   one of CONFIG.KPI.*
 * @return {string} 'GREEN' | 'YELLOW' | 'RED'
 */
function bandFor(rate, kpi) {
  if (rate >= kpi.target) return 'GREEN';
  if (rate >= kpi.yellowFloor) return 'YELLOW';
  return 'RED';
}


/**
 * KPI Achievement (%) = (Actual / Target) x 100.
 *
 * @param {number} rate  the actual success rate
 * @param {Object} kpi   one of CONFIG.KPI.*
 * @return {number}
 */
function achievementFor(rate, kpi) {
  return (rate / kpi.target) * 100;
}


/**
 * How many more delayed tickets before we drop out of green?
 *
 * This is the number the dashboard should lead with. In August 2026 the EAS
 * figure was 1 — the department passed by a single ticket. A band alone does
 * not tell you that; headroom does.
 *
 * Green requires:  successful / completed >= target/100
 * so the minimum successful count is ceil(target/100 * completed).
 *
 * @param {number} completed   total completed tickets
 * @param {number} successful  completed minus delayed
 * @param {Object} kpi         one of CONFIG.KPI.*
 * @return {number} positive = spare delays available, 0 = on the edge,
 *                  negative = already below target
 */
function headroomFor(completed, successful, kpi) {
  if (!completed) return 0;
  const minimumNeeded = Math.ceil((kpi.target / 100) * completed);
  return successful - minimumNeeded;
}
