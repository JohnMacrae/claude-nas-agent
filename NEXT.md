# NEXT — Property Agent / Property Docs

Last updated: **2026-07-29** (Stage A of the pipeline plan done and verified live)

> **Start here:** `BUGS.md` in this folder — 16 bugs + 10 improvements covering work-order management and invoicing. `WORK_ORDERS_OUTSTANDING.html` is the 1 May–29 Jul audit.
>
> **Both are gitignored — local-only, present on the NAS at `/volume1/docker/property-agent/` but never committed.** This repo (`claude-nas-agent`) is **public**; those files and `agent/JJP_Property_List.md` carry portfolio addresses tied to live maintenance issues. Keep it that way — do not commit them, and keep addresses out of `NEXT.md`.
>
> The pre-2026-07-19 history below is retained and still accurate.

---

# ▼ CURRENT STATE

## Where the work is up to

**The approved plan is at `/home/john/.claude/plans/robust-strolling-anchor.md`** — six stages (A–F) that make a work order flow end to end into an enriched, deduplicated FreeAgent draft. Read it before continuing; the reasoning behind each stage is there.

**Stage A is complete and verified live.** Stages B–F are not started.

Still true from the audit: **no invoices since 12 May**, last reference `099`, next `100`. 38 work orders arrived 1 May–29 Jul, none matched to an invoice. Root cause was the producer/consumer calendar mismatch (WO routine writes **Maintenance**, invoicing read **Property**) — fixed in `property_invoicing/agent-system-prompt.md`, but **not yet exercised**.

## Stage A — done (`agent/scheduler.js`)

`POST /invoice-check` and `POST /invoice-mark`, guarded by the existing `checkCommandAuth` (`X-Command-Token`). These replace the Open Brain `[GCAL-INVOICED]` thoughts. Verified against the running container:

| Case | Result |
|---|---|
| check unknown event | `{invoiced:false}` |
| mark | `{duplicate:false}` + row |
| check again | `{invoiced:true}` |
| mark again | `{duplicate:true}` |
| no token | `401` |

The handler has its own try/catch returning **500** on store failure. This is deliberate and load-bearing: without it a DB error returns a clean `{invoiced:false}`, which the invoicing agent reads as permission to bill again. There is no other duplicate guard.

Test rows deleted; `invoices` table is back to 0.

## Findings that change earlier assumptions

1. **`agent/` is baked into the image — it is NOT bind-mounted.** Only `flags`, `logs`, `output`, `data`, and a few json/md files are mounted (`compose.yml:8-18`). Editing `agent/*.js` and restarting does nothing; you must `docker compose build agent && docker compose up -d agent`. This is why `/wo-scan` appeared "uncommitted but running".

2. **`freeagent.js --notes` is not a notes field.** `createInvoice` splits it on newlines and runs each line through `parseLineItem` (`agent/freeagent.js:175-179`) to make **invoice line items**. Putting WO prose there would print the tenant's problem as billable/comment lines on a customer invoice. There is no `comments` field on the request body (`:190-197`) — Stage C adds one.

3. **`agent-system-prompt.md:77-80` documents behaviour that does not exist** — it claims invoices automatically get `Property:` and `Work order: WO######` in notes. Nothing in `freeagent.js` writes either. **New bug for `BUGS.md`.**

4. **The duplicate guard was already built, just unwired.** `store.invoiceMark` (`agent/store.js:255-272`) already had `ON CONFLICT (event_id) DO NOTHING` returning `{duplicate:true}`. Stage A was plumbing, not new logic.

5. **`inbox_items` has zero rows, ever** — `min(created_at)` is null and there is no `DELETE` in `store.js`. The WO processor's `POST /inbox` has never persisted. **Diagnose this before building Stage B on it.**

6. **Gmail capture is healthy.** The `invalid_grant` in the WO processor log is from 09:45, *before* the re-auth at 10:39. The 11:45 run refreshed credentials cleanly and reported `Work orders captured: 0` — correct, nothing new arrived on a 1-day lookback.

7. **Only 6 of 38 WO PDFs survive on disk**; property-docs holds 9 `doc_type=wo` documents (text lives in `document_chunks`, there is no `content` column on `documents`). **Gmail is the only complete source** — hence Stage B.

8. **Telegram tokens confirmed byte-identical** between `.env` and `../property_invoicing/.env`. That is the whole 409 conflict. `sbbrain` and `sb_picture` are independent — leave them.

## Decisions taken this session

- **WO detail comes from Gmail**, folding `tools/wo_audit.py`'s richer parsing into `mail-reader/work_order_processor.py` — which already has Gmail, the PDF parser, and a `post_inbox_item` call. The invoicing container then pulls detail over HTTP via a new `/wo-detail`. **No `gmail_client.py` mount into invoicing, no Python there, no Docker socket** — simpler than the old action 3 and the same effect.
- **Scope is forward-looking.** Fix the plumbing so new work orders produce enriched drafts. The 38 historical WOs stay a separate triage task — per `CLAUDE.md`, which are chargeable is John's call, never automated.
- **Portfolio data stays out of the public repo** (see the banner above).

## Next actions

1. **Stage B** — diagnose the empty `inbox_items` first, then fold `wo_audit.py` parsing into the WO processor, widen the inbox schema, add `GET /wo-detail?wo=`. Touches `mail-reader` (second repo) and needs a schema change.
2. **Stage C** — add `--comments` → `invoice.comments` in `agent/freeagent.js`. Self-contained.
3. **Stage D** — retarget `property_invoicing/agent-system-prompt.md` steps 2b/2f/2g to curl; add `Bash(curl:*)` to `.claude/settings.local.json`; drop `open-brain` from `.claude/settings.json`; raise `--max-budget-usd` above `0.50` (a run already died at that cap on 2026-07-16).
4. **Stage E** — split the Telegram bots. Self-contained.
5. **Stage F** — verification, ending in a **dry run**: inspect the composed `create-invoice` command *before* it fires. No FreeAgent write without explicit approval.

Stages C and E are self-contained if you want quick wins before the large one.

**Human-only, no code:** triage the 38 work orders, and process **WO001537** + **WO001540** manually — they arrived during the token outage and are in no system at all. WO001540 is *no hot water, **urgent**, 24 Jul*; address in `BUGS.md` (local-only).

## Hygiene — noted, not actioned

`property_invoicing/.claude/settings.json` has a Supabase **service_role** JWT committed, and that repo's git remote embeds a GitHub PAT in plaintext. The repo is **private**, so this is hygiene rather than an incident, but both should be rotated and moved to env vars. Stage D touches that file anyway.

## Do not re-litigate

- **Maintenance calendar only** for invoicing. Property Calendar carries Rentr lettings viewings — never invoice those.
- **The local `ob1` container is not the problem.** `OPEN_BRAIN_MCP_URL=http://ob1:8000` is read by no code and the container isn't on a reachable network. The real Open Brain is a Supabase Edge Function; the invoicing agent sends the wrong auth header (`Authorization` instead of `x-brain-key`), so dedup has **never** worked. Stage D removes the dependency entirely rather than fixing it.
- **`DATABASE_URL` is correct.** The `ECONNREFUSED 172.18.0.4:5432` at boot is a one-shot startup race (`agent/scheduler.js:837-845`); `Scheduler running (standalone — no OB1)` is an unconditional literal, not a degraded-mode signal; weekend gaps are `isWorkday()`.
- **Gmail re-auth:** `get_token.py` from John's laptop with `py -3`, writing to `W:\gmail-mcp\config\<account>\token.json`. Not the container-based helper.
- Completion state **is** recorded — free text in Maintenance event descriptions ("Done 1hr", "Completed — 1.5 hours"). Unstructured, but present.

## Key paths

- **`/home/john/.claude/plans/robust-strolling-anchor.md`** — the approved six-stage plan
- `BUGS.md`, `WORK_ORDERS_OUTSTANDING.html`, `agent/JJP_Property_List.md` — **local-only, gitignored**
- `agent/scheduler.js` — endpoints; ledger routes sit just before `/wo-scan`
- `agent/store.js:255-272` — `invoiceCheck` / `invoiceMark`
- `agent/freeagent.js:162-215` — `createInvoice`, `parseLineItem`, the missing `comments`
- `tools/wo_audit.py` — Gmail WO audit; run via `mail-reader-gmail-processor` image, `AUDIT_AFTER=YYYY/MM/DD`
- `tools/fa_list.js` — read-only FreeAgent lister; `FA_FROM=YYYY-MM-DD node fa_list.js`
- `mail-reader/work_order_processor.py:305` — `post_inbox_item`; `:465` narrow `from:rentopia` query (BUG-004)
- `../property_invoicing/agent-system-prompt.md` — steps 2b/2f/2g are the Stage D targets
- Maintenance calendar: `963dbd01a359d150a2ba10371bf80a30dc448da1100abb14ab750966a9e8a547@group.calendar.google.com`
- Property calendar: `jj52rrbqum0q362phqmsjp20uc@group.calendar.google.com`

---

# ▼ EARLIER HISTORY (to 2026-07-19) — still accurate

## Goal

Standalone business property stack: local Postgres knowledge store (docs + semantic + analytics + property maintenance), decoupled from OB1 / personal Life Engine / Paperless-as-SoT.

## Runtime (now)

| Container | Status |
|-----------|--------|
| `property-agent` | Up — OpenRouter runner (`google/gemini-2.5-flash`), `/command` OK, Telegram OK |
| `property-docs-db` | Healthy — host **5435** |
| `property-docs-tika` | Up |
| `property-docs-ingest` | Up — consume poller |
| `work-order-processor` | Up — inbox + `output/work_orders` + Paperless consume |
| `gmail-pdf-processor` | Up — statements local; other PDFs → live Paperless consume |

Repos: https://github.com/JohnMacrae/claude-nas-agent · https://github.com/JohnMacrae/property-docs

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
- Verified: `POST /command` “number for 24HC” → tenant names + mobiles (~3s) + Telegram
- Also verified: open tasks at 40WSS

### Tenant contacts from WO PDFs (2026-07-18 / 19)
- Source of truth: Rentopia **Supplier Instructed.pdf** → `Contact for Access` + `Mobile:`
- Store: `/output/work_orders/*.pdf` → cache `/data/tenant-contacts.json` via `wo.js`
- Agent tool: `wo_lookup` — “number for 24HC” → tenant name(s) + mobile(s)
- **Auto-save on intake:** work-order-processor writes `{WOnnn}.pdf` + `POST /wo-scan` (verified WO001536 + scan 2026-07-19)
- Uncommitted property-agent side: `/wo-scan` in `scheduler.js` (running in container)

### WO → Paperless path fixed (2026-07-19)
- Root cause: mail-reader mounted **dead** `paperless-ngx/consume`; Paperless watches `paperless/consume`
- Also: every WO named `Supplier Instructed.pdf` → false “Already in Paperless” skip
- Fix: remount live consume; unique names `{WOnnn}_Supplier Instructed.pdf`; WO processor also drops to consume
- Queued local WO001498/1499/1501/1535/1536 → Paperless (ids 4732–4736)
- Orphaned ~210 files moved to `paperless-stack/paperless-ngx/consume-orphan-20260719` (not auto-imported)
- Fixed `PAPERLESS_TOKEN` trailing comment in property-docs `.env`

### Siri Shortcut (manual setup on iPhone)
1. Shortcut: **Get Contents of URL**
   - URL: `http://<tailscale-host>:3005/command` (or LAN IP)
   - Method: POST
   - Headers: `Content-Type: application/json`, `X-Command-Token: <COMMAND_TOKEN from .env>`
   - Body (JSON): `{"text":"<Dictated Text>"}` — use Shortcut “Ask for Input” / Dictate Text
2. **Show Result** / **Speak Text** on the `reply` field from the JSON response
3. Example phrases: “number for 24HC”, “open tasks at 40WSS”, “mark 40WSS complete”

### Google Calendar auth (2026-07-18)
- Reused rentr-dashboard OAuth client; fresh `GOOGLE_REFRESH_TOKEN` after browser consent (`calendar.events` scope)
- Verified: `gcal.js list-events --calendar Maintenance` → ok
- Note: `list-calendars` may 403 on this scope; event ops use hardcoded Maintenance/Property IDs

### Paperless → property-docs WO bridge (2026-07-19)
- Bridge: `--filename-contains Instructed`
- Imported **9** Supplier Instructed / WO docs (`doc_type=wo`; +WO001488 / 75FWG)
- Shortcodes: 10CC, 48BC×2, 78TS, 8AM, 122NG, 24HC, 14FWG, 75FWG
- Bridge guesser updated for Rentopia “Property N / street” OCR layout
- Note: list has `Fridaywood` vs OCR `Friday Wood` — shortcode for 75FWG set manually

### Orphan consume triage (2026-07-19) — `consume-orphan-20260719` (~209 left)
Categorised by filename + `pdftotext` sampling. **Not auto-imported** (per ignore statements / JJP LLP).

| Bucket | ~count | Recommendation |
|--------|--------|----------------|
| Rentopia “Statement N for £…” | ~55 | Keep archived — do **not** import (policy) |
| Service-charge / block accounts (ED, Colne Reach, Maple Court, etc.) | ~15 | Optional later → Paperless `accounts` |
| Sapphire payment receipts (hash-named) | ~30 | Optional later — block SC receipts |
| Contractor invoices (Mighty Electrical, Lettings in a box, etc.) | ~28 | Optional later → Paperless |
| EICR / EIC / EPC | 13 | **Done** — Paperless 4738–4750 + bridged |
| Tenant refs (`lib-ref-*`) | ~14 | Optional — referencing |
| Trade receipts (Wickes) | 7 | Optional / expenses |
| Google Workspace / Microsoft (JJP LLP) | ~6 | Skip (LLP / personal SaaS) |
| Personal (will, passport scans, train e-receipt, WeddingsByDesign) | ~6 | **Do not** import to property Paperless |
| Octopus energy | ~10 | Skip unless void utilities asked |
| **WO001488** `Supplier Instructed.pdf` | 1 | **Done** → Paperless id **4737**, `wo-scan` 75FWG, bridged |

Queued WO + EICR originals under `consume-orphan-20260719/_queued_to_paperless/`. WO also at `output/work_orders/WO001488.pdf`.

### EICR pack import (2026-07-19)
- 13 files → Paperless **4738–4750** → property-docs (`doc_type=eicr` / `epc`)
- Properties: 6WC, 179C, 27NPS, 106CR, 11AM, 9AM, 198C, 81FG, 85NG (×3 EICR + EIC + EPC)
- Manual shortcode fixes where guesser hit bogus `ACRONYM` or Fridaywood/Friday Wood mismatch

## Still open

1. Add iPhone Siri Shortcut(s) for `/command`
2. Optional orphan follow-ups (invoices / SC / refs) — leave rest archived by default
3. **Optional:** fix/delete the 6 unmatched maintenance rows; rotate OpenRouter key; change property-docs Postgres password if still default
4. Optional: harden bridge shortcode guesser (reject `ACRONYM`; normalise Fridaywood)

## Next actions (priority)

1. Add iPhone Siri Shortcut(s) for `/command`
2. Wider Paperless→property-docs imports later (still ignore statements / JJP LLP unless asked)
