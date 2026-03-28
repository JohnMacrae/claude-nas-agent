# NAS Claude Agent

An autonomous Claude Code agent running on a self-hosted NAS (UGreen DXP4800 Plus), designed for property management automation and personal productivity. Reacts to real-world events, runs on a defined schedule, and pushes output to email, Pushover, and Telegram — without requiring manual interaction.

---

## Overview

This stack runs Claude Code in an isolated Docker environment on a home NAS. It connects to personal data sources via MCP (Open Brain, Gmail, Google Calendar) and the Alto property management API, executes tasks autonomously within defined safety boundaries, and notifies the owner via Pushover and Telegram rather than requiring a browser session.

It is **not** a continuously running loop. Instead, a scheduler wakes the agent at defined times and on defined triggers, runs a bounded Claude Code session, then exits. A separate watchdog process monitors spend and session frequency independently of the agent.

---

## Architecture

```
/volume1/docker/claude-agent/
├── compose.yml
├── .env                    # API keys and credentials — never committed
├── .env.example
├── .gitignore
├── agent-system-prompt.md  # System prompt used for all agent sessions
├── life-engine-schema.sql  # Supabase schema for Life Engine tables
├── docs/                   # Reference documentation — never committed
│   └── alto-api.pdf
├── properties.txt          # Static property list — never committed
├── watchdog/               # Spend + session monitor
│   ├── watchdog.js
│   ├── package.json
│   └── Dockerfile
├── agent/                  # Claude Code sessions
│   ├── scheduler.js        # Launches sessions on schedule + HTTP trigger
│   ├── telegram.js         # Telegram send/receive utility
│   ├── package.json
│   └── Dockerfile
├── approval-ui/            # Web UI for approving write actions (next phase)
├── flags/                  # Shared flag files (runtime, not committed)
├── logs/                   # Shared logs (runtime, not committed)
└── output/                 # Agent output files (runtime, not committed)
```

### Containers

| Container | Status | Role |
|-----------|--------|------|
| `claude-watchdog` | ✅ Running | Monitors API spend and session rate; can pause or kill agent |
| `claude-agent` | ✅ Running | Runs Claude Code sessions on schedule or manual trigger |
| `approval-ui` | 🔲 Next | Lightweight web page for approving pending write actions |

---

## Notifications

| Channel | Used for |
|---------|----------|
| **Pushover** | Watchdog alerts, approval requests, urgent property matters |
| **Telegram** (OBBot / @John_OBBot) | Habits reminders, mood check-ins, evening summaries |
| **Email** (Gmail MCP) | Morning property briefing, completed task reports |

---

## Scheduling

| Time | Days | Session type |
|------|------|--------------|
| 06:00 | Mon–Fri, non-public-holiday | `morning` — property briefing (email) + habits reminder (Telegram) |
| 12:00 | Mon–Fri, non-public-holiday | `checkin` — mood/energy check-in (Telegram) |
| 18:00 | Mon–Fri, non-public-holiday | `evening` — evening summary (Telegram) |
| 08:00–18:00 every 2h | Mon–Fri, non-public-holiday | `property-check` — Alto, Gmail, GCal, Open Brain |
| Any | Any | `ob-trigger` — early wake if new Open Brain item since last run |
| 18:00–06:00 | Any | Silent |
| Sat–Sun | Any | Silent unless manually triggered |
| Public holidays | Any | Silent unless manually triggered |

UK public holidays fetched from `https://www.gov.uk/bank-holidays.json` at scheduler startup.

---

## Manual Trigger

Fire a session at any time via the agent control API:

```bash
# Check status
curl http://dnas:3005/status

# Trigger a session
curl -X POST http://dnas:3005/trigger \
  -H 'Content-Type: application/json' \
  -d '{"type":"morning"}'
```

Valid types: `morning`, `checkin`, `evening`, `property-check`, `manual`

---

## Safety Model

Three independent layers prevent runaway spend or behaviour:

### Layer 1 — Anthropic hard cap
Set in [console.anthropic.com](https://console.anthropic.com) → Billing → Usage limits. Hard monthly ceiling; no code dependency.

### Layer 2 — Per-session budget
Each session is launched with `--max-budget-usd 1.50`. A single session cannot exceed this regardless of task complexity.

### Layer 3 — Watchdog ✅ Live

| Metric | Warn | Pause | Kill |
|--------|------|-------|------|
| Hourly spend | $0.63 | $1.27 | $2.54 |
| Daily spend | $2.54 | $3.81 | $6.35 |
| Sessions/hour | 4 | 6 | 8 |
| Single session tokens | 40k warn | — | 60k kill |

**Warn** → Pushover notification
**Pause** → writes `PAUSED` flag; agent checks before starting any session
**Kill** → writes `PAUSED` + `KILLED` flags; Pushover emergency notification

Watchdog status: `http://dnas:3004/status`
Manual resume: `POST http://dnas:3004/resume`

---

## Life Engine

The Life Engine is integrated into the agent's scheduled sessions (not a separate process).

| Feature | Session | Channel |
|---------|---------|---------|
| Morning habits reminder | 06:00 morning | Telegram |
| Mood/energy check-in | 12:00 checkin | Telegram |
| Evening summary | 18:00 evening | Telegram |
| Habit completion logging | Any session | Telegram reply |
| Weekly self-improvement | Sunday | Telegram |

Data stored in five Supabase tables in the Open Brain project:
`life_engine_habits`, `life_engine_habit_completions`, `life_engine_checkins`,
`life_engine_briefings`, `life_engine_evolution`

Schema: `life-engine-schema.sql`

---

## Action Model

**No approval needed**
- Reading Gmail, GCal, Open Brain, Alto
- Sending morning briefing to jramacrae@gmail.com
- Sending Telegram messages (habits, check-ins, evening summary)
- Writing to Life Engine Supabase tables
- Writing notes and task updates to Open Brain

**Requires approval** (queued to `/logs/pending-approvals.json`, Pushover alert sent)
- Sending any email other than the morning briefing
- Creating or modifying calendar entries
- Any action affecting an external system not listed above

---

## MCP Integrations

| MCP | URL | Auth |
|-----|-----|------|
| Open Brain | `https://tvoyukxvvgdambudjdbq.supabase.co/functions/v1/open-brain-mcp` | Bearer key |
| Gmail | `https://gmail.mcp.claude.com/mcp` | claudeAiOauth (from `~/.claude`) |
| Google Calendar | `https://gcal.mcp.claude.com/mcp` | claudeAiOauth (from `~/.claude`) |

The agent container mounts `/home/john/.claude` read-only so OAuth tokens set up interactively on the host are available inside the container.

---

## Alto API Integration

Alto (The Property Software Group) Client Feed Export API v13.

Base URL: `https://webservices.vebra.com/export/{datafeedid}/v13/`

Auth: HTTP Basic → token-based (1 hour expiry, auto-refreshed)

Lettings statuses: 100 = To Let, 101 = Let, 102 = Under Offer, 103 = Reserved, 104 = Let Agreed

Credentials: `ALTO_DATAFEED_ID`, `ALTO_USERNAME`, `ALTO_PASSWORD` in `.env`

Reference: `docs/alto-api.pdf`

---

## Infrastructure

| Component | Detail |
|-----------|--------|
| NAS | UGreen DXP4800 Plus |
| Hostname | `dnas` |
| Tailscale IP | `100.98.167.107` |
| OS | Debian bookworm / Ubuntu 24.04 |
| Docker | Engine (not Desktop); `docker compose` |
| Compose files | Named `compose.yml` |
| Stack root | `/volume1/docker/claude-agent/` |

### Port allocations

| Port | Service |
|------|---------|
| 3004 | Watchdog status/resume (`http://dnas:3004/status`) |
| 3005 | Agent control — status/trigger (`http://dnas:3005/status`) |

---

## Security Notes

- Agent container does **not** have access to the host Docker socket
- MCP credentials are environment variables, never baked into images
- Approval UI will be Tailscale-only
- `--dangerously-skip-permissions` used inside the container; container boundary provides the safety layer
- `properties.txt`, `.env`, `docs/`, `logs/`, `flags/`, and `output/` are all gitignored

---

## Build Status

1. ✅ Anthropic API key created; hard spend cap set
2. ✅ Watchdog container — built, running, Pushover tested
3. ✅ Agent container — built and running
4. ✅ Telegram — bot connected (OBBot / @John_OBBot), chat ID confirmed
5. ✅ Life Engine schema — applied to Supabase, habits seeded
6. 🔲 First live session validated
7. 🔲 Approval UI
8. 🔲 Alto API integration (credentials pending)
9. 🔲 OpenRent / browser skills (Phase 2)
