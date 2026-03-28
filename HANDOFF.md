# HANDOFF.md — Claude NAS Agent

This document captures the exact state of the project for continuity across conversations.
Last updated: 2026-03-28

---

## What This Project Is

An autonomous Claude Code agent running on John's UGreen DXP4800 Plus NAS (`dnas`, Tailscale IP `100.98.167.107`). It manages property management tasks and personal productivity by connecting to Gmail, Google Calendar, Open Brain (MCP), and the Alto property management API. It runs on a schedule, reacts to events, and pushes output via Pushover notifications and email.

---

## Current State

### ✅ Done
- Anthropic API key created, hard spend cap set at console.anthropic.com
- Pushover set up and tested on iOS (token + user key in `.env`)
- Watchdog container built, running, and end-to-end tested
  - Detects oversized sessions, fires Pushover notification correctly
  - Status endpoint: `http://dnas:3004/status`
  - Resume endpoint: `POST http://dnas:3004/resume`
- ntfy was trialled and dropped — Pushover is the only notification channel
- Repo created at `github.com/JohnMacrae/claude-nas-agent`
- README and this HANDOFF document up to date

### 🔲 Next — Agent Container
This is where we stopped. The agent container needs to be built next:
- Dockerfile for Claude Code
- Scheduler (Node.js) — wakes agent on schedule and OB trigger
- System prompt (drafted below, needs finalising)
- MCP configuration (Open Brain, Gmail, GCal)
- Flag file checks (PAUSED, KILLED) at session start
- Session logging to `/logs/sessions.json` (watchdog reads this)

### 🔲 After That
- Approval UI (simple web page for approving write actions)
- Alto API integration (credentials pending)
- Dry-run mode before going live
- OpenRent/Rentr browser skills (Phase 2)

---

## Infrastructure

| Item | Value |
|------|-------|
| NAS hostname | `dnas` |
| Tailscale IP | `100.98.167.107` |
| NAS user | `john` |
| OS | Debian bookworm / Ubuntu 24.04 |
| Docker | Engine (not Desktop) — use `docker compose` not `docker-compose` |
| Compose filename | `compose.yml` (not docker-compose.yml) |
| Stack root | `/volume1/docker/claude-agent/` |
| Repo | `git@github.com:JohnMacrae/claude-nas-agent.git` |

### Port allocations on dnas
Ports 3001, 3002, 3003 were already in use by other services when we started.
| Port | Service |
|------|---------|
| 3004 | Watchdog status server (host) → 3001 internal |

---

## File Structure

```
/volume1/docker/claude-agent/
├── compose.yml             # Watchdog only so far — agent commented out
├── .env                    # NEVER committed — see variables below
├── .env.example
├── .gitignore
├── README.md
├── HANDOFF.md              # This file
├── docs/                   # Gitignored
│   └── alto-api.pdf        # Alto Client Feed Export API v13 user guide
├── properties.txt          # Gitignored — 59 property addresses
├── watchdog/
│   ├── watchdog.js         # Pushover version — tested and working
│   ├── package.json
│   └── Dockerfile
├── flags/                  # Runtime, gitignored
│   # PAUSED — written by watchdog, read by agent before starting
│   # KILLED — written by watchdog on kill action
└── logs/                   # Runtime, gitignored
    # watchdog.log          — watchdog decisions
    # watchdog-state.json   — watchdog persistent state
    # sessions.json         — written by agent, read by watchdog
    # pending-approvals.json — write actions queued for approval
```

---

## Environment Variables

```
# Anthropic
ANTHROPIC_API_KEY=sk-ant-...

# Pushover
PUSHOVER_TOKEN=...
PUSHOVER_USER=...

# Watchdog timing
WATCHDOG_POLL_MS=300000

# Alto (credentials not yet obtained)
ALTO_DATAFEED_ID=
ALTO_USERNAME=
ALTO_PASSWORD=

# MCP (populated when agent is built)
OPEN_BRAIN_MCP_URL=https://tvoyukxvvgdambudjdbq.supabase.co/functions/v1/open-brain-mcp
OPEN_BRAIN_MCP_KEY=68d1a7500ae7f9b729b99a6eff48f99a7214eaf8c05eb9cef00ca8ed1c5bf737
```

---

## MCP Connections

| MCP | URL | Notes |
|-----|-----|-------|
| Open Brain | `https://tvoyukxvvgdambudjdbq.supabase.co/functions/v1/open-brain-mcp` | Key in .env |
| Gmail | `https://gmail.mcp.claude.com/mcp` | OAuth via Claude.ai |
| Google Calendar | `https://gcal.mcp.claude.com/mcp` | OAuth via Claude.ai |

Open Brain task conventions:
- Tasks use `COMPLETED`, `PENDING`, `CARRIED OVER` prefixes with dates
- Reliable retrieval: `list_thoughts` with `days:14`, `type:"task"`, `limit:20`

---

## Scheduling Design

| Time | Days | Trigger | Action |
|------|------|---------|--------|
| 06:00 | Mon–Fri, non-public-holiday | Fixed | Morning briefing |
| 08:00–18:00 | Mon–Fri, non-public-holiday | Every 2 hours | Check and act |
| Any | Any | New Open Brain item since last run | Early wake |
| 18:00–06:00 | Any | — | Silent |
| Sat–Sun | Any | — | Silent unless manually triggered |
| Public holidays | Any | — | Silent unless manually triggered |

UK public holidays: fetch from `https://www.gov.uk/bank-holidays.json` at scheduler startup.

OB trigger implementation: poll Open Brain at start of each scheduled check; if new items exist since last run timestamp, proceed regardless of schedule. Use a `lastRunAt` timestamp file at `/logs/last-run.json`.

---

## Agent System Prompt (Draft — Not Yet Finalised)

```
You are a personal property management and productivity agent running
autonomously on John's home NAS. You have access to his Gmail, Google
Calendar, and Open Brain via MCP, and the Alto property management API.

## Identity
You act on behalf of John Macrae, a landlord and property manager based
in Colchester, England, managing 59 residential rental properties.
You are not a chatbot — you are an autonomous agent that wakes on a
schedule, assesses the current situation, takes permitted actions, and
queues others for approval.

## Property Portfolio
Read /agent/properties.txt at the start of each session.
59 properties across CO1, CO2, CO3, CO4, CO15, CM2.
Managed via: OpenRent, Rentr, Alto, Rentopia East Anglia.
Key contact email: jramacrae@gmail.com

## Session Start — Always Do This First
1. Check /flags/PAUSED — if exists, log reason and exit immediately
2. Check /flags/KILLED — if exists, log reason and exit immediately
3. Read /agent/properties.txt
4. Log session start to /logs/sessions.json

## Operating Hours
- 06:00 Mon–Fri (non-public-holiday) — morning briefing
- 08:00–18:00 Mon–Fri (non-public-holiday) — every 2 hours or OB trigger
- All other times — do not run

## What You Do Each Run
1. Check Open Brain for pending tasks and new items since last run
2. Check Gmail for urgent or time-sensitive property-related messages
3. Check Google Calendar for events in the next 48 hours
4. Check Alto for property status changes since last run
5. Assess what requires action
6. Execute permitted actions directly
7. Queue write actions for approval with Pushover notification
8. Log session end to /logs/sessions.json

## Morning Briefing (06:00 only)
Send to jramacrae@gmail.com ONLY if at least one of these is true:
- A tenant has emailed in the last 24 hours
- A maintenance issue is open in Open Brain
- A viewing or inspection is due in the next 48 hours
- A rent review or tenancy renewal is due within 30 days
- A property status has changed in Alto since yesterday
- Anything else genuinely requiring John's attention

If none apply: log "nothing to report" and exit. Do not send empty briefing.

Format:
- Subject: Daily Property Briefing — [date]
- Under 300 words
- Grouped by property where relevant
- Action items clearly marked

## Permitted Actions (No Approval Needed)
- Read Gmail, GCal, Open Brain, Alto
- Send morning briefing to jramacrae@gmail.com
- Write notes and task updates to Open Brain
- Create files in /output

## Actions Requiring Approval
- Send any email other than the morning briefing
- Create or modify calendar entries
- Any action affecting an external system

Queue to /logs/pending-approvals.json, send Pushover notification.

## Hard Limits
- Do not run outside operating hours
- Do not start if PAUSED or KILLED flag exists
- Do not send emails to anyone other than jramacrae@gmail.com without approval
- Do not loop — each session has a defined scope and end
- Do not exceed 50,000 tokens per session
- Do not expose tenant personal data in logs

## Session Log Format
Append to /logs/sessions.json:
{
  "id": "<uuid>",
  "startedAt": "<iso8601>",
  "endedAt": "<iso8601>",
  "trigger": "scheduled|ob-trigger|manual",
  "totalTokens": <n>,
  "itemsChecked": { "openBrain": <n>, "gmail": <n>, "gcal": <n>, "alto": <n> },
  "actionsTaken": ["list"],
  "pendingApprovals": <n>
}
```

---

## Alto API Summary

- Base URL: `https://webservices.vebra.com/export/{datafeedid}/v13/`
- Auth: HTTP Basic (username:password base64) → returns Token header, valid 1 hour
- On 401: re-authenticate with username:password
- Key endpoint: `GET /property/{yyyy}/{MM}/{dd}/{HH}/{mm}/{ss}` — changed since timestamp
- Full doc: `docs/alto-api.pdf`
- Credentials: not yet obtained — chase The Property Software Group

---

## Watchdog Thresholds (Live)

| Metric | Warn | Pause | Kill |
|--------|------|-------|------|
| Hourly spend | $0.63 | $1.27 | $2.54 |
| Daily spend | $2.54 | $3.81 | $6.35 |
| Sessions/hour | 4 | 6 | 8 |
| Session tokens | 40k | — | 60k |

---

## Known Issues / Notes

- Python heredocs work better than bash for writing long files on this NAS
- `docker compose` not `docker-compose`
- Compose files named `compose.yml` not `docker-compose.yml`
- Ports 3001/3002/3003 already allocated on dnas — use 3004+ for this stack
- Windows development machine — use scp or WinSCP to transfer files
- ntfy was tested and dropped (iOS APNs issue) — Pushover only
- Alto credentials pending — system prompt has placeholder for Alto section
- Rentopia manages some properties but structure doesn't matter — agent treats all 59 via Alto

---

## How to Continue

Start a new conversation with:

"Continue building the claude-nas-agent. The repo is at github.com/JohnMacrae/claude-nas-agent — read HANDOFF.md for full context. Watchdog is running and tested. Next step is the agent container and scheduler."
