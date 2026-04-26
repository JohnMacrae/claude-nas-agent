# HANDOFF.md — Property Agent

Last updated: 2026-04-26

---

## What This Project Is

An autonomous Claude Code agent running on John's UGreen DXP4800 Plus NAS (`dnas`, Tailscale IP `100.98.167.107`). It manages 59 residential rental properties and personal productivity. It runs as a subagent of Open Brain (OB1), which can trigger it via the `trigger_property_agent` MCP tool, and also runs on its own schedule.

---

## Current State

### ✅ Done
- Anthropic API key created, hard spend cap set
- Pushover set up and tested (token + user key in `.env`)
- Watchdog merged into `scheduler.js` — was a separate container (`claude-watchdog`), now removed
- Repo at `github.com/JohnMacrae/claude-nas-agent`
- Life Engine integrated into scheduled sessions
  - Schema moved to `OB1/schemas/life-engine/schema.sql` (canonical source)
  - Tables applied to Supabase: `life_engine_habits`, `life_engine_habit_completions`, `life_engine_checkins`, `life_engine_briefings`, `life_engine_evolution`
  - Two starter habits seeded
- property-agent container running on `agent-net` Docker network
- **OB1 containerised** — was a Supabase Edge Function, now runs locally as `ob1` container on port 8100
  - MCP endpoint no longer public — only reachable on Tailscale network
  - `trigger_property_agent` tool added to OB1's MCP server
  - property-agent connects to OB1 at `http://ob1:8000` (internal Docker)
- Telegram capture deployed as Supabase Edge Function
  - Bot: OBBot / @John_OBBot, token in `.env`, chat ID 725925511
  - Webhook: `https://tvoyukxvvgdambudjdbq.supabase.co/functions/v1/telegram-capture`
  - End-to-end tested — messages captured to `thoughts` table ✓
- Slack capture working (pre-existing Edge Function `ingest-thought`) ✓
- First live session completed — Gmail, GCal, Open Brain all confirmed
- **FreeAgent invoicing** — `agent/freeagent.js` wired into morning session (see below)
- **Scheduler fix** — morning/checkin/evening sessions now fire outside the property-check operating window (were being suppressed by the `isOperatingHours` guard)

### 🔲 Next
- Approval UI (simple web page for approving write actions)
- Alto API integration (credentials pending)
- Remove old `claude.ai Open Brain` Supabase connector from claude.ai → Settings → Connectors
- OpenRent/Rentr browser skills (Phase 2)

---

## Infrastructure

| Item | Value |
|------|-------|
| NAS hostname | `dnas` (Tailscale alias) |
| Tailscale IP | `100.98.167.107` |
| NAS user | `john` |
| Docker root | `/volume1/docker/` |
| Stack root | `/volume1/docker/property-agent/` |
| OB1 root | `/volume1/docker/OB1/` |
| Docker network | `agent-net` (external, shared) |
| Repo | `git@github.com:JohnMacrae/claude-nas-agent.git` |

### Port allocations

| Port | Service |
|------|---------|
| 3005 | property-agent control (`GET /status`, `POST /trigger`, `POST /resume`) |
| 8000 | Portainer — do not use |
| 8100 | OB1 MCP server (external host port → internal 8000) |

---

## Containers

```
docker network: agent-net
  ├── ob1            (port 8100:8000) — Open Brain MCP server
  └── property-agent (port 3005:3001) — Claude Code scheduler
```

Start both:
```bash
docker network create agent-net   # only needed once
cd /volume1/docker/OB1 && docker compose up -d
cd /volume1/docker/property-agent && docker compose up -d
```

---

## MCP Connections (inside property-agent container)

```bash
docker exec -it property-agent claude mcp list
```

| Name | URL | Status |
|------|-----|--------|
| open-brain | http://ob1:8000 | ✅ Local Docker |
| Gmail | https://gmail.mcp.claude.com/mcp | ✅ claude.ai account MCP |
| Google Calendar | https://gcal.mcp.claude.com/mcp | ✅ claude.ai account MCP |
| Meal Planning | Supabase Edge Function | ✅ |
| Family Calendar | Supabase Edge Function | ✅ |
| Home Maintenance | Supabase Edge Function | ✅ |
| Household Knowledge | Supabase Edge Function | ✅ |

Note: `claude.ai Open Brain` (old Supabase Edge Function connector) should still be removed from claude.ai → Settings → Connectors.

---

## Environment Variables (.env)

```
ANTHROPIC_API_KEY=          # Used by watchdog for spend tracking
PUSHOVER_TOKEN=
PUSHOVER_USER=
WATCHDOG_POLL_MS=300000
TELEGRAM_BOT_TOKEN=         # OBBot
TELEGRAM_CHAT_ID=725925511

# Open Brain — local container
OPEN_BRAIN_MCP_URL=http://ob1:8000
OPEN_BRAIN_MCP_KEY=68d1a7500ae7f9b729b99a6eff48f99a7214eaf8c05eb9cef00ca8ed1c5bf737

# Supabase (for Life Engine tables)
SUPABASE_PROJECT_URL=https://tvoyukxvvgdambudjdbq.supabase.co
SUPABASE_SERVICE_KEY=

# FreeAgent
FREEAGENT_CLIENT_ID=
FREEAGENT_CLIENT_SECRET=
FREEAGENT_REFRESH_TOKEN=
FREEAGENT_CONTACT_URL=      # Fallback contact for events with no property shortcode

# Alto (pending)
ALTO_DATAFEED_ID=
ALTO_USERNAME=
ALTO_PASSWORD=
```

---

## Watchdog (merged into scheduler.js)

Runs checks after every session and on a 5-minute timer.

| Metric | Warn | Pause | Kill |
|--------|------|-------|------|
| Sessions/hour | 4 | 6 | 8 |
| Session tokens | 40k warn | — | 60k kill |

Pause resets daily at midnight. Kill requires manual `POST /resume`.

```bash
curl http://dnas:3005/status
curl -X POST http://dnas:3005/resume
```

---

## OB1 Integration

OB1 (`ob1` container, port 8100) is the orchestration layer. It exposes a `trigger_property_agent` MCP tool that any Claude session connected to OB1 can call:

```
trigger_property_agent(type: "property-check", reason: "urgent tenant email")
→ POST http://property-agent:3001/trigger
→ async session launched
```

OB1's `.env` has `PROPERTY_AGENT_URL=http://property-agent:3001`.

---

## Capture Channels

| Channel | Method | Destination |
|---------|--------|-------------|
| Slack | `ingest-thought` Supabase Edge Function | `thoughts` table |
| Telegram | `telegram-capture` Supabase Edge Function | `thoughts` table |

Telegram webhook: `https://tvoyukxvvgdambudjdbq.supabase.co/functions/v1/telegram-capture`

---

## FreeAgent Invoicing

The agent creates draft invoices in FreeAgent automatically each morning from the previous day's Property Calendar events.

### How it works

1. Morning session calls `list_events` on the Property Calendar for yesterday.
2. Events matching `ACRONYM - description` with a non-empty `event.description` are invoiced.
3. Events matching `ACRONYM - inv` (inventory checks) are skipped.
4. The agent calls:
   ```
   node /agent/freeagent.js create-invoice \
     --description "<event.summary>" \
     --address "<full property address>" \
     --notes "<event.description>" \
     --dated-on "<YYYY-MM-DD>"
   ```

### Per-property contacts

Each property gets its own FreeAgent contact (named by shortcode, e.g. `122EW`) with the property address populated from `JJP_Property_List.md`. The contact is created automatically on first invoice if it doesn't exist. This means the invoice Bill To section shows the correct property address rather than a generic contact.

### Line item parsing (`event.description` format)

| Description line | Result |
|-----------------|--------|
| `Sink unblocked` | Comment (no price) |
| `Callout £60` | Hours, qty 1, £60 |
| `2 hours plumbing` | Hours, qty 2, £70 + £30 (rates split) |
| `2 hours plumbing £80` | Hours, qty 2, £70 + £30 (explicit price ignored for multi-hour split) |
| `1 day scaffolding` | Days, qty 1, £0 (add cost when contractor invoices) |
| `£150 materials` | Hours, qty 1, £150 |

### Rates (`rates.json`)

```json
{
  "labour": {
    "first_hour_gbp": 70.00,
    "subsequent_hours_gbp": 30.00
  },
  "default": {
    "quantity": 1
  }
}
```

`rates.json` is volume-mounted — edit on disk, no rebuild needed.

### Environment variables

| Variable | Purpose |
|----------|---------|
| `FREEAGENT_CLIENT_ID` | OAuth client ID |
| `FREEAGENT_CLIENT_SECRET` | OAuth client secret |
| `FREEAGENT_REFRESH_TOKEN` | Long-lived refresh token |
| `FREEAGENT_CONTACT_URL` | Fallback contact URL (used when no property shortcode found) |

### Already-processed guard

The morning session checks Open Brain for `[GCAL-INVOICED] event_id:<id>` before invoicing. Re-running the morning session will not duplicate invoices.

---

## Known Issues / Notes

- Python heredocs work better than bash for writing long files on this NAS
- `docker compose` not `docker-compose`
- Compose files named `compose.yml`
- `~/.bashrc` does not exist on dnas — use `~/.bash_profile`
- Alto credentials pending — system prompt has placeholder
- ntfy was trialled and dropped — Pushover only for alerts
- `life-engine-schema.sql` in this repo is superseded by `OB1/schemas/life-engine/schema.sql`
- **btrfs inode issue**: editing a volume-mounted file (e.g. `rates.json`) with a tool that creates a new file rather than writing in-place will leave the container on the old inode. The container won't see the change until restarted: `cd /volume1/docker/property-agent && docker compose restart agent`
- **Test invoices in FreeAgent**: 7 draft test invoices (IDs 89452128, 89452224, 89452370, 89452423, 89452494, 89452633, 89452696) were created during invoicing debugging on 26 Apr 2026 — delete them manually in FreeAgent

---

## How to Continue

Start a new conversation with:

"Continue building the property-agent. Read /volume1/docker/property-agent/HANDOFF.md for full context. FreeAgent invoicing is now working — per-property contacts, correct rates from rates.json, auto invoice numbering. 7 test draft invoices need deleting in FreeAgent (see Known Issues). Next priorities: clean up test invoices, then Approval UI or Alto integration."
