#!/usr/bin/env node
// Work-order PDF contact store — tenant name/phone from "Contact for Access".
//
//   node wo.js scan
//   node wo.js lookup --property 24HC
//   node wo.js list
//
// PDFs: WORK_ORDERS_DIR (default /output/work_orders)
// Cache: DATA_DIR/tenant-contacts.json (latest WO per shortcode wins)

const fs = require('fs');
const path = require('path');
const { PDFParse } = require('pdf-parse');

const DATA_DIR = process.env.DATA_DIR || '/data';
const AGENT_DIR = process.env.AGENT_DIR || path.dirname(__filename);
const WORK_ORDERS_DIR = process.env.WORK_ORDERS_DIR || '/output/work_orders';
const JJP_PATH = path.join(AGENT_DIR, 'JJP_Property_List.md');
const ALIASES_PATH = path.join(AGENT_DIR, 'property-aliases.json');
const CACHE_FILE = path.join(DATA_DIR, 'tenant-contacts.json');

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

function loadJjp() {
  const map = new Map(); // shortcode -> address
  if (!fs.existsSync(JJP_PATH)) return map;
  const text = fs.readFileSync(JJP_PATH, 'utf8');
  for (const line of text.split('\n')) {
    const m = line.match(/^\|\s*([A-Z0-9]+)\s*\|\s*([^|]+)\|/);
    if (!m) continue;
    const code = m[1].trim();
    if (code === 'Acronym') continue;
    map.set(code, m[2].trim());
  }
  return map;
}

let _aliasesCache = null;
function loadAliases() {
  if (_aliasesCache) return _aliasesCache;
  try {
    const j = JSON.parse(fs.readFileSync(ALIASES_PATH, 'utf8'));
    _aliasesCache = j.street_aliases || {};
  } catch {
    _aliasesCache = {};
  }
  return _aliasesCache;
}

function norm(s) {
  let out = String(s || '')
    .toLowerCase()
    .replace(/[''']/g, '')
    .replace(/[.,]/g, ' ');
  const aliases = loadAliases();
  for (const [alias, canonical] of Object.entries(aliases)) {
    out = out.split(alias.toLowerCase()).join(canonical.toLowerCase());
  }
  return out
    .replace(/\b(court|crt|road|rd|street|st|gardens|gdns|grove|gr|green|grn|close|cl|mews|walk|way|park|square|sq)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function houseNumber(s) {
  const m = String(s || '').match(/(\d+)/);
  return m ? m[1] : null;
}

function resolveShortcode(propertyLines, jjp) {
  const joined = propertyLines.join(' ');
  const num = houseNumber(propertyLines[0] || joined);
  const nJoined = norm(joined);
  let best = null;
  let bestScore = 0;
  for (const [code, addr] of jjp.entries()) {
    const nAddr = norm(addr);
    const addrNum = houseNumber(addr);
    if (num && addrNum && num !== addrNum) continue;
    // token overlap on significant words
    const tokens = nJoined.split(' ').filter((t) => t.length > 2 && t !== num);
    let score = 0;
    for (const t of tokens) {
      if (nAddr.includes(t)) score += 1;
    }
    if (num && addrNum === num) score += 2;
    if (score > bestScore) {
      bestScore = score;
      best = code;
    }
  }
  return bestScore >= 3 ? best : null;
}

function parseWoText(text) {
  const lines = text
    .replace(/\u00a0/g, ' ')
    .replace(/\t+/g, ' ')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const out = {
    order_number: '',
    date: '',
    property_lines: [],
    contact_name: '',
    mobile: '',
    email: '',
    contacts: [], // [{ name, mobile, email }]
  };
  let inProp = false;
  let inContact = false;
  const mobiles = []; // { name, mobile }
  const emails = []; // { name, email }

  for (const line of lines) {
    if (line.startsWith('Order Number')) {
      out.order_number = line.replace(/^Order Number\s*/i, '').trim();
    } else if (/^Date\s+\d{2}\/\d{2}\/\d{4}/.test(line)) {
      const m = line.match(/\d{2}\/\d{2}\/\d{4}/);
      if (m) out.date = m[0];
    } else if (line.startsWith('Property')) {
      inProp = true;
      inContact = false;
      const v = line.replace(/^Property\s*/i, '').trim();
      if (v) out.property_lines.push(v);
    } else if (line.startsWith('Contact for Access')) {
      inProp = false;
      inContact = true;
      out.contact_name = line.replace(/^Contact for Access\s*/i, '').trim();
    } else if (/^Works Manager/i.test(line) || /^Billing/i.test(line) || /^Problem reported/i.test(line)) {
      break;
    } else if (inProp) {
      out.property_lines.push(line);
    } else if (inContact) {
      // "Mobile: 07…" or "Mrs Jane Mobile: 07…"
      const mob = line.match(/^(.*?)Mobile:\s*([\d+\s]+)\s*$/i);
      if (mob) {
        mobiles.push({
          name: (mob[1] || '').trim() || out.contact_name,
          mobile: mob[2].replace(/\s+/g, ''),
        });
        continue;
      }
      const em = line.match(/^(.*?)\s+(\S+@\S+)\s*$/);
      if (em && /@/.test(line)) {
        emails.push({ name: em[1].trim(), email: em[2].trim() });
        continue;
      }
      if (/^Mobile:\s*/i.test(line)) {
        mobiles.push({
          name: out.contact_name,
          mobile: line.replace(/^Mobile:\s*/i, '').replace(/\s+/g, ''),
        });
      }
    }
  }

  // Merge mobiles + emails by name where possible
  const byName = new Map();
  for (const m of mobiles) {
    const key = m.name || out.contact_name || 'tenant';
    byName.set(key, { name: key, mobile: m.mobile, email: null });
  }
  for (const e of emails) {
    const key = e.name || out.contact_name || 'tenant';
    if (byName.has(key)) byName.get(key).email = e.email;
    else byName.set(key, { name: key, mobile: null, email: e.email });
  }
  out.contacts = [...byName.values()];
  if (mobiles.length) {
    out.mobile = mobiles[0].mobile;
    if (!out.contact_name) out.contact_name = mobiles[0].name;
  }
  if (emails.length && !out.email) out.email = emails[0].email;
  return out;
}

async function parsePdfFile(filePath) {
  const buf = fs.readFileSync(filePath);
  const parser = new PDFParse({ data: buf });
  const data = await parser.getText();
  const parsed = parseWoText(data.text || '');
  parsed.source_file = path.basename(filePath);
  parsed.source_path = filePath;
  parsed.mtime = fs.statSync(filePath).mtime.toISOString();
  return parsed;
}

function readCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    }
  } catch (e) {
    console.error(`wo: cache read failed: ${e.message}`);
  }
  return { updated_at: null, by_property: {} };
}

function writeCache(cache) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, CACHE_FILE);
}

function dateKey(dmy) {
  // dd/mm/yyyy → sortable yyyymmdd
  const m = String(dmy || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return '00000000';
  return `${m[3]}${m[2]}${m[1]}`;
}

async function scan() {
  const jjp = loadJjp();
  if (!fs.existsSync(WORK_ORDERS_DIR)) {
    return { ok: false, error: `WORK_ORDERS_DIR missing: ${WORK_ORDERS_DIR}` };
  }
  const files = fs.readdirSync(WORK_ORDERS_DIR).filter((f) => f.toLowerCase().endsWith('.pdf'));
  const cache = readCache();
  const scanned = [];
  const errors = [];

  for (const file of files) {
    const full = path.join(WORK_ORDERS_DIR, file);
    try {
      const parsed = await parsePdfFile(full);
      const shortcode = resolveShortcode(parsed.property_lines, jjp);
      const record = {
        property: shortcode,
        order_number: parsed.order_number,
        date: parsed.date,
        address_lines: parsed.property_lines,
        tenant_name: parsed.contact_name,
        mobile: parsed.mobile,
        email: parsed.email || null,
        contacts: parsed.contacts || [],
        source_file: parsed.source_file,
        mtime: parsed.mtime,
        scanned_at: new Date().toISOString(),
      };
      scanned.push(record);
      if (!shortcode || !(record.tenant_name || record.mobile)) continue;

      const prev = cache.by_property[shortcode];
      const newer =
        !prev ||
        dateKey(record.date) > dateKey(prev.date) ||
        (dateKey(record.date) === dateKey(prev.date) && record.mtime > (prev.mtime || ''));
      if (newer) cache.by_property[shortcode] = record;
    } catch (e) {
      errors.push({ file, error: e.message });
    }
  }

  cache.updated_at = new Date().toISOString();
  writeCache(cache);
  return {
    ok: true,
    scanned: scanned.length,
    properties: Object.keys(cache.by_property).length,
    errors,
    by_property: cache.by_property,
  };
}

function lookup(property) {
  if (!property) throw new Error('--property is required');
  const code = String(property).trim().toUpperCase();
  const cache = readCache();
  let hit = cache.by_property[code] || null;

  // Lazy: if miss, caller should run scan; still try case variants
  if (!hit) {
    for (const [k, v] of Object.entries(cache.by_property)) {
      if (k.toUpperCase() === code) {
        hit = v;
        break;
      }
    }
  }

  if (!hit) {
    return {
      ok: false,
      property: code,
      error: `No tenant contact in WO PDF store for ${code}. Run scan after placing the latest Supplier Instructed.pdf in ${WORK_ORDERS_DIR}.`,
      cache_updated_at: cache.updated_at,
    };
  }

  const contacts = hit.contacts && hit.contacts.length
    ? hit.contacts
    : [{ name: hit.tenant_name, mobile: hit.mobile, email: hit.email }];
  const speakBits = contacts
    .filter((c) => c.mobile)
    .map((c) => `${c.name}, ${c.mobile}`);
  const speakable = speakBits.length
    ? speakBits.join('. ')
    : `${hit.tenant_name || 'Tenant'}, number not on WO PDF`;

  return {
    ok: true,
    property: code,
    tenant_name: hit.tenant_name,
    mobile: hit.mobile,
    email: hit.email || null,
    contacts,
    order_number: hit.order_number,
    date: hit.date,
    address_lines: hit.address_lines,
    source_file: hit.source_file,
    speakable,
  };
}

function list() {
  const cache = readCache();
  const items = Object.values(cache.by_property).sort((a, b) =>
    String(a.property).localeCompare(String(b.property))
  );
  return { ok: true, count: items.length, updated_at: cache.updated_at, contacts: items };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  let result;
  switch (cmd) {
    case 'scan':
      result = await scan();
      break;
    case 'lookup':
      // Auto-scan if cache empty or --rescan
      if (args.rescan || !fs.existsSync(CACHE_FILE)) {
        await scan();
      }
      result = lookup(args.property);
      break;
    case 'list':
      result = list();
      break;
    default:
      throw new Error('Usage: wo.js scan|lookup|list');
  }
  console.log(JSON.stringify(result));
}

module.exports = { scan, lookup, list, parseWoText, resolveShortcode, loadJjp, norm, houseNumber };

if (require.main === module) {
  main().catch((e) => {
    console.error(JSON.stringify({ ok: false, error: e.message }));
    process.exit(1);
  });
}
