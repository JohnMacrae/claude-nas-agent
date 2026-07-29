#!/usr/bin/env node
// HTML report of outstanding work orders, served by scheduler.js at
// GET /wo-report and linked from the morning Telegram message.
//
//   node wo-report.js [--from YYYY-MM-DD] > report.html
//
// Every row links to its Google Calendar event so the job can be closed where
// completion is actually recorded — add "Done 1hr" to the event description
// and the next colour pass picks it up.
//
// Classification is NOT duplicated here: it comes from wo-colour.scan(), so
// the report and the calendar colours can never disagree.
//
// Self-contained by design — inline CSS, no external fonts, scripts or images.
// The NAS may be reachable with no route to the internet.

const path = require('path');
const woColour = require('./wo-colour');

const { COLOUR_STALE, STALE_AFTER_DAYS } = woColour;

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// "48BC - WO001540" → "48BC". Falls back to the whole summary when there is no
// separator rather than guessing.
function shortcodeOf(summary) {
  const [head] = String(summary || '').split(/\s+[-–]\s+/);
  return (head || '').trim() || String(summary || '').trim();
}

function woNumberOf(event) {
  const m = `${event.summary || ''} ${event.description || ''}`.match(/WO\d{6}/i);
  return m ? m[0].toUpperCase() : '';
}

// First meaningful line of the description, minus the redundant "WO######: "
// prefix the intake writes.
function problemOf(event, limit = 110) {
  const first = String(event.description || '')
    .split('\n')
    .map(l => l.trim())
    .find(Boolean) || '';
  const stripped = first
    .replace(/^WO\d{6}\s*:\s*/i, '')
    // Drop the intake boilerplate — "Status: urgent. Routed from OB1 [PA]
    // thought <date>." adds nothing here and crowds out the actual problem.
    .split(/\s*(?:Status:|Priority:|Routed from)/i)[0]
    .trim();
  return stripped.length > limit ? `${stripped.slice(0, limit - 1)}…` : stripped;
}

function formatDate(iso) {
  const d = new Date(`${String(iso).slice(0, 10)}T12:00:00Z`);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

const STYLES = `
:root { color-scheme: light dark; --bg:#fff; --fg:#16181d; --muted:#6b7280;
  --line:#e5e7eb; --card:#fff; --red:#b42318; --redbg:#fef3f2; --amber:#b54708; --amberbg:#fffaeb; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#14161a; --fg:#e8eaed; --muted:#9aa1ab; --line:#2a2e35; --card:#1b1e24;
    --red:#f97066; --redbg:#2b1614; --amber:#fdb022; --amberbg:#2a1e0c; }
}
* { box-sizing: border-box; }
body { margin:0; padding:16px; background:var(--bg); color:var(--fg);
  font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  -webkit-text-size-adjust:100%; }
header { margin:0 0 16px; }
h1 { font-size:19px; margin:0 0 4px; letter-spacing:-0.01em; }
.sub { color:var(--muted); font-size:13px; }
.counts { display:flex; gap:8px; margin:12px 0 0; flex-wrap:wrap; }
.pill { font-size:13px; font-weight:600; padding:4px 10px; border-radius:999px; border:1px solid transparent; }
.pill.red { color:var(--red); background:var(--redbg); border-color:var(--red); }
.pill.amber { color:var(--amber); background:var(--amberbg); border-color:var(--amber); }
ul { list-style:none; margin:16px 0 0; padding:0; }
li { margin:0 0 8px; }
a.row { display:block; padding:12px 14px; min-height:44px; text-decoration:none; color:inherit;
  background:var(--card); border:1px solid var(--line); border-left-width:4px; border-radius:10px; }
a.row:active { opacity:.65; }
a.row.stale { border-left-color:var(--red); }
a.row.open  { border-left-color:var(--amber); }
.top { display:flex; align-items:baseline; gap:8px; flex-wrap:wrap; }
.code { font-weight:700; }
.wo { color:var(--muted); font-size:13px; font-variant-numeric:tabular-nums; }
.tag { margin-left:auto; font-size:11px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; }
.tag.stale { color:var(--red); }
.tag.open { color:var(--amber); }
.problem { margin-top:4px; }
.meta { margin-top:4px; color:var(--muted); font-size:13px; }
.empty { padding:32px 12px; text-align:center; color:var(--muted); }
footer { margin-top:24px; color:var(--muted); font-size:12px; }
`;

function page(title, bodyHtml) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body>
${bodyHtml}
</body>
</html>
`;
}

function renderRow({ event, state, age }) {
  const stale = state === 'stale';
  const cls = stale ? 'stale' : 'open';
  const tag = stale ? `overdue` : 'open';
  const wo = woNumberOf(event);
  const problem = problemOf(event);
  const href = event.htmlLink || '#';

  return `  <li><a class="row ${cls}" href="${escapeHtml(href)}" target="_blank" rel="noopener">
    <div class="top">
      <span class="code">${escapeHtml(shortcodeOf(event.summary))}</span>
      <span class="wo">${escapeHtml(wo)}</span>
      <span class="tag ${cls}">${tag}</span>
    </div>
    ${problem ? `<div class="problem">${escapeHtml(problem)}</div>` : ''}
    <div class="meta">${escapeHtml(formatDate(event.start))} · ${age} day${age === 1 ? '' : 's'} old</div>
  </a></li>`;
}

// Outstanding only — complete jobs are deliberately absent. The point of the
// page is the list of things still to do.
async function collect(opts = {}) {
  const { items, from, scanned, skipped } = await woColour.scan(opts);
  const outstanding = items
    .filter(i => i.state !== 'complete')
    .sort((a, b) => String(a.event.start).localeCompare(String(b.event.start)));
  return {
    from,
    scanned,
    skipped,
    complete: items.filter(i => i.state === 'complete').length,
    stale: outstanding.filter(i => i.state === 'stale').length,
    open: outstanding.filter(i => i.state === 'open').length,
    items: outstanding,
  };
}

async function render(opts = {}) {
  const data = await collect(opts);
  const generated = new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' });

  const counts = [
    data.stale ? `<span class="pill red">${data.stale} overdue</span>` : '',
    data.open ? `<span class="pill amber">${data.open} open</span>` : '',
  ].filter(Boolean).join('');

  const body = data.items.length
    ? `<ul>\n${data.items.map(renderRow).join('\n')}\n</ul>`
    : `<div class="empty">Nothing outstanding. All work orders since ${escapeHtml(data.from)} are complete.</div>`;

  const html = `<header>
  <h1>Outstanding work orders</h1>
  <div class="sub">Maintenance calendar, from ${escapeHtml(data.from)} · tap a job to open it in Google Calendar</div>
  ${counts ? `<div class="counts">${counts}</div>` : ''}
</header>
${body}
<footer>
  Overdue = open more than ${STALE_AFTER_DAYS} days and not yet invoiced.<br>
  Close a job by adding &ldquo;Done 1hr&rdquo; to its calendar description.<br>
  Generated ${escapeHtml(generated)} · ${data.complete} complete, ${data.skipped} non-WO entries not shown.
</footer>`;

  return page('Outstanding work orders', html);
}

function renderError(message) {
  return page('Report unavailable', `<header><h1>Report unavailable</h1></header>
<div class="empty">${escapeHtml(message)}</div>`);
}

async function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--from');
  const from = i !== -1 ? args[i + 1] : undefined;
  try {
    console.log(await render({ from }));
  } catch (e) {
    console.log(renderError(e.message));
    process.exitCode = 1;
  } finally {
    const store = require('./store');
    if (store.USE_DB) await require('./db').closePool().catch(() => {});
  }
}

module.exports = { render, renderError, collect };

if (require.main === module) main();
