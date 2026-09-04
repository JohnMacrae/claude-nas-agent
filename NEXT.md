# NEXT — Property Agent / Property Docs

Last updated: **2026-09-04**

> Older detail (Stage A–F invoice-automation plan, the 2026-07 decouple-from-OB1 work,
> WO→Paperless bridge fixes, Telegram pending-question fix, etc.) has been trimmed from this
> file to keep it current — it's all still in git history: `git log -- NEXT.md`.

## Current state

Branch **`main`**, pushed. Working tree has one unrelated uncommitted change:
`compose.yml` adds `GOOGLE_REFRESH_TOKEN_FILE=/gmail-config/calendar-refresh-token` to the
property-agent service env — pre-existing at the start of this session, not part of the
invoice-run work below, not yet investigated or committed.

**Three code changes are live in the running container via `docker cp` fast path but the
image has not been rebuilt yet** — a container recreate before rebuilding would silently
revert all of this:
- `agent/invoice-run.js` — minimum-charge fallback (commit `af66ba5`, pushed)
- `agent/freeagent.js` — `extractHours` mid-sentence fallback + `ensureCompletionHoursLine`
  (uncommitted)
- `agent/agent-runner.js` — `gcal_update_event` now normalizes completion notes via
  `ensureCompletionHoursLine` (uncommitted)

## What just happened

**Chased a Telegram report discrepancy through two related fixes, then reprocessed the
backlog.**

1. **Automated invoice-run was silently skipping completed-but-unbillable jobs.** John
   noticed 12 WOs reported "no billable lines in notes" and asked why. Root cause:
   `invoice-run.js` called `freeagent.js` with `allowMinimum: false`, so a completed job
   with no parseable £/hours in its notes was skipped rather than billed (the existing
   minimum-hour fallback in `freeagent.js` was only reachable from manual
   `create-invoice`). John confirmed he wants the minimum applied automatically. Fixed,
   verified via dry-run, committed as `af66ba5`, pushed.
2. **Manually reran `invoice-run.js` (not dry-run)** for the full window to actually draft
   the 12 backlog WOs rather than wait for tomorrow's 06:00 run. All 12 now have FreeAgent
   draft invoices, refs 132–143 (see table in chat — WO001560/561/562/564/563 and
   WO001501/513/519/518/517/522/524).
3. **John spotted one of the 12 (WO001560, ref 132) was actually reported at 2hrs via
   Telegram ("198c - done -2hrs") but drafted at the 1hr minimum.** Traced to the calendar
   event's actual description: `"Complete — confirmed by John via Telegram 2026-08-26.
   2hrs."` — free-text prose, not the clean "Complete Nhr" line the "Job completion with
   hours" system-prompt path calls for. The cheap model (`deepseek-v4-flash`) matched an
   input shape nearly identical to its own worked example (`107GR done 1h`,
   `agent-system-prompt.md:108`) but still didn't format the note correctly — same
   instruction-non-adherence class as the `pending_set` issue fixed in `77632f2`. Because
   step 1's minimum-charge fallback is now live, this kind of miss silently underbills
   instead of surfacing in the report, so it needed a code fix, not just a one-off invoice
   correction:
   - `freeagent.js` `extractHours`: added a last-resort fallback that matches an hours
     figure anywhere in the text (not just start/end-anchored), so prose like the above now
     parses correctly on its own.
   - `freeagent.js` `ensureCompletionHoursLine(description)` (new, exported): if a
     completion note doesn't already parse to a billable line but an hours figure can be
     found anywhere in it, appends a clean `"Complete Nhr."` line. No-op if it already
     parses, isn't a completion note, or has no hours mentioned at all (genuinely
     hours-less completions still fall through to the 1hr minimum, correctly).
   - `agent-runner.js`: `gcal_update_event` now runs `a.description` through
     `ensureCompletionHoursLine` before writing to the calendar — deterministic, no model
     cooperation required, same pattern as the `pending_set` auto-fallback.
   - Verified both changes against the real WO001560 text plus the existing "Done 1hr" /
     "59BC-1.5hr" / "Hob replaced 2hr" / "Cancelled — ..." patterns — no regressions.
   - Fixed the live data: `freeagent.js update-invoice` on invoice 94240375 (ref 132) →
     2hr / £100.00 (was 1hr / £70.00); local ledger (`store.invoiceUpdate` on event
     `psal5mad1n0porspf4l4n6051k`) updated to match.

## Next actions

1. **Commit `agent/freeagent.js` and `agent/agent-runner.js`, then rebuild the property-agent
   image** — three files now differ from the image (see Current state); the `docker cp`
   fast-path changes won't survive a container recreate otherwise.
2. Watch the next Telegram-driven "done" reply with hours to confirm
   `ensureCompletionHoursLine` writes a clean line in practice, not just in the unit check
   run here.
3. Watch the next real invoice-run (06:00) to confirm minimum-charge drafts create cleanly in
   FreeAgent and look right to John before they email at 24h.
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
