#!/usr/bin/env node
// Slim pending-confirm state for voice commands / ambiguous ops.
// One active pending object at a time (single-user agent).
//
//   node pending.js get
//   node pending.js set --intent complete_task --property 40WSS --question "..." [--candidates '[]']
//   node pending.js clear

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || '/data';
const PENDING_FILE = path.join(DATA_DIR, 'pending-confirm.json');
const DEFAULT_TTL_MIN = parseInt(process.env.PENDING_TTL_MINUTES || '20', 10);

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readRaw() {
  try {
    if (fs.existsSync(PENDING_FILE)) {
      return JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
    }
  } catch (e) {
    console.error(`pending: read failed: ${e.message}`);
  }
  return null;
}

function writeRaw(obj) {
  ensureDir();
  const tmp = `${PENDING_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, PENDING_FILE);
}

function getPending() {
  const p = readRaw();
  if (!p) return null;
  if (p.expires_at && Date.parse(p.expires_at) < Date.now()) {
    clearPending();
    return null;
  }
  return p;
}

function setPending({ intent, property = null, question, candidates = [], ttlMinutes = DEFAULT_TTL_MIN } = {}) {
  if (!intent) throw new Error('intent is required');
  if (!question) throw new Error('question is required');
  const now = Date.now();
  const ttl = Number.isFinite(Number(ttlMinutes)) ? Number(ttlMinutes) : DEFAULT_TTL_MIN;
  const obj = {
    id: crypto.randomUUID(),
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttl * 60_000).toISOString(),
    intent,
    property: property || null,
    candidates: Array.isArray(candidates) ? candidates : [],
    question,
  };
  writeRaw(obj);
  return obj;
}

function clearPending() {
  try {
    if (fs.existsSync(PENDING_FILE)) fs.unlinkSync(PENDING_FILE);
  } catch (e) {
    console.error(`pending: clear failed: ${e.message}`);
  }
  return { ok: true, cleared: true };
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

async function cli() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  let result;
  switch (cmd) {
    case 'get': {
      const pending = getPending();
      result = { ok: true, pending };
      break;
    }
    case 'set': {
      let candidates = [];
      if (args.candidates && args.candidates !== true) {
        candidates = JSON.parse(args.candidates);
      }
      const pending = setPending({
        intent: args.intent,
        property: args.property !== true ? args.property : null,
        question: args.question,
        candidates,
        ttlMinutes: args.ttl != null && args.ttl !== true ? args.ttl : DEFAULT_TTL_MIN,
      });
      result = { ok: true, pending };
      break;
    }
    case 'clear': {
      result = clearPending();
      break;
    }
    default:
      throw new Error('Usage: pending.js get|set|clear');
  }
  console.log(JSON.stringify(result));
}

module.exports = { getPending, setPending, clearPending, PENDING_FILE };

if (require.main === module) {
  cli().catch((e) => {
    console.error(JSON.stringify({ ok: false, error: e.message }));
    process.exit(1);
  });
}
