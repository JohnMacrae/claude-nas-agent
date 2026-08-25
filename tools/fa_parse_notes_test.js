#!/usr/bin/env node
// Dry-run parser for calendar description → invoice items.
// Usage: node tools/fa_parse_notes_test.js

const path = require('path');
const {
  normalizeNotesLines,
  notesToInvoiceItems,
} = require(path.join(__dirname, '../agent/freeagent.js'));

// Address omitted — repo is public. Boilerplate still matches isNoiseLine().
const SAMPLE = `WO001474: Evaluate and Refurbish Property as Necessary. Status: urgent. Routed from OB1 [PA] intake 2026-06-08.

complete

Replumbing various leaks - 5hr
Bathroom refit - 12hr
Damp Work - 4hr
Bathroom trim - 2hr
Finishing - 4hr`;

const lines = normalizeNotesLines(SAMPLE);
const items = notesToInvoiceItems(SAMPLE, '40WSS - WO001474');
const net = items.reduce((sum, i) => {
  if (i.item_type === 'Comment') return sum;
  return sum + parseFloat(i.quantity) * parseFloat(i.price);
}, 0);

console.log('Normalized lines:', lines);
console.log('Invoice items:', JSON.stringify(items, null, 2));
console.log('Net value:', net.toFixed(2));

const ok = net === 850 && items.filter(i => i.item_type === 'Hours').length === 2;
if (!ok) {
  console.error('FAIL: expected net 850.00 and 2 Hours line items');
  process.exit(1);
}
console.log('PASS');
