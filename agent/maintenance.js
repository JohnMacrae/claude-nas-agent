#!/usr/bin/env node
// Property maintenance CLI, backed by the property-docs Postgres database.
// Bash-callable by Claude sessions. Always prints a single JSON object to
// stdout and exits non-zero with a JSON error on failure.
//
//   node maintenance.js upcoming [--days 30] [--property 59BC]
//   node maintenance.js add --name "..." --category plumbing --priority high [--property 59BC] [--notes ...] [--frequency-days N] [--next-due ISO]
//   node maintenance.js log --task-id UUID --notes "..." [--performed-by contractor] [--cost 0] [--next-action "..."] [--completed-at ISO]
//   node maintenance.js search --q "boiler" [--property 59BC]

const crypto = require('crypto');

let db;
try {
  // Reuse the shared Postgres pool helper if it lives alongside this file.
  db = require('./db');
} catch (e) {
  // Fallback: minimal standalone pg Pool.
  const { Pool } = require('pg');
  const DATABASE_URL = process.env.DATABASE_URL || '';
  let pool = null;
  db = {
    isConfigured: () => !!DATABASE_URL,
    query: async (text, params) => {
      if (!DATABASE_URL) throw new Error('DATABASE_URL is not set');
      if (!pool) {
        pool = new Pool({ connectionString: DATABASE_URL, max: 5 });
        pool.on('error', (err) => console.error(`maintenance: idle client error: ${err.message}`));
      }
      return pool.query(text, params);
    },
    closePool: async () => {
      if (pool) {
        await pool.end();
        pool = null;
      }
    },
  };
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS property_maintenance_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    property_shortcode TEXT,
    name TEXT NOT NULL,
    category TEXT,
    frequency_days INTEGER,
    last_completed TIMESTAMPTZ,
    next_due TIMESTAMPTZ,
    priority TEXT DEFAULT 'medium',
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
  );

  CREATE TABLE IF NOT EXISTS property_maintenance_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID REFERENCES property_maintenance_tasks(id) ON DELETE CASCADE NOT NULL,
    completed_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    performed_by TEXT,
    cost NUMERIC(10, 2),
    notes TEXT,
    next_action TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_property_maintenance_tasks_property_next_due
    ON property_maintenance_tasks(property_shortcode, next_due);
  CREATE INDEX IF NOT EXISTS idx_property_maintenance_logs_task_completed
    ON property_maintenance_logs(task_id, completed_at DESC);
`;

let schemaEnsured = false;
async function ensureSchema() {
  if (schemaEnsured) return;
  await db.query(SCHEMA_SQL);
  schemaEnsured = true;
}

function uuid() {
  return crypto.randomUUID();
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

async function cmdUpcoming(args) {
  const days = args.days != null ? Number(args.days) : 30;
  if (!Number.isFinite(days)) throw new Error('--days must be a number');
  const property = args.property || null;

  const params = [days];
  let sql = `
    SELECT * FROM property_maintenance_tasks
    WHERE next_due IS NOT NULL
      AND next_due <= now() + ($1::int * interval '1 day')
  `;
  if (property) {
    params.push(property);
    sql += ` AND property_shortcode = $${params.length}`;
  }
  sql += ` ORDER BY next_due ASC`;

  const { rows } = await db.query(sql, params);
  const now = Date.now();
  const tasks = rows.map((r) => {
    const nextDue = r.next_due ? new Date(r.next_due) : null;
    return {
      ...r,
      overdue: nextDue ? nextDue.getTime() < now : false,
      days_until_due: nextDue ? Math.ceil((nextDue.getTime() - now) / 86400000) : null,
    };
  });

  return {
    ok: true,
    days_ahead: days,
    count: tasks.length,
    overdue_count: tasks.filter((t) => t.overdue).length,
    tasks,
  };
}

async function cmdAdd(args) {
  if (!args.name || args.name === true) throw new Error('--name is required');

  const id = uuid();
  const frequencyDays = args['frequency-days'] != null && args['frequency-days'] !== true
    ? Number(args['frequency-days'])
    : null;
  if (args['frequency-days'] != null && !Number.isFinite(frequencyDays)) {
    throw new Error('--frequency-days must be a number');
  }

  const { rows } = await db.query(
    `INSERT INTO property_maintenance_tasks
       (id, property_shortcode, name, category, frequency_days, next_due, priority, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      id,
      args.property || null,
      args.name,
      args.category || null,
      frequencyDays,
      args['next-due'] || null,
      args.priority || 'medium',
      args.notes || null,
    ]
  );

  return { ok: true, task: rows[0] };
}

async function cmdLog(args) {
  const taskId = args['task-id'];
  if (!taskId || taskId === true) throw new Error('--task-id is required');

  const completedAt = args['completed-at'] && args['completed-at'] !== true
    ? args['completed-at']
    : new Date().toISOString();
  const cost = args.cost != null && args.cost !== true ? Number(args.cost) : null;
  if (args.cost != null && !Number.isFinite(cost)) throw new Error('--cost must be a number');

  const logId = uuid();
  const { rows: logRows } = await db.query(
    `INSERT INTO property_maintenance_logs
       (id, task_id, completed_at, performed_by, cost, notes, next_action)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      logId,
      taskId,
      completedAt,
      args['performed-by'] || null,
      cost,
      args.notes || null,
      args['next-action'] || null,
    ]
  );
  const log = logRows[0];

  const { rows: taskRows } = await db.query(
    `SELECT * FROM property_maintenance_tasks WHERE id = $1`,
    [taskId]
  );
  if (!taskRows.length) throw new Error(`task not found: ${taskId}`);
  let task = taskRows[0];

  // A DB trigger (if present) may have already updated last_completed/next_due
  // as a side effect of the log insert. Only patch it here if that didn't happen.
  const triggerApplied =
    task.last_completed &&
    new Date(task.last_completed).getTime() === new Date(completedAt).getTime();

  if (!triggerApplied) {
    const nextDue = task.frequency_days
      ? new Date(new Date(completedAt).getTime() + task.frequency_days * 86400000).toISOString()
      : null;
    const { rows: updated } = await db.query(
      `UPDATE property_maintenance_tasks
       SET last_completed = $2, next_due = $3, updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [taskId, completedAt, nextDue]
    );
    task = updated[0];
  }

  return { ok: true, log, task };
}

async function cmdSearch(args) {
  const q = args.q && args.q !== true ? args.q : null;
  if (!q) throw new Error('--q is required');
  const property = args.property || null;
  const like = `%${q}%`;

  const taskParams = [like];
  let taskSql = `
    SELECT * FROM property_maintenance_tasks
    WHERE (name ILIKE $1 OR category ILIKE $1 OR notes ILIKE $1)
  `;
  if (property) {
    taskParams.push(property);
    taskSql += ` AND property_shortcode = $${taskParams.length}`;
  }
  taskSql += ` ORDER BY next_due ASC NULLS LAST, created_at DESC`;
  const { rows: tasks } = await db.query(taskSql, taskParams);

  const logParams = [like];
  let logSql = `
    SELECT l.*, t.name AS task_name, t.property_shortcode, t.category
    FROM property_maintenance_logs l
    JOIN property_maintenance_tasks t ON t.id = l.task_id
    WHERE (l.notes ILIKE $1 OR l.next_action ILIKE $1)
  `;
  if (property) {
    logParams.push(property);
    logSql += ` AND t.property_shortcode = $${logParams.length}`;
  }
  logSql += ` ORDER BY l.completed_at DESC`;
  const { rows: logs } = await db.query(logSql, logParams);

  return {
    ok: true,
    query: q,
    tasks_count: tasks.length,
    logs_count: logs.length,
    tasks,
    logs,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));

  if (!db.isConfigured()) {
    throw new Error('DATABASE_URL is not set');
  }
  await ensureSchema();

  switch (cmd) {
    case 'upcoming':
      return cmdUpcoming(args);
    case 'add':
      return cmdAdd(args);
    case 'log':
      return cmdLog(args);
    case 'search':
      return cmdSearch(args);
    default:
      throw new Error('Usage: maintenance.js <upcoming|add|log|search> [options]');
  }
}

main()
  .then(async (result) => {
    console.log(JSON.stringify(result, null, 2));
    await db.closePool();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(JSON.stringify({ ok: false, error: err.message }));
    try {
      await db.closePool();
    } catch (_) {
      // ignore
    }
    process.exit(1);
  });
