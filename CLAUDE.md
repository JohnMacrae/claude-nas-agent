# Property Agent — project instructions

Work-order management and invoicing for John Macrae's 60-property Colchester rental portfolio (managed via Rentopia).

**Read `NEXT.md` first for current state, `BUGS.md` for known defects.** This file holds only durable facts — things that stay true between sessions.

**This repo is public.** `BUGS.md`, `WORK_ORDERS_OUTSTANDING.html` and `agent/JJP_Property_List.md` are gitignored because they map portfolio addresses to live maintenance issues. They exist locally at `/volume1/docker/property-agent/`. Do not commit them, and keep addresses and postcodes out of anything that is committed.

---

## Architecture — know this before proposing changes

**Two agents, two different LLMs, two different runtimes.**

| | `property-agent` (this folder) | `property_invoicing` (`../property_invoicing/`) |
|---|---|---|
| LLM | **`google/gemini-2.5-flash`** via OpenRouter | **Claude**, via `claude --print` |
| Runtime | `agent/agent-runner.js` — custom tool loop | Claude Code CLI, `--max-budget-usd 0.50` |
| Tools | Registered tools only — **no Bash, no MCP client** | Bash (allowlisted) + Claude account connectors |
| Schedule | morning 05:00, property-check 07:00–15:00 /2h, weekdays | 06:00 Mon–Fri, single shot |

`property-agent` **has no Bash and no MCP client** — Claude Code was removed from its image on 2026-07-18 and the `~/.claude` mounts dropped. It cannot be told to "run a script". Anything new it must do has to be a registered tool in `agent/agent-runner.js` (`gcal_*`, `store_*`, `wo_lookup`, `telegram_send`, …).

Consequence: **give it Gmail access by bind-mounting `gmail-mcp/gmail_client.py` and calling it directly**, as `mail-reader`, `EICR`, `BL_Audit` and `lead-tracker` all do. Not via MCP.

`isWorkday()` (`agent/scheduler.js:75`) gates the schedule on weekday + UK bank holidays. Gaps at weekends are expected, not faults.

## The pipeline

```
Rentopia email  →  mail-reader/work_order_processor.py  →  POST /inbox (172.17.0.1:3005)
                →  property-agent  →  Maintenance calendar event (+ WO PDF, + Paperless)
                →  property_invoicing (06:00)  →  reads yesterday's Maintenance events
                →  freeagent.js create-invoice  →  FreeAgent draft
```

## Standing decisions — do not re-litigate

- **Maintenance calendar only** for invoicing. The Property Calendar carries Rentr lettings viewings which must **never** be invoiced. (Decided 2026-07-29.) IDs are in `agent/gcal.js:12-14`.
- **The local `ob1` container is not a dependency.** `OPEN_BRAIN_MCP_URL=http://ob1:8000` in `../property_invoicing/.env` is read by no code, and the container is not on a reachable network. Starting it changes nothing — do not propose it. The real Open Brain is a Supabase Edge Function; see BUG-014.
- **`property-agent` was deliberately decoupled from Open Brain / OB1** (`agent-system-prompt.md:10`, `:196` — *"NEVER Open Brain"*). Its replacement ledger is `store_invoice_check` / `store_invoice_mark` → the `invoices` table (`agent/store.js:255-272`). Use that, not thoughts.
- **`DATABASE_URL` is correct.** `ECONNREFUSED 172.18.0.4:5432` at boot is a one-shot startup race (`agent/scheduler.js:837-845`), caught and harmless — property-agent and property-docs are separate compose projects so `depends_on` is impossible. `Scheduler running (standalone — no OB1)` (`:847`) is an unconditional literal, **not** a degraded-mode signal.
- **Gmail re-auth:** `gmail-mcp/get_token.py` run from John's laptop with `py -3`, writing straight to `W:\gmail-mcp\config\<account>\token.json`. Launchers: `reauth.bat`, `reauth-kk4oyj.bat`. Do not propose the container-based `gmail-auth-helper`.
- **Job completion is recorded as free text** in Maintenance event descriptions ("Done", "Done 1hr", "Completed — 1.5 hours"). Unstructured, but it is there — do not conclude completion is untracked.

## Safety rules

- **Never create, amend or delete a FreeAgent invoice without explicit approval.** `freeagent.js create-invoice` writes to live accounts. Read-only inspection is fine — use `tools/fa_list.js`.
- **There is no duplicate-invoice guard** (BUG-008) and dedup is currently broken (BUG-014). Assume any invoicing run can double-bill until both are fixed.
- **A work order existing does not mean a charge is due.** Refurb / EPC / EICR-remedial jobs are often quoted separately; some are cancelled. Triage is John's call — present a list, never auto-invoice.
- Invoice numbering is sequential and **currently at `099`**. Check continuity before creating.
- Do not change Docker ports, Tailscale, DNS or firewall without explicit authorisation.

## Conventions

- Properties are identified by **shortcode** (`122NG`, `24HC`, `8AM`). Canonical list: `../property_details/JJP_Property_List.md`; street aliases: `property-aliases.json`; rates: `rates.json`.
- Shortcode resolution is punctuation-sensitive and silently drops work orders when it fails (BUG-011). Prefer postcode matching.
- Work orders are `WO######`. Include the WO number in invoice descriptions so reconciliation is exact (BUG-009).

## Key files

| Path | What |
|---|---|
| `NEXT.md` | Current state + priority actions |
| `BUGS.md` | 21 bugs, 10 improvements — **gitignored, local-only** |
| `WORK_ORDERS_OUTSTANDING.html` | 1 May–29 Jul audit — **gitignored, local-only** |
| `agent/JJP_Property_List.md` | 60 shortcodes → addresses — **gitignored, local-only** |
| `WORK_ORDER_PIPELINE.md`, `HANDOFF.md` | Pipeline detail, longer history |
| `agent/agent-runner.js` | Tool loop + tool definitions |
| `agent/scheduler.js` | Schedule, watchdog, HTTP endpoints (`:416-554`) |
| `agent/freeagent.js` | `create-invoice` only — no list/reconcile yet |
| `agent/gcal.js` | Calendar tools + both calendar IDs |
| `agent/store.js` | Local store incl. the unused invoice ledger |
| `tools/wo_audit.py` | Gmail work-order audit (broader than the processor's query) |
| `tools/fa_list.js` | Read-only FreeAgent invoice lister |
| `../CONTAINERS.html`, `../PORTS.html` | NAS-wide stack index and port registry |
