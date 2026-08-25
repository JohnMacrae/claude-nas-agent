#!/usr/bin/env node
// Key/lockbox lookup by shortcode, backed by the "Key book" CSV export.
//
//   node keys.js match [--dry-run]   — one-time/occasional: fill in the
//                                       Shortcode column, flag anything
//                                       that doesn't match confidently
//   node keys.js lookup --property 48BC
//   node keys.js list
//
// KEY_BOOK_DIR (default /property_details) is globbed for the newest file
// matching /^key book.*\.csv$/i — the filename is timestamped and will
// change on a future re-export, so it is never hardcoded.
//
// Runtime lookup() does a trivial exact match on the Shortcode column —
// all the fuzzy address matching happens once, offline, in match(), so a
// live voice query never risks a wrong guess.

const fs = require('fs');
const path = require('path');
const wo = require('./wo');

const KEY_BOOK_DIR = process.env.KEY_BOOK_DIR || '/property_details';
const HEADER = ['Property', 'Shortcode', 'Keycode', 'Lockbox'];

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; }
      else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

function findKeyBookFile() {
  if (!fs.existsSync(KEY_BOOK_DIR)) return null;
  const candidates = fs.readdirSync(KEY_BOOK_DIR)
    .filter((f) => /^key book.*\.csv$/i.test(f))
    .map((f) => {
      const full = path.join(KEY_BOOK_DIR, f);
      return { full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return candidates.length ? candidates[0].full : null;
}

// Minimal quoted-CSV line parser — handles embedded commas inside quoted
// fields and doubled "" as an escaped quote. No multi-line quoted fields
// (not present in this data).
function parseCsvLine(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { cur += c; }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      fields.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  fields.push(cur);
  return fields;
}

function csvField(value) {
  const s = String(value == null ? '' : value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!lines.length) return { header: [], rows: [] };
  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  const rows = lines.slice(1).map((line) => {
    const fields = parseCsvLine(line);
    const row = {};
    header.forEach((h, i) => { row[h] = (fields[i] || '').trim(); });
    return row;
  });
  return { header, rows };
}

function writeCsv(filePath, rows) {
  const lines = [HEADER.join(',')];
  for (const row of rows) {
    lines.push(HEADER.map((h) => csvField(row[h])).join(','));
  }
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${lines.join('\n')}\n`);
  fs.renameSync(tmp, filePath);
}

function loadKeyBook() {
  const file = findKeyBookFile();
  if (!file) return { ok: false, error: `No "Key book*.csv" found in ${KEY_BOOK_DIR}`, file: null, rows: [] };
  const text = fs.readFileSync(file, 'utf8');
  const { rows } = parseCsv(text);
  return { ok: true, file, rows };
}

// Score `address` against every JJP entry, same token-overlap + house-number
// gate as wo.js's resolveShortcode, but also reports ties so match() can
// flag ambiguous rows instead of silently picking the first one found.
function scoreAll(address, jjp) {
  const num = wo.houseNumber(address);
  const nAddr = wo.norm(address);
  const tokens = nAddr.split(' ').filter((t) => t.length > 2 && t !== num);
  const scored = [];
  for (const [code, jjpAddr] of jjp.entries()) {
    const nJjp = wo.norm(jjpAddr);
    const jjpNum = wo.houseNumber(jjpAddr);
    if (num && jjpNum && num !== jjpNum) continue;
    let score = 0;
    for (const t of tokens) if (nJjp.includes(t)) score++;
    if (num && jjpNum === num) score += 2;
    if (score > 0) scored.push({ code, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

function match(opts = {}) {
  const dryRun = !!opts.dryRun;
  const book = loadKeyBook();
  if (!book.ok) return book;
  const jjp = wo.loadJjp();

  const matched = [];
  const flagged = [];
  const alreadySet = [];

  for (const row of book.rows) {
    if (row.Shortcode) {
      alreadySet.push(row);
      continue;
    }
    const scored = scoreAll(row.Property, jjp);
    const best = scored[0];
    if (!best || best.score < 3) {
      flagged.push({ ...row, reason: 'no_match' });
      continue;
    }
    const tied = scored.filter((s) => s.score === best.score);
    if (tied.length > 1) {
      flagged.push({ ...row, reason: 'ambiguous', candidates: tied.map((t) => t.code) });
      continue;
    }
    matched.push({ ...row, Shortcode: best.code });
  }

  if (!dryRun) {
    const allRows = [...alreadySet, ...matched, ...flagged];
    writeCsv(book.file, allRows);
  }

  return {
    ok: true,
    dryRun,
    file: book.file,
    alreadySet: alreadySet.length,
    matched: matched.map((m) => ({ property: m.Property, shortcode: m.Shortcode, keycode: m.Keycode })),
    flagged: flagged.map((f) => ({
      property: f.Property,
      keycode: f.Keycode,
      reason: f.reason,
      candidates: f.candidates || null,
    })),
  };
}

function lookup(shortcode) {
  if (!shortcode) throw new Error('--property is required');
  const code = String(shortcode).trim().toUpperCase();
  const book = loadKeyBook();
  if (!book.ok) return book;

  const rows = book.rows.filter((r) => (r.Shortcode || '').toUpperCase() === code);
  if (!rows.length) {
    return {
      ok: false,
      property: code,
      error: `No key on file for ${code}. Check the Key book has a matching Shortcode row (run "keys.js match" after updating it).`,
    };
  }

  // A single Keycode field can itself hold multiple comma-separated codes
  // (e.g. "B053, 57") as well as multiple rows sharing one shortcode.
  const keycodes = rows
    .flatMap((r) => String(r.Keycode || '').split(','))
    .map((k) => k.trim())
    .filter(Boolean);
  const lockbox = rows.map((r) => r.Lockbox).find(Boolean) || null;

  const keyLabel = keycodes.length > 1 ? `Keys ${keycodes.join(', ')}` : `Key ${keycodes[0] || 'unknown'}`;
  const speakable = lockbox ? `${keyLabel}, lockbox ${lockbox}` : keyLabel;

  return { ok: true, property: code, keycodes, lockbox, speakable };
}

function list() {
  const book = loadKeyBook();
  if (!book.ok) return book;
  return { ok: true, count: book.rows.length, file: book.file, rows: book.rows };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  let result;
  switch (cmd) {
    case 'match':
      result = match({ dryRun: !!args['dry-run'] });
      break;
    case 'lookup':
      result = lookup(args.property);
      break;
    case 'list':
      result = list();
      break;
    default:
      throw new Error('Usage: keys.js match [--dry-run] | lookup --property X | list');
  }
  console.log(JSON.stringify(result, null, 2));
}

module.exports = { loadKeyBook, match, lookup, list, parseCsvLine, scoreAll };

if (require.main === module) {
  main().catch((e) => {
    console.error(JSON.stringify({ ok: false, error: e.message }));
    process.exit(1);
  });
}
