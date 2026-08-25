#!/usr/bin/env python3
"""Audit work-order emails since a cutoff date, independent of the processor's
dedup state. Reports every candidate WO email and whether it was captured."""
import json, os, re, sys
from pathlib import Path

sys.path.insert(0, "/app")
import gmail_client as gc
from work_order_processor import parse_pdf, pick_pdf_attachment, order_number_from_subject

CUTOFF = os.environ.get("AUDIT_AFTER", "2026/05/01")

QUERIES = [
    f'subject:"work order" from:rentopia after:{CUTOFF}',
    f'subject:"work request" from:rentopia after:{CUTOFF}',
    f'from:rentopia after:{CUTOFF}',
    f'subject:"work order" after:{CUTOFF}',
    f'subject:"works order" after:{CUTOFF}',
    f'subject:"work request" after:{CUTOFF}',
    f'subject:"maintenance request" after:{CUTOFF}',
    f'"work order" has:attachment after:{CUTOFF}',
]

processed = set()
try:
    processed = set(json.load(open("/data/logs/processed_work_orders.json")))
except Exception as e:
    print(f"[warn] no dedup file: {e}", file=sys.stderr)

wo_dir = Path("/work_orders")
saved_pdfs = {p.stem.upper() for p in wo_dir.glob("*.pdf")} if wo_dir.exists() else set()

rows, seen = [], set()
for q in QUERIES:
    try:
        msgs = gc.search_messages(q, max_results=100)
    except Exception as e:
        print(f"[warn] query failed {q}: {e}", file=sys.stderr)
        continue
    for m in msgs:
        if m["id"] in seen:
            continue
        seen.add(m["id"])
        try:
            d = gc.read_message(m["id"])
        except Exception as e:
            print(f"[warn] read failed {m['id']}: {e}", file=sys.stderr)
            continue
        frm = (d.get("from") or "").lower()
        fwd = ("jramacrae@gmail.com" in frm or "kk4oyj@gmail.com" in frm)
        att = pick_pdf_attachment(d.get("attachments", []))
        parsed = {}
        if att:
            try:
                parsed = parse_pdf(gc.get_attachment(d["id"], att["attachment_id"]))
            except Exception as e:
                parsed = {"_err": str(e)}
        on = (parsed.get("order_number") or order_number_from_subject(d.get("subject", "")) or "").upper()
        rows.append({
            "id": m["id"],
            "order": on or "(none)",
            "subject": (d.get("subject") or "")[:70],
            "from": (d.get("from") or "")[:45],
            "date": d.get("date", "")[:25],
            "wo_date": parsed.get("date", ""),
            "priority": parsed.get("priority", ""),
            "property": " / ".join(parsed.get("property_lines", []) or [])[:60],
            "problem": (parsed.get("problem") or parsed.get("description") or "")[:90],
            "has_pdf": bool(att),
            "forwarded": fwd,
            "in_dedup": m["id"] in processed,
            "pdf_saved": on in saved_pdfs,
        })

rows.sort(key=lambda r: (r["order"], r["date"]))
print(json.dumps({"cutoff": CUTOFF, "total": len(rows), "rows": rows}, indent=1))
