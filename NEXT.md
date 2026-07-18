# NEXT — Property Agent / Property Docs

Last updated: 2026-07-18 (dcp)

## Goal

Standalone business property stack: local Postgres knowledge store (docs + semantic + analytics + property maintenance), decoupled from OB1 / personal Life Engine / Paperless-as-SoT.

## Done

### Decouple from OB1 (earlier this session)
- Local store CLI, `POST /inbox`, Telegram getUpdates, Life Engine sessions removed
- Open Brain MCP removed from compose / settings
- WO processor posts to `/inbox` (mail-reader)
- Docs: README, HANDOFF, PROJECT, `docs/what-this-does.html`

### Property Docs stack (`/volume1/docker/property-docs/`)
- Postgres + pgvector container `property-docs-db` **healthy**
- Host port **5435→5432** (5433/5434 taken on NAS)
- Schema applied: documents/chunks/tags, inbox/notes/invoices/telegram_replies, `property_maintenance_*`, views, HNSW
- Tika service in compose; consume/files volumes
- Synology ACL note: init SQL needs group-readable by postgres (gid 999)

### Property Agent → Postgres
- `agent/db.js` + rewritten `agent/store.js` (Postgres when `DATABASE_URL` set; JSON fallback)
- `scheduler.js` awaits async store
- `DATABASE_URL` wired in compose + `.env` / `.env.example`
- Race-safe UNIQUE inserts verified against live DB

### Maintenance migration path
- `property-docs/scripts/migrate_maintenance.py` (+ README, requirements) — verified dry-run + idempotent upsert in throwaway DB
- `agent/maintenance.js` CLI (upcoming / add / log / search) — verified
- Home Maintenance MCP removed from `.claude/settings.json`
- Migrate defaults aligned to host port **5435**
- Supabase export **not run yet** — needs `SUPABASE_*` (available in `mail-reader/.env`, not currently in `property-agent/.env`)

### Docs ingest / Paperless bridge
- `property-docs/ingest/worker.py` + Dockerfile/requirements/README
- `property-docs/scripts/paperless_bridge.py` + README
- `agent/docs.js` — search/list/get via `pg`/`db.js` (lexical + optional vector); verified against live DB
- System prompt cut over to `maintenance.js` / `docs.js` (no HM MCP / Paperless)

## Blockers / gaps

1. **Run maintenance migrate** — `python migrate_maintenance.py --dry-run` then live (`SUPABASE_*` from mail-reader `.env`)
2. **Rebuild property-agent image** — `docker compose up -d --build` (db/store/maintenance/docs/pg)
3. **Dedicated Property Telegram bot** — current token still conflicts with OBBot webhook (`getUpdates` 409)
4. **OPENROUTER_API_KEY** in `property-docs/.env` for embeddings (lexical search works without it)
5. **Paperless import** — bridge dry-run then limited import
6. **Change default Postgres password** in property-docs `.env` if still example value
7. Merge ingest service into property-docs compose if still only a snippet

## Next actions (priority)

1. Dry-run + apply maintenance migration into property-docs DB
2. Rebuild/restart `property-agent`; smoke-test `/status`, `store.js`, `maintenance.js`, `docs.js`
3. Ingest sample PDF via consume/; Paperless bridge `--dry-run --limit 20`
4. New Telegram bot token for property ops
5. Put `property-docs` under git + remote (stack exists on disk; not yet a repo at dcp time)

## Key URLs / paths

| Item | Value |
|------|--------|
| Property Docs DB (host) | `localhost:5435` |
| Property Docs DB (docker) | `property-docs-db:5432` |
| Agent control | `http://dnas:3005` |
| Docs stack | `/volume1/docker/property-docs/` |
| Agent stack | `/volume1/docker/property-agent/` |

## Parallel agents (2026-07-18)

| Stream | Status |
|--------|--------|
| Infra / schema (Opus) | Done — DB live |
| Store → Postgres (Sonnet) | Done — verified |
| Maintenance migrate + CLI (Sonnet) | Code done — migrate not executed |
| Docs ingest + docs.js + prompt (Sonnet) | Ingest + Paperless done; docs.js rewritten on `pg` + prompt cutover verified |
