#!/usr/bin/env node
// Colour-code work-order events on the Maintenance calendar so the state of
// the portfolio is readable at a glance.
//
//   node wo-colour.js [--from YYYY-MM-DD] [--dry-run] [--json]
//
//   complete                      → left alone (whatever colour it has)
//   open, <= 14 days old          → Tangerine (6)  — orange
//   open, > 14 days, uninvoiced   → Tomato (11)    — red
//
// Only events carrying a WO###### number are touched. Free-text entries like
// "122NG - blocked Drain" are somebody's own note, not a tracked work order,
// and are left exactly as they are.
//
// NOTE ON "uninvoiced": the invoices ledger is keyed by calendar event id and
// is currently empty, so every event reads as uninvoiced and red is in
// practice age-based. The check is here so it starts discriminating the moment
// the invoicing agent writes to the ledger (Stage D) — no change needed then.

const path = require('path');
const { spawn } = require('child_process');
const store = require('./store');

const CALENDAR = 'Maintenance';
const COLOUR_OPEN = '6';   // Tangerine
const COLOUR_STALE = '11'; // Tomato
const STALE_AFTER_DAYS = 14;
const DEFAULT_FROM = '2026-05-01'; // start of the work-order audit window

const WO_RE = /WO\d{6}/i;

// A completion marker only counts when it opens the description or starts its
// own sentence or line — "Manage and complete refurbishment" is the job being
// asked for, not a job that has been done. Observed real markers: a leading
// "Done 1hr.", a trailing "\n\nComplete 1hr - new Thermostat", "Cancelled ...".
const DONE_RE = /(?:^|\n|\.\s+)(done|complete[d]?|cancelled)\b/i;

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
    const proc = spawn('node', [path.join(__dirname, 'gcal.js'), ...args], {
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

function daysOld(startDate, today) {
  const start = new Date(`${String(startDate).slice(0, 10)}T00:00:00Z`);
  return Math.floor((today - start) / 86400000);
}

// complete → null (leave alone); otherwise the colour it should carry.
function classify(event, today) {
  const description = event.description || '';
  if (DONE_RE.test(description)) return { state: 'complete', want: null };
  const age = daysOld(event.start, today);
  if (age > STALE_AFTER_DAYS) return { state: 'stale', want: COLOUR_STALE, age };
  return { state: 'open', want: COLOUR_OPEN, age };
}

async function run(opts = {}) {
  const from = opts.from || DEFAULT_FROM;
  const dryRun = Boolean(opts.dryRun);
  const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);

  // End bound is tomorrow: events dated today must be included, and Google's
  // timeMax is exclusive.
  const to = new Date(today.getTime() + 86400000).toISOString().slice(0, 10);

  const listed = await gcal([
    'list-events', '--calendar', CALENDAR,
    '--from', `${from}T00:00:00Z`,
    '--to', `${to}T23:59:59Z`,
    '--limit', '500',
  ]);

  const summary = {
    ok: true, from, to, dryRun,
    scanned: listed.count || 0,
    skipped: 0, complete: 0, open: 0, stale: 0,
    changed: 0, unchanged: 0,
    errors: [],
    changes: [],
  };

  for (const event of listed.events || []) {
    if (!WO_RE.test(`${event.summary || ''} ${event.description || ''}`)) {
      summary.skipped++;
      continue;
    }

    const { state, want } = classify(event, today);
    summary[state]++;
    if (want === null) continue; // complete — keep whatever colour it has

    // Red is reserved for work that is both stale and still unbilled. A store
    // failure must not silently downgrade it to orange, so let it throw.
    let colour = want;
    if (want === COLOUR_STALE) {
      const invoiced = await store.invoiceCheck(event.id);
      if (invoiced) colour = COLOUR_OPEN;
    }

    if ((event.colorId || null) === colour) { summary.unchanged++; continue; }

    const change = { id: event.id, summary: event.summary, state, from: event.colorId || null, to: colour };
    if (dryRun) { summary.changes.push(change); summary.changed++; continue; }

    try {
      await gcal(['update-event', '--calendar', CALENDAR, '--event-id', event.id, '--color-id', colour]);
      summary.changes.push(change);
      summary.changed++;
    } catch (e) {
      summary.errors.push({ id: event.id, summary: event.summary, error: e.message });
    }
  }

  if (summary.errors.length) summary.ok = false;
  return summary;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    const result = await run({
      from: args.from && args.from !== true ? args.from : undefined,
      dryRun: Boolean(args['dry-run']),
    });
    console.log(JSON.stringify(result, null, args.json ? 0 : 1));
    process.exitCode = result.ok ? 0 : 1;
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: e.message }));
    process.exitCode = 1;
  } finally {
    if (store.USE_DB) {
      const db = require('./db');
      await db.closePool().catch(() => {});
    }
  }
}

module.exports = { run, classify, DONE_RE, WO_RE };

if (require.main === module) main();
