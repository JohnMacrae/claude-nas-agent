# Work Order Pipeline — map & gotchas

Last updated: 2026-07-19

This documents where the work-order machinery lives and the non-obvious traps
discovered while debugging WO intake, so future sessions don't re-discover them
by trial and error.

---

## The pipeline (intended flow)

```
Rentopia email (info@rentopia.uk) → jramacrae@gmail.com
   subject: "...Work Request... Work Order: WO00xxxx", PDF attached
        │
        ▼
work-order-processor container  (runs every 2h, see its compose)
   • searches Gmail via gmail_client.py using token at /gmail-config/token.json
   • parse_pdf() → property_lines, problem, date, priority
   • addr_to_shortcode() → e.g. 78TS
   • save Supplier Instructed.pdf → property-agent/output/work_orders/{WOnnn}.pdf
   • also drop {WOnnn}_Supplier Instructed.pdf → paperless/consume (live)
   • POST http://property-agent:3001/inbox  (local JSON store — not Supabase)
   • POST /wo-scan → refresh tenant-contacts.json
   • urgent/emergency → also POST /trigger (property-check)
   • gmail-pdf-processor (02:00) also sends non-statement PDFs to the same live consume
     (unique names for Supplier Instructed; must mount paperless/consume not paperless-ngx/consume)
        │
        ▼
property-agent session reads /data/inbox.json → creates calendar event
   on the **Maintenance** calendar + logs Home Maintenance task
```

Code: `/volume1/docker/mail-reader/work_order_processor.py`
Log:  `/volume1/docker/mail-reader/data/logs/work_order_processor.log`
Dedup: `/volume1/docker/mail-reader/data/logs/processed_work_orders.json`

---

## ⚠️ Current breakage (2026-05-22 →)

The processor's Gmail auth is dead:

```
ERROR - Gmail search failed: invalid_grant: Token has been expired or revoked.
Work orders captured: 0
```

- First failure: **2026-05-22 07:45**. Zero captures since.
- Last good capture: **WO001496** (30RC) on 2026-05-20.
- The processor's `gmail_client.py` refreshes against an OAuth **client** whose
  credentials appear to have been revoked. Reading the same `token.json` is not
  enough — refresh needs the matching client_id/secret.

### Why the production MCP still works (and the fix John wants)

The same `token.json` is consumed by **two different code paths**:

| Consumer | Token path (host: `/volume1/docker/gmail-mcp/config/jramacrae/`) | Status |
|----------|------------------------------------------------------------------|--------|
| `work-order-processor` (`gmail_client.py`, `mail-reader-work-order-processor` image) | `/gmail-config/token.json` | ❌ invalid_grant |
| Production MCP (`gmail-mcp:local` image) | `/config/token.json` | ✅ works |

The production `gmail-mcp:local` server refreshes successfully where the old
`gmail_client.py` path does not. **Directive (John, 2026-06-04): the property
agent should use the production gmail MCP, not the standalone processor's
`gmail_client.py` token path.** Re-pointing the WO pipeline at the production
MCP is the proper fix (vs. re-authing the dead client yet again).

---

## Production Gmail MCP servers (what this Claude session uses)

Configured in `/home/john/.claude/.mcp.json` → `mcpServers`. Three accounts:
`gmail-jramacrae`, `gmail-kk4oyj`, `gmail-serenitybrides`.

Each is an **ephemeral `docker run --rm -i` stdio container** (image
`gmail-mcp:local`), spawned per session. Example (`gmail-jramacrae`):

```
docker run --rm -i
  -v /volume1/docker/gmail-mcp/config/jramacrae:/config:ro     # READ-ONLY
  -v /volume1/docker/gmail-mcp/logs/jramacrae:/logs            # writable
  -e GMAIL_ACCOUNT=jramacrae@gmail.com
  -e GMAIL_SCOPE_TIER=modify
  -e GMAIL_TOKEN_PATH=/config/token.json
  -e GMAIL_AUDIT_LOG=/logs/audit.jsonl
  gmail-mcp:local
```

Tools: `search_messages`, `read_message`, `get_attachment`, `send_email`,
`create_draft`, `add_label`/`remove_label`, `mark_read`, `forward_message`,
`list_labels`. Scope tiers: jramacrae=`modify`, kk4oyj & serenitybrides=`send`.

### 🪤 `get_attachment` save_path trap (cost us several failed attempts)

`save_path` is **inside the ephemeral MCP container**, NOT the host or the
property-agent working dir:
- `/tmp/...` → written into the throwaway container, **lost on exit** (`--rm`).
  You will not find it on the host or in `gmail-mcp-*` containers.
- `/config/...` → **read-only**, write fails.
- `/logs/...` → the ONLY writable host-mapped path. Lands on host at
  `/volume1/docker/gmail-mcp/logs/<account>/...`, owned by **root**.

**Recipe to pull a PDF for property-agent use:**
1. `get_attachment(save_path="/logs/<name>.pdf")`
2. On host, `cp /volume1/docker/gmail-mcp/logs/jramacrae/<name>.pdf` into the
   caller's folder (e.g. `output/work_orders/`). `cp` makes it john-owned, so
   no `chown` needed; then remove the root-owned original from the logs dir.

(The standalone `gmail-mcp-jramacrae` / `gmail-mcp-kk4oyj` /
`gmail-mcp-serenitybrides` long-running containers are a *different* deployment
from the per-session stdio servers above — don't go looking for session files
inside them.)

---

## Parsing WO PDFs

- **PyPDF2 is NOT installed on the host.** It lives in the
  `mail-reader-work-order-processor` image (running container:
  `work-order-processor`).
- Parser functions in `/app/work_order_processor.py`: `parse_pdf(bytes)`,
  `addr_to_shortcode(lines)`, `parse_date("dd/mm/yyyy")`.
- 🪤 `docker exec work-order-processor python3 - <<'PY' ...` (heredoc on stdin)
  **produces no output** here. Instead write the script to a file,
  `docker cp` it in, then `docker exec ... python3 /tmp/script.py`.

---

## Calendar IDs

| Calendar | ID |
|----------|----|
| Property Calendar | `jj52rrbqum0q362phqmsjp20uc@group.calendar.google.com` |
| Maintenance (WO events route here) | `963dbd01a359d150a2ba10371bf80a30dc448da1100abb14ab750966a9e8a547@group.calendar.google.com` |
| Family | `family01910427949220416167@group.calendar.google.com` |

---

## Rentopia WO email shape (for searching)

- From: `Rentopia East Anglia Ltd <info@rentopia.uk>` (search `from:rentopia`)
- Subject: `...: Work Request - Property: <addr> - Work Order: WO00xxxx [ref:...]`
- Attachment: `Supplier Instructed.pdf`
- Rentopia sometimes sends the **same WO twice** (two emails, different `ref:`,
  identical PDF) — dedupe by WO number.
- WO numbers are global across all Rentopia clients, so gaps in the sequence
  (e.g. WO001497, WO001500) are normal — those belong to other landlords.
