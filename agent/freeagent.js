#!/usr/bin/env node
// FreeAgent utility for the property agent.
// Called by the agent via the Bash tool during a session.
//
// Usage:
//   node freeagent.js create-invoice --description "122EW - blocked sink" --dated-on "2026-04-24"
//   node freeagent.js create-invoice --description "..." --dated-on "..." --notes "1 hour labour\n£30 mount" --contact "https://api.freeagent.com/v2/contacts/12345"
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

let RATES = { labour: { first_hour_gbp: 70.00, subsequent_hours_gbp: 30.00 }, default: { quantity: 1 } };
try {
  RATES = JSON.parse(fs.readFileSync('/agent/rates.json', 'utf8'));
} catch {
  // fall back to defaults if file missing
}

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN || !DEFAULT_CONTACT) {
  console.error(JSON.stringify({
    ok: false,
    error: 'FREEAGENT_CLIENT_ID, FREEAGENT_CLIENT_SECRET, FREEAGENT_REFRESH_TOKEN, and FREEAGENT_CONTACT_URL must all be set',
  }));
  process.exit(1);
}

async function getAccessToken() {
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

// Returns one or two invoice_item objects for a single line of the calendar event description.
function parseLineItem(raw) {
  let text = raw.trim();

  // Extract explicit price: £30, £30.50, £1,200
  let explicitPrice = null;
  const priceMatch = text.match(/£([\d,]+(?:\.\d{1,2})?)/);
  if (priceMatch) {
    explicitPrice = parseFloat(priceMatch[1].replace(',', ''));
    text = text.replace(priceMatch[0], '').trim();
  }

  // Hours: "1 hour labour", "2.5 hours plumbing", "2 hrs", "1.5 hr", "2h"
  const hourMatch = text.match(/^([\d.]+)\s*(?:hours?|hrs?|h)\b/i);
  if (hourMatch) {
    const hours = parseFloat(hourMatch[1]);
    const label = text.slice(hourMatch[0].length).replace(/^[\s\-–,]+/, '') || 'Labour';
    const { first_hour_gbp, subsequent_hours_gbp } = RATES.labour;

    if (hours <= 1) {
      return [{
        description: label,
        item_type:   'Hours',
        quantity:    hours,
        price:       String(explicitPrice ?? (hours * first_hour_gbp).toFixed(2)),
      }];
    }
    const subsequent = parseFloat((hours - 1).toFixed(2));
    return [
      { description: `${label} (first hour)`,       item_type: 'Hours', quantity: 1,          price: String(first_hour_gbp) },
      { description: `${label} (subsequent hours)`, item_type: 'Hours', quantity: subsequent, price: String(subsequent_hours_gbp) },
    ];
  }

  // Days: "1 day scaffolding"
  const dayMatch = text.match(/^([\d.]+)\s*days?\b/i);
  if (dayMatch) {
    const label = text.slice(dayMatch[0].length).replace(/^[\s\-–,]+/, '') || 'Labour';
    return [{
      description: label,
      item_type:   'Days',
      quantity:    parseFloat(dayMatch[1]),
      price:       String(explicitPrice ?? '0'),
    }];
  }

  // Fixed-price item: explicit £ amount, no time unit stated — default to 1 hour
  if (explicitPrice !== null) {
    return [{
      description: text || raw.trim(),
      item_type:   'Hours',
      quantity:    RATES.default?.quantity ?? 1,
      price:       String(explicitPrice),
    }];
  }

  // Description-only line: no price, no time unit — rendered as a label on the invoice
  return [{
    description: text || raw.trim(),
    item_type:   'Comment',
  }];
}

async function createInvoice({ description, notes, address, datedOn, contact }) {
  const token = await getAccessToken();

  // Resolve contact: explicit → per-property lookup/create → default
  let contactUrl = contact;
  if (!contactUrl && address) {
    const shortcode = description.match(/^([A-Z0-9]+)\s*[-–]/i)?.[1];
    if (shortcode) {
      contactUrl = await getOrCreatePropertyContact(token, shortcode, address);
    }
  }
  contactUrl = contactUrl || DEFAULT_CONTACT;

  const lines = notes
    ? notes.split('\n').map(l => l.trim()).filter(Boolean)
    : [description];

  const invoice_items = lines.flatMap(parseLineItem);

  const body = {
    invoice: {
      contact:               contactUrl,
      dated_on:              datedOn,
      payment_terms_in_days: 30,
      invoice_items,
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
      notes:       args.notes   || null,
      address:     args.address || null,
      datedOn:     args['dated-on'],
      contact:     args.contact || null,
    }).catch(e => {
      console.error(JSON.stringify({ ok: false, error: e.message }));
      process.exit(1);
    });
    break;
  }
  default:
    console.error(JSON.stringify({ ok: false, error: `Unknown command: ${cmd || '(none)'}. Usage: freeagent.js create-invoice --description TEXT --dated-on YYYY-MM-DD [--address ADDR] [--contact URL]` }));
    process.exit(1);
}
