# NEXT — Property Agent / Property Docs

Last updated: 2026-07-18 18:10

## Goal

Standalone business property stack: local Postgres knowledge store (docs + semantic + analytics + property maintenance), decoupled from OB1 / personal Life Engine / Paperless-as-SoT.

## Runtime (now)

| Container | Status |
|-----------|--------|
| `property-agent` | Up — OpenRouter runner (`google/gemini-2.5-flash`), `/command` OK, Telegram OK |
| `property-docs-db` | Healthy — host **5435** |
| `property-docs-tika` | Up |
| `property-docs-ingest` | Up — consume poller |

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

### Tenant contacts from WO PDFs (2026-07-18)
- Source of truth: Rentopia **Supplier Instructed.pdf** → `Contact for Access` + `Mobile:`
- Store: `/output/work_orders/*.pdf` → cache `/data/tenant-contacts.json` via `wo.js`
- Agent tool: `wo_lookup` — “number for 24HC” → tenant name(s) + mobile(s), not the street address
- Verified 24HC from WO001535: Juliet + Chibuzo Nwachukwu numbers
- **Gap:** processor does not yet auto-save PDFs into `output/work_orders` on intake — drop PDFs there (or fetch) then `wo_scan`

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
- Verified: `gcal.js list-events --calendar Maintenance` → ok (e.g. 24HC WO001535, 14FWG WO001536)
- Note: `list-calendars` may 403 on this scope; event ops use hardcoded Maintenance/Property IDs
- Re-auth if needed: forward `8765`, open http://localhost:8765/admin/google-auth (http not https), copy token into property-agent `.env`

## Still open

1. **Auto-save WO PDFs** on work-order-processor intake → `output/work_orders`
2. **Paperless import at scale** — bridge ready; decide batch size / filters
3. **Optional:** fix/delete the 6 unmatched maintenance rows; rotate OpenRouter key; change property-docs Postgres password if still default

## Next actions (priority)

1. Auto-save Supplier Instructed PDFs into `output/work_orders` on WO intake + `wo_scan`
2. Add iPhone Siri Shortcut(s) for `/command`
3. Paperless bridge import (filtered or batched)
