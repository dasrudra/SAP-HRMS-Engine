# EAS KPI Engine

Dashboards for the two Enterprise Application Services KPIs defined in
**TVL-KPI-001 v1.0 §6.3**:

| | KPI | Formula | Target |
|---|---|---|---|
| KPI 1 | Error/Issue Resolution Time | `(Completed Successfully ÷ Total Completed) × 100` | ≥ 99.50% monthly |
| KPI 2 | User Training Feedback Analysis | `(Avg Score ÷ Max Score) × 100` | ≥ 90% |

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
2. Rename it `EAS KPI Engine`
3. Create these files (⊕ next to *Files*), matching the names exactly:

   | File | Type |
   |---|---|
   | `Config.gs` | Script |
   | `Setup.gs` | Script |
   | `Code.gs` | Script |
   | `Index.html` | HTML |
   | `Styles.html` | HTML |
   | `App.html` | HTML |

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
├── Config.gs         every setting: targets, thresholds, sheet + column names
├── Setup.gs          run-once builders for the spreadsheet and its tabs
├── Code.gs           doGet(), include(), bootstrap payload
├── Index.html        page shell and the four views
├── Styles.html       all CSS, inlined at render time
└── App.html          all browser JavaScript, inlined at render time
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
- This repository must be **private** before real data or the spreadsheet ID
  goes anywhere near it.

---

## Status

- [x] Project scaffold, config, storage bootstrap
- [x] App shell with URL-backed state (survives refresh)
- [ ] Excel parser and upsert pipeline
- [ ] KPI 1 calculation engine
- [ ] KPI 1 dashboard
- [ ] KPI 2 dashboard
- [ ] Merge into the Database Center
