/**
 * kpi-config.js - the four indicators, and which of them have data.
 * ===========================================================================
 *
 * CONFIG.KPI and CONFIG.KPI_ORDER from src/Config.gs, which is what
 * `getBootstrap` sends as `kpiList` and what the Comparison screen's
 * selector is built from.
 *
 * THE TWO LIVE ONES ARE NOT WRITTEN OUT AGAIN HERE. KPI 1 lives in
 * api/kpi.js and KPI 2 in api/kpi2.js, because that is where the arithmetic
 * that scores them lives and a target has to sit beside the code that bands
 * against it. This file adds the fields those two did not need - the policy
 * flag, the SLA layer, the formula - and supplies the two that have no
 * arithmetic at all.
 *
 * Config.gs says why that matters, about a different pair:
 *
 *     "two hand-maintained copies drift: a correction to the formula
 *      string, the SLA layer or the measure name would land on one and not
 *      the other, and the two screens would quietly start describing
 *      themselves differently."
 *
 * So `target`, `yellowFloor` and `unit` for KPI 1 and KPI 2 are read from
 * those modules and never retyped. If somebody changes KPI 1's target in
 * kpi.js, the Comparison screen's caption changes with it.
 *
 * WHY KPI 3 AND KPI 4 ARE LISTED AT ALL, having no ingest and no screen.
 * App.html is explicit: "Every KPI is selectable - a disabled option tells
 * you nothing about why." They are part of the approved policy, somebody
 * will look for them, and a selector that simply omits them says they do
 * not exist. Picking one shows what it is and that nothing has been
 * uploaded against it, which is the true answer.
 */

const kpi = require('./kpi');
const kpi2 = require('./kpi2');


/**
 * The document the three policy KPIs are transcribed from.
 *
 * CONFIG.POLICY. A screen can cite it by name and version, and an indicator
 * with no definition link of its own falls back to it.
 */
const POLICY = {
  code: 'TVL-KPI-001',
  version: 'v1.0',
  section: '5.3',
  name: 'TVL-KPI-001 v1.0, section 5.3'
};


/* KPI 1, from api/kpi.js plus the fields the arithmetic did not need. */
const RESOLUTION = Object.assign({}, kpi.KPI_RESOLUTION, {
  policy: true,
  layer: 3,
  slaLayer: 'Layer 3: Service Requests',
  formula: '(Completed Successfully \u00f7 Total Completed) \u00d7 100',
  active: true          // has a working ingest pipeline
});

/* KPI 2. Already complete in api/kpi2.js - taken as it stands. */
const FEEDBACK = Object.assign({}, kpi2.KPI_FEEDBACK);

/*
  KPI 3. Config.gs records at length that this entry used to be wrong in
  three different ways at once, and that the approved policy settled it:

      "The EAS Layer 1 indicator is Incident Notification Timeliness, and
       it measures how promptly an incident is REPORTED to the central
       support team, not how quickly it is fixed. Resolution is Layer 3's
       business, and that is KPI 1."

  Carried over word for word, because the distinction is the whole reason
  no ingest was ever written for it.
*/
const INCIDENT = {
  id: 'KPI3',
  name: 'Incident Notification Timeliness',
  shortName: 'Notification Timeliness',
  policy: true,
  layer: 1,
  slaLayer: 'Layer 1: Incident & Emergency Management',
  measure: 'Actual Success Rate (%)',
  formula: '(Incidents Notified Within SLA \u00f7 Total Applicable Incidents) ' +
           '\u00d7 100',
  target: 90.00,
  yellowFloor: 85.00,
  unit: '%',
  period: 'monthly',
  active: false
};

const AVAILABILITY = {
  id: 'KPI4',
  name: 'SAP Service Availability',
  shortName: 'Service Availability',
  policy: true,
  layer: 2,
  slaLayer: 'Layer 2: Service Availability',
  measure: 'SAP Availability (%)',
  formula: '(Scheduled Time \u2212 Unplanned Downtime) \u00f7 Scheduled Time ' +
           '\u00d7 100',
  target: 99.50,
  yellowFloor: 89.55,
  unit: '%',
  period: 'monthly',
  active: false
};


/* CONFIG.KPI_ORDER. The order the selector and the Summary table show. */
const KPI_LIST = [RESOLUTION, FEEDBACK, INCIDENT, AVAILABILITY];


/**
 * KPI 1'S TWO STANDARDS, in the order the toggle shows them.
 *
 * The same tickets and the same two formulas scored against two targets:
 * the policy's 90%, which is what goes to TVL headquarters, and the EAS
 * team's own 99.50%. Sent so that a figure printed on a screen cannot
 * disagree with the target it was scored against.
 */
const KPI1_STANDARDS = [
  Object.assign({}, RESOLUTION),
  Object.assign({}, RESOLUTION, kpi.KPI_RESOLUTION_EAS)
];


/**
 * Which period a KPI is compared by.
 *
 * KPI 1 compares MONTHS: tickets arrive daily, so a month is a full
 * reading. KPI 2 compares QUARTERS, for the reason App.html gives - "a
 * module is trained once or twice a quarter, so month by month is mostly
 * empty columns and the rest carry a rate over a handful of responses.
 * Comparing two of those compares noise."
 */
function periodKindOf(kpiId) {
  return kpiId === 'KPI2' ? 'QUARTER' : 'MONTH';
}


module.exports = {
  POLICY, KPI_LIST, KPI1_STANDARDS, periodKindOf,
  RESOLUTION, FEEDBACK, INCIDENT, AVAILABILITY
};
