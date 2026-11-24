# Port inventory - what the Apps Script system does, and what has moved

Nothing is retired until its row here says DONE and Rudra has used the
replacement. This file is the contract: if a feature is not in it, it has
not been counted, and the port is not finished.

Counted on 2026-11-18 from the repository, not from memory:

| | |
|---|---|
| Server code | 17,064 lines across 16 `.gs` files |
| Page code | `src/App.html` plus 6 more HTML files |
| Server endpoints the page calls | **50** |
| Screens | **20** |
| Spreadsheet tabs | **17** |
| Roles | **3** - USER < ADMIN < MASTER |

Status values: `DONE` - ported and tested. `PART` - partly ported.
`TODO` - not started. `KEEP` - deliberately staying on Apps Script for now.

---

## Roles

`Auth.gs` line 86: `const ROLE_RANK = { USER: 1, ADMIN: 2, MASTER: 3 };`

Every permission check asks whether a rank is high ENOUGH, never whether it
equals one value. MASTER is not decoration - `requireMaster()` guards
account creation, password resets, role changes, the audit log, sign-up
opening, and one Messenger action.

| Role | Rank | Can |
|---|---|---|
| USER | 1 | read own data, send messages, tick own objectives |
| ADMIN | 2 | the team inbox, uploads, everything a USER can |
| MASTER | 3 | accounts, roles, password resets, audit log, sign-ups |

**Status: DONE.** `account.role` accepts all three; `requireAdmin` compares
rank so MASTER passes an ADMIN gate; `requireMaster` added.

> Caught during this inventory: the first schema listed only USER and ADMIN,
> and `requireAdmin` used `role !== 'ADMIN'` - which would have deleted the
> MASTER tier AND locked the highest role out of every admin screen.

---

## api/public/demo.html is NOT the new interface

It is a test harness: about 290 lines against `src/App.html`'s 28,403. It
exists to prove the API returns correct data and to show the response time,
and it is thrown away when the real front end arrives.

**Nothing in `src/App.html` has been changed, and nothing in it will be
dropped.** The interface is ported as its own stage, after the endpoints,
and it reproduces the existing design exactly - the same discipline applied
to the arithmetic, where an equivalence test proves the port answers what
the original answered. Where a screen's behaviour is not obvious from the
code it is written down under "Behaviour that is easy to lose" below.

Judge the demo page on whether the data is right. Judge nothing else by it.

## Screens

| Screen | What it is | Status |
|---|---|---|
| `home` | landing page, cards into everything else | TODO |
| `kpi1` | KPI 1 - ITSM ticket dashboard | TODO |
| `kpi2` | KPI 2 - Training dashboard | TODO |
| `compare` | comparison between periods | TODO |
| `objective` | SMART objectives and Unique Roles | TODO |
| `team` | EAS Team directory with presence | **PART** |
| `knowledge` | Knowledge Share posts | TODO |
| `learnings` | LEARN entries | TODO |
| `byweekly` | By-Weekly meeting links | TODO |
| `links` | portal links, incl. TVL Knowledge Base | TODO |
| `uploads` | CSV upload and history | TODO |
| `master` | Accounts (MASTER only) | TODO |
| `help` | Help / FAQ - the team inbox (ADMIN+) | TODO |
| `settings` | shown as "Summary" | TODO |
| `about` | about page | TODO |
| `contact` | contact page | TODO |
| `partners` | partners page | TODO |
| `projects` | projects page | TODO |
| `mark` | internal | TODO |
| `wait` | loading/waiting state | TODO |

`team` is PART: the directory and presence display are ported; photos,
section grouping and the away toggle are not.

**The internal name `settings` must not be renamed.** It is shown as
"Summary" but every saved bookmark uses `?view=settings`.

---

## The 50 endpoints

### Auth and accounts
| Endpoint | Status | Notes |
|---|---|---|
| `login` | DONE | `POST /api/login` |
| `getSession` / `renewToken` / `logout` | PART | `/api/me` covers the first |
| `changeMyPassword` | TODO | |
| `masterListAccounts` | PART | `/api/accounts`, admin+ |
| `masterSetDetails` | TODO | MASTER |
| `masterResetPassword` | TODO | MASTER |
| `masterGrantToEmployeeId` | TODO | MASTER |
| `masterSetSignups` / `signupsAreOpen` | TODO | MASTER |
| `masterAuditLog` | TODO | MASTER, AUTH_LOG tab |

Not yet ported and important: **sign-in lockout already exists in Auth.gs**
(`attemptKey`, `recordFailure`, `clearFailures`, `lockoutRemaining`). The new
API has its own in-memory version. Behaviour must be compared before the old
one is switched off.

### Bootstrap and shell
| Endpoint | Status |
|---|---|
| `getBootstrap` | TODO |
| `getByWeeklyLinks` | `GET /api/byweekly` - DONE (plus a new MASTER-only `POST` to set an address) |

### Team and presence
| Endpoint | Status | Notes |
|---|---|---|
| `getTeam` | DONE | `GET /api/team` |
| `getPresence` | DONE | `GET /api/presence` |
| `presenceTick` | DONE | `POST /api/presence/tick` |
| `presenceClear` | DONE | `POST /api/presence/clear` |
| `getPeopleByAffiliate` / `listAffiliates` | TODO | |

### KPI
| Piece | Status |
|---|---|
| the KPI 1 arithmetic - `scoreRows`, `isCompleted`, `toNumber`, `bandFor`, `achievementFor`, `headroomFor`, `groupBy`, `groupByKey`, `round2`, `monthsInScope`, `quarterOf`, `monthsOfQuarter`, `quarterLabel`, `quarterScheme` | DONE - `api/kpi.js` |
| `sectionFor`, `matchPerson`, `rosterIndex`, `rosterOrderFor` | DONE - `api/roster.js`, table `roster`, filled by `node api/import-roster.js` |
| `getKpi1`, `readKpi1` | DONE - `GET /api/kpi1`, `api/kpi-read.js` |
| `moduleForTicket`, `moduleFromPart`, `moduleForPerson`, `ticketModulePatterns`, `personModuleIndex`, `whyModule` | DONE - `api/modules.js`, exceptions on `roster.module` |
| `getKpiComparison` | DONE - `GET /api/kpi1/compare` |
| `getPeopleByAffiliate`, `listAffiliates` | TODO |
| `recomputeKpiCache`, `recomputeAfterUpload` | NOT PORTED, deliberately - see below |
| the ticket merge (`mergeRows`, `stampOf`, `isBlank`, `truthy`) | DONE - `api/ticket-merge.js`, shared by the CSV importer and the Uploads screen |
| the KPI 2 arithmetic - `normaliseAnswer`, `answerTier`, `answerTiers`, `moduleFor`, `scoreFeedback`, `byRespondents`, `FEEDBACK_ANSWERS`, `TRAINING_MODULES`, `QUESTION_LABELS` | DONE - `api/kpi2.js`, table `training` |
| `getKpi2`, `comparisonEntry`, `byQuarterKey` | DONE - `GET /api/kpi2`, `api/kpi2-read.js` |
| `getKpi2Comparison` | DONE - `GET /api/kpi2/compare` |
| `listFeedbackMonths`, `listFeedbackQuarters` | DONE - `GET /api/kpi2/periods` |
| `runKpi2SelfTest` | NOT PORTED - `api/kpi2-equivalence-test.js` does more than it did |

`api/kpi.js` is pure arithmetic and is proved identical to `src/Kpi.gs` and
`src/Config.gs` by `api/kpi-equivalence-test.js` - **16,239 comparisons**,
in `npm test`, needing nothing switched on. 21 deliberate breaks were made
and all 21 were caught.

`api/kpi2.js` is the same arrangement: **27,991 comparisons** across 42
checks, against the real `normaliseAnswer`, `answerTier`, `moduleFor`,
`scoreFeedback` and `CONFIG.TRAINING_COLUMNS`, lifted out of
`src/Config.gs`, `src/Kpi.gs` and `src/Kpi2.gs` at run time. 31 mutations,
29 caught; the two survivors are equivalent and each now has an assertion
pinning the reason.

The nineteen-column feedback layout is compared heading by heading, in
order, because it is the one piece of KPI 2 that the Uploads screen also
depends on: `kpi2.TRAINING_COLUMNS` is what turns a row of an `.xlsx` into
a row of the `training` table, and a column list that drifts from
`CONFIG.TRAINING_COLUMNS` would file every answer under the wrong question
without failing anything.

**KPI 2 is NOT a policy KPI and that survives the port.** Config.gs is
blunt: TVL-KPI-001 section 5.3 gives EAS three KPIs and this is not one of
them, so it "must never be presented as though it were". `policy: false` is
carried through, and the equivalence suite fails if it changes.

**Two things about KPI 2 that are easy to get wrong and silent when you do:**

- **An answer nobody anticipated is UNKNOWN**, which counts in the
  denominator and never in the numerator. An unrecognised form wording
  therefore *lowers* the rate and shows on screen, rather than quietly
  inflating it.
- **No data is not nought per cent.** A module nobody was asked about gets
  band `NO DATA`, not `RED`. `bandFor(0)` is `RED`, so the guard that
  produces `NO DATA` is load-bearing; the matching guard on `achievement`
  is not, because `achievementFor(0)` is already 0. Both are written down
  in `api/kpi2.js` so neither gets tidied away by mistake.

**The target moved on 1 October 2026 and history is NOT frozen.**
`Config.gs` records that KPI 1 was 99.50 / 89.55 and that TVL-KPI-001 v1.0
sets it to 90.00 / 85.00: "the bands are worked out from these numbers
every time a screen is drawn - so every month shown, past and present, is
scored against the policy in force today." Months the old figure called
YELLOW or RED are GREEN now, deliberately. Nothing in the port caches a
band, so there is nothing that could freeze an old one into place. The
equivalence test scores against the old thresholds as well as the current
ones, so putting them back would still agree with `Kpi.gs`.

**Headroom is the number the dashboard should lead with.** In August 2026
the EAS figure was 1 - the department passed by a single ticket. A band
alone does not tell you that.

**Three branches needed contrived inputs to test at all**, and they are
noted in the test rather than left to rot: the `instanceof Date` guard
(indistinguishable from the line under it for any value a spreadsheet
produces), the `completed ? ... : 0` guards (invisible at target 90,
because 0/90 is 0 either way - they only show at target 0), and the
cross-calendar-year quarter arithmetic (unreachable while both schemes
start in January).

### Objectives
| Endpoint | Status | Notes |
|---|---|---|
| `getObjectives` | DONE | `GET /api/objectives` |
| `recordObjMilestone` | DONE | `POST /api/objectives/record-milestone` |
| `createObjMilestone` | TODO | |
| `tickObjTask` | DONE | `POST /api/objectives/tick-task` |
| `tickObjMilestone` | DONE | `POST /api/objectives/tick-milestone` |
| `saveObjSlotNote` | DONE | `POST /api/objectives/note` |

The arithmetic (`objCountState`, `objTallyTotal`, `objTallyShare`,
`objSlotCount`, `objWorkingDays`, `objDaysInMonth`, `objIsQuarterEnd`) is
ported in `api/objectives.js` and **proved identical to Objective.gs over
3,248 comparisons** by `api/equivalence-test.js`, which lifts the real
functions out of the .gs file rather than describing what they should do.
Run both with `npm test` in `api`.

That test earned its place on its first run: the port had hard-coded a
five-day Sun-Thu week, while Config.gs says WORK_DAYS: [0,1,2,3,4,6] - six
days, Saturday included, only Friday off. Every DAILY objective would have
been 4 to 5 squares short in its denominator, every month.

The slot state machine is ported too - `objTaskState`, `objSlotsElapsed`,
`objSlotsOpen`, `objSlotEnd`, the marks string (`objMarksRead`,
`objMarksSet`, `objMarksBlank`, `objMarksCount`) and `objPeriodOf`. The
equivalence test now runs **21,689 comparisons**, including every slot
boundary at 23:59:59.999 and one millisecond either side.

Three deliberate mutants were used to check the test is not vacuous:
making a late mark count as on-time (312 differences), accepting any
character into the marks string (18), and treating today as elapsed (136 -
and this one SURVIVED until the boundary times were added, because every
test `now` was midday and slot ends are at 23:59:59.999).

`objProgressAll` is ported too, with everything under it: `objTaskSquares`,
`objPlanSquares`, `objPlanMonthState`, `objMilestoneScore`, `objLogKey`,
`objPeriods`, `objPeriodIndex`, `objPeriodCell`, `objTally`. This is what
feeds the two summary cards. **23,415 comparisons, all identical.**

Eight deliberate mutants, all caught: late marks counting as on-time (454
differences), today counting as elapsed (136), the marks string accepting
any character (18), the four KPIs no longer excluded (72), `overall`
counting future months (48), an uncounted auto month going green (96),
PERIOD targets ceasing to be cumulative (59), and each percentage share
rounded separately instead of by subtraction (357).

Two of those only became catchable after the test itself was fixed - see
the commit log. The fixture generator was taking `next() % 4` from the low
bits of a linear congruential generator, which cycle almost immediately,
so nearly every log row was skipped and the whole objProgressAll suite was
running against an almost-empty log.

Still TODO: The two summary cards - **Progress
this month** and **Overall progress** - depend on those.

### Messenger
| Endpoint | New route | Status |
|---|---|---|
| `myMessages` | `GET /api/messages/mine` | DONE |
| `markMyMessagesRead` | `POST /api/messages/read` | DONE |
| `listThreads` | `GET /api/messages/threads` | DONE |
| `messagesWaiting` | `GET /api/messages/waiting` | DONE |
| `messengerBoot` | `GET /api/messages/boot` | PART - `faq` is empty until the FAQ tab is ported |
| `sendMessage` | `POST /api/messages/send` | DONE |
| `sendUnverifiedMessage` | `POST /api/messages/signin` | DONE |
| `replyToThread` | `POST /api/messages/reply` | DONE |
| `attachSignInThread` | `POST /api/messages/attach` | DONE |
| `deleteThread` | `POST /api/messages/delete` | DONE |
| `getChatImage`, `saveChatImages` | - | TODO - needs a file store |

Read side: `api/messenger-read.js`, write side `api/messenger-write.js`,
tables in `db/08-messenger.sql` plus `db/09-account-name.sql`. Tested by
`api/messenger-test.js` (52 checks, 13 deliberate breaks, none survived)
and `api/messenger-write-test.js` (96 checks, 21 deliberate breaks, none
survived).

**Attachments are dropped and the sender is told, which is what the live
system does today.** `saveChatImages` returns `[]` and writes nothing when
no folder is configured, and `CHAT_FOLDER` has never been set on the live
script - so the port matches it exactly, down to the wording "N images
could not be attached". When a file store is chosen, `saveChatImages` in
`messenger-write.js` is the only function that changes. The limits are
already recorded there: three images a line, three megabytes each, images
only, checked server-side.

**No email is sent yet.** `alertTeamOfMessage` needs SMTP, which this port
has not set up. The decision it drives is ported and tested - the team is
only nudged when it is not already sitting on something unanswered in that
same query, because "four lines in a row while somebody thinks out loud is
one interruption, not four" - and the endpoints return `wouldEmail` saying
what would have gone. Wiring the mail in should not need that logic
rewritten.

**A role change waits for the token to expire.** `messengerBoot` in the
original reads `liveRoleOf(session.u)` from the sheet on every call, so
demoting an admin takes effect at once. Here the role is a claim inside the
JWT, so it takes effect when that token runs out. Same for every other
`requireAdmin` route. Worth fixing when the Accounts screen is ported -
either by checking the role against the database per request, or by keeping
a list of tokens issued before a role change.

Three fixed bugs must not come back: a reply must reach the sender's own
inbox; the unread badge must clear; operations must refresh without a manual
reload.

**The one rule that looks like a bug and is not.** An unverified thread -
one typed into the public sign-in page - never appears in the panel of the
employee whose ID was typed, *even after that ID is enrolled*. So a reply
written into a sign-in-page thread reaches nobody, which is exactly the
reported symptom "I reset his password and sent a reply, and his chatbox is
empty". The exception was written and taken out again: the sign-in page is
public, so anybody can type ANY employee ID into it, and showing those
messages to the owner of the ID lets a stranger put words into a
colleague's own panel with the team's answer underneath. The cost is the
team's to carry, not the reader's; the fix is `attachSignInThread`, an
admin confirming out of band and attaching it. `messenger-test.js` fails
loudly if anyone loosens this.

**No foreign key from `msg_thread.person` to `team`**, deliberately.
`sendUnverifiedMessage` must answer identically whether or not an employee
ID exists - a foreign key would refuse the insert for an ID that does not,
turning the sign-in page into a list of everybody who works here for
anyone willing to try numbers at it.

**The badge counts cards, not rows and not persons.** One person who asked
twice and got one answer is not waiting; one ID with a verified thread and
an unverified one (which happens when an account is deleted after a
signed-in conversation) is two cards, because with no account there is
nothing to prove they are the same human. The inbox and the badge both
read it off one answer so they cannot disagree.

### Knowledge and learning
| Endpoint | New route | Status |
|---|---|---|
| `faqEntries` | `GET /api/faq` | DONE |
| `getKnowledge` | `GET /api/knowledge` | DONE |
| `createKnowledge` | `POST /api/knowledge` | DONE |
| `deleteKnowledge` | `POST /api/knowledge/delete` | DONE |
| `getLearning` | `GET /api/learn` | DONE |
| `addKnowledgeChunk` | - | TODO - needs a file store |
| `scanLearnFolder`, `walkLearnFolder`, `syncLearnFolder` | - | TODO - needs a file store |

All four screens are in `api/content.js`, tables in `db/10-content.sql`,
tested by `api/content-test.js` - 83 checks, 25 deliberate breaks, none
survived.

**The FAQ seed is a fallback, not a starting point.** An empty `faq` table
means the seven questions in `Config.gs FAQ_SEED`, "so a fresh database
still has something to show". One row in the table and the seed is not used
at all - an override rather than a merge, which is the only version that
lets somebody delete a seeded question.

**Removing a Knowledge share is the author's and nobody else's**, not even
a master's. `Knowledge.gs` decided it that way on purpose: this is a page
people post half-finished thoughts to, and a note somebody else can delete
is a note people think twice about writing. `requireMaster` on that route
would be the wrong guard, not a stricter one. The awkward case - a share
whose author has left - is rare, and the chilling effect would be constant.

**Learnings and Knowledge look alike and behave nothing alike.** Learnings
is the approved library, read-only from the page, because "an SOP anybody
can edit from a browser is not an SOP". Knowledge is the other half:
anybody signed in can post, no approval step. Sharing one file does not
mean they are converging.

**`GET /api/faq` is the only public, read-only endpoint in the API.** It
takes no token because the FAQ is on the sign-in page, where nobody has
one. It cannot be made to say anything about who works here, which is what
makes leaving it open safe - unlike `POST /api/messages/signin`, which is
public because it has to be and is defended from the inside.

**`POST /api/byweekly` is new, and is MASTER only.** There is no tab to
type an address into any more, so without it the four meeting links could
only be changed with SQL. They are personal OneDrive links carrying their
owner's work email in the path, and changing one points every colleague at
a different document. A `javascript:` address is refused at the point of
saving, not merely hidden at the point of drawing, so it cannot sit in the
table looking saved.

**Two caches were dropped deliberately**, both of which existed to avoid a
whole-tab read: `byweekly.links` (one hour) and `learn.library` (ten
minutes). A query on an indexed table is not what they were protecting
against, and each had a cost the original records - `refreshByWeeklyLinks`
exists only to clear the first after an edit, and `getLearning` notes that
a library over 100KB is silently refused by the cache anyway.

### Uploads

`src/Ingest.gs` ported to `api/uploads.js`, `api/ticket-merge.js`,
`db/15-uploads.sql` and `db/16-training.sql`. 183 checks in
`api/uploads-test.js`; 51 mutations run, 47 caught and the four survivors
are equivalent. **This is what removes the export-a-CSV-and-run-a-command
step**, and with the feedback half it is now the whole ingest chain:
tickets and training responses both arrive through it.

| Apps Script | New route | Status |
|---|---|---|
| `beginUpload` | `POST /api/uploads/begin` | DONE |
| `appendTicketBatch` | `POST /api/uploads/tickets` | DONE |
| `finishUpload` | `POST /api/uploads/finish` | DONE |
| `getUploadHistory` | `GET /api/uploads` | DONE |
| `deleteUpload` | `POST /api/uploads/delete` | DONE |
| `getUploadCsvChunk`, `uploadCsvName`, `csvCell` | `GET /api/uploads/csv` | DONE |
| `appendFeedbackBatch` | `POST /api/uploads/feedback` | DONE |
| `finishFeedbackUpload` | `POST /api/uploads/feedback/finish` | DONE |
| `auditFeedback` | `GET /api/uploads/orphans` | DONE |
| `purgeOrphanedFeedback` | `POST /api/uploads/orphans/purge` | DONE |
| `removeFeedbackOf` | inside `POST /api/uploads/delete` | DONE |
| `compactFeedback` | - | **dropped**, like `compactTickets` - see below |
| `compactTickets`, `rewrite`, `mergeRows`, `stampOf` | `ticket-merge.js`, as one SQL statement | DONE, differently - see below |
| `recomputeAfterUpload` | - | **dropped**, with the KPI cache |
| `uploadStamp` | one lookup of `upload_run.uploaded_at` | DONE, differently |
| `clearAllTickets` | - | TODO, if it is wanted at all |

**A feedback response is replaced whole; a ticket is merged field by
field.** That difference is deliberate and it is the one thing in this file
that is not a mechanical port. Two ticket exports describe the same ticket
from different angles, so merging them column by column is how the record
gets completed - which is why `ticket-merge.js` has twenty-four CASE
expressions in it. A re-uploaded feedback file means the file was
**corrected**, and half the old answers mixed with half the new ones is not
a state anybody asked for, so `FEEDBACK_SQL` sets every column from the
incoming row and the response id is never in the SET list.

**Deleting an upload now takes its responses with it.** It did not, in the
original: `deleteUpload` touched tickets only, so deleting a
training-feedback upload took the row out of the history and left every
response of it on the `TRAINING` tab - KPI 2 went on reporting data the
user believed they had deleted. `removeFeedbackOf` runs in the same
transaction as the ticket prune and the history row, and the result now
reports `feedbackRemoved` alongside the ticket counts.

**Which file a response came from is asked twice.** `source_file` when it
is filled in, and otherwise the part of the `Response ID` before its last
hash, because the id is `filename#rownumber` and rows written before
`Source File` was populated still identify themselves. The last hash, not
the first: a quarterly export is called `Q1#2026.xlsx`.

That guard reads `hash > 0`, and **`hash >= 0` is an equivalent mutation**.
The two differ only when the hash is the first character, and there
`id.slice(0, 0)` is the empty string the other branch returns anyway. The
test for `'#3'` is kept because it pins the answer, but no test can fail on
the change. `> 0` stays because it says the intent - a filename has at
least one character in it.

**Matching is never done with LIKE.** `_` and `%` are wildcards in a LIKE
pattern, and an export called `TEST-UPL_2026.xlsx` would match
`TEST-UPLx2026.xlsx` - a delete that removed somebody else's rows. Both the
count and the delete use `left(response_id, length(f) + 1) = f || '#'`
instead, and a mutation that puts LIKE back is caught.

**The purge deletes by the ids the audit listed**, not by re-deriving the
condition in SQL, so the two cannot disagree about a `'#'` inside a text
field. `GET /api/uploads/orphans` reports what it found and changes
nothing; the purge is a second, separate call.

### The Uploads screen

`api/public/uploads.html`, with the parsing in `api/public/upload-parse.js`
and the design in `api/public/app.css`. The uploads half of `src/Index.html`
and `src/App.html`, which is where the `.xlsx` is actually read. **This is
the piece that removes the Saturday routine**: drop the exports on the page
and they are in PostgreSQL, with no CSV written and no command typed.

| Apps Script | New | Status |
|---|---|---|
| the Uploads view in `Index.html` | `api/public/uploads.html` | DONE - same markup, same words |
| `Styles.html` | `api/public/app.css` | DONE - copied whole, for all twenty screens |
| `readWorkbook` | in the page; hands its grid to `gridToFile` | DONE |
| `detectReportType`, `findFeedbackQuestions` | `upload-parse.js` | DONE |
| `normalizeFeedback`, `feedbackDateParts`, `asDate` | `upload-parse.js` | DONE |
| `normalizeRows`, `mergeFiles`, `isBlank`, `formatDate` | `upload-parse.js` | DONE |
| `detectModule`, `detectSection`, `describeFeedbackFile` | `upload-parse.js` | DONE |
| `getBootstrap`'s upload half | `GET /api/uploads/boot` | DONE |
| `wireUploads`, `handleFiles`, `runUpload` | in the page | DONE |
| `loadUploads`, `summariseFiles`, `summariseRepeats`, `summariseRange` | in the page | DONE |
| `renderOrphans`, `askThenPurge` | in the page | DONE |
| `renderMissingData`, `uploaderText`, `rowActions` | in the page | DONE |
| `downloadUpload`, `downloadText` | in the page | DONE |
| `askThenDelete`, `confirmDialog`, `describeDeletion` | in the page | DONE |
| `openUpload` | `dashboardFor`, which says the answer | the KPI screens it would open are not ported yet |
| `recomputeAfterUpload` | - | **dropped**, with the KPI cache |

**The parsing is a file of its own, and that is the only structural change.**
In Apps Script it lived inside the dashboard's one script block, where
nothing could reach it. It is the only code in the system that reads a file
somebody else's software wrote, and the only part of this port where a
mistake is not an error on screen but a number in a monthly report that is
quietly wrong. Out on its own, `api/upload-parse-test.js` can lift the real
functions out of `src/App.html` and run them beside it: **55,590
comparisons** across 75 checks, every cell of every row.

Those functions take the column lists and the match patterns as arguments
where the original read them off `state.boot`. That is the one signature
change, it is what makes them testable, and the page passes exactly what the
server sent it.

**66 mutations of the parser, 64 caught.** The two survivors are facts about
the original rather than gaps: taking the report flags out of `mergeFiles`'s
skip list changes nothing, because `isBlank` stringifies and `String(false)`
is not blank; and the explicit "the section export is authoritative" block
is redundant, because `Department` is not in that skip list and the generic
blank-fill has already done it. Both are kept - they state the intent - and
both have an assertion pinning the reason they cannot be caught.

**The screen is tested in a real browser**, against the real server and a
real database: `api/uploads-ui-test.js`, 129 checks. Three things in the
chain exist nowhere else - `FileReader`, SheetJS reading the zip an `.xlsx`
is, and the drop itself - and the option that matters most in the whole
screen lives exactly there. `cellDates: true` is one word; without it every
date cell arrives as `46162`, the number of days since 1900, and KPI 2 goes
blank while the data sits in the file perfectly well. No unit test reaches
that. The browser suite asserts the option was asked for, on every workbook.

**What the mutation runs found in the screen, rather than confirmed.** Each
of these was a check that passed and could not be made to fail:

- **Batching was never exercised.** Rows go up in batches of 400 and every
  fixture was three rows, so the loop ran once and the slice boundary never
  existed. Sending only the first batch passed everything. There is now a
  900-row upload, and the rows either side of 400 and 800 are named
  individually.
- **The orphan notice had no test at all.** Making its purge button appear
  for viewers changed nothing, because no run ever drew the notice. It is
  now created by writing an orphan straight into the table - which is how
  real ones got there - and purged through the dialog, with a non-orphan
  present that has to survive.
- **Saying no was never tested.** Every run clicked Confirm, so a delete
  that ignored the answer passed. Escape and Cancel are both checked now,
  on both dialogs.
- **No fixture had a special character in it**, so dropping `escapeHtml`
  entirely changed nothing. A file called `TEST-UI <b>bold</b> & 'quoted'`
  is now uploaded, and its tags have to come back as text.
- **A trailing blank row**, which real exports carry, and **a feedback file
  whose name places no module**, which has to be reported rather than
  quietly filed under `(unassigned)`.

**47 mutations of the screen, 45 caught.** The two survivors are both cases
this suite genuinely cannot reach, and each says so where it sits:

- **`blankrows: false` cannot be caught.** A blank row is dropped twice
  over - once by that option and again by the no-Ticket-ID rule for tickets
  or the answered-nothing rule for feedback - so removing the option
  changes no stored row and no number on screen. It is kept because a real
  `.xlsx` can carry tens of thousands of phantom trailing rows, and parsing
  them all to throw them away is a cost rather than a bug.
- **Removing the row from the table before the refresh cannot be caught.**
  The page takes the row out itself and then re-reads the history, and by
  the time the status box can be read the re-read may already have
  finished - so the outcome is identical either way. It is kept for the
  reason `App.html` gives: "the answer to did that work should not depend
  on a second round trip that might itself be slow", and a delete can take
  minutes. The outcome is what is asserted.

**One real regression was caught this way.** `GET /api/uploads/boot` was
written to compute the orphan count for admins only, on the reasoning that
the button it feeds is admin-only. `App.html` is explicit that this is
wrong: "The warning is worth showing everybody - the button that acts on it
is not." A viewer reading a KPI 2 figure inflated by responses nobody can
account for should be told, whether or not they can fix it. The count goes
to everybody now; the per-file breakdown stays admin-only, because a
feedback export's filename can carry the trainer's name.

**Open Dashboard stays, and says rather than opens.** KPI 1 and KPI 2 have
their endpoints and their arithmetic but no screen yet. The button's two
hard parts are ported and tested all the same - which KPI an upload belongs
to (counted, not "does the word FEEDBACK appear anywhere", which sent every
mixed drop to KPI 2) and which period it opens on (All months when it spans
several, not the first month of the range, which opened a January-to-
September export on January). One line changes when those screens arrive.

**One thing to check in `app.css`, carried over from `Styles.html`.** The
`.msgr-bar-icon` rule embeds a photograph of a person as a base64 WebP. It
is already in this public repository, because `src/Styles.html` is - this
copy does not expose anything new - but if that is a colleague rather than
a stock image it should not be in a public repository at all, and it is the
kind of thing that is easy to forget is in there. It belongs on the same
list as the colleague names in `Config.gs`.

**SheetJS is still loaded from the CDN**, pinned to 0.18.5 exactly as
`App.html` pins it. Worth knowing before go-live: if the hosting network
blocks `cdnjs.cloudflare.com`, the dropzone cannot read a file and nothing
else on the screen is affected, which is a confusing way to fail. Serving a
local copy is a ten-minute change and the right one to make once the server
is a Youngone machine.

**Three functions have no port, and each is an improvement rather than a
gap:**

- **`compactTickets` / `rewrite`.** `appendTicketBatch` appended blindly
  because "looking up 20,000 existing IDs on every one of 20 batches would
  mean reading the whole sheet 20 times", and `finishUpload` then read the
  whole tab, merged in JavaScript and rewrote it. A primary key does that
  per row, indexed, inside the insert. The dangerous part goes with it:
  `rewrite()` exists only because an earlier version "destroyed twenty
  thousand tickets" by clearing before writing. **Nothing in the port ever
  clears the table.**
- **`recomputeAfterUpload`.** It rebuilt `KPI_MONTHLY`. There is no cache -
  scoring 26,000 tickets across eleven months measures 200ms - so there is
  nothing to rebuild, nothing to go stale, and no second call that can be
  interrupted half way.
- **`uploadStamp`.** It re-derived the upload's start time by parsing it
  back out of the ID string. One indexed lookup is exact and has no
  timezone arithmetic in it. It also closes a hole: the original returned
  `new Date()` for an ID it did not recognise, so rows could be appended
  against an upload that was never opened. That is now refused.

**`api/ticket-merge.js` is new and exists for one reason.** There are now
two ways a ticket gets in - the CSV importer and this screen - and they must
reach the same answer, not a similar one. Two copies of twenty-four
near-identical CASE expressions would agree on the day they were written and
drift the first time one was corrected. `import-tickets.js` now takes the
merge, the column list and every cell reader from it, which removed 186
lines from that file; a structural check in `uploads-test.js` fails if a
copy of the statement ever reappears there.

**Two things were found while porting this, and both are fixed.**

1. **A timestamp with no timezone on it was being read in the timezone of
   the process.** The ITSM exports write `2026-08-20 10:00` and nothing in
   the text says where. On the Windows machine in Dhaka that is right by
   accident; on a server - and almost every Linux server is set to UTC - it
   is six hours late. Six hours is invisible mid-month and decisive at the
   end of one: a ticket raised at 20:00 on 31 August becomes 02:00 on 1
   September, and a **monthly KPI scores it in the wrong month**. A naive
   timestamp is now read as Dhaka explicitly, and one that names its zone is
   believed. **Nothing changes on a machine already set to Dhaka, so no
   re-import is needed.** There is a test that runs the same export in child
   processes set to UTC, Dhaka and New York and requires all three to agree.
2. **The random part of an upload ID was four hex characters**, as the sheet
   used. 65,536 values collide about a quarter of the time over 200 draws -
   measured, not estimated: the test that generates 200 IDs failed on its
   first run at 199 unique. In the sheet that produced the duplicate-log-row
   bug Ingest.gs describes; here `upload_id` is the primary key, so the
   database refuses the second upload and it fails to start. Now eight
   characters. Nothing reads the suffix.

**`rows_added` and `rows_updated` mean something different now, and better.**
`finishUpload` wrote the result of `compactTickets` into those columns - the
number of unique tickets left in the WHOLE SHEET and the number of
duplicates collapsed across all of it. Facts about the tab, displayed beside
one upload's filename as though they were facts about the upload. The merge
reports per row whether it inserted or updated, so they now answer the
question their heading asks.

---

## Backups

`src/Backup.gs` ported to `api/backup.js`, `api/restore.js` and
`db/14-backup.sql`. 166 checks in `api/backup-test.js`, 170 when it is run
with a user that may create a database; 44 mutations run, 43 caught.

| Apps Script | Here | Status |
|---|---|---|
| `backupNow` | `backupNow()`, `node backup.js` | DONE |
| `pruneBackups` | `toPrune()` | DONE |
| `backupHealth` | `backupHealth()`, `GET /api/backup/health` | DONE |
| `restoreGuide` | `restoreGuide()`, `node backup.js --guide` | DONE |
| `installBackupTrigger` | `node backup.js --install` prints the `schtasks` | PART - it cannot create the task itself |
| `removeBackupTrigger` | the `schtasks /delete` line in the same output | PART |
| `pruneAuthLog`, called between the copy and the prune | nothing to call yet - there is no `auth_log` table. **The call goes back in at that exact point**, and `backupNow()` says so where it belongs | TODO with Accounts |
| Drive version history | **nothing. There is no equivalent** | n/a |
| Drive Trash, 30 days | **nothing. `DROP` is final** | n/a |

Same constants as the original: 30 daily copies, 02:00 local, stale after 36
hours.

**What Google was doing for free, and now nobody is.** Three of the four
things that can go wrong were Drive's problem and are now ours: a deleted
row, a deleted database, and a dead disk. Only the fourth - a bad upload -
has the same answer in both systems, and it was never a job for a backup.

**The two decisions that differ from `Backup.gs`, both deliberate:**

- It **deletes** where Drive **trashed**. There is no recycle bin for a
  file a script deletes, so the care went into never choosing the wrong
  file: `parseBackupName()` refuses anything this system did not write,
  down to rejecting hour 24 and a `.dump.bak` suffix, and `toPrune()`
  throws rather than accept a `keep` below 1.
- A dump that **cannot be read back is renamed `.bad`**, not deleted and
  not left alone. Left alone it keeps a backup's name while being the
  newest file in the folder, which makes it the one somebody restores in a
  panic.

**Still outstanding, and it is configuration rather than code:**

1. `BACKUP_DIR` must point somewhere **that is not this machine**. Unset, it
   writes into `backups/` beside the database, which survives a dropped
   table and nothing else. `backup.js` warns on every run until it is set.
2. The nightly task has to exist, and then `BACKUP_SCHEDULED=yes`.
3. **A restore has to be done by hand, once, before cutover.** The suite
   proves the loop against a scratch database when it is given a user that
   can create one; on the live machine that is `node restore.js <file>
   tvl_eas_check`. A backup nobody has restored is a guess.

---

## Spreadsheet tabs

| Tab | Holds | New table | Status |
|---|---|---|---|
| `TEAM` | the directory | `team` | DONE |
| ACCOUNTS | logins | `account` | PART - 7 of 12 columns; see below |
| AUTH_LOG | sign-in audit trail | - | TODO |
| `TICKETS` | ITSM tickets | `ticket` | PART - table and import done (`node api/import-tickets.js`), endpoints not |
| `KPI_MONTHLY` | monthly KPI figures | - | TODO |
| `TRAINING` | training records | - | TODO |
| `KPI_CONFIG` | KPI settings | - | TODO |
| `OPERATORS` | operator list | - | TODO |
| `UPLOAD_LOG` | upload history | - | TODO |
| `QUESTIONS` | questions | - | TODO |
| `FAQ` | FAQ entries | `faq` | DONE - empty table means the built-in seed |
| `THREADS` | messenger threads | `msg_thread` | PART - table done, data not imported |
| `MESSAGES` | messenger messages | `msg_line` | PART - table done, data not imported |
| `LEARN` | learning entries | `learn` | PART - table and read side done, the folder scan that fills it is not |
| `KNOWLEDGE` | knowledge posts | `knowledge` | DONE - attachments wait on a file store |
| `BY_WEEKLY` | meeting links | `by_weekly` | DONE - the four rows exist, paste the addresses in |
| `OBJ_PLAN` / `OBJ_TASK` | objectives | `obj_plan` / `obj_task` | DONE - `node api/import-objectives.js` |
| `OBJ_LOG` | objective marks | `obj_log` | PART |
| MIN_MEET | orphaned - to be deleted | - | n/a |

### What the `account` table is still missing

The ACCOUNTS tab has twelve columns. `account` carries seven of them:
Employee ID, Role, Hash, Must Change, Last Sign In, Created, and Name.

| Tab column | In `account`? | |
|---|---|---|
| Salt | no, and not coming | the scrypt hash carries its own salt and parameters inside the string, so there is nothing to keep in a column of its own |
| Password Set | not yet | Accounts screen |
| Sign Ins | not yet | Accounts screen |
| Note | not yet | Accounts screen |
| Email | not yet | Accounts screen, and where alerts go |

`Name` was the one the messenger could not do without - without it
`accountNameOf` can only answer `''`, so the panel would ask every person
for their name on every page load and store a fresh copy each time. Added
by `db/09-account-name.sql`, which only ever adds a column and never
touches a row. The other four are added when the Accounts screen is
ported, because a column nothing reads is a column nobody maintains.

Presence has no tab: it lives in CacheService, which is why it is lost on
every cache eviction. The new `presence` table fixes that for free.

ONE DELIBERATE SIMPLIFICATION, recorded so it is a decision and not a
silent loss. Presence.gs writes each beat under TWO keys
(`presenceWriteKeys`) because an Apps Script login is free-form text that
might be an employee ID or a name, so it cannot know which. In the new
system a login IS the employee ID - `account.employee_id` is a foreign key
to `team.employee_id` - so the join is exact and the second key has nothing
left to solve. The consequence: somebody with no employee ID can no longer
have a login at all. All 36 people have one, so there is no live effect,
and the alternative is guessing at identity, which is what the dual key
was working around.

---

## Behaviour that is easy to lose

Written down because none of it is obvious from the code, and all of it was
decided for a reason.

1. **Offline is derived, never stored.** A shut laptop sends nothing. Staleness
   decides. Window is 8 minutes.
2. **A person with no employee ID is keyed by name** for presence, and filling
   the ID in must move their dot immediately. There is a test for this.
3. **`settings` is the internal name, "Summary" is the label.** Bookmarks.
4. **Help is ADMIN+ only**, and a USER who lands there is sent home rather
   than shown an empty screen.
5. **The back trail holds 24 entries** and a restore is not a navigation.
6. **Pure ASCII everywhere**, enforced by guards in `tests/wiring-test.js`.
7. **No personal data in the repository.** Test IDs live in the reserved
   blocks `200000xx`, `2090xxxx`, `2099xxxx`.
8. **The deployment is published to "Anyone"**, so every endpoint is a URL a
   stranger can call. Nothing may trust its input.
9. **PostgreSQL has no version history and no trash.** Sheets quietly gave
   the old system both; a `DELETE` here is final the moment it commits, and
   `DROP DATABASE` has no thirty days of grace. Every recovery story now
   starts with a dump that was taken beforehand.

---

## Order of work

1. ~~Database~~ DONE
2. ~~API skeleton, directory~~ DONE
3. ~~Sign-in~~ DONE
4. ~~Presence~~ DONE
5. ~~Objectives~~ DONE except `createObjMilestone` (adding a milestone,
   admin only) - read, tick, record and note all ported and tested
6. ~~Messenger~~ DONE except `getChatImage` / `saveChatImages`, which need
   a file store, and the `faq` key in `messengerBoot`, which needs the FAQ
   tab. Reading, sending, replying, attaching and deleting are all ported
   and tested.
7. ~~Knowledge, Learn, FAQ, By-Weekly~~ DONE except the two that need a
   file store: Knowledge attachments and the Learnings folder scan.
   ("Links" was `getByWeeklyLinks`, so it is four screens, not five.)
8. **KPI 1, KPI 2, Compare, Uploads** - KPI 1 and Compare
   are ported and proved identical to the original arithmetic (16,239
   comparisons); the ticket import and the roster both work. **KPI 2's
   arithmetic is ported and proved identical over 27,991 comparisons**, and
   **KPI 2's read side is ported** - three endpoints, 67 checks, 26
   mutations and all 26 caught. **Uploads is ported whole, screen included**
   - tickets and training feedback, download, history, delete, orphan audit
   and purge: 183 server checks, and the screen itself at
   `api/public/uploads.html`, driven end to end in a real browser (129
   checks, 47 mutations, 45 caught). **This is the first of the twenty
   screens and the one that
   changes the Saturday routine** - the `.xlsx` is parsed in the browser
   and fed straight to the endpoints, so there is no CSV and no terminal.
   Left in this stage: **the KPI 1 and KPI 2 screens**, which the Uploads
   screen's Open Dashboard button already works out the target for and
   says rather than opens.
9. ~~Backups~~ DONE as code. **NOT done as a working arrangement** until
   `BACKUP_DIR` points off this machine, the nightly task exists, and one
   restore has actually been done. See the Backups section above. This has
   to be true before cutover, not after - the moment the new system is the
   one people type into, a message or a Knowledge post exists nowhere else.
10. Accounts and audit log - and `pruneAuthLog()` goes back into
    `backupNow()` when `auth_log` arrives.
11. **Deployment.** `clasp push` is lost at cutover: today VS Code to live
    is one command, afterwards something has to put the code on the server
    and restart Node. Not built, and not optional.
12. The shell: home, nav, the remaining static screens. `api/public/app.css`
    is already there - the whole of `src/Styles.html`, copied - so each
    screen as it arrives looks like the finished thing rather than like a
    test page. Uploads is a page of its own until the nav exists to put it
    behind.

Apps Script keeps running untouched throughout. Nothing is switched off
until its row says DONE.

---

## The ticket import

`node api/import-tickets.js` reads `data/TICKETS.csv` - the TICKETS tab
exported as CSV - and merges it into the `ticket` table. Tested by
`api/import-tickets-test.js`: 28 checks, 11 deliberate breaks, none
survived.

**It does NOT clear the table first**, unlike `import-objectives.js` which
does. The objectives are a fixed list re-exported whole; tickets arrive in
overlapping exports that each carry part of the picture, and the merge is
how two partial views become one row. Clearing would throw away whichever
half was not in today's file.

`Ingest.gs mergeRows` is one `INSERT ... ON CONFLICT DO UPDATE` here rather
than read-merge-write, so two imports running together cannot each start
from the same copy. Three rules, and they are not the same rule:

| | |
|---|---|
| most columns | take the incoming value if the existing one is blank **or** the incoming row is newer. A blank incoming value never erases a real one. |
| `In Overall Report`, `In Dept Report` | always OR'd. Which reports a ticket appeared in is what decides whether EAS is scored on it. |
| `Source Files` | accumulates, unique, in the order first seen, so the audit trail shows every file that contributed. |

A row with no `Last Updated` counts as **oldest**, so it cannot overwrite
anything on a recency claim it has not made.

**Why the TICKETS tab and not the ITSM .xlsx files.** The Apps Script
system has the *browser* parse the five exports, decide which report each
is, normalise and merge them - because "parsing a 20,000-row spreadsheet on
the server would run straight into the 6-minute execution ceiling". That
work is done by the time rows reach the tab. Replacing it is the Uploads
screen, which is still outstanding; until then Apps Script keeps merging
and this carries the result across.

## The KPI_MONTHLY cache, and why the port may not want one

`readKpi1` reads a cache tab rather than the tickets, and `recomputeKpiCache`
rebuilds it after every upload. The cache exists because reading 20,000
spreadsheet rows on every page load is slow - the same reason the By-Weekly
and Learnings caches existed, but with far more rows behind it.

A `GROUP BY` over an indexed table is not that. The cache also has a cost
the original carries: it has to be recomputed, and a month whose recompute
was missed shows stale figures.

The one subtlety to preserve is in `readKpi1`'s own note: **an all-months
figure is not an average of monthly figures.** January with 4 completed and
one delay scores 75%; August with 2,640 and 11 scores 99.58%; their mean is
87.29%, "which describes nothing that happened". The true rate is
`sum(successful) / sum(completed)`. Summing raw counts and recomputing is
exactly what a SQL aggregate does by construction, so dropping the cache
preserves this rather than threatening it.

**Decided: not ported.** `GET /api/kpi1` scores the tickets directly every
time. Measured on 25,808 tickets across 11 months: **200 ms** for the whole
period, every breakdown, from scratch. That is not what the cache was
protecting against, and dropping it means nothing can go stale and
`recomputeAfterUpload` has nothing to do.

The rule it had to preserve is preserved *by construction*: there is no
intermediate percentage left anywhere to be tempted into averaging. Proved
on deliberately lopsided months - 4 completed against 400 - where summing
and averaging differ by ten points rather than hundredths.

## Attribution: which section handled a ticket

`api/roster.js`, table `roster` (`db/12-roster.sql`), filled by
`node api/import-roster.js`. Proved identical to `src/Config.gs` by
`api/roster-equivalence-test.js` - **5,681 comparisons**, in `npm test`,
needing nothing switched on. 18 deliberate breaks, 16 caught; the two that
cannot be caught are explained below.

**A ticket carries a name, not an employee ID.** `Current Activity In
Charge` is text the ITSM wrote, and it writes one person several ways. All
of them must resolve to one person or their tickets split across two rows
of the table, one labelled `(unassigned)`.

**The section is not the module**, and **sections changed shape in August
2026** - before that there were two, not four, so an older month is
reported under the names in force then.

**The roster is not `team.sub_department`.** Two reasons, both silent if
ignored: the two lists spell sections differently on purpose, and **people
who have left are not in `team`** - `CONFIG.FORMER` exists so their months
keep totalling the same number. Build the index from the directory and
every leaver's tickets fall into `(unassigned)` the day their row goes.

**`import-roster.js` reads `src/Config.gs` directly** rather than a CSV.
That is where the org chart already is; retyping 37 names would be a
second copy to keep in step, and the first time they disagreed a month's
figures would move with nothing to say why.

### Two things found while doing this

**`CONFIG.ROSTER`'s clash map is dead code.** A bare form is only recorded
when it differs from the key - when the key starts `md` - and it is that
key with those two characters removed. Two distinct keys sharing a bare
form would mean `k1.slice(2) === k2.slice(2)` with both starting `md`,
which means `k1 === k2`: one person. Brute-forced over the honorific
spellings and the awkward names; nothing collides. It is kept in the port
because this is a port, but nothing should rely on it to catch a duplicate
name - two people with the same name are one entry in `full` and the
second silently replaces the first, which `import-roster.js` **does**
report.

**Colleagues' names are in `src/Config.gs`, which is in a public
repository.** That predates this port - `src/` is the live Apps Script
pulled by clasp - and it is not something the port introduced or can fix
on its own. It is flagged because the standing rule for this work is that
personal data does not get committed, and a reader of this file should
know the rule has an exception they did not choose.

Writing these files, quoting those comments put ten copies of real names
into four new files without a moment's thought. `roster-equivalence-test.js`
now fails if any name from the chart appears in a file the port added -
checked against the roster lifted at run time, so the guard carries no
list of its own.

## The module breakdown

`api/modules.js`, with the per-person exceptions on `roster.module`
(`db/13-roster-module.sql`, filled by `node api/import-roster.js`). Proved
identical to `src/Config.gs` by `api/module-equivalence-test.js` - **2,716
comparisons**, in `npm test`. 10 deliberate breaks, all caught.

Three sources, in order, and the order is the design:

1. the **Part column**, when it names one of the modules EAS reports on.
   That list is closed - the Part column also carries Account, Monitoring,
   Groupware, PC/Monitor, Others, FRP, TexManager and WMIS, and letting
   those through "produced a table of fifteen rows, half of which no one
   reports against".
2. otherwise the **person** who handled it - "whoever handled the ticket,
   it belongs to their module".
3. failing both, **`(unassigned)`**, so it is visible rather than guessed.

**Grouped from the tickets, not rolled up from the Part rows**, because "a
Part that names no module has to fall through to the person who handled
the ticket - and only the ticket row carries both columns".

**Codes before words, longest first within each.** A code is what the ITSM
writes in a Part cell on purpose; a word is a guess at what a prose Part
might mean, and a guess must never beat a deliberate label. The word
boundary in each pattern is what stops `co` firing inside `Accounting`.

### Two things that cannot be tested against the real data

Recorded so they read as decisions rather than gaps:

**The regex escaping in `ticketModulePatterns` is a no-op today.** Not one
of the 24 Part patterns contains a character it changes, so deleting it
alters no answer. It matters the day somebody adds a spelling with a dot or
a plus - unescaped, `c.o` stops being a literal and would claim `cao` and
`c-o` too. The function now takes an optional list so a synthetic one with
metacharacters reaches the guard, the same technique `portalLinks` uses.

**The `month` argument to `moduleForTicket` changes nothing.**
`moduleForPerson` reads the section at today's names whatever month the
ticket is from, because the pre-split name covered three modules at once
and cannot name just one. Replacing the month with `null` is an equivalent
mutation - no test can catch it because there is no behaviour to catch. It
is kept because `Config.gs` takes it, and a port that quietly drops an
argument is a port that has decided something.
