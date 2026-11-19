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
| `getByWeeklyLinks` | TODO |

### Team and presence
| Endpoint | Status | Notes |
|---|---|---|
| `getTeam` | DONE | `GET /api/team` |
| `getPresence` | DONE | `GET /api/presence` |
| `presenceTick` | DONE | `POST /api/presence/tick` |
| `presenceClear` | DONE | `POST /api/presence/clear` |
| `getPeopleByAffiliate` / `listAffiliates` | TODO | |

### KPI
| Endpoint | Status |
|---|---|
| `getKpi1`, `getKpi2` | TODO |
| `recomputeAfterUpload` | TODO |

### Objectives
| Endpoint | Status |
|---|---|
| `getObjectives` | TODO |
| `createObjMilestone`, `recordObjMilestone` | TODO |
| `tickObjMilestone`, `tickObjTask` | TODO |
| `saveObjSlotNote` | TODO |

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
| Endpoint | Status |
|---|---|
| `messengerBoot`, `listThreads`, `myMessages` | TODO |
| `sendMessage`, `sendUnverifiedMessage`, `replyToThread` | TODO |
| `markMyMessagesRead`, `messagesWaiting` | TODO |
| `attachSignInThread` | TODO |
| `deleteThread` | TODO |
| `getChatImage` | TODO |

Three fixed bugs must not come back: a reply must reach the sender's own
inbox; the unread badge must clear; operations must refresh without a manual
reload.

### Knowledge and learning
| Endpoint | Status |
|---|---|
| `getKnowledge`, `createKnowledge`, `addKnowledgeChunk`, `deleteKnowledge` | TODO |
| `getLearning` | TODO |
| `faqEntries` | TODO |

### Uploads
| Endpoint | Status |
|---|---|
| `beginUpload`, `getUploadCsvChunk`, `finishUpload`, `deleteUpload` | TODO |
| `appendTicketBatch`, `appendFeedbackBatch` | TODO |
| `finishFeedbackUpload`, `purgeOrphanedFeedback` | TODO |
| `getUploadHistory` | TODO |

---

## Spreadsheet tabs

| Tab | Holds | New table | Status |
|---|---|---|---|
| `TEAM` | the directory | `team` | DONE |
| ACCOUNTS | logins | `account` | PART |
| AUTH_LOG | sign-in audit trail | - | TODO |
| `TICKETS` | ITSM tickets | - | TODO |
| `KPI_MONTHLY` | monthly KPI figures | - | TODO |
| `TRAINING` | training records | - | TODO |
| `KPI_CONFIG` | KPI settings | - | TODO |
| `OPERATORS` | operator list | - | TODO |
| `UPLOAD_LOG` | upload history | - | TODO |
| `QUESTIONS` | questions | - | TODO |
| `FAQ` | FAQ entries | - | TODO |
| `THREADS` | messenger threads | - | TODO |
| `MESSAGES` | messenger messages | - | TODO |
| `LEARN` | learning entries | - | TODO |
| `KNOWLEDGE` | knowledge posts | - | TODO |
| `BY_WEEKLY` | meeting links | - | TODO |
| `OBJ_PLAN` / `OBJ_TASK` | objectives | `obj_plan` / `obj_task` | DONE - `node api/import-objectives.js` |
| `OBJ_LOG` | objective marks | `obj_log` | PART |
| MIN_MEET | orphaned - to be deleted | - | n/a |

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

---

## Order of work

1. ~~Database~~ DONE
2. ~~API skeleton, directory~~ DONE
3. ~~Sign-in~~ DONE
4. ~~Presence~~ DONE
5. **Objectives** - schema and arithmetic DONE, endpoints next
6. Messenger
7. Knowledge, Learn, FAQ, Links, By-Weekly
8. KPI 1, KPI 2, Compare, Uploads
9. Accounts and audit log
10. The shell: home, nav, the remaining static screens

Apps Script keeps running untouched throughout. Nothing is switched off
until its row says DONE.
