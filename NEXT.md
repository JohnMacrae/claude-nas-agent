# NEXT — Property Agent / Property Docs

Last updated: **2026-09-04**

> Older detail (Stage A–F invoice-automation plan, the 2026-07 decouple-from-OB1 work,
> WO→Paperless bridge fixes, Telegram pending-question fix, etc.) has been trimmed from this
> file to keep it current — it's all still in git history: `git log -- NEXT.md`.

## Current state

Branch **`main`**, pushed, commits `af66ba5` and `b08f5bf`. Working tree has one unrelated
uncommitted change: `compose.yml` adds
`GOOGLE_REFRESH_TOKEN_FILE=/gmail-config/calendar-refresh-token` to the property-agent service
env — pre-existing at the start of this session, not part of the invoice-run work below, not
yet investigated or committed.

**All three code changes are committed and pushed but only `docker cp`'d into the running
container — the image has not been rebuilt.** A container recreate before rebuilding would
silently revert to the old (skip-and-underbill) behaviour:
- `agent/invoice-run.js` — minimum-charge fallback (`af66ba5`)
- `agent/freeagent.js` — `extractHours` mid-sentence fallback + `ensureCompletionHoursLine`
  (`b08f5bf`)
- `agent/agent-runner.js` — `gcal_update_event` normalizes completion notes via
  `ensureCompletionHoursLine` (`b08f5bf`)

## What just happened

**Chased a Telegram report discrepancy through two related fixes, reprocessed the backlog,
then verified every draft against the fixed parser.**

1. **Automated invoice-run was silently skipping completed-but-unbillable jobs.** Root cause:
   `invoice-run.js` called `freeagent.js` with `allowMinimum: false`, so a completed job with
   no parseable £/hours was skipped rather than billed. John confirmed he wants the existing
   minimum-hour fallback applied automatically. Fixed, committed `af66ba5`.
2. **Manually reran `invoice-run.js` (not dry-run)** to draft the 12 backlog WOs immediately.
   All 12 got FreeAgent drafts, refs 132–143 (WO001560/561/562/564/563,
   WO001501/513/519/518/517/522/524).
3. **John spotted WO001560 (ref 132) was reported at 2hrs via Telegram ("198c - done -2hrs")
   but drafted at the 1hr minimum.** Cause: the calendar description was free-text prose
   ("Complete — confirmed by John via Telegram 2026-08-26. 2hrs.") instead of a clean
   "Complete Nhr" line — the model didn't follow the "Job completion with hours" format even
   though the input matched its own worked example (`agent-system-prompt.md:108`), same
   instruction-non-adherence class as the `pending_set` fix in `77632f2`. Fixed in code
   (not prompt-only, per that precedent), committed `b08f5bf`:
   - `freeagent.js` `extractHours`: added a last-resort fallback matching an hours figure
     anywhere in the text.
   - `freeagent.js` `ensureCompletionHoursLine(description)` (new): appends a clean
     "Complete Nhr." line when a completion note has hours but doesn't already parse — no
     model cooperation required.
   - `agent-runner.js`: `gcal_update_event` now runs descriptions through
     `ensureCompletionHoursLine` before writing.
   - Verified against "Done 1hr" / "59BC-1.5hr" / "Hob replaced 2hr" / "Cancelled — ..." —
     no regressions.
4. **Verified all 12 drafts against the fixed parser** (re-ran invoice-run live — 0 new
   creates, all 12 correctly `already_ledger`, confirming idempotency; then reparsed each
   event's actual calendar description with the current `freeagent.js` and compared to the
   ledger). Found a **second** pre-fix casualty: **WO001563 (198C, ref 136)** had the identical
   prose pattern ("Complete — confirmed by John via Telegram 2026-08-26. 2hrs.") and was also
   drafted at £70/1hr instead of £100/2hrs.
5. **Corrected both bad drafts** via `freeagent.js update-invoice` + `store.invoiceUpdate`:
   - WO001560 (invoice 94240375, ref 132): £70/1hr → **£100/2hrs**
   - WO001563 (invoice 94240387, ref 136): £70/1hr → **£100/2hrs**
   Final state of all 12: 10 correctly at £70/1hr (genuinely hours-less notes), 2 corrected to
   £100/2hrs. Ledger and FreeAgent agree on all 12.

## Next actions

1. **Rebuild the property-agent image** so it matches the pushed source — `af66ba5` and
   `b08f5bf` are only `docker cp`'d in, not baked in; a container recreate before rebuilding
   would revert to the old behaviour.
2. Watch the next Telegram-driven "done" reply with hours to confirm
   `ensureCompletionHoursLine` writes a clean line in practice (only unit-tested so far).
3. Watch the next real invoice-run (06:00) to confirm minimum-charge drafts create cleanly and
   look right to John before they email at 24h.
4. Investigate/decide on the uncommitted `compose.yml` change (see Current state) — commit or
   revert.
5. WO-capture parallel run (property-agent native vs `mail-reader`'s `work-order-processor`)
   — compare a few more days of logs before retiring the old Python container.

## Do not re-litigate

- **Maintenance calendar only** for invoicing — Property calendar carries Rentr lettings
  viewings, never invoice those.
- **Automated invoice-run now bills every completed job** — either parsed billable lines, or a
  1-hour minimum charge if notes have none. There is no more "completed but unbillable, skip"
  state in the automated path (2026-09-04 decision, John confirmed explicitly).
- **Completion notes with hours are normalized deterministically at write time**
  (`ensureCompletionHoursLine`, called from `gcal_update_event`) and parsed more liberally at
  invoice-run time (`extractHours` mid-sentence fallback) — both landed 2026-09-04 specifically
  because the model doesn't reliably follow the "write a clean Complete Nhr line" instruction
  even when the input matches its own worked examples. Don't revert to prompt-only enforcement.
- **`gcal.js list-events` defaults to `--limit 50`** — pass a higher `--limit` explicitly when
  scanning a wide date range (e.g. `wo-report`/`invoice-run` use their own paging; ad-hoc
  scripts querying the full `2026-05-01`–present window silently truncate at 50 otherwise, as
  seen during the 2026-09-04 draft verification).
- **The local `ob1` container is not a dependency** — not on a reachable network, nothing
  reads `OPEN_BRAIN_MCP_URL`.
- **`DATABASE_URL` is correct** — `ECONNREFUSED` at boot is a harmless one-shot startup race
  (`agent/scheduler.js:837-845`); weekend gaps are `isWorkday()`, not a fault.
- **`agent/` is baked into the image, not bind-mounted for the running container** — but for
  quick fixes it's fine to `docker cp` a changed file straight into `/agent/` in the running
  container (agent-runner.js is spawned fresh per session, no restart needed) as a fast path;
  still commit + rebuild the image properly afterward so the image matches.
- Completion state **is** recorded — free text in Maintenance event descriptions ("Done 1hr",
  "Completed — 1.5 hours"). Unstructured, but present.
- Gmail re-auth: `get_token.py` from John's laptop with `py -3`, writing to
  `W:\gmail-mcp\config\<account>\token.json`. Not the container-based helper.

## Key paths

- `BUGS.md`, `WORK_ORDERS_OUTSTANDING.html`, `agent/JJP_Property_List.md` — **local-only,
  gitignored**
- `agent/invoice-run.js` — deterministic complete→draft→email-after-24h run; `allowMinimum:
  true` switch, `no_billable_lines` skip path removed
- `agent/freeagent.js` — `notesToInvoiceItems`/`createInvoice`/minimum-charge fallback
  (`:259-266`); `extractHours` mid-sentence fallback and `ensureCompletionHoursLine` (new,
  2026-09-04)
- `agent/agent-runner.js` — `gcal_update_event` case now calls
  `freeagent.ensureCompletionHoursLine` before writing
- `agent/wo-report.js` / `agent/wo-colour.js` — separate "still open" report; shares the
  `done`/`complete[d]`/`cancelled` completion heuristic with invoice-run but has no concept of
  billing state — a job marked done never appears there regardless of invoicing outcome
- Maintenance calendar: `963dbd01a359d150a2ba10371bf80a30dc448da1100abb14ab750966a9e8a547@group.calendar.google.com`
- Property calendar: `jj52rrbqum0q362phqmsjp20uc@group.calendar.google.com`
