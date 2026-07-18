# NEXT — Property Agent / Property Docs

Last updated: 2026-07-18 12:07 (dcp)

## Goal

Standalone business property stack: local Postgres knowledge store (docs + semantic + analytics + property maintenance), decoupled from OB1 / personal Life Engine / Paperless-as-SoT.

## Runtime (now)

| Container | Status |
|-----------|--------|
| `property-agent` | Up — `/status` OK, watchdog OK, inbox 0 |
| `property-docs-db` | Healthy — host **5435** |
| `property-docs-tika` | Up |
| `property-docs-ingest` | Up — consume poller |

Repos: https://github.com/JohnMacrae/claude-nas-agent · https://github.com/JohnMacrae/property-docs

## Done

### Decouple from OB1
- Local store CLI, `POST /inbox`, Telegram getUpdates, Life Engine sessions removed
- Open Brain MCP removed; WO processor posts to `/inbox`
- Docs: README, HANDOFF, PROJECT, `docs/what-this-does.html`, this file

### Property Docs (`/volume1/docker/property-docs/`)
- Postgres + pgvector schema (documents/chunks, ops queues, `property_maintenance_*`)
- Ingest worker + Tika; Paperless bridge script verified (2-doc smoke, ~4.7k available)
- Git + remote established

### Property Agent
- `db.js` / `store.js` / `maintenance.js` / `docs.js` against property-docs
- System prompt uses local CLIs only (no HM MCP / Paperless / OB1)
- Image rebuilt; container running with `DATABASE_URL` + `OPENROUTER_API_KEY`

## Still open

1. **Run maintenance migrate** — dry-run then live (`SUPABASE_*` from `mail-reader/.env`)
2. **Dedicated Property Telegram bot** — shared OBBot token → `getUpdates` 409
3. **Paperless import at scale** — bridge ready; decide batch size / filters
4. **Optional:** rotate OpenRouter key (brief tool-log exposure during parallel build)
5. **Optional:** change property-docs Postgres password if still example default

## Next actions (priority)

1. `cd /volume1/docker/property-docs/scripts &&` migrate dry-run → apply
2. Create Property Agent Telegram bot; set token; restart agent
3. Paperless bridge import (filtered or batched)
