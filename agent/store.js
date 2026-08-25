#!/usr/bin/env node
// Property agent store — Postgres-backed when DATABASE_URL is set, otherwise
// falls back to the local JSON files under DATA_DIR (with a stderr warning).
// Usable as a library (require) or CLI:
//   node store.js list-inbox [--all]
//   node store.js complete --id <id> --actioned "..."
//   node store.js note --text "..." [--property X] [--type Y]
//   node store.js invoice-mark --event-id <id> [--acronym X] [--hours N]
//   node store.js invoice-mark-draft --event-id <id> --invoice-url URL [--reference R] [--net N] [--acronym X] [--hours N]
//   node store.js invoice-mark-sent --event-id <id>
//   node store.js invoice-check --event-id <id>
//   node store.js list-drafts [--hours 24]
//   node store.js list-replies
//   node store.js mark-replies --ids id1,id2
//   node store.js add-inbox --property --type --status --note --date --order-number --source
//
// All exported functions are async (return Promises) regardless of backend,
// so callers (scheduler.js, this file's own CLI) must await them.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const DATA_DIR = process.env.DATA_DIR || '/data';

const FILES = {
  inbox: path.join(DATA_DIR, 'inbox.json'),
  notes: path.join(DATA_DIR, 'actions.json'), // filename kept for backwards compatibility
  invoices: path.join(DATA_DIR, 'invoices.json'),
  telegramReplies: path.join(DATA_DIR, 'telegram-replies.json'),
};

const USE_DB = db.isConfigured();

if (!USE_DB) {
  console.error(
    `store: DATABASE_URL not set — falling back to local JSON store at ${DATA_DIR}. ` +
    `This is only safe for local testing; set DATABASE_URL to use Postgres.`
  );
}

function uuid() {
  return crypto.randomUUID();
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// JSON fallback (file-based, synchronous under the hood, exposed as async)
// ---------------------------------------------------------------------------

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`store: failed to read ${file}: ${e.message}`);
  }
  return fallback;
}

function writeJson(file, data) {
  ensureDir();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

const jsonStore = {
  async listInbox({ includeClosed = false } = {}) {
    const items = readJson(FILES.inbox, []);
    if (includeClosed) return items;
    return items.filter(i => i.status !== 'closed' && !i.completed_at);
  },

  async addInboxItem(item) {
    const items = readJson(FILES.inbox, []);
    const orderNumber = item.order_number || null;
    if (orderNumber != null) {
      const existing = items.find(i => i.order_number === orderNumber);
      if (existing) return { ...existing, duplicate: true };
    }
    const record = {
      id: item.id || uuid(),
      property: item.property,
      type: item.type || 'maintenance',
      status: item.status || 'open',
      note: item.note || '',
      date: item.date || todayStr(),
      order_number: orderNumber,
      source: item.source || 'manual',
      created_at: item.created_at || new Date().toISOString(),
      completed_at: null,
      actioned: null,
      priority: item.priority || null,
      problem: item.problem || null,
      description: item.description || null,
      address: item.address || null,
    };
    items.push(record);
    writeJson(FILES.inbox, items);
    return record;
  },

  async inboxByOrder(orderNumber) {
    const items = readJson(FILES.inbox, []);
    return items.find(i => i.order_number === orderNumber) || null;
  },

  async completeInboxItem(id, actioned) {
    const items = readJson(FILES.inbox, []);
    const idx = items.findIndex(i => i.id === id);
    if (idx === -1) return null;
    items[idx] = {
      ...items[idx],
      status: 'closed',
      completed_at: new Date().toISOString(),
      actioned: actioned || items[idx].actioned || '',
    };
    writeJson(FILES.inbox, items);
    return items[idx];
  },

  async addNote(text, meta = {}) {
    const notes = readJson(FILES.notes, []);
    const record = {
      id: uuid(),
      property: meta.property || null,
      type: meta.type || null,
      text,
      created_at: new Date().toISOString(),
    };
    notes.push(record);
    writeJson(FILES.notes, notes);
    return record;
  },

  async invoiceCheck(eventId) {
    const invoices = readJson(FILES.invoices, []);
    return invoices.find(i => i.event_id === eventId) || null;
  },

  async invoiceMark(eventId, extra = {}) {
    return jsonStore.invoiceMarkDraft(eventId, extra);
  },

  async invoiceMarkDraft(eventId, extra = {}) {
    const invoices = readJson(FILES.invoices, []);
    const existing = invoices.find(i => i.event_id === eventId);
    if (existing) return { ...existing, duplicate: true };
    const now = new Date().toISOString();
    const record = {
      event_id: eventId,
      acronym: extra.acronym ?? null,
      hours: extra.hours ?? null,
      invoice_url: extra.invoice_url ?? null,
      reference: extra.reference ?? null,
      status: 'draft',
      drafted_at: now,
      sent_at: null,
      net_value: extra.net_value != null ? Number(extra.net_value) : null,
      invoiced_at: now,
      wo_number: extra.wo_number ?? null,
    };
    invoices.push(record);
    writeJson(FILES.invoices, invoices);
    return record;
  },

  async invoiceCheckByWo(woNumber) {
    if (!woNumber) return null;
    const invoices = readJson(FILES.invoices, []);
    return invoices.find(i => i.wo_number === woNumber && i.status !== 'voided') || null;
  },

  async invoiceMarkSent(eventId) {
    const invoices = readJson(FILES.invoices, []);
    const idx = invoices.findIndex(i => i.event_id === eventId);
    if (idx === -1) return null;
    const now = new Date().toISOString();
    invoices[idx] = {
      ...invoices[idx],
      status: 'sent',
      sent_at: now,
    };
    writeJson(FILES.invoices, invoices);
    return invoices[idx];
  },

  async listDraftsOlderThan(hours = 24) {
    const cutoff = Date.now() - Number(hours) * 3600_000;
    const invoices = readJson(FILES.invoices, []);
    return invoices.filter(i => {
      if ((i.status || 'draft') !== 'draft') return false;
      if (!i.invoice_url) return false;
      const t = new Date(i.drafted_at || i.invoiced_at || 0).getTime();
      return t && t <= cutoff;
    });
  },

  async invoiceUpdate(eventId, fields = {}) {
    const invoices = readJson(FILES.invoices, []);
    const idx = invoices.findIndex(i => i.event_id === eventId);
    if (idx === -1) return null;
    invoices[idx] = { ...invoices[idx], ...fields };
    writeJson(FILES.invoices, invoices);
    return invoices[idx];
  },

  async listPendingReplies() {
    const replies = readJson(FILES.telegramReplies, []);
    return replies.filter(r => !r.processed);
  },

  async addTelegramReply(reply) {
    const replies = readJson(FILES.telegramReplies, []);
    const messageId = reply.message_id ?? null;
    if (messageId != null) {
      const existing = replies.find(r => r.message_id === messageId);
      if (existing) return { ...existing, duplicate: true };
    }
    const record = {
      id: reply.id || uuid(),
      text: reply.text || '',
      message_id: messageId,
      received_at: reply.received_at || new Date().toISOString(),
      processed: false,
      processed_at: null,
    };
    replies.push(record);
    writeJson(FILES.telegramReplies, replies);
    return record;
  },

  async markRepliesProcessed(ids) {
    const idSet = new Set(ids);
    const replies = readJson(FILES.telegramReplies, []);
    let count = 0;
    for (const r of replies) {
      if (idSet.has(r.id) && !r.processed) {
        r.processed = true;
        r.processed_at = new Date().toISOString();
        count++;
      }
    }
    writeJson(FILES.telegramReplies, replies);
    return count;
  },
};

// ---------------------------------------------------------------------------
// Postgres backend
// ---------------------------------------------------------------------------

const pgStore = {
  async listInbox({ includeClosed = false } = {}) {
    const where = includeClosed ? '' : `WHERE status <> 'closed' AND completed_at IS NULL`;
    const { rows } = await db.query(`SELECT * FROM inbox_items ${where} ORDER BY created_at ASC`);
    return rows;
  },

  async addInboxItem(item) {
    const id = item.id || uuid();
    const orderNumber = item.order_number || null;
    const { rows } = await db.query(
      `INSERT INTO inbox_items (id, property, type, status, note, date, order_number, source, created_at,
                               priority, problem, description, address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::timestamptz, now()), $10, $11, $12, $13)
       ON CONFLICT (order_number) DO NOTHING
       RETURNING *`,
      [
        id,
        item.property,
        item.type || 'maintenance',
        item.status || 'open',
        item.note || '',
        item.date || todayStr(),
        orderNumber,
        item.source || 'manual',
        item.created_at || null,
        item.priority || null,
        item.problem || null,
        item.description || null,
        item.address || null,
      ]
    );
    if (rows.length) return rows[0];

    // Conflict on order_number (only reachable when orderNumber is non-null,
    // since NULLs never conflict on a UNIQUE constraint) — race-safe:
    // report the row that won the race rather than erroring.
    const existing = await db.query(`SELECT * FROM inbox_items WHERE order_number = $1`, [orderNumber]);
    if (existing.rows.length) return { ...existing.rows[0], duplicate: true };
    throw new Error(`addInboxItem: conflict on order_number ${orderNumber} but no matching row found`);
  },

  async inboxByOrder(orderNumber) {
    const { rows } = await db.query(
      `SELECT * FROM inbox_items WHERE order_number = $1`,
      [orderNumber]
    );
    return rows[0] || null;
  },

  async completeInboxItem(id, actioned) {
    const { rows } = await db.query(
      `UPDATE inbox_items
       SET status = 'closed', completed_at = now(), actioned = COALESCE($2, actioned, '')
       WHERE id = $1
       RETURNING *`,
      [id, actioned || null]
    );
    return rows[0] || null;
  },

  async addNote(text, meta = {}) {
    const { rows } = await db.query(
      `INSERT INTO notes (id, property, type, text, created_at)
       VALUES ($1, $2, $3, $4, now())
       RETURNING *`,
      [uuid(), meta.property || null, meta.type || null, text]
    );
    return rows[0];
  },

  async ensureInvoicesSchema() {
    return ensureInvoicesSchema();
  },

  async invoiceCheck(eventId) {
    await ensureInvoicesSchema();
    const { rows } = await db.query(`SELECT * FROM invoices WHERE event_id = $1`, [eventId]);
    return rows[0] || null;
  },

  async invoiceMark(eventId, extra = {}) {
    return pgStore.invoiceMarkDraft(eventId, extra);
  },

  async invoiceMarkDraft(eventId, extra = {}) {
    await ensureInvoicesSchema();
    const { rows } = await db.query(
      `INSERT INTO invoices (
         event_id, acronym, hours, invoice_url, reference, status,
         drafted_at, sent_at, net_value, invoiced_at, wo_number
       ) VALUES ($1, $2, $3, $4, $5, 'draft', now(), NULL, $6, now(), $7)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING *`,
      [
        eventId,
        extra.acronym ?? null,
        extra.hours ?? null,
        extra.invoice_url ?? null,
        extra.reference ?? null,
        extra.net_value != null ? Number(extra.net_value) : null,
        extra.wo_number ?? null,
      ]
    );
    if (rows.length) return rows[0];

    const existing = await db.query(`SELECT * FROM invoices WHERE event_id = $1`, [eventId]);
    if (existing.rows.length) return { ...existing.rows[0], duplicate: true };
    throw new Error(`invoiceMarkDraft: conflict on event_id ${eventId} but no matching row found`);
  },

  async invoiceCheckByWo(woNumber) {
    if (!woNumber) return null;
    await ensureInvoicesSchema();
    const { rows } = await db.query(
      `SELECT * FROM invoices WHERE wo_number = $1 AND status <> 'voided' ORDER BY drafted_at ASC LIMIT 1`,
      [woNumber]
    );
    return rows[0] || null;
  },

  async invoiceMarkSent(eventId) {
    await ensureInvoicesSchema();
    const { rows } = await db.query(
      `UPDATE invoices
       SET status = 'sent', sent_at = now()
       WHERE event_id = $1
       RETURNING *`,
      [eventId]
    );
    return rows[0] || null;
  },

  async listDraftsOlderThan(hours = 24) {
    await ensureInvoicesSchema();
    const { rows } = await db.query(
      `SELECT * FROM invoices
       WHERE COALESCE(status, 'draft') = 'draft'
         AND invoice_url IS NOT NULL
         AND COALESCE(drafted_at, invoiced_at) <= now() - ($1::text || ' hours')::interval
       ORDER BY COALESCE(drafted_at, invoiced_at) ASC`,
      [String(Number(hours))]
    );
    return rows;
  },

  async invoiceUpdate(eventId, fields = {}) {
    await ensureInvoicesSchema();
    const { rows } = await db.query(
      `UPDATE invoices SET
         invoice_url = COALESCE($2, invoice_url),
         reference = COALESCE($3, reference),
         status = COALESCE($4, status),
         net_value = COALESCE($5, net_value),
         hours = COALESCE($6, hours),
         acronym = COALESCE($7, acronym),
         drafted_at = COALESCE($8::timestamptz, drafted_at),
         sent_at = COALESCE($9::timestamptz, sent_at)
       WHERE event_id = $1
       RETURNING *`,
      [
        eventId,
        fields.invoice_url ?? null,
        fields.reference ?? null,
        fields.status ?? null,
        fields.net_value != null ? Number(fields.net_value) : null,
        fields.hours != null ? Number(fields.hours) : null,
        fields.acronym ?? null,
        fields.drafted_at ?? null,
        fields.sent_at ?? null,
      ]
    );
    return rows[0] || null;
  },

  async listPendingReplies() {
    const { rows } = await db.query(
      `SELECT * FROM telegram_replies WHERE processed = false ORDER BY received_at ASC`
    );
    return rows;
  },

  async addTelegramReply(reply) {
    const id = reply.id || uuid();
    const messageId = reply.message_id ?? null;
    const { rows } = await db.query(
      `INSERT INTO telegram_replies (id, message_id, text, received_at)
       VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()))
       ON CONFLICT (message_id) DO NOTHING
       RETURNING *`,
      [id, messageId, reply.text || '', reply.received_at || null]
    );
    if (rows.length) return rows[0];

    const existing = await db.query(`SELECT * FROM telegram_replies WHERE message_id = $1`, [messageId]);
    if (existing.rows.length) return { ...existing.rows[0], duplicate: true };
    throw new Error(`addTelegramReply: conflict on message_id ${messageId} but no matching row found`);
  },

  async markRepliesProcessed(ids) {
    if (!ids.length) return 0;
    const { rowCount } = await db.query(
      `UPDATE telegram_replies
       SET processed = true, processed_at = now()
       WHERE id = ANY($1::uuid[]) AND processed = false`,
      [ids]
    );
    return rowCount;
  },
};

let invoicesSchemaReady = false;

async function ensureInvoicesSchema() {
  if (!USE_DB || invoicesSchemaReady) return;
  await db.query(`
    ALTER TABLE invoices ADD COLUMN IF NOT EXISTS invoice_url text;
    ALTER TABLE invoices ADD COLUMN IF NOT EXISTS reference text;
    ALTER TABLE invoices ADD COLUMN IF NOT EXISTS status text;
    ALTER TABLE invoices ADD COLUMN IF NOT EXISTS drafted_at timestamptz;
    ALTER TABLE invoices ADD COLUMN IF NOT EXISTS sent_at timestamptz;
    ALTER TABLE invoices ADD COLUMN IF NOT EXISTS net_value numeric;
    ALTER TABLE invoices ADD COLUMN IF NOT EXISTS wo_number text;
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_invoices_wo_number ON invoices (wo_number)`);
  await db.query(`
    UPDATE invoices
    SET status = COALESCE(NULLIF(status, ''), 'draft'),
        drafted_at = COALESCE(drafted_at, invoiced_at, now())
    WHERE status IS NULL OR status = '' OR drafted_at IS NULL
  `);
  invoicesSchemaReady = true;
}

const backend = USE_DB ? pgStore : jsonStore;

// ---------------------------------------------------------------------------
// Public API (async — always returns Promises)
// ---------------------------------------------------------------------------

function listInbox(opts) {
  return backend.listInbox(opts);
}
function addInboxItem(item) {
  return backend.addInboxItem(item);
}
function inboxByOrder(orderNumber) {
  return backend.inboxByOrder(orderNumber);
}
function completeInboxItem(id, actioned) {
  return backend.completeInboxItem(id, actioned);
}
function addNote(text, meta) {
  return backend.addNote(text, meta);
}
function invoiceCheck(eventId) {
  return backend.invoiceCheck(eventId);
}
function invoiceMark(eventId, extra) {
  return backend.invoiceMark(eventId, extra);
}
function invoiceMarkDraft(eventId, extra) {
  return backend.invoiceMarkDraft(eventId, extra);
}
function invoiceCheckByWo(woNumber) {
  return backend.invoiceCheckByWo(woNumber);
}
function invoiceMarkSent(eventId) {
  return backend.invoiceMarkSent(eventId);
}
function listDraftsOlderThan(hours) {
  return backend.listDraftsOlderThan(hours);
}
function invoiceUpdate(eventId, fields) {
  return backend.invoiceUpdate(eventId, fields);
}
function listPendingReplies() {
  return backend.listPendingReplies();
}
function addTelegramReply(reply) {
  return backend.addTelegramReply(reply);
}
function markRepliesProcessed(ids) {
  return backend.markRepliesProcessed(ids);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

// AggregateError (e.g. ECONNREFUSED trying both ::1 and 127.0.0.1 for
// "localhost") has an empty top-level .message; pull something useful from
// .errors/.code so the CLI never emits {"ok":false,"error":""}.
function formatError(e) {
  if (e && e.message) return e.message;
  if (e && Array.isArray(e.errors) && e.errors.length) {
    return e.errors.map(sub => sub.message || sub.code).filter(Boolean).join('; ') || String(e);
  }
  if (e && e.code) return e.code;
  return String(e);
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

  try {
    switch (cmd) {
      case 'list-inbox': {
        const items = await listInbox({ includeClosed: !!args.all });
        console.log(JSON.stringify({ ok: true, items }, null, 2));
        break;
      }
      case 'complete': {
        if (!args.id) throw new Error('--id required');
        const item = await completeInboxItem(args.id, args.actioned || '');
        if (!item) throw new Error(`inbox item not found: ${args.id}`);
        console.log(JSON.stringify({ ok: true, item }));
        break;
      }
      case 'note': {
        if (!args.text) throw new Error('--text required');
        const record = await addNote(args.text, { property: args.property, type: args.type });
        console.log(JSON.stringify({ ok: true, record }));
        break;
      }
      case 'invoice-mark': {
        if (!args['event-id']) throw new Error('--event-id required');
        const record = await invoiceMarkDraft(args['event-id'], {
          acronym: args.acronym || null,
          hours: args.hours != null ? Number(args.hours) : null,
          invoice_url: args['invoice-url'] || null,
          reference: args.reference || null,
          net_value: args.net != null ? Number(args.net) : null,
        });
        console.log(JSON.stringify({ ok: true, record }));
        break;
      }
      case 'invoice-mark-sent': {
        if (!args['event-id']) throw new Error('--event-id required');
        const record = await invoiceMarkSent(args['event-id']);
        if (!record) throw new Error(`invoice not found: ${args['event-id']}`);
        console.log(JSON.stringify({ ok: true, record }));
        break;
      }
      case 'invoice-check': {
        if (!args['event-id']) throw new Error('--event-id required');
        const record = await invoiceCheck(args['event-id']);
        console.log(JSON.stringify({ ok: true, invoiced: !!record, record }));
        break;
      }
      case 'list-drafts': {
        const hours = args.hours != null ? Number(args.hours) : 24;
        const records = await listDraftsOlderThan(hours);
        console.log(JSON.stringify({ ok: true, hours, records }, null, 2));
        break;
      }
      case 'list-replies': {
        console.log(JSON.stringify({ ok: true, replies: await listPendingReplies() }, null, 2));
        break;
      }
      case 'mark-replies': {
        const ids = (args.ids || '').split(',').map(s => s.trim()).filter(Boolean);
        if (!ids.length) throw new Error('--ids required (comma-separated)');
        const count = await markRepliesProcessed(ids);
        console.log(JSON.stringify({ ok: true, marked: count }));
        break;
      }
      case 'add-inbox': {
        // Convenience for manual testing
        const record = await addInboxItem({
          property: args.property,
          type: args.type || 'maintenance',
          status: args.status || 'open',
          note: args.note || '',
          date: args.date,
          order_number: args['order-number'] || null,
          source: args.source || 'cli',
        });
        console.log(JSON.stringify({ ok: true, record }));
        break;
      }
      default:
        console.error(`Usage: store.js <list-inbox|complete|note|invoice-mark|invoice-mark-sent|invoice-check|list-drafts|list-replies|mark-replies|add-inbox> [options]`);
        process.exitCode = 1;
    }
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: formatError(e) }));
    process.exitCode = 1;
  } finally {
    // Let the pg pool's idle connections close so the CLI process can exit
    // promptly instead of hanging on an open socket.
    await db.closePool().catch(() => {});
  }
}

module.exports = {
  DATA_DIR,
  FILES,
  USE_DB,
  listInbox,
  addInboxItem,
  inboxByOrder,
  completeInboxItem,
  addNote,
  invoiceCheck,
  invoiceCheckByWo,
  invoiceMark,
  invoiceMarkDraft,
  invoiceMarkSent,
  listDraftsOlderThan,
  invoiceUpdate,
  listPendingReplies,
  addTelegramReply,
  markRepliesProcessed,
  readJson,
  writeJson,
};

if (require.main === module) cli();
