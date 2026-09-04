# NEXT — Property Agent / Property Docs

Last updated: **2026-09-04**

> Older detail (Stage A–F invoice-automation plan, the 2026-07 decouple-from-OB1 work,
> WO→Paperless bridge fixes, Telegram pending-question fix, etc.) has been trimmed from this
> file to keep it current — it's all still in git history: `git log -- NEXT.md`.

## Current state

Branch **`main`**, pushed, working tree has one unrelated uncommitted change:
`compose.yml` adds `GOOGLE_REFRESH_TOKEN_FILE=/gmail-config/calendar-refresh-token` to the
property-agent service env — pre-existing at the start of this session, not part of the
invoice-run work below, not yet investigated or committed.

## What just happened

**Invoice-run now applies a 1-hour minimum charge instead of skipping unbillable completions.**
John noticed the daily Telegram report listing 12 completed WOs as "no billable lines in
notes" and asked why — traced to `agent/invoice-run.js` calling
`freeagent.notesToInvoiceItems`/`createInvoice` with `allowMinimum: false`, so a completed job
whose notes had no parseable £/hours was skipped rather than billed. He confirmed he wants the
existing minimum-hour fallback (already in `freeagent.js`, previously only reachable via manual
`create-invoice`) applied automatically by the automated run too.

- `agent/invoice-run.js`: both calls now pass `allowMinimum: true`. Removed the now-dead
  `no_billable_lines` skip branch and its Telegram report line — `billableItems` can no longer
  come back empty once the minimum fallback is on, so that reason can never fire. The
  "Completed, unpaid" report section now only ever reports `create_failed` (a real FreeAgent
  API error).
- `CLAUDE.md` automated-invoicing bullet updated to describe the minimum-charge fallback.
- Verified live: `docker cp`'d the changed file into the running container and ran
  `node invoice-run.js --dry-run --from 2026-08-01` — confirmed WO001562/WO001564/WO001563 (the
  previously-skipped 78BC/198C jobs) now draft at £70.00 / 1hr instead of skipping.
- **Change is live in the running container via `docker cp` fast path only — image not yet
  rebuilt.** Per standing note below, rebuild so the image matches source before this is
  considered durable (a container restart/recreate before rebuild would revert to the old
  behaviour).

## Next actions

1. **Rebuild the property-agent image** so it matches the `docker cp`'d source (fast-path
   change will not survive a container recreate otherwise).
2. Watch the next real invoice-run (06:00) to confirm minimum-charge drafts create cleanly in
   FreeAgent and look right to John before they email at 24h.
3. Investigate/decide on the uncommitted `compose.yml` change (see Current state) — commit or
   revert.
4. WO-capture parallel run (property-agent native vs `mail-reader`'s `work-order-processor`)
   — compare a few more days of logs before retiring the old Python container.

## Do not re-litigate

- **Maintenance calendar only** for invoicing — Property calendar carries Rentr lettings
  viewings, never invoice those.
- **Automated invoice-run now bills every completed job** — either parsed billable lines, or a
  1-hour minimum charge if notes have none. There is no more "completed but unbillable, skip"
  state in the automated path (2026-09-04 decision, John confirmed explicitly).
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
- `agent/invoice-run.js` — deterministic complete→draft→email-after-24h run; today's change is
  the `allowMinimum: true` switch and the removed `no_billable_lines` skip path
- `agent/freeagent.js` — `notesToInvoiceItems`/`createInvoice`/minimum-charge fallback
  (`freeagent.js:259-266`)
- `agent/wo-report.js` / `agent/wo-colour.js` — separate "still open" report; shares the
  `done`/`complete[d]`/`cancelled` completion heuristic with invoice-run but has no concept of
  billing state — a job marked done never appears there regardless of invoicing outcome
- Maintenance calendar: `963dbd01a359d150a2ba10371bf80a30dc448da1100abb14ab750966a9e8a547@group.calendar.google.com`
- Property calendar: `jj52rrbqum0q362phqmsjp20uc@group.calendar.google.com`
