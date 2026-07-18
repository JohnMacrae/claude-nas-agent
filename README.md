# Property Agent

A standalone Claude Code agent on a self-hosted NAS for **rental property management** (business). It runs on a defined schedule and via HTTP trigger, pushing output via email, Pushover, and Telegram.

Decoupled from Open Brain (OB1) and personal Life Engine. Memory is a local JSON store under `data/`.

---

## Architecture

```
work-order-processor ──POST /inbox──┐
HTTP client ──POST /trigger─────────┤
Telegram getUpdates ───────────────┤
                                   ▼
property-agent container (scheduler.js)
  └── spawns: claude --print --dangerously-skip-permissions --max-budget-usd 1.50
        ↓
        MCPs: Google Calendar · Home Maintenance
        Local store: /data (inbox, actions, invoices, telegram-replies)
        Utils: telegram.js · freeagent.js · store.js
        Notifications: Telegram · Pushover · morning email
```

Container runs on `agent-net` (shared with other NAS stacks as needed). No runtime dependency on `ob1`.

### File structure

```
/volume1/docker/property-agent/
├── compose.yml
├── .env                        # Credentials — never committed
├── .env.example
├── agent-system-prompt.md      # System prompt for all sessions
├── properties.txt              # Property addresses — never committed
├── data/                       # Local business memory
│   ├── inbox.json
│   ├── actions.json
│   ├── invoices.json
│   └── telegram-replies.json
├── agent/
│   ├── scheduler.js            # Schedule + watchdog + HTTP + Telegram poll
│   ├── store.js                # Local JSON store CLI/library
│   ├── telegram.js
│   ├── freeagent.js
│   ├── package.json
│   └── Dockerfile
├── flags/
├── logs/
└── output/
```

---

## Scheduling

| Time | Days | Session type |
|------|------|--------------|
| 06:00 | Mon–Fri, non-public-holiday | `morning` — property briefing (email) + FreeAgent drafts |
| 08:00–18:00 every 2h | Mon–Fri, non-public-holiday | `property-check` — inbox, GCal, Home Maintenance |
| Any | Any | `manual` / `http-trigger` — HTTP or Telegram `/trigger` |
| 18:00–06:00 | Any | Silent |
| Sat–Sun / public holidays | Any | Silent unless manually triggered |

UK public holidays from `https://www.gov.uk/bank-holidays.json`.

Personal habits / check-ins / evening Life Engine sessions are **not** part of this agent.

---

## Manual Trigger

```bash
# Status
curl http://dnas:3005/status

# Fire a session
curl -X POST http://dnas:3005/trigger \
  -H 'Content-Type: application/json' \
  -d '{"type":"manual","reason":"ad-hoc check"}'

# Add inbox item (work orders)
curl -X POST http://dnas:3005/inbox \
  -H 'Content-Type: application/json' \
  -d '{"property":"59BC","type":"maintenance","status":"open","note":"WO001500: boiler","date":"2026-07-18","order_number":"WO001500"}'

# Resume after watchdog pause
curl -X POST http://dnas:3005/resume
```

Valid trigger types: `morning`, `property-check`, `manual`, `http-trigger`

Telegram (property bot): `/status`, `/trigger`, `/resume`, `/maintenance`, `/inbox`, `/help`

---

## Safety Model

| Layer | Mechanism |
|-------|-----------|
| 1 — Hard cap | Anthropic console monthly billing limit |
| 2 — Per-session | `--max-budget-usd 1.50` per session |
| 3 — Watchdog | Built into scheduler; session rate + token counts |

| Metric | Warn | Pause | Kill |
|--------|------|-------|------|
| Sessions/hour | 4 | 6 | 8 |
| Single session tokens | 40k | — | 60k |

---

## MCP Connections

| MCP | Notes |
|-----|-------|
| Google Calendar | OAuth via mounted Claude credentials |
| Home Maintenance | Supabase Edge Function MCP |

Open Brain MCP is **not** configured.

---

## Action Model

**No approval needed**
- Reading GCal, Home Maintenance, Alto
- Morning briefing email to jramacrae@gmail.com
- Telegram property ops messages
- Local store writes (`store.js`)
- Maintenance calendar events for routed inbox maintenance items
- FreeAgent draft invoices (morning)

**Requires approval** (queued to `/logs/pending-approvals.json`, Pushover alert)
- Any other outbound email
- Other calendar creates/modifies
- Other external writes

---

## Infrastructure

| Component | Detail |
|-----------|--------|
| NAS | UGreen DXP4800 Plus |
| Hostname | `dnas` (Tailscale alias) |
| Tailscale IP | `100.98.167.107` |
| Stack root | `/volume1/docker/property-agent/` |
| Docker network | `agent-net` |
| Port | 3005 → 3001 (control API) |

---

## Setup notes

1. Create a **dedicated Property Agent Telegram bot** (do not reuse personal OBBot) and set `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` in `.env`.
2. `docker compose up -d --build`
3. Work-order processor should POST to `http://…:3005/inbox` (see mail-reader stack).
