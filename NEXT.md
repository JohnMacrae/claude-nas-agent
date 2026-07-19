# NEXT — Property Agent / Property Docs

Last updated: 2026-07-19 15:45 (dcppr)

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
- Imported **8** Supplier Instructed / WO docs (`doc_type=wo`, 8 chunks + embeddings)
- Shortcodes: 10CC, 48BC×2, 78TS, 8AM, 122NG, 24HC, 14FWG (OCR backfill for filename-only titles)
- Bridge guesser updated for Rentopia “Property N / street” OCR layout

## Still open

1. Triage `consume-orphan-20260719` (~210 files) if anything useful remains
2. Add iPhone Siri Shortcut(s) for `/command`
3. **Optional:** fix/delete the 6 unmatched maintenance rows; rotate OpenRouter key; change property-docs Postgres password if still default

## Next actions (priority)

1. Add iPhone Siri Shortcut(s) for `/command`
2. Optional: triage orphan consume archive
3. Wider Paperless→property-docs imports later (still ignore statements / JJP LLP unless asked)
