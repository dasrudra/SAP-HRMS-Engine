# TVL-EAS Database

Dashboards for the Enterprise Application Services KPIs defined in
**TVL-KPI-001 v1.0, section 5.3**. Four indicators are defined; two carry data
today:

| | KPI | Formula | Target | Live |
|---|---|---|---|---|
| KPI 1 | Error/Issue Resolution Time | `(Completed Successfully / Total Completed) * 100` | see below | yes |
| KPI 2 | User Training Feedback Analysis | `(Avg Score / Max Score) * 100` | >= 90% | yes |
| KPI 3 | Incident & Emergency Management | - | >= 90% | not yet |
| KPI 4 | Service Availability | - | >= 99.50% | not yet |

**KPI 1 is scored against two standards, from the same counts.** A toggle on
its page switches between them, and every figure, band and chart on the screen
follows it:

| Standard | Target | Yellow floor | Document |
|---|---|---|---|
| Company KPI | >= 90.00% | 85.00% | TVL-KPI-001 v1.0, section 5.3 - the figure reported to TVL headquarters |
| EAS KPI | >= 99.50% | 89.55% | Layer 3 TVL-EAS KPI, Error/Issue Resolution Time - the standard the team holds itself to |

The counts are facts and are stored once. Rate, achievement, band and headroom
are judgements and are recomputed at draw time, which is why two standards need
no second copy of the data.

Data arrives as Excel exports from `itsm.youngone.com` — the **Performance
Report [Service/Part]** and one **Personal Performance Report** per department.
There is no API; upload is the integration.

Built standalone. It merges into the SAP & HRMS Database Center later as two
new sidebar entries below Audit Trail.

---

## Scope

EAS is four departments, which partition cleanly — no ticket appears in two:

| Department | Engineers | Aug 2026 tickets |
|---|---|---|
| Manufacturing Applications | 9 | 754 |
| Sales Applications | 10 | 667 |
| SCM Applications | 8 | 623 |
| Financial Applications | 8 | 501 |

The **union of the four department exports** is the KPI denominator — not the
overall Service/Part report, which also contains work done by engineers outside
EAS.

---

## Setup

### 1. Create the Apps Script project

1. Go to <https://script.google.com> → **New project**
2. Rename it `TVL-EAS Database`
3. Create these files (⊕ next to *Files*), matching the names exactly:

   | File | Type |
   |---|---|
   | `Config.gs` | Script |
   | `Setup.gs` | Script |
   | `Auth.gs` | Script |
   | `Code.gs` | Script |
   | `Ingest.gs` | Script |
   | `Kpi.gs` | Script |
   | `Kpi2.gs` | Script |
   | `Questions.gs` | Script |
   | `Messenger.gs` | Script |
   | `Backup.gs` | Script |
   | `Index.html` | HTML |
   | `Styles.html` | HTML |
   | `Bg.html` | HTML |
   | `App.html` | HTML |
   | `Report.html` | HTML |

4. Paste in the contents from `src/` in this repo
5. Delete the default `Code.gs` stub content first so it isn't duplicated

### 2. Create the database

1. Select `Setup.gs`, choose **`setupDatabase`** from the function dropdown, press **Run**
2. Approve the authorisation prompt — it is asking permission for *this script*
   to use *your* Drive and Sheets
3. The Execution log prints a spreadsheet ID. Copy it.
4. Paste it into `CONFIG.SPREADSHEET_ID` in `Config.gs`
5. Run **`verifySetup`** — every tab should report `OK`

### 3. Deploy

**Deploy → New deployment → Web app**

- Execute as: **Me**
- Who has access: **Only myself** (widen it once login exists)

Open the `/exec` URL it gives you.

> Apps Script does not publish edits automatically. After changing code, use
> **Deploy → Manage deployments → edit → New version**, or test against the
> `/dev` URL which always runs the latest saved code.

---

## Layout

```
src/
├── appsscript.json   manifest — timezone, runtime, web app access
├── Config.gs         every setting: the KPI definitions and both KPI 1
│                     standards, thresholds, tab and column names, policy links
├── Setup.gs          run-once builders for the spreadsheet and its tabs
├── Auth.gs           accounts, password hashing, signed tokens, roles, and the
│                     sign-up and password-reset doors
├── Code.gs           doGet(), include(), bootstrap payload
├── Ingest.gs         receives parsed ticket rows from the browser and stores
│                     them; the .xlsx parsing itself happens in the browser
├── Kpi.gs            KPI 1 — monthly figures, the two standards, sections,
│                     affiliates, the people tables and the comparison
├── Kpi2.gs           KPI 2 — training feedback
├── Questions.gs      the published FAQ, read from a tab on every page load
├── Messenger.gs      question threads between viewers and admins, and the
│                     notification emails
├── Backup.gs         scheduled Drive copies of the whole workbook, and
│                     pruning of the sign-in log
├── Index.html        page shell and the views
├── Styles.html       all CSS, inlined at render time
├── Bg.html           the sign-in picture
├── App.html          all browser JavaScript, inlined at render time
└── Report.html       "Download as Report" — builds a real .xlsx per table
```

### The two worlds

`.gs` runs on Google's servers and can reach Sheets, Drive and Gmail but cannot
touch the page. `<script>` inside `.html` runs in the browser and can draw the
page but cannot reach a spreadsheet. The only bridge is:

```javascript
google.script.run
  .withSuccessHandler(function (data) { render(data); })
  .withFailureHandler(function (err)  { showError(err); })
  .getBootstrap();                       // a function in Code.gs
```

### Storage

| Tab | Key | Holds |
|---|---|---|
| `TICKETS` | Ticket ID | Normalised tickets + man-hours + provenance |
| `KPI_MONTHLY` | month + scope | Precomputed KPI results |
| `TRAINING` | session + attendee | KPI 2 feedback scores |
| `KPI_CONFIG` | KPI + effective from | Editable targets and thresholds |
| `UPLOAD_LOG` | upload ID | Audit evidence for every file loaded |
| `OPERATORS` | operator | Login and role |

`Ticket ID` is the primary key. Uploads **upsert** on it, so re-uploading an
overlapping date range corrects rows instead of duplicating them.

---

## Known quirks in the ITSM exports

Handled by the parser, listed here so they don't surprise anyone:

- `' Category'` and `' Sub Category'` ship with a **leading space** in the header
- `Delay Days` arrives as int in one export and float in another
- Request Date is date-only from the Personal report, full timestamp from Service/Part
- Some Completion Date cells contain **whitespace only** — these count as incomplete
- `Man*Hour` contains a literal asterisk
- `Processing M/H (Level1)`, `CTS Number` and `Remarks` are empty in every export seen so far
- The two reports **do not reconcile**: for August 2026, 9 tickets appear only
  in the overall report and 6 only in the department files. Both are ingested
  and the difference is reported rather than hidden.

---

## Security

- **Never commit ITSM exports.** They carry employee names, IDs, emails and full
  ticket bodies. `.gitignore` blocks `*.xlsx` and `*.csv`.
- **Never commit `.clasp.json`** — it holds the script ID.
- **Never commit the deployment URL or any operator password.**
- **This repository is public, and the code in it is meant to be read.** The
  data is not: no export, no spreadsheet ID, no password and no deployment URL
  belongs in a commit. `.gitignore` blocks `*.xlsx`, `*.csv` and `*.pdf`, which
  is a backstop and not a substitute for checking what you are staging.
- Every role check runs on the server. In Apps Script **every global function
  is an endpoint**, reachable by anyone who can open the page, so a check that
  lives only in the browser is not a check at all. Each endpoint takes a signed
  token as its first argument and verifies it before doing anything.

---

## Status

- [x] Project scaffold, config, storage bootstrap
- [x] App shell with URL-backed state (survives refresh)
- [x] Excel parser and upsert pipeline
- [x] KPI 1 calculation engine, scored against both standards
- [x] KPI 1 dashboard — sections, affiliates, per-person tables, comparison
- [x] KPI 2 dashboard
- [x] Accounts: sign-up, sign-in, password reset, roles, signed tokens
- [x] Questions and FAQ, with email notification
- [x] Download as Report (.xlsx) on every table
- [ ] Backups have never been run — `installBackupTrigger()` is written but
      has not been executed, so no backup exists yet
- [ ] KPI 3 and KPI 4 — defined in `Config.gs`, no ingest yet
- [ ] Move off Google Sheets onto a real database (undecided)
- [ ] Merge into the SAP & HRMS Database Center
