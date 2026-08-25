#!/usr/bin/env node
// Deterministic Maintenance → FreeAgent invoice run (no LLM).
//
//   node invoice-run.js [--dry-run] [--create-only] [--send-only] [--from YYYY-MM-DD] [--send-after-hours 24]
//
// Create draft when description has done/complete[d] (not cancelled) AND notes
// parse to ≥1 billable line. Email drafts that have been ledger-status draft
// for ≥ send-after-hours (default 24).

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const store = require('./store');
const freeagent = require('./freeagent');
const woColour = require('./wo-colour');

const CALENDAR = 'Maintenance';
const DEFAULT_FROM = woColour.DEFAULT_FROM || '2026-05-01';
const AGENT_DIR = process.env.AGENT_DIR || __dirname;
const JJP_CANDIDATES = [
  path.join(AGENT_DIR, 'JJP_Property_List.md'),
  '/agent/JJP_Property_List.md',
  '/volume1/docker/property_details/JJP_Property_List.md',
];

const WO_RE = /WO\d{6}/i;
const CANCELLED_RE = /(?:^|\n|\.\s+)cancelled\b/i;
const COMPLETE_RE = /(?:^|\n|\.\s+)(done|complete[d]?)\b/i;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

function gcal(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [path.join(AGENT_DIR, 'gcal.js'), ...args], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr.trim() || `gcal.js exited ${code}`));
      try {
        resolve(JSON.parse(stdout.trim() || '{}'));
      } catch (e) {
        reject(new Error(`gcal.js returned unparseable output: ${stdout.slice(0, 200)}`));
      }
    });
    proc.on('error', reject);
  });
}

function loadJjp() {
  const map = new Map();
  const jjpPath = JJP_CANDIDATES.find((p) => fs.existsSync(p));
  if (!jjpPath) return map;
  const text = fs.readFileSync(jjpPath, 'utf8');
  for (const line of text.split('\n')) {
    const m = line.match(/^\|\s*([A-Z0-9]+)\s*\|\s*([^|]+)\|/);
    if (!m) continue;
    const code = m[1].trim();
    if (code === 'Acronym') continue;
    if (!map.has(code)) map.set(code, m[2].trim());
  }
  return map;
}

function shortcodeOf(summary) {
  const [head] = String(summary || '').split(/\s+[-–]\s+/);
  return (head || '').trim();
}

function woNumberOf(event) {
  const m = `${event.summary || ''} ${event.description || ''}`.match(/WO\d{6}/i);
  return m ? m[0].toUpperCase() : '';
}

function problemOf(event) {
  const first = String(event.description || '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean) || '';
  return first
    .replace(/^WO\d{6}\s*:\s*/i, '')
    .split(/\s*(?:Status:|Priority:|Routed from)/i)[0]
    .trim()
    .slice(0, 80);
}

function eventDate(event) {
  return String(event.start || '').slice(0, 10);
}

function classifyDescription(description) {
  const text = description || '';
  if (CANCELLED_RE.test(text)) return 'cancelled';
  if (COMPLETE_RE.test(text)) return 'complete';
  return 'open';
}

function buildDescription(event) {
  const code = shortcodeOf(event.summary);
  const wo = woNumberOf(event);
  const problem = problemOf(event) || String(event.summary || '').replace(/^[^–-]+[-–]\s*/, '').trim();
  if (code && wo) return `${code} - ${wo} - ${problem || 'maintenance'}`;
  return event.summary || 'Maintenance job';
}

function buildComments(event, address) {
  const wo = woNumberOf(event);
  const problem = problemOf(event);
  const parts = [];
  if (address) parts.push(`Property: ${address}.`);
  if (wo) parts.push(`Work order: ${wo}${problem ? `: ${problem}` : ''}.`);
  return parts.join(' ').trim() || null;
}

function labourHours(items) {
  return freeagent.billableItems(items)
    .filter((i) => i.item_type === 'Hours')
    .reduce((sum, i) => sum + parseFloat(i.quantity), 0);
}

async function createPass({ events, jjp, dryRun }) {
  const created = [];
  const skipped = [];

  for (const event of events) {
    const blob = `${event.summary || ''} ${event.description || ''}`;
    if (!WO_RE.test(blob)) continue;

    const state = classifyDescription(event.description);
    if (state === 'cancelled') {
      skipped.push({ event_id: event.id, summary: event.summary, reason: 'cancelled' });
      continue;
    }
    if (state !== 'complete') continue;

    const existing = await store.invoiceCheck(event.id);
    if (existing) {
      skipped.push({
        event_id: event.id,
        summary: event.summary,
        reason: 'already_ledger',
        reference: existing.reference || null,
        status: existing.status || null,
      });
      continue;
    }

    // Same WO can appear on two different calendar events (a stray
    // duplicate, a re-created event after a gcal-auth gap, etc). event_id
    // dedup alone misses that — cross-check by WO number too (BUG-020).
    const wo = woNumberOf(event);
    if (wo) {
      const byWo = await store.invoiceCheckByWo(wo);
      if (byWo && byWo.event_id !== event.id) {
        skipped.push({
          event_id: event.id,
          summary: event.summary,
          reason: 'already_ledger_by_wo',
          wo_number: wo,
          other_event_id: byWo.event_id,
          reference: byWo.reference || null,
          status: byWo.status || null,
        });
        continue;
      }
    }

    const notes = event.description || '';
    const items = freeagent.notesToInvoiceItems(notes, event.summary, { allowMinimum: false });
    const billable = freeagent.billableItems(items);
    if (!billable.length) {
      skipped.push({ event_id: event.id, summary: event.summary, reason: 'no_billable_lines' });
      continue;
    }

    const code = shortcodeOf(event.summary);
    const address = (code && jjp.get(code)) || null;
    const description = buildDescription(event);
    const comments = buildComments(event, address);
    const datedOn = eventDate(event);
    const net = freeagent.netFromItems(items);
    const hours = labourHours(items);

    const entry = {
      event_id: event.id,
      summary: event.summary,
      description,
      dated_on: datedOn,
      net_value: net.toFixed(2),
      hours,
    };

    if (dryRun) {
      created.push({ ...entry, dry_run: true });
      continue;
    }

    try {
      const result = await freeagent.createInvoice({
        description,
        notes,
        address,
        datedOn,
        comments,
        allowMinimum: false,
      });
      const record = await store.invoiceMarkDraft(event.id, {
        acronym: code || null,
        hours,
        invoice_url: result.invoice_url,
        reference: result.reference,
        net_value: result.net_value || net,
        wo_number: wo || null,
      });
      created.push({
        ...entry,
        invoice_url: result.invoice_url,
        reference: result.reference,
        duplicate: !!record.duplicate,
      });
      // Stay under FreeAgent ~60 req/min when contact lookups fire.
      await new Promise((r) => setTimeout(r, 3000));
    } catch (e) {
      skipped.push({
        event_id: event.id,
        summary: event.summary,
        reason: 'create_failed',
        error: e.message,
      });
    }
  }

  return { created, skipped };
}

async function sendPass({ dryRun, sendAfterHours }) {
  const sent = [];
  const skipped = [];
  const drafts = await store.listDraftsOlderThan(sendAfterHours);

  for (const row of drafts) {
    if (!row.invoice_url) {
      skipped.push({ event_id: row.event_id, reason: 'missing_invoice_url' });
      continue;
    }
    if (dryRun) {
      sent.push({
        event_id: row.event_id,
        invoice_url: row.invoice_url,
        reference: row.reference,
        acronym: row.acronym || null,
        net_value: row.net_value,
        dry_run: true,
      });
      continue;
    }
    try {
      const result = await freeagent.sendInvoice(row.invoice_url);
      await store.invoiceMarkSent(row.event_id);
      sent.push({
        event_id: row.event_id,
        invoice_url: row.invoice_url,
        reference: result.reference || row.reference,
        acronym: row.acronym || null,
        net_value: row.net_value,
      });
    } catch (e) {
      skipped.push({
        event_id: row.event_id,
        invoice_url: row.invoice_url,
        reason: 'send_failed',
        error: e.message,
      });
    }
  }

  return { sent, skipped };
}

function outstandingFrom(events) {
  const out = [];
  for (const event of events) {
    const blob = `${event.summary || ''} ${event.description || ''}`;
    if (!WO_RE.test(blob)) continue;
    if (classifyDescription(event.description) !== 'open') continue;
    out.push({
      event_id: event.id,
      summary: event.summary,
      start: eventDate(event),
      wo: woNumberOf(event),
    });
  }
  return out;
}

async function run(opts = {}) {
  const dryRun = !!opts.dryRun;
  const createOnly = !!opts.createOnly;
  const sendOnly = !!opts.sendOnly;
  const from = opts.from || DEFAULT_FROM;
  const sendAfterHours = opts.sendAfterHours != null ? Number(opts.sendAfterHours) : 24;

  const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  const to = new Date(today.getTime() + 86400000).toISOString().slice(0, 10);

  const listed = await gcal([
    'list-events', '--calendar', CALENDAR,
    '--from', `${from}T00:00:00Z`,
    '--to', `${to}T23:59:59Z`,
    '--limit', '500',
  ]);
  const events = listed.events || [];
  const jjp = loadJjp();

  let created = [];
  let sent = [];
  let skipped = [];

  if (!sendOnly) {
    const c = await createPass({ events, jjp, dryRun });
    created = c.created;
    skipped = skipped.concat(c.skipped);
  }

  if (!createOnly) {
    const s = await sendPass({ dryRun, sendAfterHours });
    sent = s.sent;
    skipped = skipped.concat(s.skipped.map((x) => ({ ...x, phase: 'send' })));
  }

  const outstanding = outstandingFrom(events);

  return {
    ok: true,
    dryRun,
    from,
    to,
    scanned: listed.count || events.length,
    created,
    sent,
    skipped,
    outstanding,
    counts: {
      created: created.length,
      sent: sent.length,
      skipped: skipped.length,
      outstanding: outstanding.length,
    },
  };
}

// "Invoiced" = has a FreeAgent invoice, draft or sent (drafting counts as
// invoiced — the 24h hold is a review window, not a billing gap).
// "Unpaid" here means completed but NOT invoiced: notes didn't parse to a
// billable line, or FreeAgent create failed — these need a manual look,
// and previously silently vanished from the report.
function formatTelegramReport(result) {
  const lines = [];

  const invoiced = [
    ...result.created.map((c) => ({ ...c, state: 'drafted' })),
    ...result.sent.map((s) => ({ ...s, state: 'sent' })),
  ];
  if (invoiced.length) {
    lines.push(`✅ Completed & invoiced (${invoiced.length}):`);
    for (const c of invoiced.slice(0, 20)) {
      const label = c.summary || c.acronym || c.event_id;
      const ref = c.reference ? `#${c.reference}` : '';
      const amount = c.net_value != null ? ` £${Number(c.net_value).toFixed(2)}` : '';
      const tag = c.state === 'sent' ? ' (sent)' : '';
      lines.push(`• ${label}${ref ? ` → ${ref}` : ''}${amount}${tag}`);
    }
    if (invoiced.length > 20) lines.push(`• …+${invoiced.length - 20} more`);
  }

  const unpaid = result.skipped.filter(
    (s) => s.reason === 'no_billable_lines' || s.reason === 'create_failed'
  );
  if (unpaid.length) {
    lines.push(`⚠️ Completed, unpaid (${unpaid.length}):`);
    for (const u of unpaid.slice(0, 20)) {
      const why = u.reason === 'no_billable_lines'
        ? 'no billable lines in notes'
        : `FreeAgent create failed: ${(u.error || 'unknown error').slice(0, 80)}`;
      lines.push(`• ${u.summary || u.event_id} — ${why}`);
    }
    if (unpaid.length > 20) lines.push(`• …+${unpaid.length - 20} more`);
  }

  if (result.outstanding.length) {
    lines.push(`Outstanding open (${result.outstanding.length}) — see /wo-report`);
  }

  if (!lines.length) return null;
  return lines.join('\n');
}

module.exports = {
  run,
  formatTelegramReport,
  classifyDescription,
  DEFAULT_FROM,
};

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  run({
    dryRun: !!args['dry-run'],
    createOnly: !!args['create-only'],
    sendOnly: !!args['send-only'],
    from: args.from || undefined,
    sendAfterHours: args['send-after-hours'] != null ? Number(args['send-after-hours']) : 24,
  })
    .then(async (result) => {
      console.log(JSON.stringify(result, null, 2));
      await require('./db').closePool().catch(() => {});
      if (!result.ok) process.exitCode = 1;
    })
    .catch(async (e) => {
      console.error(JSON.stringify({ ok: false, error: e.message }));
      await require('./db').closePool().catch(() => {});
      process.exit(1);
    });
}
