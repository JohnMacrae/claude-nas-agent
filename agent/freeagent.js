#!/usr/bin/env node
// FreeAgent utility for the property agent.
// Called by the agent via the Bash tool during a session.
//
// Usage:
//   node freeagent.js create-invoice --description "122EW - blocked sink" --dated-on "2026-04-24"
//   node freeagent.js create-invoice --description "..." --dated-on "..." --notes "1 hour labour\n£30 mount" --contact "https://api.freeagent.com/v2/contacts/12345"
//   node freeagent.js create-invoice --description "122EW - WO001540 - blocked sink" --dated-on "2026-04-24" --comments "122 Eastwood Way, Colchester CO4 9UQ. WO001540 (urgent): no hot water."
//   node freeagent.js update-invoice --invoice-url "https://api.freeagent.com/v2/invoices/93425215" --notes "..." [--comments "..."] [--dated-on YYYY-MM-DD]
//
// If --address is supplied and no --contact, a per-property contact is looked up or created
// automatically using the shortcode from --description.
// Labour rates are read from /agent/rates.json at runtime.

const fs = require('fs');

const CLIENT_ID       = process.env.FREEAGENT_CLIENT_ID;
const CLIENT_SECRET   = process.env.FREEAGENT_CLIENT_SECRET;
const REFRESH_TOKEN   = process.env.FREEAGENT_REFRESH_TOKEN;
const DEFAULT_CONTACT = process.env.FREEAGENT_CONTACT_URL;

const BASE = 'https://api.freeagent.com/v2';
const HOUR_UNIT = '(?:hours?|hrs?|h)';

let RATES = { labour: { first_hour_gbp: 70.00, subsequent_hours_gbp: 30.00 }, default: { quantity: 1 } };
try {
  RATES = JSON.parse(fs.readFileSync('/agent/rates.json', 'utf8'));
} catch {
  // fall back to defaults if file missing
}

function requireEnv() {
  if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN || !DEFAULT_CONTACT) {
    console.error(JSON.stringify({
      ok: false,
      error: 'FREEAGENT_CLIENT_ID, FREEAGENT_CLIENT_SECRET, FREEAGENT_REFRESH_TOKEN, and FREEAGENT_CONTACT_URL must all be set',
    }));
    process.exit(1);
  }
}

async function getAccessToken() {
  if (process.env.FREEAGENT_BEARER_TOKEN) return process.env.FREEAGENT_BEARER_TOKEN;
  const params = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: REFRESH_TOKEN,
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });
  const res = await fetch(`${BASE}/token_endpoint`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    params.toString(),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`Token refresh failed: ${res.status} ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

// Parse a UK address string into FreeAgent contact fields.
// e.g. "122 Enville Way, Colchester CO4 9UQ" → { address1, town, postcode }
function parseUKAddress(address) {
  const postcodeMatch = address.match(/\b([A-Z]{1,2}\d{1,2}[A-Z]?\s+\d[A-Z]{2})\s*$/i);
  const postcode = postcodeMatch ? postcodeMatch[1].toUpperCase() : '';
  const withoutPostcode = address.slice(0, postcodeMatch ? postcodeMatch.index : undefined)
    .replace(/,\s*$/, '').trim();
  const parts = withoutPostcode.split(',').map(s => s.trim());
  return {
    address1: parts[0] || '',
    town:     parts.slice(1).join(', ') || '',
    postcode,
  };
}

// Find a FreeAgent contact whose organisation_name matches the shortcode,
// or create one with the supplied address.
async function getOrCreatePropertyContact(token, shortcode, address) {
  const searchRes = await fetch(
    `${BASE}/contacts?search_term=${encodeURIComponent(shortcode)}`,
    { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } }
  );
  const searchData = await searchRes.json();
  const match = (searchData.contacts || []).find(c => c.organisation_name === shortcode);
  if (match) return match.url;

  const { address1, town, postcode } = parseUKAddress(address);
  const createRes = await fetch(`${BASE}/contacts`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      contact: { organisation_name: shortcode, address1, town, postcode, country: 'GBR' },
    }),
  });
  const createData = await createRes.json();
  if (!createRes.ok) {
    throw new Error(`Contact creation failed: ${createRes.status} ${JSON.stringify(createData)}`);
  }
  process.stderr.write(JSON.stringify({ info: `Created FreeAgent contact for ${shortcode}`, url: createData.contact.url }) + '\n');
  return createData.contact.url;
}

function isNoiseLine(line) {
  const t = line.trim();
  if (!t) return true;
  if (/^(complete|done|cancelled)\.?$/i.test(t)) return true;
  if (/^WO\d+:\s*.+\bStatus:\s*.+/i.test(t)) return true;
  return false;
}

function normalizeNotesLines(notesText) {
  return notesText
    .split('\n')
    .map(l => l.trim())
    .filter(l => !isNoiseLine(l));
}

function extractHours(text) {
  let m = text.match(new RegExp(`^([\\d.]+)\\s*${HOUR_UNIT}\\b\\s*(.*)$`, 'i'));
  if (m) {
    const label = m[2].replace(/^[\s\-–,]+/, '').trim();
    return { hours: parseFloat(m[1]), label: label || 'Labour' };
  }
  m = text.match(new RegExp(`^(.+?)\\s*[\\-–]\\s*([\\d.]+)\\s*${HOUR_UNIT}\\b\\s*$`, 'i'));
  if (m) {
    return { hours: parseFloat(m[2]), label: m[1].trim() || 'Labour' };
  }
  return null;
}

// Parse one notes line into a segment (labour, days, fixed price, or comment).
function parseLineSegment(raw) {
  let text = raw.trim();
  if (!text) return null;

  let explicitPrice = null;
  const priceMatch = text.match(/£([\d,]+(?:\.\d{1,2})?)/);
  if (priceMatch) {
    explicitPrice = parseFloat(priceMatch[1].replace(',', ''));
    text = text.replace(priceMatch[0], '').trim();
  }

  const hourInfo = extractHours(text);
  if (hourInfo) {
    return { kind: 'labour', ...hourInfo, explicitPrice };
  }

  const dayMatch = text.match(/^([\d.]+)\s*days?\b/i);
  if (dayMatch) {
    const label = text.slice(dayMatch[0].length).replace(/^[\s\-–,]+/, '') || 'Labour';
    return {
      kind:        'days',
      quantity:    parseFloat(dayMatch[1]),
      label,
      explicitPrice,
    };
  }

  if (explicitPrice !== null) {
    return {
      kind:        'fixed',
      description: text || raw.trim(),
      price:       explicitPrice,
    };
  }

  return { kind: 'comment', description: text || raw.trim() };
}

function makeLabourItems(labourSegments, totalHours) {
  const { first_hour_gbp, subsequent_hours_gbp } = RATES.labour;
  const labels = labourSegments.map(s => s.label).filter(Boolean);
  const desc = labels.length
    ? `Labour — ${labels.join('; ')} (${totalHours} hours total)`
    : `Labour (${totalHours} hours total)`;
  const explicit = labourSegments.find(s => s.explicitPrice != null)?.explicitPrice;

  if (totalHours <= 1) {
    return [{
      description: desc,
      item_type:   'Hours',
      quantity:    totalHours,
      price:       String(explicit ?? (totalHours * first_hour_gbp).toFixed(2)),
    }];
  }

  const subsequent = parseFloat((totalHours - 1).toFixed(2));
  return [
    { description: `${desc} (first hour)`,       item_type: 'Hours', quantity: 1,          price: String(first_hour_gbp) },
    { description: `${desc} (subsequent hours)`, item_type: 'Hours', quantity: subsequent, price: String(subsequent_hours_gbp) },
  ];
}

function buildInvoiceItems(segments) {
  const labour = segments.filter(s => s.kind === 'labour');
  const totalHours = labour.reduce((sum, s) => sum + s.hours, 0);
  const labourItems = totalHours > 0 ? makeLabourItems(labour, totalHours) : [];

  const items = [];
  let labourEmitted = false;
  for (const s of segments) {
    if (s.kind === 'labour') {
      if (!labourEmitted) {
        items.push(...labourItems);
        labourEmitted = true;
      }
      continue;
    }
    if (s.kind === 'days') {
      items.push({
        description: s.label || 'Labour',
        item_type:   'Days',
        quantity:    s.quantity,
        price:       String(s.explicitPrice ?? '0'),
      });
    } else if (s.kind === 'fixed') {
      items.push({
        description: s.description,
        item_type:   'Hours',
        quantity:    RATES.default?.quantity ?? 1,
        price:       String(s.price),
      });
    } else if (s.kind === 'comment') {
      items.push({ description: s.description, item_type: 'Comment' });
    }
  }

  return items;
}

function notesToInvoiceItems(notes, fallbackDescription) {
  const lines = notes
    ? normalizeNotesLines(notes)
    : [fallbackDescription];
  const segments = lines.map(parseLineSegment).filter(Boolean);
  const invoice_items = buildInvoiceItems(segments);

  if (!invoice_items.some(i => i.item_type !== 'Comment')) {
    invoice_items.unshift({
      description: 'Minimum charge (1 hour)',
      item_type:   'Hours',
      quantity:    1,
      price:       String(RATES.labour.first_hour_gbp),
    });
  }

  return invoice_items;
}

async function createInvoice({ description, notes, address, datedOn, contact, comments }) {
  requireEnv();
  const token = await getAccessToken();

  let contactUrl = contact;
  if (!contactUrl && address) {
    const shortcode = description.match(/^([A-Z0-9]+)\s*[-–]/i)?.[1];
    if (shortcode) {
      contactUrl = await getOrCreatePropertyContact(token, shortcode, address);
    }
  }
  contactUrl = contactUrl || DEFAULT_CONTACT;

  const invoice_items = notesToInvoiceItems(notes, description);

  const body = {
    invoice: {
      contact:               contactUrl,
      dated_on:              datedOn,
      payment_terms_in_days: 30,
      invoice_items,
      ...(comments ? { comments } : {}),
    },
  };

  const res = await fetch(`${BASE}/invoices`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Invoice creation failed: ${res.status} ${JSON.stringify(data)}`);
  }

  const invoiceUrl = data.invoice?.url || data.url;
  console.log(JSON.stringify({ ok: true, invoice_url: invoiceUrl }));
}

async function updateInvoice({ invoiceUrl, notes, description, comments, datedOn }) {
  requireEnv();
  const token = await getAccessToken();
  const id = invoiceUrl.split('/').pop();

  const getRes = await fetch(`${BASE}/invoices/${id}?nested_invoice_items=true`, {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
  });
  const getData = await getRes.json();
  if (!getRes.ok) {
    throw new Error(`Invoice fetch failed: ${getRes.status} ${JSON.stringify(getData)}`);
  }

  const existing = getData.invoice;
  const newItems = notesToInvoiceItems(notes, description || existing.reference);
  const destroyedItems = (existing.invoice_items || [])
    .map(i => {
      const itemId = i.id ?? i.url?.split('/').pop();
      return itemId ? { id: Number(itemId), _destroy: 1 } : null;
    })
    .filter(Boolean);

  const body = {
    invoice: {
      contact:               existing.contact,
      dated_on:              datedOn || existing.dated_on,
      payment_terms_in_days: existing.payment_terms_in_days ?? 30,
      invoice_items:         [...destroyedItems, ...newItems],
      ...(comments !== undefined ? { comments } : { comments: existing.comments }),
    },
  };

  const res = await fetch(`${BASE}/invoices/${id}`, {
    method:  'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Invoice update failed: ${res.status} ${JSON.stringify(data)}`);
  }

  const inv = data.invoice;
  console.log(JSON.stringify({
    ok:          true,
    invoice_url: inv.url,
    reference:   inv.reference,
    net_value:   inv.net_value,
    comments:    inv.comments,
    items:       (inv.invoice_items || []).map(i => ({
      description: i.description,
      item_type:   i.item_type,
      quantity:    i.quantity,
      price:       i.price,
    })),
  }));
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      args[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return args;
}

if (require.main !== module) {
  module.exports = {
    isNoiseLine,
    normalizeNotesLines,
    extractHours,
    parseLineSegment,
    buildInvoiceItems,
    notesToInvoiceItems,
  };
} else {
requireEnv();

const [, , cmd, ...rest] = process.argv;

switch (cmd) {
  case 'create-invoice': {
    const args = parseArgs(rest);
    if (!args.description || !args['dated-on']) {
      console.error(JSON.stringify({ ok: false, error: 'create-invoice requires --description and --dated-on' }));
      process.exit(1);
    }
    createInvoice({
      description: args.description,
      notes:       args.notes    || null,
      address:     args.address  || null,
      datedOn:     args['dated-on'],
      contact:     args.contact  || null,
      comments:    args.comments || null,
    }).catch(e => {
      console.error(JSON.stringify({ ok: false, error: e.message }));
      process.exit(1);
    });
    break;
  }
  case 'update-invoice': {
    const args = parseArgs(rest);
    if (!args['invoice-url'] || !args.notes) {
      console.error(JSON.stringify({ ok: false, error: 'update-invoice requires --invoice-url and --notes' }));
      process.exit(1);
    }
    updateInvoice({
      invoiceUrl:  args['invoice-url'],
      notes:       args.notes,
      description: args.description || null,
      comments:    args.comments !== undefined ? args.comments : undefined,
      datedOn:     args['dated-on'] || null,
    }).catch(e => {
      console.error(JSON.stringify({ ok: false, error: e.message }));
      process.exit(1);
    });
    break;
  }
  case 'parse-notes': {
    const args = parseArgs(rest);
    if (!args.notes) {
      console.error(JSON.stringify({ ok: false, error: 'parse-notes requires --notes' }));
      process.exit(1);
    }
    const items = notesToInvoiceItems(args.notes, args.description || 'Labour');
    const net = items.reduce((sum, i) => {
      if (i.item_type === 'Comment') return sum;
      return sum + parseFloat(i.quantity) * parseFloat(i.price);
    }, 0);
    console.log(JSON.stringify({ ok: true, net_value: net.toFixed(2), invoice_items: items }, null, 2));
    break;
  }
  default:
    console.error(JSON.stringify({ ok: false, error: `Unknown command: ${cmd || '(none)'}. Usage: freeagent.js create-invoice | update-invoice | parse-notes` }));
    process.exit(1);
}
}
