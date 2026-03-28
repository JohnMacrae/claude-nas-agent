# NAS Claude Agent

An autonomous Claude Code agent running on a self-hosted NAS (UGreen DXP4800 Plus), designed for property management automation and personal productivity. Reacts to real-world events, runs on a defined schedule, and pushes output to email and mobile — without requiring manual interaction.

---

## Overview

This stack runs Claude Code in an isolated Docker environment on a home NAS. It connects to personal data sources via MCP (Open Brain, Gmail, Google Calendar) and the Alto property management API, executes tasks autonomously within defined safety boundaries, and notifies the owner via Pushover push notification and email rather than requiring a browser session.

It is **not** a continuously running loop. Instead, a scheduler wakes the agent at defined times and on defined triggers, runs a bounded Claude Code session, then exits. A separate watchdog process monitors spend and session frequency independently of the agent.

---

## Architecture

```
/volume1/docker/claude-agent/
├── compose.yml
├── .env                    # API keys and credentials — never committed
├── .env.example
├── .gitignore
├── docs/                   # Reference documentation — never committed
│   └── alto-api.pdf
├── properties.txt          # Static property list — never committed
├── watchdog/               # Spend + session monitor
│   ├── watchdog.js
│   ├── package.json
│   └── Dockerfile
├── agent/                  # Claude Code sessions (next phase)
├── approval-ui/            # Web UI for approving write actions (next phase)
├── flags/                  # Shared flag files (runtime, not committed)
└── logs/                   # Shared logs (runtime, not committed)
```

### Containers

| Container | Status | Role |
|-----------|--------|------|
| `watchdog` | ✅ Running | Monitors API spend and session rate; can pause or kill agent |
| `agent` | 🔴 Next | Runs Claude Code sessions on schedule or trigger |
| `approval-ui` | 🔴 Next | Lightweight web page for approving pending write actions |

---

## Notifications

Push notifications via **Pushover** (iOS/Android). Credentials stored in `.env` as `PUSHOVER_TOKEN` and `PUSHOVER_USER`.

---

## Scheduling

| Time | Trigger | Action |
|------|---------|--------|
| 06:00 Mon–Fri | Fixed (non-public-holiday) | Morning briefing — GCal, Gmail, Open Brain, Alto summary |
| 08:00–18:00 Mon–Fri | Every 2 hours, non-public-holiday | Check for pending tasks, new items, urgent mail |
| Any time | New Open Brain item | Wake early if new item written since last run |
| 18:00–06:00 | Silent | No sessions |
| Weekends | Silent | No sessions unless manually triggered |
| Public holidays | Silent | No sessions unless manually triggered |

UK public holidays fetched from `api.gov.uk/bank-holidays` at startup.

---

## Safety Model

Three independent layers prevent runaway spend or behaviour:

### Layer 1 — Anthropic hard cap
Set in [console.anthropic.com](https://console.anthropic.com) → Billing → Usage limits. Hard monthly ceiling; API returns an error if exceeded. No code dependency.

### Layer 2 — Per-session token budget
Each Claude Code session is launched with a maximum token budget. A single session cannot consume more than its allocation regardless of task complexity.

| Parameter | Value |
|-----------|-------|
| Max tokens per session | 50,000 |
| Max sessions per hour | 3 |

### Layer 3 — Watchdog process ✅ Live
A separate container with no Claude Code dependency. Polls every 5 minutes, tracks session frequency via shared volume, and takes escalating action:

| Metric | Warn | Pause | Kill |
|--------|------|-------|------|
| Hourly spend | $0.63 (~£0.50) | $1.27 (~£1.00) | $2.54 (~£2.00) |
| Daily spend | $2.54 (~£2.00) | $3.81 (~£3.00) | $6.35 (~£5.00) |
| Sessions/hour | 4 | 6 | 8 |
| Single session tokens | 40k warn | — | 60k kill |

**Warn** → Pushover push notification (priority: high)
**Pause** → writes `PAUSED` flag file; agent checks before starting any session
**Kill** → writes `PAUSED` + `KILLED` flag files; Pushover emergency notification

Watchdog status: `http://dnas:3004/status`
Manual resume: `POST http://dnas:3004/resume`

---

## Action Model

The agent distinguishes between **read** and **write** actions:

**Read / notify (no approval needed)**
- Morning briefing email
- Push notifications for upcoming events
- Summaries of new Open Brain items
- Flagging urgent Gmail

**Write (requires approval)**
- Sending email on behalf of owner
- Creating or modifying calendar entries
- Any file creation intended for external use

Write actions are queued to `/logs/pending-approvals.json`. Owner receives a Pushover notification. Pending actions expire after 24 hours if not approved.

---

## MCP Integrations

| MCP | Access | Used for |
|-----|--------|----------|
| Open Brain | Read + Write | Task tracking, event triggers, briefing content |
| Gmail | Read (agent) | Flagging urgent mail, briefing content |
| Gmail | Send (approval-gated) | Drafts and sends after owner approval |
| Google Calendar | Read (agent) | Upcoming events, briefing content |
| Google Calendar | Write (approval-gated) | New entries after owner approval |

---

## Alto API Integration

Alto (The Property Software Group) Client Feed Export API v13.

Base URL: `https://webservices.vebra.com/export/{datafeedid}/v13/`

Auth: HTTP Basic → token-based (1 hour expiry, auto-refreshed)

Key calls used by agent:
- `GET /property/{yyyy}/{MM}/{dd}/{HH}/{mm}/{ss}` — changed properties since last check
- `GET /branch/{clientid}/property/{prop_id}` — full property details

Lettings statuses: 100 = To Let, 101 = Let, 102 = Under Offer, 103 = Reserved, 104 = Let Agreed

Credentials: `ALTO_DATAFEED_ID`, `ALTO_USERNAME`, `ALTO_PASSWORD` in `.env`

Reference: `docs/alto-api.pdf`

---

## Property Portfolio

59 residential properties across Colchester (CO1–CO4), Clacton (CO15), and Chelmsford (CM2). Full list in `properties.txt` (not committed — contains addresses).

Managed via: OpenRent, Rentr, Alto, Rentopia East Anglia

---

## Skills

The agent has access to skill files describing how to perform structured tasks. Skills are mounted read-only into the agent container.

| Skill | Description |
|-------|-------------|
| `docx` | Word document creation |
| `pdf` | PDF reading and creation |
| `openrent-enquiries` | OpenRent landlord dashboard (Phase 2) |

---

## Output Channels

| Channel | Used for |
|---------|----------|
| Email (via Gmail MCP) | Morning briefing, summaries, completed task reports |
| Pushover push notification | Urgent alerts, approval requests, watchdog warnings |
| Approval UI (Tailscale) | Reviewing and approving pending write actions |

The approval UI will be accessible only via Tailscale.

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
| Logs | `/volume1/docker/claude-agent/logs/` |
| Shared flags | `/volume1/docker/claude-agent/flags/` |
| Watchdog status | `http://dnas:3004/status` |

---

## Security Notes

- Agent container does **not** have access to the host Docker socket
- MCP credentials are environment variables, never baked into images
- Approval UI will be Tailscale-only
- Agent runs as non-root user inside container
- All sessions logged with timestamp, token count, and actions taken
- `--dangerously-skip-permissions` used inside the container; the container boundary provides the safety layer
- `properties.txt`, `.env`, `docs/`, `logs/`, and `flags/` are all gitignored

---

## Build Order

1. ✅ Anthropic API key created; hard spend cap set
2. ✅ Watchdog container — built, running, Pushover tested
3. 🔲 Agent container and scheduler
4. 🔲 Approval UI
5. 🔲 MCP connections tested
6. 🔲 Dry-run validated; live mode enabled
7. 🔲 Alto API integration
8. 🔲 OpenRent / browser skills (Phase 2)

---

## Status

🟡 In progress — watchdog live and tested. Agent container next.
