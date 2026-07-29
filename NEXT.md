# NEXT — Property Agent / Property Docs

Last updated: **2026-07-29** (work-order → invoicing audit; calendar mismatch found and fixed)

> **Start here:** `BUGS.md` in this folder — 16 bugs + 10 improvements covering work-order management and invoicing. `WORK_ORDERS_OUTSTANDING.html` is the 1 May–29 Jul audit. Both are new as of 2026-07-29.
>
> **Both are gitignored — local-only, present on the NAS at `/volume1/docker/property-agent/` but never committed.** This repo (`claude-nas-agent`) is **public**; those files and `agent/JJP_Property_List.md` carry portfolio addresses tied to live maintenance issues. Keep it that way — do not commit them, and keep addresses out of `NEXT.md`.
>
> The pre-2026-07-19 history below is retained and still accurate.

---

# ▼ CURRENT SESSION (2026-07-29)

## Headline

**No invoices have been raised since 12 May.** Last invoice reference is **`099`** — next is `100`. 38 work orders arrived 1 May–29 Jul; none are matched to an invoice.

**Root cause (BUG-000, now fixed):** the WO→calendar routine writes to the **Maintenance** calendar; the invoicing agent was reading the **Property** calendar. Both IDs sit side by side in `agent/gcal.js:12-14`. Producer and consumer never met.

## Changed this session

| File | Change | Live? |
|---|---|---|
| `property_invoicing/agent-system-prompt.md` | Retargeted Property → **Maintenance** calendar (lines 1, 33, 114); added "never read Property Calendar" guard (it carries Rentr viewings) and stop-don't-fall-back if the calendar is missing | Yes — `:ro` mount, applies next session |
| `gmail-mcp/reauth.bat` | `python` → `py -3` | n/a |
| `gmail-mcp/reauth-kk4oyj.bat` | **new** — re-mints kk4oyj against the jramacrae OAuth client | n/a |
| `property-agent/BUGS.md` | **new** | n/a |
| `property-agent/WORK_ORDERS_OUTSTANDING.html` | **new** | n/a |
| `property-agent/tools/{wo_audit.py,fa_list.js}` | **new** — audit scripts preserved from scratch | n/a |
| `/volume1/docker/CONTAINERS.html` | **new** — NAS-wide stack index (stays at NAS level; non-invoicing findings live in its actions table) | n/a |

Gmail tokens for `jramacrae` and `kk4oyj` were dead 8+ days — **re-authed and verified**. No code changed, no invoices created, all FreeAgent access read-only.

## Which LLM runs what (verified live 2026-07-29)

| Agent | LLM | How |
|---|---|---|
| `property-agent` | **`google/gemini-2.5-flash`** via OpenRouter | `agent/agent-runner.js` custom tool loop. Set in `.env`; defaulted at `agent-runner.js:17`; used at `:657`, `:771`. Confirmed in the running container. |
| `property_invoicing` | **Claude** (Claude Code default, John's account) | `scheduler.js:194-208` spawns `claude --print`, capped `--max-budget-usd 0.50` |

**Three consequences for the prompt work in action 1:**

1. **property-agent has no Bash and no MCP client.** Per the 2026-07-18 migration below — *"Prompt retargeted to discrete tools (no Bash / no Claude MCP); Claude Code removed from image; `~/.claude` mounts dropped from compose."* Enriching its prompt means working within its registered tools (`gcal_*`, `store_*`, `wo_lookup`, `telegram_send`); it cannot be told to run a script.
2. **This is why Gmail access must be a direct `gmail_client.py` call, not an MCP** (action 3) — there is no MCP client left in that container to host one.
3. **Gemini 2.5 Flash is cheap and fast but light.** Fine for routing and lookups; extracting full structured work-order detail from PDF text is a heavier task. If enriched invoices come out thin or inconsistent, suspect the model before the prompt — `AGENT_MODEL` is a one-line env change to test something stronger.

**Also:** `property_invoicing`'s £0.50 per-session budget already killed a run outright (`Error: Exceeded USD budget (0.5)`, 2026-07-16). Asking it to do more per session will require raising that cap.

## Next actions (priority)

1. **Enrich draft invoices with full WO detail** ← John's next task. Currently the invoice inherits only `--description "<event.summary>"` / `--notes "<event.description>"`, so it gets terse calendar text ("Done 1hr"). Wants WO number, property, problem, priority, dates, work performed.
   **Blocker:** the detail lives in the WO PDFs but only **6 of 38** survive on disk (BUG-012 — backfill only reaches the 1-day/7-day lookback). Deep-backfill before relying on them.

2. **Telegram — give invoicing its own bot.** SBBrain is **not** the conflict. Four stacks, three distinct bots, all posting to chat `725925511`:

   | Stack | Token sha256 prefix | |
   |---|---|---|
   | `property-agent` | `4271b6cc` | ← **same token** |
   | `property_invoicing` | `4271b6cc` | ← **same token** |
   | `sbbrain` | `210f52ba` | independent — leave alone |
   | `sb_picture` | `c4f4424b` | independent — leave alone |

   The 409 `getUpdates` conflict is purely property-agent ↔ property-invoicing. Mint a new bot for invoicing, or unset `TELEGRAM_BOT_TOKEN` there. Decide which agent owns inbound commands.

3. **Gmail access for the invoicing agent.**
   **Blocker:** the `gmail-*` MCP servers in `/home/john/.claude.json` are stdio servers that run `docker run --rm -i`; `property-invoicing` has no Docker socket, so it cannot start them.
   **Recommended:** bind-mount `gmail-mcp/gmail_client.py` and call it directly, as `mail-reader`, `EICR`, `BL_Audit` and `lead-tracker` already do. No socket exposure, matches existing pattern.

4. **Migrate invoicing off Open Brain** (connectivity proven: `property-invoicing → 172.17.0.1:3005/status` = HTTP 200):
   1. Add `/invoice-check` + `/invoice-mark` to `agent/scheduler.js` — thin wrappers over existing `store.invoiceCheck()` / `store.invoiceMark()` (`agent/store.js:255-272`), `COMMAND_TOKEN`-guarded like `/command`
   2. Repoint invoicing prompt steps 2b/6g to curl them — needs `Bash(curl:*)` in `property_invoicing/.claude/settings.local.json` (currently `node|cat|ls` only)
   3. Drop `open-brain` from `property_invoicing/.claude/settings.json`

   Fixes BUG-005 + BUG-014 together and makes a backfill safe.

5. **Human-only, no code:** triage the 38 work orders (which are chargeable?) — shortlist of 11 with completion notes is in BUG-000. And process **WO001537** + **WO001540** manually; they arrived during the token outage and are in no system at all. WO001540 = *no hot water, **urgent**, 24 Jul* — address in `BUGS.md` (local-only).

## Calendar / MCP access — resolved 2026-07-29

**The invoicing agent's calendar access comes from Claude account-level connectors, not from local MCP config.** `/home/john/.claude.json` (bind-mounted into the container alongside `~/.claude`) records:

```
claudeAiMcpEverConnected = ["claude.ai Gmail", "claude.ai Google Calendar",
  "claude.ai Open Brain", "claude.ai Home Maintenance", "claude.ai sbbrain", …]
account: jramacrae@gmail.com
```

The prompt's tool names (`list_calendars`, `list_events`, `search_thoughts`, `capture_thought`, `log_maintenance`) match the connector tool names exactly. Google Calendar via this connector is **authenticated and working** — it was used successfully this session to read both calendars.

**Two corrections to earlier conclusions:**

1. **The "`list-calendars` may 403" note below does *not* apply here.** That concerns `agent/gcal.js`, which uses property-agent's own `GOOGLE_REFRESH_TOKEN` — a different auth path entirely. The invoicing agent goes through the Claude connector. Step 1 of the prompt is fine as written.

2. **BUG-014/BUG-015 have a second possible cause.** Open Brain and Home Maintenance exist *both* as local MCP entries in `property_invoicing/.claude/settings.json` (with the wrong auth header — verified 401) *and* as claude.ai connectors. In the current context those two connectors expose only `authenticate` / `complete_authentication`, i.e. they are **not authenticated**, whereas Google Calendar exposes its full tool set. So whichever path the container resolves at runtime, both are broken — but the fix differs:
   - local MCP path → correct the header to `x-brain-key` (proven to return 200)
   - connector path → re-authenticate the connectors from Claude

   **Not yet determined which path the container actually resolves.** Settle this before spending effort on either fix — a single test run with a trivial `search_thoughts` call would answer it. The migration in action 4 removes the ambiguity entirely by dropping Open Brain from the invoicing path.

## Do not re-litigate

- **Maintenance calendar only** for invoicing. Property Calendar carries Rentr lettings viewings — never invoice those.
- **The local `ob1` container is not the problem.** `OPEN_BRAIN_MCP_URL=http://ob1:8000` is read by no code, and the container isn't on a reachable network. Starting it changes nothing. The real Open Brain is a **Supabase Edge Function** and it is ACTIVE — the invoicing agent just sends the wrong auth header (`Authorization` instead of `x-brain-key`), so dedup has **never** worked. See BUG-014.
- **`DATABASE_URL` is correct.** The `ECONNREFUSED 172.18.0.4:5432` is a one-shot startup race (`agent/scheduler.js:837-845`); `Scheduler running (standalone — no OB1)` is an unconditional literal (`:847`), not a degraded-mode signal; the 25–26 July gap was **the weekend** (`isWorkday()`, `:75`). Verified live.
- **Gmail re-auth:** `get_token.py` run from John's laptop with `py -3`, writing to `W:\gmail-mcp\config\<account>\token.json`. Not the container-based helper.
- Completion state **is** recorded — free text in Maintenance event descriptions ("Done 1hr", "Completed — 1.5 hours"). Unstructured, but present.

## Key paths (this session)

- `BUGS.md`, `WORK_ORDERS_OUTSTANDING.html` — this folder
- `tools/wo_audit.py` — Gmail WO audit, broader than the processor's `from:rentopia` query. Run via `mail-reader-gmail-processor` image with `gmail_client.py` + `work_order_processor.py` mounted, `AUDIT_AFTER=YYYY/MM/DD`, `LOG_PATH=/tmp/audit.log`
- `tools/fa_list.js` — read-only FreeAgent lister; `docker cp` into `property-agent`, `FA_FROM=YYYY-MM-DD node fa_list.js`. Basis for BUG-006's `list-invoices`
- `agent/freeagent.js:233` — `create-invoice` only, no list/reconcile
- `agent/gcal.js:12-14` — both calendar IDs
- `agent/store.js:255-272`, `agent/agent-runner.js:228,240` — the unused ledger
- `mail-reader/work_order_processor.py:465` — narrow `from:rentopia` query (BUG-004)
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
