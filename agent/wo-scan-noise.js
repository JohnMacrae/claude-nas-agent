#!/usr/bin/env node
// Persisted set of Gmail message ids already reported to Telegram as
// "other rentopia.uk PDF, not a work order" noise (wo-gmail-scan.js). The
// scan's --days window re-finds the same non-WO email on every run until it
// ages out of the search, so without this the report re-lists it every
// cycle and grows without bound. filterUnseenAndMark() returns only the
// entries not already reported, then marks all of them (seen and new) as
// reported so each one surfaces at most once, ever.

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '/data';
const SEEN_FILE = path.join(DATA_DIR, 'wo-scan-noise-seen.json');

function readIds() {
  try {
    if (fs.existsSync(SEEN_FILE)) return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')));
  } catch (e) {
    console.error(`wo-scan-noise: read failed: ${e.message}`);
  }
  return new Set();
}

function writeIds(set) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${SEEN_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify([...set]));
  fs.renameSync(tmp, SEEN_FILE);
}

function filterUnseenAndMark(entries) {
  const seen = readIds();
  const unseen = entries.filter((e) => !seen.has(e.message_id));
  for (const e of entries) seen.add(e.message_id);
  writeIds(seen);
  return unseen;
}

module.exports = { filterUnseenAndMark, SEEN_FILE };
