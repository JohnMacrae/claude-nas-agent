# Property Agent

An autonomous Claude Code agent running on a self-hosted NAS, acting as a subagent of [Open Brain (OB1)](../OB1). Manages 59 residential rental properties and personal productivity. Runs on a defined schedule and can be triggered by OB1's MCP, pushing output via email, Pushover, and Telegram.

---

## Architecture

```
OB1 (MCP server, ob1 container)
  └── trigger_property_agent tool → POST http://property-agent:3001/trigger
        ↓
property-agent container (scheduler.js)
  └── spawns: claude --print --dangerously-skip-permissions --max-budget-usd 1.50
        ↓
        MCPs: Open Brain (local ob1) · Gmail · Google Calendar
        Notifications: Telegram · Pushover · Email
```

Both containers run on `agent-net` Docker network on the NAS.

### File structure

```
/volume1/docker/claude-agent/
├── compose.yml
├── .env                        # Credentials — never committed
├── .env.example
├── agent-system-prompt.md      # System prompt for all sessions
├── properties.txt              # 59 property addresses — never committed
├── docs/                       # Reference docs — never committed
│   └── alto-api.pdf
├── agent/
│   ├── scheduler.js            # Schedule + watchdog + HTTP control server
│   ├── telegram.js             # Telegram send/receive utility
│   ├── package.json
│   └── Dockerfile
├── flags/                      # Runtime flag files (PAUSED, KILLED)
├── logs/                       # Session logs and watchdog state
└── output/                     # Agent output files
```

### Containers

| Container | Role |
|-----------|------|
| `property-agent` | Runs Claude Code sessions on schedule or trigger |

The watchdog is merged into `scheduler.js` — no separate container.

---

## Scheduling

| Time | Days | Session type |
|------|------|--------------|
| 06:00 | Mon–Fri, non-public-holiday | `morning` — property briefing (email) + habits reminder (Telegram) |
| 12:00 | Mon–Fri, non-public-holiday | `checkin` — mood/energy check-in (Telegram) |
| 18:00 | Mon–Fri, non-public-holiday | `evening` — evening summary (Telegram) |
| 08:00–18:00 every 2h | Mon–Fri, non-public-holiday | `property-check` — Alto, Gmail, GCal, Open Brain |
| Any | Any | `ob-trigger` — fired by OB1 when new items need attention |
| 18:00–06:00 | Any | Silent |
| Sat–Sun | Any | Silent unless manually triggered |
| Public holidays | Any | Silent unless manually triggered |

UK public holidays fetched from `https://www.gov.uk/bank-holidays.json` at startup.

---

## Manual Trigger

```bash
# Status
curl http://dnas:3005/status

# Fire a session
curl -X POST http://dnas:3005/trigger \
  -H 'Content-Type: application/json' \
  -d '{"type":"manual","reason":"ad-hoc check"}'

# Resume after watchdog pause
curl -X POST http://dnas:3005/resume
```

Valid types: `morning`, `checkin`, `evening`, `property-check`, `manual`

OB1 can also trigger sessions via the `trigger_property_agent` MCP tool from any connected Claude session.

---

## Safety Model

| Layer | Mechanism |
|-------|-----------|
| 1 — Hard cap | Anthropic console monthly billing limit |
| 2 — Per-session | `--max-budget-usd 1.50` per session |
| 3 — Watchdog | Built into scheduler; monitors session rate and token counts |

### Watchdog thresholds

| Metric | Warn | Pause | Kill |
|--------|------|-------|------|
| Sessions/hour | 4 | 6 | 8 |
| Single session tokens | 40k | — | 60k |

**Pause** → writes `PAUSED` flag + Pushover alert. Resets at midnight.
**Kill** → writes `PAUSED` + `KILLED` flags + emergency Pushover. Requires manual `/resume`.

---

## MCP Connections

| MCP | URL | Auth |
|-----|-----|------|
| Open Brain | `http://ob1:8000` (local Docker) | `x-brain-key` header |
| Gmail | `https://gmail.mcp.claude.com/mcp` | claude.ai account MCP |
| Google Calendar | `https://gcal.mcp.claude.com/mcp` | claude.ai account MCP |

Configured via `docker exec -it property-agent claude mcp list`.

Open Brain runs locally on the NAS — MCP traffic never leaves the network.

---

## Life Engine

Integrated into scheduled sessions. Tables defined in `OB1/schemas/life-engine/schema.sql`.

| Feature | Session | Channel |
|---------|---------|---------|
| Morning habits reminder | 06:00 morning | Telegram |
| Mood/energy check-in | 11:00 checkin | Telegram |
| Evening summary | 18:00 evening | Telegram |
| Weekly self-improvement | Sunday | Telegram |

Data stored in Supabase (`life_engine_habits`, `life_engine_habit_completions`, `life_engine_checkins`, `life_engine_briefings`, `life_engine_evolution`).

---

## Action Model

**No approval needed**
- Reading Gmail, GCal, Open Brain, Alto
- Sending morning briefing to jramacrae@gmail.com
- Sending Telegram messages (habits, check-ins, evening summary)
- Writing to Life Engine Supabase tables
- Writing notes and task updates to Open Brain

**Requires approval** (queued to `/logs/pending-approvals.json`, Pushover alert sent)
- Any email other than the morning briefing
- Creating or modifying calendar entries
- Any action on an external system not listed above

---

## Infrastructure

| Component | Detail |
|-----------|--------|
| NAS | UGreen DXP4800 Plus |
| Hostname | `dnas` (Tailscale alias) |
| Tailscale IP | `100.98.167.107` |
| Stack root | `/volume1/docker/claude-agent/` |
| Docker network | `agent-net` (shared with OB1) |
| Port | 3005 → 3001 (control API) |

---

## Build Status

1. ✅ Anthropic API key + hard spend cap
2. ✅ Watchdog — merged into scheduler
3. ✅ property-agent container running
4. ✅ Telegram connected (OBBot / @John_OBBot)
5. ✅ Life Engine schema applied to Supabase
6. ✅ OB1 containerised locally — Open Brain MCP on agent-net
7. ✅ Telegram capture deployed (Supabase Edge Function)
8. ✅ trigger_property_agent wired in OB1 MCP
9. 🔲 Approval UI
10. 🔲 Alto API integration (credentials pending)
11. 🔲 OpenRent / browser skills (Phase 2)
