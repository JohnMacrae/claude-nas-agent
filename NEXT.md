# NEXT — Property Agent / Property Docs

Last updated: **2026-08-25** (key_lookup added — see below)

## Key/lockbox lookup by shortcode — 2026-08-25 (`384a738`)

New `key_lookup` tool (`agent/keys.js`), same voice-command pattern as `wo_lookup`. The Key book CSV (`/volume1/docker/property_details/Key book - *.csv`, sibling dir, not in this repo) had no shortcode column, only free-text addresses — rather than fuzzy-matching on every live query, `node keys.js match` did that once offline (reusing `wo.js`'s `resolveShortcode` token-overlap logic, now exported as `norm`/`houseNumber`) and wrote a `Shortcode` column into the CSV directly. 62/62 rows matched confidently, 0 flagged. Runtime `lookup()` is now a trivial exact match — no fuzzy guessing live. Verified end-to-end: `POST /command "key for 48BC"` → `"Key B049, lockbox 7487."`.

**If the Key book is ever re-exported** (new timestamped filename, e.g. new/changed rows): re-run `node keys.js match` — it only fills in blank `Shortcode` cells and re-flags anything that doesn't match, existing rows are left untouched.

## Invoice-run Telegram report restructured — 2026-08-25 (`c4ad8ee`)

Two clear sections now: "✅ Completed & invoiced" (drafted or sent) and "⚠️ Completed, unpaid" (completed but genuinely unbilled — no billable lines parsed, or a FreeAgent create error). The unpaid bucket previously had zero visibility — those jobs silently vanished into an internal skip list. See `agent/invoice-run.js`'s `formatTelegramReport`.

## Work-order Gmail capture folded into property-agent — 2026-08-25 (`dc050e4`)

property-agent now captures work orders directly (new `agent/gmail.js` + `agent/wo-gmail-scan.js`, native Node port — see commit message for full detail). Verified 0 mismatches against Python's parser/shortcode logic on all 48 fixture PDFs in `output/work_orders`, and a live dry-run matched today's earlier Python-container capture exactly.

**Currently in parallel-run**: mail-reader's `work-order-processor` container is still running (`docker-compose.yml` at `/volume1/docker/mail-reader`, cron slots 05:30/07:45.../17:45) alongside property-agent's own new schedule (same times, in-process). Both are safe together — `store.addInboxItem`'s `order_number` uniqueness means whichever finds a WO first wins, the other no-ops. **Not yet retired** — compare logs for 2-3 days across all seven schedule slots before removing the `work-order-processor` service block from mail-reader's compose file. (The plan file this was designed from has since been overwritten by the key_lookup plan above — this paragraph is now the authoritative record of that decision.) `gmail_pdf_processor.py`/`gmail-processor` (Rentopia statement parsing, unrelated) is untouched either way.

**Next step**: after a few days of clean parallel-run agreement, remove `work-order-processor` from `mail-reader/docker-compose.yml` and archive (don't delete) `work_order_processor.py`.

## Agent was down 2026-08-23 → 2026-08-25 — fixed

Two independent breakages, both now resolved:

- **LLM backend**: an in-progress change switched `LLM_BACKEND` to `ollama` pointing at `shack.beetal-carp.ts.net:11434` (Ollama on shack, over Tailscale) — an attempt to move off OpenRouter. Port 11434 was unreachable (closed/filtered) from the NAS host itself, so every scheduled session (morning, property-check, manual) failed instantly with `fetch failed`. Reverting to OpenRouter then surfaced a second problem: the key (`sk-or-v1-335d...`) had a **$3/month spend limit configured on the key itself** (separate from account credit balance — check via `GET openrouter.ai/api/v1/key`), and it was spent — that's *why* the Ollama migration was started. John raised the key's limit; verified working against a paid model (`~deepseek/deepseek-v4-flash-latest`) same day.
- **Google Calendar**: `invalid_grant` again (recurring ~7-day expiry). Re-authorised via the SSH-tunnel method (`ssh -L 8765:localhost:8765 <nas>` → `http://localhost:8765/admin/google-auth`), then `tools/sync-gcal-token.sh`. Auth confirmed OK, `gcal-auth-dead` flag cleared. **Still not confirmed** whether the OAuth client's publishing status is actually "In production" in Google Cloud Console — if it's slipped back to Testing, this will recur every 7 days. Worth checking.

**Committed** (`bd0e9c0` + follow-up on `fix/wo-paperless-bridge-handoff`): Ollama-backend support (dormant unless `LLM_BACKEND=ollama`), the morning `telegram_send` guard, WO-vs-`maintenance_add` dedup fixes, and defaults in `compose.yml`/`.env.example` flipped back to `openrouter` (was defaulting to `ollama`, which is how the outage happened — a fresh checkout would have inherited the same break).

### Model fallback — added 2026-08-25 (`agent/agent-runner.js`), now cross-backend

`AGENT_MODEL_FALLBACK` (comma-separated, optional) is tried in order if `AGENT_MODEL`'s request fails for any reason (model pulled/renamed, key limit, backend unreachable, provider outage). Each entry is either a bare model (same backend as `AGENT_MODEL`) or `backend:model` (e.g. `openrouter:google/gemini-2.5-flash`) to fail over to a different backend entirely. Runner logs which backend+model actually served each request; the result JSON's `backend`/`model` fields report what succeeded, not just the configured primary.

**Tried Ollama on shack as primary, reverted same day — data-corruption risk, not just slow.**

`qwen3:4b` worked but was far too slow for scheduled use (7 minutes for one Telegram tool-call round trip). Switched to `qwen2.5:7b-instruct-q4_K_M` — fast (8s) on a synthetic test, but on a **real property-check run with 4 live work orders** it: called `maintenance_log` (the recurring-task ledger tool) using inbox-item IDs as `task_id`, **fabricated fictitious repair-completion notes** ("Temp repair completed, issue resolved until next inspection" — no such repair happened), hit a DB foreign-key error twice, then gave up. It never created the Maintenance calendar events, never sent the required 🔴 urgent Telegram alerts for the two urgent WOs (78BC electrics + water ingress, 16AM smoke alarm), and never closed the inbox items — silently, with a plausible-sounding final reply. Confirmed via `/status` (`openInbox` still 4) and an empty Maintenance calendar query.

Had to bypass it and re-run the same session manually forced onto OpenRouter (`~deepseek/deepseek-v4-flash-latest`), which processed all 4 correctly in 36s: 4 calendar events, all inbox items closed, urgent Telegram alert sent (`message_id:385`).

**Reverted to OpenRouter as primary same day.** Ollama/shack dropped from the fallback chain entirely — a confidently-wrong result that corrupts state is worse than an honest failure, so it's not worth keeping as a fallback either. If shack is revisited later, any candidate model needs to be validated against a real multi-tool-call session (not just a trivial "reply OK" test) before it's trusted with live work orders.

Current live `.env` (not committed — gitignored):
```
LLM_BACKEND=openrouter
OLLAMA_BASE_URL=http://shack.beetal-carp.ts.net:11434
AGENT_MODEL=~deepseek/deepseek-v4-flash-latest
AGENT_MODEL_FALLBACK=openrouter:~deepseek/deepseek-v4-flash-latest,openrouter:google/gemini-2.5-flash,openrouter:minimax/minimax-m2.7:free,openrouter:nvidia/nemotron-3-super-120b-a12b:free
```
(First fallback entry is redundant with the primary and gets deduped automatically by `agent-runner.js` — harmless, left as-is.)

Last two fallbacks are free-tier OpenRouter models (confirmed working, no spend-limit exposure) — genuine last-resort if both paid models are unavailable. Fallback mechanism itself verified end-to-end by forcing a bogus primary model and confirming the runner logs the fallthrough correctly.

### Also fixed same session: Gmail token expiry was blocking new work-order capture

Separate from the Calendar token (different account/scope): the `jramacrae` Gmail token feeding `gmail-pdf-processor`/`work-order-processor` had been dead since 2026-07-29 (`invalid_grant`), failing silently every night at 02:00. John re-ran `reauth.bat` from the laptop. Backlog caught up manually:
```
docker exec gmail-pdf-processor python3 /app/gmail_pdf_processor.py       # files PDFs to Paperless
docker exec -e WO_DAYS_TO_SEARCH=7 work-order-processor python3 work_order_processor.py   # POSTs WOs to /inbox
```
Note: `gmail-pdf-processor` and `work-order-processor` are **two different containers** built from the same image (`/volume1/docker/mail-reader/docker-compose.yml`) — only `work-order-processor` has `PROPERTY_AGENT_URL` set correctly (`http://172.17.0.1:3005`); running the WO script inside `gmail-pdf-processor` fails with a DNS error (`property-agent` hostname unresolvable — wrong network) since it defaults to `http://property-agent:3001`. Use `work-order-processor` for anything WO-related.

---

> **Start here:** `BUGS.md` in this folder — 21 bugs + 10 improvements covering work-order management and invoicing. `WORK_ORDERS_OUTSTANDING.html` is the 1 May–29 Jul audit.
>
> **Both are gitignored — local-only, present on the NAS at `/volume1/docker/property-agent/` but never committed.** This repo (`claude-nas-agent`) is **public**; those files and `agent/JJP_Property_List.md` carry portfolio addresses tied to live maintenance issues. Keep it that way — do not commit them, and keep addresses out of `NEXT.md`.

---

# ▼ CURRENT STATE

## Where the work is up to

**The approved plan is at `/home/john/.claude/plans/robust-strolling-anchor.md`** — six stages (A–F). Read it before continuing; the reasoning behind each stage is there.

**Stages A, B and C are complete. Invoice automation now lives in property-agent (`invoice-run`). D–F partially superseded.**

### Invoice-run — done 2026-08-12 (`agent/invoice-run.js`)

Deterministic (no LLM) path owned by property-agent:

1. Scan Maintenance from `2026-05-01` → today
2. **Draft** when description has `done`/`complete`/`completed` at line/sentence start **and** notes parse to ≥1 billable line (no minimum-charge fallback; no category skips). Cancelled → skip.
3. Ledger row: `event_id`, `invoice_url`, `reference`, `status=draft`, `drafted_at`, `net_value`
4. **Email** FreeAgent draft to `jramacrae@gmail.com` when `status=draft` and `drafted_at` ≥ 24h old → `status=sent`
5. Morning Telegram lists drafted / emailed / outstanding open WOs (+ `/wo-report` link)
6. Manual: `POST /invoice-run` (token) or `node invoice-run.js [--dry-run|--create-only|--send-only]`

`property_invoicing` 06:00 auto-create is **disabled** (log only) to prevent double-billing. First-hour rate is once per job. Parser also accepts `Done 1hr` / `Label 2hr` (no dash).

**Live backlog (2026-08-12):** FreeAgent drafts **102–130** (29 rows, all with `invoice_url`). None emailed yet — 24h gate. Re-check: create pass is idle; send pass empty until tomorrow morning.

**Schema:** `property-docs/schema/003_invoices_status.sql` (+ runtime `ALTER` in `store.js`).

### WO001557 missing from calendar — fixed 2026-08-12 (BUG-018 in the wild)

Property-check on **10 Aug** got `invalid_grant` on `gcal_create_event` / `gcal_list_events`, then still `store_complete`d the inbox ("attempted to create calendar event"). No Maintenance event → invisible to `/wo-report` and invoice-run.

**Fixed:** created Maintenance event `59BC - WO001557` (dated 10 Aug), reopened inbox item. Now **open** on outstanding report (~2 days old). Physical work still outstanding (urgent boiler/timer + neighbour ceiling water).

### Invoice notes parser — done 2026-08-12 (`agent/freeagent.js`)

Live test on Maintenance event for WO001474 (multi-line trailing hours). Blind pass previously billed **£70 minimum**.

Now:
- Trailing / leading hours, `Done 1hr`, `Label 2hr`
- Drops noise + WO intake boilerplate
- **First hour once per job**
- CLI: `parse-notes`, `update-invoice`, `send-invoice`
- Dry-run: `node tools/fa_parse_notes_test.js`

**Deploy note:** `agent/` is baked into the image — `Dockerfile` must `COPY invoice-run.js`; rebuild after pull.

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

1. **BUG-018** — forbid `store_complete` unless referenced tool calls returned `ok:true` (WO001557 on 10 Aug is the live proof).
2. Tomorrow morning: confirm invoice-run **emails** drafts ≥24h old (102–130).
3. Attend **WO001557** (urgent boiler / neighbour ceiling) — now on calendar + open inbox.
4. **Stage E** — split the Telegram bots (if still wanted).
5. Optional: richer `/wo-detail` comments on drafts.

**Human-only:** review FreeAgent drafts before/as they email; delete duplicate `30RC - WO001496` event (BUG-020).

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
