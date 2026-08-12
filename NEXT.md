# NEXT — Property Agent / Property Docs

Last updated: **2026-08-12** (invoice notes parser + first-hour-per-job; draft 102 live-tested; gcal token file + auth alert)

> **Start here:** `BUGS.md` in this folder — 21 bugs + 10 improvements covering work-order management and invoicing. `WORK_ORDERS_OUTSTANDING.html` is the 1 May–29 Jul audit.
>
> **Both are gitignored — local-only, present on the NAS at `/volume1/docker/property-agent/` but never committed.** This repo (`claude-nas-agent`) is **public**; those files and `agent/JJP_Property_List.md` carry portfolio addresses tied to live maintenance issues. Keep it that way — do not commit them, and keep addresses out of `NEXT.md`.

---

# ▼ CURRENT STATE

## Where the work is up to

**The approved plan is at `/home/john/.claude/plans/robust-strolling-anchor.md`** — six stages (A–F). Read it before continuing; the reasoning behind each stage is there.

**Stages A, B and C (parser follow-up) are complete. D–F are not started.**

### Invoice notes parser — done 2026-08-12 (`agent/freeagent.js`)

Live test on Maintenance event `40WSS - WO001474` (marked complete with multi-line trailing hours). Blind pass of raw `event.description` as `--notes` previously billed **£70 minimum** because hours only matched at line start.

Now:
- Accepts trailing forms (`Label - 5hr`) and leading (`5hr Label`)
- Drops noise: standalone `complete`/`done`/`cancelled`, WO intake boilerplate (`WO######: … Status: …`)
- **First hour is once per job**, not per notes line — sum all labour hours, then 1×£70 + rest×£30
- CLI: `parse-notes`, `update-invoice` (PUT with `_destroy` on existing items)
- Dry-run: `node tools/fa_parse_notes_test.js` (expects net £850 for the 27h sample)

**Draft invoice `102`** (`https://api.freeagent.com/v2/invoices/93425215`): amended to **£850**, dated 2026-08-12, comments carry property + WO reference. Ledger marked for event id `e9uggr2nf11340p0k6k31cvbp0`.

**Still open for invoicing quality:** morning agent still looks at **yesterday only**; Stage D still not wired to `/invoice-check` + `/invoice-mark`. Parsing logic was mirrored into `property_invoicing/agent/freeagent.js`, but that copy still lacks `--comments` / `update-invoice` / `parse-notes` (Comment line-items for Property/WO instead).

**Deploy note:** `agent/` is baked into the image — rebuild/restart after pull, or `docker cp` will be lost on recreate.

## Stage C — done 2026-07-31 (`agent/freeagent.js` + `property_invoicing/agent-system-prompt.md`)

- `freeagent.js`: `--comments` → `invoice.comments` (FreeAgent's real free-text field, confirmed via their docs).
- Prompt: `--description` now includes `WO######` when the event summary has one; `--comments` composed explicitly with property + WO reference; false "automatic" claim removed; `--notes` documented as billing-only (line-item parsing), not for WO prose.

**Not done — folds into Stage D:** `--comments` is only a one-line reference, not the fuller `/wo-detail` (problem/priority/dates) content; `/invoice-check` + `/invoice-mark` (Stage A) still aren't wired into this prompt, so dedup is still not real.

### Calendar token file + auth alert — done 2026-08-12

- `gcal.js` reads refresh token from `/data/google-refresh-token` (rentr-dashboard re-auth) before env fallback
- `tools/sync-gcal-token.sh` copies token from rentr-dashboard DB → token file + `.env`, then rebuilds agent
- Scheduler Pushover-alerts once on `invalid_grant` (`gcal-auth-dead` flag), clears when healthy again

## Stage A — done (`agent/scheduler.js`)

`POST /invoice-check` and `POST /invoice-mark`, guarded by `checkCommandAuth` (`X-Command-Token`). These replace the Open Brain `[GCAL-INVOICED]` thoughts.

| Case | Result |
|---|---|
| check unknown event | `{invoiced:false}` |
| mark | `{duplicate:false}` + row |
| check again | `{invoiced:true}` |
| mark again | `{duplicate:true}` |
| no token | `401` |

The handler returns **500** on store failure. Deliberate and load-bearing: a clean `{invoiced:false}` on a DB error reads as permission to bill again.

**Does nothing until Stage D points the invoicing prompt at it.** Key is `event_id`, so it will not catch the same WO invoiced from two different calendar events — which BUG-020 now makes a real possibility.

## Stage B — done (three repos)

| Repo | Change |
|---|---|
| `property-docs` | `schema/002_wo_detail.sql` — adds `priority`, `problem`, `description`, `address` to `inbox_items`. **Applied.** |
| `property-agent` | `store.js`: new fields on `addInboxItem` (both backends) + new `inboxByOrder()`. `scheduler.js`: `/inbox` passes detail through; new `GET /wo-detail?wo=`, token-guarded. |
| `mail-reader` | `work_order_processor.py`: detail passthrough, eight-query search, forwarded copies no longer dropped. |

Verified: `POST /inbox` with full detail → `201`; `GET /wo-detail?wo=` → `200` (case-insensitive), `401` no token, `404` unknown, `400` no param.

**A 90-day re-run captured 3 work orders and backfilled 34 PDFs**, including **WO001537 and WO001540** — the two BUG-002 said were "in no system at all". Both now have Maintenance events. The physical work on WO001540 (urgent) is **still outstanding**.

**Plan correction:** Stage B's first bullet ("fold `wo_audit.py`'s parsing into the processor") was a no-op — `wo_audit.py:9` already imports `parse_pdf` from the processor. One parser, always was. What differed was the *queries*, and that the processor discarded four fields it had already parsed.

## Calendar auth — restored 2026-07-29

The `gcal_*` tools had been failing `invalid_grant` since **27 Jul**, so no Maintenance events were being created at all. Root cause: the shared OAuth client was in **Testing** publishing status → Google expires refresh tokens after 7 days.

**Fixed by:** publishing the client to production, then re-consenting via rentr-dashboard's page. `property-agent` and `rentr-dashboard` share one OAuth client and the same `calendar.events` scope — one token serves both, and re-consenting one revokes the other's.

**This is now the standard method** — see memory `google-token-refresh-method`. Not the container-based helper.

## Three defects found by the live run

All logged in `BUGS.md`, none fixed:

- **BUG-018** — the agent called `store_complete` claiming *"Maintenance task added and calendar event created"* after both tool calls returned `ok:false`. Three WOs closed with a false audit trail. Reopened by hand. **Worst of the three.**
- **BUG-019** — `maintenance_add` fails every call: sends `"High"`/`"Urgent"`, constraint allows lowercase only. One-line fix.
- **BUG-020** — no calendar dedup before `gcal_create_event`; it tried to duplicate an existing (cancelled) WO001531 event. Only the dead token prevented it. Double-billing path given BUG-008.

## Next actions

1. **Rebuild `property-agent`** so the baked image keeps `freeagent.js` / `gcal.js` / `scheduler.js` (docker cp is not durable).
2. **Commit/push `property_invoicing` parser mirror** (local `agent/freeagent.js` dirty) and decide whether to finish syncing `--comments` there.
3. **Stage D** — retarget `property_invoicing/agent-system-prompt.md` steps 2b/2f/2g to curl `/invoice-check` + `/invoice-mark` (+ `/wo-detail`); drop Open Brain dedup; raise `--max-budget-usd` above `0.50`.
4. **BUG-018** — forbid `store_complete` unless the referenced calls returned `ok:true`; make `actioned` name the event id. (BUG-019 already fixed.)
5. **Stage E** — split the Telegram bots.
6. **Stage F** — dry-run: inspect composed `create-invoice` before it fires.

**Human-only, no code:** triage outstanding WOs on `/wo-report`. **Delete the duplicate `30RC - WO001496` event** (BUG-020). Review draft **102** in FreeAgent before sending.

## Hygiene — noted, not actioned (BUG-016)

`property_invoicing/.claude/settings.json` has a Supabase **service_role** JWT and **is tracked in git**, so the key is in history and rotation is required, not optional. That repo's `origin` also embeds a GitHub PAT in plaintext in `.git/config`. The repo is **private**, which caps exposure. Stage D touches that file anyway.

## Do not re-litigate

- **Maintenance calendar only** for invoicing. Property Calendar carries Rentr lettings viewings — never invoice those.
- **The local `ob1` container is not the problem.** `OPEN_BRAIN_MCP_URL=http://ob1:8000` is read by no code and the container isn't on a reachable network. Stage D removes the dependency rather than fixing it.
- **`DATABASE_URL` is correct.** The `ECONNREFUSED 172.18.0.4:5432` at boot is a one-shot startup race (`agent/scheduler.js:837-845`); `Scheduler running (standalone — no OB1)` is an unconditional literal, not a degraded-mode signal; weekend gaps are `isWorkday()`.
- **Gmail re-auth** (distinct from Calendar): `get_token.py` from John's laptop with `py -3`, writing to `W:\gmail-mcp\config\<account>\token.json`.
- **`agent/` is baked into the image, not bind-mounted.** Editing `agent/*.js` and restarting does nothing — `docker compose build agent && docker compose up -d agent`. Same for `mail-reader`.
- Completion state **is** recorded — free text in Maintenance event descriptions ("Done 1hr", "Completed — 1.5 hours"). Unstructured, but present.

## Key paths

- **`/home/john/.claude/plans/robust-strolling-anchor.md`** — the approved six-stage plan
- `BUGS.md`, `WORK_ORDERS_OUTSTANDING.html`, `agent/JJP_Property_List.md` — **local-only, gitignored**
- `agent/scheduler.js` — endpoints; ledger + `/wo-detail` sit just before `/wo-scan`
- `agent/store.js` — `invoiceCheck`/`invoiceMark`, `addInboxItem`, `inboxByOrder`
- `agent/freeagent.js:162-215` — `createInvoice`, `parseLineItem`, the missing `comments`
- `agent/agent-runner.js` — tool definitions; BUG-019's fix goes here
- `../property-docs/schema/002_wo_detail.sql` — the Stage B migration
- `../mail-reader/work_order_processor.py` — intake, queries, `post_inbox_item`
- `tools/wo_audit.py` — Gmail WO audit; run via `mail-reader-gmail-processor` image, `AUDIT_AFTER=YYYY/MM/DD`
- `tools/fa_list.js` — read-only FreeAgent lister; `FA_FROM=YYYY-MM-DD node fa_list.js`
- `../property_invoicing/agent-system-prompt.md` — steps 2b/2f/2g are the Stage D targets
- Maintenance calendar: `963dbd01a359d150a2ba10371bf80a30dc448da1100abb14ab750966a9e8a547@group.calendar.google.com`
- Property calendar: `jj52rrbqum0q362phqmsjp20uc@group.calendar.google.com`

---

# ▼ EARLIER HISTORY (to 2026-07-19) — still accurate

## Goal

Standalone business property stack: local Postgres knowledge store (docs + semantic + analytics + property maintenance), decoupled from OB1 / personal Life Engine / Paperless-as-SoT.

## Runtime

| Container | Status |
|-----------|--------|
| `property-agent` | Up — OpenRouter runner (`google/gemini-2.5-flash`), `/command` OK, Telegram OK |
| `property-docs-db` | Healthy — host **5435** |
| `property-docs-tika` | Up |
| `property-docs-ingest` | Up — consume poller |
| `work-order-processor` | Up — inbox + `output/work_orders` + Paperless consume |
| `gmail-pdf-processor` | Up — statements local; other PDFs → live Paperless consume |

Repos: https://github.com/JohnMacrae/claude-nas-agent · https://github.com/JohnMacrae/property-docs · https://github.com/JohnMacrae/mail-reader

## Done

### Decouple from OB1
- Local store CLI, `POST /inbox`, Telegram getUpdates, Life Engine sessions removed
- Open Brain MCP removed; WO processor posts to `/inbox`

### Property Docs (`/volume1/docker/property-docs/`)
- Postgres + pgvector; ingest + Tika; Paperless bridge ready
- Maintenance migrate from Supabase (80 tasks / 16 logs); 6 unmatched shortcodes remain

### Property Agent — OpenRouter + voice commands (2026-07-18)
- Replaced `claude` spawn with `agent/agent-runner.js` (OpenRouter tool loop, model `AGENT_MODEL` default `google/gemini-2.5-flash`)
- New: `gcal.js`, `pending.js` (slim confirm state), `POST /command` (Siri Shortcuts)
- Prompt retargeted to discrete tools (no Bash / no Claude MCP)
- Claude Code removed from image; `~/.claude` mounts dropped from compose
- Verified: `POST /command` "number for 24HC" → tenant names + mobiles (~3s) + Telegram

### Tenant contacts from WO PDFs (2026-07-18 / 19)
- Source of truth: Rentopia **Supplier Instructed.pdf** → `Contact for Access` + `Mobile:`
- Store: `/output/work_orders/*.pdf` → cache `/data/tenant-contacts.json` via `wo.js`
- Agent tool: `wo_lookup` — "number for 24HC" → tenant name(s) + mobile(s)
- **Auto-save on intake:** work-order-processor writes `{WOnnn}.pdf` + `POST /wo-scan`

### WO → Paperless path fixed (2026-07-19)
- Root cause: mail-reader mounted **dead** `paperless-ngx/consume`; Paperless watches `paperless/consume`
- Also: every WO named `Supplier Instructed.pdf` → false "Already in Paperless" skip
- Fix: remount live consume; unique names `{WOnnn}_Supplier Instructed.pdf`; WO processor also drops to consume
- Orphaned ~210 files moved to `paperless-stack/paperless-ngx/consume-orphan-20260719` (not auto-imported)

### Siri Shortcut (manual setup on iPhone)
1. Shortcut: **Get Contents of URL**
   - URL: `http://<tailscale-host>:3005/command` (or LAN IP)
   - Method: POST
   - Headers: `Content-Type: application/json`, `X-Command-Token: <COMMAND_TOKEN from .env>`
   - Body (JSON): `{"text":"<Dictated Text>"}`
2. **Show Result** / **Speak Text** on the `reply` field
3. Example phrases: "number for 24HC", "open tasks at 40WSS", "mark 40WSS complete"

### Google Calendar auth (2026-07-18, re-done 2026-07-29)
- Reused rentr-dashboard OAuth client; `GOOGLE_REFRESH_TOKEN` after browser consent (`calendar.events` scope)
- `list-calendars` may 403 on this scope; event ops use hardcoded Maintenance/Property IDs
- See "Calendar auth" above for the 7-day Testing-mode expiry and the standard refresh method

### Paperless → property-docs WO bridge (2026-07-19)
- Bridge: `--filename-contains Instructed`; imported **9** Supplier Instructed / WO docs (`doc_type=wo`)
- Bridge guesser updated for Rentopia "Property N / street" OCR layout

### EICR pack import (2026-07-19)
- 13 files → Paperless **4738–4750** → property-docs (`doc_type=eicr` / `epc`)
- Manual shortcode fixes where the guesser hit bogus `ACRONYM` or a street-name mismatch

## Still open

1. Add iPhone Siri Shortcut(s) for `/command`
2. Optional orphan follow-ups (invoices / SC / refs) — leave rest archived by default
3. **Optional:** fix/delete the 6 unmatched maintenance rows; rotate OpenRouter key; change property-docs Postgres password if still default
4. Optional: harden bridge shortcode guesser (reject `ACRONYM`; normalise street aliases)
