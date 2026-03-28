# HANDOFF.md — Claude NAS Agent

This document captures the exact state of the project for continuity across conversations.
Last updated: 2026-03-28

---

## What This Project Is

An autonomous Claude Code agent running on John's UGreen DXP4800 Plus NAS (`dnas`, Tailscale IP `100.98.167.107`). It manages property management tasks and personal productivity by connecting to Gmail, Google Calendar, Open Brain (MCP), and the Alto property management API. It runs on a schedule, reacts to events, and pushes output via Pushover notifications, email, and Telegram.

---

## Current State

### ✅ Done
- Anthropic API key created, hard spend cap set at console.anthropic.com
- Pushover set up and tested on iOS (token + user key in `.env`)
- Watchdog container built, running, and end-to-end tested
  - Detects oversized sessions, fires Pushover notification correctly
  - Status endpoint: `http://dnas:3004/status`
  - Resume endpoint: `POST http://dnas:3004/resume`
- ntfy was trialled and dropped — Pushover is the only alert channel
- Repo created at `github.com/JohnMacrae/claude-nas-agent`
- Life Engine integrated into agent design (Option B — not running as separate loop)
  - Life Engine schema SQL written and **applied** to Supabase
  - Tables created: `life_engine_habits`, `life_engine_habit_completions`,
    `life_engine_checkins`, `life_engine_briefings`, `life_engine_evolution`
  - Two starter habits seeded: Morning walk (weekdays), Evening wind-down (daily)
  - Supabase service key in `.env`
- Agent container built and running
  - Dockerfile: Node 20 + Claude Code
  - `scheduler.js` — fires sessions at 06:00/12:00/18:00 and every 2h property checks
  - `telegram.js` — send/receive utility called by agent via Bash tool
  - HTTP control server on port 3005
    - `GET http://dnas:3005/status` — session state, flags
    - `POST http://dnas:3005/trigger` body `{"type":"morning"}` — fire any session type
  - Mounts `~/.claude` from host so Gmail/GCal OAuth tokens work inside container
- Telegram bot connected
  - Bot name: OBBot, username: @John_OBBot
  - Token: `TELEGRAM_BOT_TOKEN` in `.env`
  - Chat ID: `725925511` (`TELEGRAM_CHAT_ID` in `.env`)
  - Agent sends via `node /agent/telegram.js send "message"`
  - Agent receives via `node /agent/telegram.js wait-reply "prompt" [timeout_secs]`
- Updated system prompt: `agent-system-prompt.md` (finalised)

### 🔲 Next — First Live Session
- Trigger a manual session to validate end-to-end:
  ```bash
  curl -X POST http://dnas:3005/trigger \
    -H 'Content-Type: application/json' \
    -d '{"type":"manual"}'
  docker logs -f claude-agent
  ```
- Verify: Telegram message arrives, session log written to `/logs/`
- Check MCP connections work (Open Brain, Gmail, GCal)

### 🔲 After That
- Approval UI (simple web page for approving write actions)
- Alto API integration (credentials pending)
- Dry-run mode before going live on schedule
- OpenRent/Rentr browser skills (Phase 2)

---

## Life Engine Integration Design

Life Engine is NOT a separate loop or stack. It is integrated into the
existing scheduled agent sessions. Key decisions:

| Life Engine feature | How integrated |
|---------------------|---------------|
| Morning habits reminder | Appended to 06:00 morning session, sent via Telegram |
| Mood/energy check-in | New 12:00 session (checkin trigger) |
| Evening summary | New 18:00 session (evening trigger) |
| Habit completion logging | Via Telegram replies during any session |
| Weekly self-improvement | Sunday sessions check evolution table |
| Morning property briefing | Unchanged — email only, no Telegram |

Telegram is personal/lifestyle only. Property matters stay on email + Pushover.

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
| OB1 repo | `/volume1/docker/OB1` |

### Port allocations on dnas
| Port | Service |
|------|---------|
| 3004 | Watchdog (`http://dnas:3004/status`, `POST /resume`) |
| 3005 | Agent control (`http://dnas:3005/status`, `POST /trigger`) |

---

## File Structure

```
/volume1/docker/claude-agent/
├── compose.yml
├── .env                        # NEVER committed
├── .env.example
├── .gitignore
├── README.md
├── HANDOFF.md
├── agent-system-prompt.md      # Finalised system prompt
├── life-engine-schema.sql      # Applied to Supabase ✅
├── docs/                       # Gitignored
│   └── alto-api.pdf
├── properties.txt              # Gitignored — 59 property addresses
├── watchdog/                   # ✅ Running
│   ├── watchdog.js
│   ├── package.json
│   └── Dockerfile
├── agent/                      # ✅ Running
│   ├── scheduler.js            # Schedule + HTTP control server
│   ├── telegram.js             # Telegram send/receive utility
│   ├── package.json
│   └── Dockerfile
├── approval-ui/                # 🔲 Next
├── flags/                      # Runtime, gitignored
├── logs/                       # Runtime, gitignored
└── output/                     # Runtime, gitignored
```

---

## Environment Variables

```
# Anthropic
ANTHROPIC_API_KEY=sk-ant-...

# Pushover
PUSHOVER_TOKEN=
PUSHOVER_USER=

# Watchdog timing
WATCHDOG_POLL_MS=300000

# Telegram
TELEGRAM_BOT_TOKEN=        # OBBot token from @BotFather
TELEGRAM_CHAT_ID=725925511 # John's Telegram chat ID

# Open Brain / Supabase
OPEN_BRAIN_MCP_URL=https://tvoyukxvvgdambudjdbq.supabase.co/functions/v1/open-brain-mcp
OPEN_BRAIN_MCP_KEY=        # Open Brain MCP key
SUPABASE_PROJECT_URL=https://tvoyukxvvgdambudjdbq.supabase.co
SUPABASE_SERVICE_KEY=      # From Supabase → Project Settings → API → service_role

# Alto (credentials not yet obtained)
ALTO_DATAFEED_ID=
ALTO_USERNAME=
ALTO_PASSWORD=
```

---

## MCP Connections

| MCP | URL | Notes |
|-----|-----|-------|
| Open Brain | `https://tvoyukxvvgdambudjdbq.supabase.co/functions/v1/open-brain-mcp` | Key in .env |
| Gmail | `https://gmail.mcp.claude.com/mcp` | claudeAiOauth from `~/.claude/.credentials.json` |
| Google Calendar | `https://gcal.mcp.claude.com/mcp` | claudeAiOauth from `~/.claude/.credentials.json` |

`~/.claude` is mounted read-only into the agent container at `/root/.claude`.
OAuth tokens from interactive Claude Code sessions on the host are inherited automatically.

Open Brain task conventions:
- Tasks use `COMPLETED`, `PENDING`, `CARRIED OVER` prefixes with dates
- Reliable retrieval: `list_thoughts` with `days:14`, `type:"task"`, `limit:20`

---

## Scheduling Design

| Time | Days | Trigger | Action |
|------|------|---------|--------|
| 06:00 | Mon–Fri, non-public-holiday | Fixed | Morning briefing (email) + habits reminder (Telegram) |
| 08:00–18:00 | Mon–Fri, non-public-holiday | Every 2 hours | Property check and act |
| 12:00 | Mon–Fri, non-public-holiday | Fixed | Mood/energy check-in (Telegram) |
| 18:00 | Mon–Fri, non-public-holiday | Fixed | Evening summary (Telegram) |
| Any | Any | New Open Brain item since last run | Early wake |
| 18:00–06:00 | Any | — | Silent |
| Sat–Sun | Any | — | Silent unless manually triggered |
| Public holidays | Any | — | Silent unless manually triggered |
| Sunday weekly | Any | — | Self-improvement review (if 7+ days since last) |

UK public holidays: fetch from `https://www.gov.uk/bank-holidays.json` at scheduler startup.

---

## Agent System Prompt

Finalised. See `agent-system-prompt.md` in this repo.
Key design decisions:
- Property briefing → email only (no Telegram)
- Telegram → personal/lifestyle only (habits, check-ins, evening summary)
- Life Engine tables → Open Brain Supabase project
- No duplicate morning briefing — one email, one Telegram habits message

---

## Telegram Utility (agent/telegram.js)

Called by the agent via Bash tool during a session.

```bash
# Send a message
node /agent/telegram.js send "Good morning 👋"

# Wait for a reply (sends prompt, polls up to 120s)
node /agent/telegram.js wait-reply "How are you feeling?" 120

# Get recent updates (raw)
node /agent/telegram.js updates [offset]
```

All output is JSON. `wait-reply` returns `{"ok":true,"text":"..."}` or `{"ok":false,"reason":"timeout"}`.

---

## Watchdog Thresholds (Live)

| Metric | Warn | Pause | Kill |
|--------|------|-------|------|
| Hourly spend | $0.63 | $1.27 | $2.54 |
| Daily spend | $2.54 | $3.81 | $6.35 |
| Sessions/hour | 4 | 6 | 8 |
| Session tokens | 40k | — | 60k |

---

## Installed on dnas (as john)

| Package | Version | Notes |
|---------|---------|-------|
| Node.js | v18.20.4 | Pre-installed |
| npm | 9.2.0 | Installed via apt |
| Claude Code | 2.1.86 | Installed via npm -g (also inside agent container) |
| Bun | 1.3.11 | Installed via bun.sh/install |
| Bun PATH | ~/.bash_profile | `export PATH="$HOME/.bun/bin:$PATH"` |

---

## Known Issues / Notes

- Python heredocs work better than bash for writing long files on this NAS
- `docker compose` not `docker-compose`
- Compose files named `compose.yml` not `docker-compose.yml`
- Ports 3001/3002/3003 already allocated on dnas — use 3004+ for this stack
- ntfy was tested and dropped (iOS APNs issue) — Pushover only for alerts
- Alto credentials pending — system prompt has placeholder
- Rentopia manages some properties but agent treats all 59 via Alto
- ttyd container (port 7681) was used for browser-based terminal during setup
  — should be removed: `docker rm -f ttyd`
- ~/.bashrc does not exist on dnas — use ~/.bash_profile instead
- Bun install requires unzip: `sudo apt-get install -y unzip`
- `claude --channels` does not exist — Telegram is handled via direct Bot API (telegram.js)

---

## How to Continue

Start a new conversation with:

"Continue building the claude-nas-agent. The repo is at github.com/JohnMacrae/claude-nas-agent
— read HANDOFF.md for full context. Watchdog and agent containers are both running.
Telegram is connected (OBBot). Life Engine schema is applied to Supabase.
Next step is validating the first live session end-to-end."
