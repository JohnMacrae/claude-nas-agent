# NEXT — Property Agent / Property Docs

Last updated: **2026-08-25**

> Older detail (Stage A–F invoice-automation plan, the 2026-07 decouple-from-OB1 work,
> WO→Paperless bridge fixes, etc.) has been trimmed from this file to keep it current —
> it's all still in git history: `git log -- NEXT.md` / `git show 3a3731b:NEXT.md` for the
> last full version before this trim.

## Current state

Branch **`fix/wo-paperless-bridge-handoff`**, pushed, working tree clean.
Latest commit: `77632f2` — Telegram pending-question fix (below).

## What just happened

**Telegram questions now survive across sessions (`77632f2`).** Root problem: sessions are
stateless — when the agent asks John a clarifying question via `telegram_send` and his reply
arrives later, it's processed in a brand-new session with zero memory of what was asked.
`pending_set`/`pending_get` (`agent/pending.js`) already existed for exactly this (question +
context, injected as `PENDING CONFIRM` alongside `PENDING TELEGRAM REPLIES` — see
`scheduler.js:327-334`), but was only wired into the voice-command flow.

- First fix attempt was prompt-only (`agent-system-prompt.md`): told the model to always pair
  a `telegram_send` question with `pending_set`, including an inline "HARD RULE". **Verified
  live, twice, that the cheap model (`deepseek-v4-flash`) ignored it both times.**
- Real fix is in code: `agent/agent-runner.js`'s `telegram_send` handler now auto-calls
  `pending_set` itself whenever the sent text contains `?` and nothing already covers it —
  no model cooperation required. An explicit `pending_set` from the model (richer intent/
  property/candidates) still overrides the auto-fallback when it fires.
- Retested live a third time after the code fix: confirmed `pending-confirm.json` populated
  automatically even though the model again sent a bare question. Test artifacts (fake
  Telegram replies, the auto-set pending-confirm) cleaned up — real Telegram messages did go
  to John's phone during testing (two synthetic clarifying questions), already flagged to him
  as noise, no action needed on them.
- System prompt also gained: "Question / request" replies now check `PENDING CONFIRM` for
  context before answering, and the shortcode-clarify path is explicit about the pairing.

**78BC — WO001564 (no water supply) confirmed still open by John, chase up tomorrow
(2026-08-26).** WO001562 (fuse box/water dripping, same property) is done. Logged via
`store_note` (id `44504a87-6811-428a-99c9-fbcaa3b7fa0d`) — no code action needed, just a
human follow-up. Maintenance calendar will keep surfacing it via property-check sweeps in
the meantime.

## Next actions

1. **Chase 78BC WO001564 tomorrow (2026-08-26)** — no water supply, still open.
2. Watch the next few real (non-test) Telegram question/reply round-trips to confirm the
   `pending_set` auto-fallback holds up outside a synthetic test.
3. WO-capture parallel run (property-agent native vs `mail-reader`'s `work-order-processor`)
   — compare a few more days of logs before retiring the old Python container.
4. Confirm invoice-run is still emailing drafts ≥24h old cleanly (last known-good state:
   2026-08-12 backlog, BUG-020 dedup fix landed 2026-08-25).

## Do not re-litigate

- **Maintenance calendar only** for invoicing — Property calendar carries Rentr lettings
  viewings, never invoice those.
- **The local `ob1` container is not a dependency** — not on a reachable network, nothing
  reads `OPEN_BRAIN_MCP_URL`.
- **`DATABASE_URL` is correct** — `ECONNREFUSED` at boot is a harmless one-shot startup race
  (`agent/scheduler.js:837-845`); weekend gaps are `isWorkday()`, not a fault.
- **`agent/` is baked into the image, not bind-mounted for the running container** — but for
  quick fixes it's fine to `docker cp` a changed file straight into `/agent/` in the running
  container (agent-runner.js is spawned fresh per session, no restart needed) as a fast path;
  still commit + rebuild the image properly afterward so the image matches.
- Completion state **is** recorded — free text in Maintenance event descriptions ("Done 1hr",
  "Completed — 1.5 hours"). Unstructured, but present.
- Gmail re-auth: `get_token.py` from John's laptop with `py -3`, writing to
  `W:\gmail-mcp\config\<account>\token.json`. Not the container-based helper.

## Key paths

- `BUGS.md`, `WORK_ORDERS_OUTSTANDING.html`, `agent/JJP_Property_List.md` — **local-only,
  gitignored**
- `agent/agent-runner.js` — tool definitions + `executeTool`; today's fix is in the
  `telegram_send` case
- `agent/pending.js` — single-slot pending-confirm state (question/intent/property/TTL)
- `agent/scheduler.js` — HTTP endpoints, session launch + `PENDING CONFIRM`/`PENDING TELEGRAM
  REPLIES` injection (`:280-335`)
- `agent-system-prompt.md` — "Asking John a Question via Telegram" + "Telegram Reply
  Processing" sections
- `agent/store.js` — `addTelegramReply`/`listPendingReplies`/`addNote`, Postgres-backed when
  `DATABASE_URL` set
- Maintenance calendar: `963dbd01a359d150a2ba10371bf80a30dc448da1100abb14ab750966a9e8a547@group.calendar.google.com`
- Property calendar: `jj52rrbqum0q362phqmsjp20uc@group.calendar.google.com`
