# NAS Claude Agent

An autonomous Claude Code agent running on a self-hosted NAS (UGreen DXP4800 Plus), designed for property management automation and personal productivity. Reacts to real-world events, runs on a defined schedule, and pushes output to email and mobile — without requiring manual interaction.

---

## Overview

This stack runs Claude Code in an isolated Docker environment on a home NAS. It connects to personal data sources via MCP (Open Brain, Gmail, Google Calendar), executes tasks autonomously within defined safety boundaries, and notifies the owner via push notification and email rather than requiring a browser session.

It is **not** a continuously running loop. Instead, a scheduler wakes the agent at defined times and on defined triggers, runs a bounded Claude Code session, then exits. A separate watchdog process monitors spend and session frequency independently of the agent.

---

## Architecture

```
/volume1/docker/claude-agent/
├── compose.yml
├── agent/            # Claude Code sessions (scheduled, bounded)
├── watchdog/         # Spend + frequency monitor (independent)
├── ntfy/             # Self-hosted push notifications
├── approval-ui/      # Web UI for approving write actions
└── caddy/            # Reverse proxy (Tailscale access)
```

### Containers

| Container | Role |
|-----------|------|
| `agent` | Runs Claude Code sessions on schedule or trigger |
| `watchdog` | Monitors API spend and session rate; can pause or kill agent |
| `ntfy` | Self-hosted push notification server (iOS + Android) |
| `approval-ui` | Lightweight web page for approving pending write actions |
| `caddy` | Reverse proxy; accessible via Tailscale only |

---

## Scheduling

| Time | Trigger | Action |
|------|---------|--------|
| 06:00 | Fixed (daily) | Morning briefing — GCal, Gmail, Open Brain summary |
| 08:00–18:00 | Every 2 hours | Check for pending tasks, new items, urgent mail |
| Any time | New Open Brain item | Wake early if new item written since last run |
| 18:00–06:00 | Silent | No sessions except the 06:00 briefing |

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

### Layer 3 — Watchdog process
A separate container with no Claude Code dependency. Polls the Anthropic usage API hourly, tracks session frequency via a shared volume, and takes escalating action:

| Metric | Warn | Pause | Kill |
|--------|------|-------|------|
| Hourly spend | £0.50 | £1.00 | £2.00 |
| Daily spend | £2.00 | £3.00 | £5.00 |
| Sessions/hour | 4 | 6 | 8 |
| Single session tokens | 40k | — | 60k |

**Warn** → ntfy push notification to owner  
**Pause** → writes `PAUSED` flag file; agent checks before starting any session  
**Kill** → sends SIGTERM to agent container  

Watchdog logs all decisions to `/volume1/docker/claude-agent/watchdog/logs/`.

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

Write actions are queued as pending items. Owner receives an ntfy push with a link to the approval UI. Pending actions expire after 24 hours if not approved.

---

## MCP Integrations

| MCP | Access | Used for |
|-----|--------|----------|
| Open Brain | Read + Write | Task tracking, event triggers, briefing content |
| Gmail | Read only (agent) | Flagging urgent mail, briefing content |
| Gmail | Send (approval-gated) | Drafts and sends after owner approval |
| Google Calendar | Read only (agent) | Upcoming events, briefing content |
| Google Calendar | Write (approval-gated) | New entries after owner approval |

---

## Skills

The agent has access to a set of skill files describing how to perform structured tasks (document creation, property management workflows, etc.). Skills are mounted read-only into the agent container.

| Skill | Description |
|-------|-------------|
| `docx` | Word document creation |
| `pdf` | PDF reading and creation |
| `openrent-enquiries` | OpenRent landlord dashboard automation |

---

## Output Channels

| Channel | Used for |
|---------|----------|
| Email (via Gmail MCP) | Morning briefing, summaries, completed task reports |
| ntfy push notification | Urgent alerts, approval requests, watchdog warnings |
| Approval UI (Tailscale) | Reviewing and approving pending write actions |

The approval UI is accessible only via Tailscale — not exposed to the public internet.

---

## Build Order

Safety before capability:

1. Anthropic API key created; hard spend cap set at console.anthropic.com
2. Watchdog container built and tested
3. ntfy container deployed and mobile app configured
4. Scheduler and agent container built (dry-run mode first)
5. Approval UI built
6. Caddy reverse proxy configured for Tailscale
7. MCP connections tested
8. Dry-run validated; live mode enabled
9. OpenRent / browser skills integrated (Phase 2)

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

---

## Security Notes

- Agent container does **not** have access to the host Docker socket
- MCP credentials are environment variables, never baked into images
- Approval UI is Tailscale-only
- Agent runs as non-root user inside container
- All sessions logged with timestamp, token count, and actions taken
- `--dangerously-skip-permissions` is used inside the container; the container boundary provides the safety layer

---

## Status

🔴 Pre-build — API key obtained, spend cap set. Watchdog next.
