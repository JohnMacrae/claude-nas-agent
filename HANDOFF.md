# HANDOFF.md — Property Agent

Last updated: 2026-07-18

---

## What This Project Is

An autonomous Claude Code agent running on John's UGreen DXP4800 Plus NAS (`dnas`, Tailscale IP `100.98.167.107`). It manages 59 residential rental properties as a **standalone business agent**. Memory is a local JSON store under `data/`. It runs on its own schedule and via HTTP/Telegram trigger.

**Decoupled from OB1 (2026-07-18):** no Open Brain MCP, no Life Engine sessions, no Supabase `thoughts` reads/writes. Personal habits/check-ins live with the life-engine skill / OB1 only.

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
- **DST/timezone fix (Apr 2026)** — added `TZ=Europe/London` to `compose.yml`; without this the container ran UTC and all sessions fired 1 hour late during BST
- **freeagent.js — hrs/h support** — `parseLineItem` regex extended to recognise `hr`, `hrs`, and `h` as time unit abbreviations in addition to `hour`/`hours` (e.g. `2 hrs`, `1h`)
- **Maintenance calendar for WO events (May 2026)** — WO calendar events now route to the "Maintenance" calendar (not Property Calendar). Three places updated in `agent-system-prompt.md`: Permitted Actions, job-completion lookup, and [PA] maintenance intake.
- **Calendar backfill (May 2026)** — 27 WO events added retrospectively to Property Calendar for WO001446–WO001488 (Mar–May 2026) after Gmail scan vs calendar comparison. WO001488 already present from live processor; total coverage now WO001271–WO001488.
- **Work-order Gmail scan switched to jramacrae@gmail.com** — was kk4oyj@gmail.com until early March 2026, now jramacrae@gmail.com receives Rentopia WO emails. `docker-compose.yml` in `mail-reader` already uses jramacrae credentials.
- **Gmail OAuth re-authentication (May 2026)** — jramacrae token expired (old OAuth client revoked after credentials.json regeneration in April). Re-authenticated using new `installed`-type OAuth client via SSH tunnel + browser paste-code flow. Token saved to `/volume1/docker/gmail-mcp/config/jramacrae/token.json`.
- **Address parser fix (May 2026)** — `work_order_processor.py` `addr_to_shortcode()` now tries progressively shorter word sequences after the house number. Fixes "48, Grantchester Court, Bignell Croft" → `48BC` (comma after number caused full string "48 grantchester court bignell croft" to miss SHORTCODES lookup).
- **Property Calendar audit (Apr 2025–Apr 2026)** — full audit of 196 events; 31 events updated:
  - 7 events: time expressions moved to own line (were embedded at end of task line, e.g. `Replace waste 1.5 hours` → two lines)
  - 22 events: hours added to descriptions + summaries reformatted to `ACRONYM - description` pattern
  - 6 events: descriptions cleared (access/survey notes with no billable labour)
  - Multi-property event (`CO Alarms 10JS, 79AW, 6EB`) and `Valuations` event left as-is; single invoice against default contact — split manually if needed
- **Telegram reply pipeline fix (May 2026)** — replies captured by Supabase `telegram-capture` but never processed: they have no embedding so `search_thoughts` (vector search) can't find them. Fix: `scheduler.js` now fetches unprocessed `[TELEGRAM-REPLY]` thoughts from Supabase REST before each session and injects them directly into the Claude prompt. Backlog of 12 unprocessed replies cleared (25BC, 75FWG, EICR tasks, 40WSS tasks).
- **Telegram reply processed-marking (May 2026)** — after each successful session, the scheduler PATCHes Supabase to mark all injected replies `processed: true` using the IDs it already holds — no agent SQL or execute_sql needed. Eliminates re-processing backlog that was causing ~7 min sessions; sessions now run in ~2 min.
- **OAuth auth check removed (May 2026)** — repeated attempts to track token expiry caused false PAUSED states and noisy warnings. The `claudeAiOauth` refresh token handles renewal automatically; no manual intervention or monitoring needed. Check removed entirely.
- **sessions.json repair (May 2026)** — file was corrupted (leading comma, then NDJSON appended after closing `]`). Rebuilt from recovered data; system prompt updated to use an atomic `node` read-modify-write so agents can't corrupt it again.
- **Test draft invoices deleted (May 2026)** — the 7 leftover test draft invoices in FreeAgent have been removed.
- **Backlog invoices generated (May 2026)** — Apr 2025–Apr 2026 invoice backlog created in FreeAgent from the audited Property Calendar events.

### 🔲 Next
- Create dedicated Property Agent Telegram bot (do not reuse personal OBBot) and set token in `.env`
- Rebuild/restart: `docker compose up -d --build`
- Approval UI (simple web page for approving write actions)
- Alto API integration (credentials pending)
- OpenRent/Rentr browser skills (Phase 2)
- Optional: remove unused `trigger_property_agent` from OB1 MCP

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
| 3005 | property-agent control (`GET /status`, `POST /trigger`, `POST /inbox`, `POST /resume`) |
| 8000 | Portainer — do not use |
| 8100 | OB1 MCP server (external host port → internal 8000) |

---

## Containers

```
docker network: agent-net
  └── property-agent (port 3005:3001) — Claude Code scheduler + local store
```

(OB1 may still run on the same network for personal use; property-agent does not call it.)

```bash
docker network create agent-net   # only needed once
cd /volume1/docker/property-agent && docker compose up -d --build
```

---

## MCP Connections (inside property-agent container)

Configured in `.claude/settings.json` + host Claude OAuth mounts.

| Name | Status |
|------|--------|
| Google Calendar | ✅ via Claude OAuth mount |
| Home Maintenance | ✅ Supabase Edge Function MCP |
| Open Brain | ❌ removed |
| Gmail | ❌ disabled for this agent (marks mail read) |

---

## Environment Variables (.env)

```
ANTHROPIC_API_KEY=
PUSHOVER_TOKEN=
PUSHOVER_USER=
WATCHDOG_POLL_MS=300000
TELEGRAM_BOT_TOKEN=         # Dedicated Property Agent bot (not personal OBBot)
TELEGRAM_CHAT_ID=725925511

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

## Scheduler Internals

`scheduler.js` runs continuously inside the container. It drives all timed sessions via a `tick()` function called every minute.

### How a session fires

```
setInterval(tick, 60_000)
  └── tick()
        ├── now = new Date()           // local time — correct because TZ=Europe/London
        ├── hm  = hours*100 + minutes  // e.g. 1200 for noon BST
        ├── isWorkday(now)             // Mon–Fri, not a UK bank holiday
        └── compare hm against fixed values:
              600  → launchSession('morning')
              even hours 08:00–18:00 → launchSession('property-check')
```

`morning` fires at 06:00. `property-check` fires on even hours 08:00–16:00 inside operating hours. Personal checkin/evening sessions were removed.

Bank holidays are fetched from `https://www.gov.uk/bank-holidays.json` at startup and refreshed every 24 hours.

Local store: `/data/inbox.json`, `actions.json`, `invoices.json`, `telegram-replies.json`. Telegram inbound via `getUpdates` (not Supabase).

### TZ requirement

`TZ=Europe/London` **must** be set in `compose.yml`. Without it `new Date().getHours()` returns UTC inside the container, causing all sessions to fire 1 hour late during BST. Setting TZ also handles the GMT→BST and BST→GMT transitions automatically — no cron adjustments needed at clock-change dates.

### HTTP control API

```
GET  http://dnas:3005/status          → JSON: running, watchdog, inbox counts, recent sessions
POST http://dnas:3005/trigger         → body: {"type":"morning|property-check|manual|http-trigger","reason":"..."}
POST http://dnas:3005/inbox           → body: {"property","type","status","note","date","order_number"}
POST http://dnas:3005/resume          → clears PAUSED + KILLED flags
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

## OB1 (legacy / unused by this agent)

Property Agent no longer depends on OB1. OB1 may still expose `trigger_property_agent` pointing at `POST http://property-agent:3001/trigger` — harmless if unused. Prefer HTTP `/trigger`, `/inbox`, or the property Telegram bot.

Personal capture (Slack/Telegram → Supabase `thoughts`) remains an OB1/life-engine concern, not this stack.

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
| `2 hrs plumbing` | Hours, qty 2, £70 + £30 (`hrs`, `hr`, `h` all recognised) |
| `1h labour` | Hours, qty 1, £70 |
| `2 hours plumbing £80` | Hours, qty 2, £70 + £30 (explicit price ignored for multi-hour split) |
| `1 day scaffolding` | Days, qty 1, £0 (add cost when contractor invoices) |
| `£150 materials` | Hours, qty 1, £150 |

**Time must be on its own line and at the start of the line.** `parseLineItem` matches `^[\d.]+ (hours|hour|hrs|hr|h)` — hours embedded mid-line (e.g. `Replace waste 1.5 hours`) will not be parsed. Correct format:
```
Replace waste
1.5 hours
```

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

The morning session checks the local store: `node /agent/store.js invoice-check --event-id <id>`. On success it runs `invoice-mark`. Re-running the morning session will not duplicate invoices.

---

## Known Issues / Notes

- Python heredocs work better than bash for writing long files on this NAS
- `docker compose` not `docker-compose`
- Compose files named `compose.yml`
- `~/.bashrc` does not exist on dnas — use `~/.bash_profile`
- Alto credentials pending — system prompt has placeholder
- ntfy was trialled and dropped — Pushover only for alerts
- Life Engine is **not** part of this agent anymore — personal only (OB1 / life-engine skill)
- **btrfs inode issue**: editing a volume-mounted file (e.g. `rates.json`) with a tool that creates a new file rather than writing in-place will leave the container on the old inode. Restart: `cd /volume1/docker/property-agent && docker compose restart agent`
- **Gmail work-order token expiry**: the `work-order-processor` uses `/volume1/docker/gmail-mcp/config/jramacrae/token.json`. If the OAuth client is revoked, refresh fails with `invalid_grant` (broken since 2026-05-22). Processor now POSTs to `/inbox` when Gmail works again.
- **Telegram bot conflict**: property-agent polls `getUpdates` on `TELEGRAM_BOT_TOKEN`. Use a dedicated property bot so personal OBBot webhook is undisturbed.
- **Schrodinger's maintenance tasks**: session log claiming a task was "closed" does not guarantee `log_maintenance` succeeded. Authoritative source is `get_upcoming_maintenance`.

---

## Telegram Shorthand

John can send these directly in Telegram:

| Format | What happens |
|--------|-------------|
| `59BC complete` or `59BC done` | Closes all open maintenance tasks for 59BC |
| `59BC-1.5hr` | Finds the most recent uninvoiced GCal event for 59BC, updates description to `Completed — DD Mon YYYY\n1.5 hours`, ready for next morning invoice run |
| `59BC 2h` | Same as above with 2 hours |

Property references accept shortcodes (e.g. `59BC`) or full address (number + street name). Unrecognised references get a ⚠️ error reply.

---

## How to Continue

Start a new conversation with:

"Continue building the property-agent. Read /volume1/docker/property-agent/HANDOFF.md for full context. FreeAgent invoicing is working end-to-end. Property Calendar has been fully audited and cleaned for Apr 2025–Apr 2026, and all WOs since March 2026 (WO001446–WO001488) have been backfilled. Going forward, WO calendar events land in the Maintenance calendar. The 7 test draft invoices have been deleted and the Apr 2025–Apr 2026 invoice backlog has been generated in FreeAgent. Next priorities: Approval UI or Alto integration."
