// Postgres pool helper for the property agent.
// Shared by store.js. Only instantiated when DATABASE_URL is set — store.js
// decides at call time whether to use this or fall back to the local JSON store.

const { Pool, types } = require('pg');

// DATE columns (OID 1082) come back from pg as JS Date objects by default,
// which then serialize to full ISO timestamps via JSON.stringify. The old
// JSON store always used plain 'YYYY-MM-DD' strings for `date`, so keep that
// shape by disabling the Date conversion for this OID.
types.setTypeParser(1082, (val) => val);

const DATABASE_URL = process.env.DATABASE_URL || '';

let pool = null;

function isConfigured() {
  return !!DATABASE_URL;
}

function getPool() {
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL is not set — cannot create Postgres pool');
  }
  if (!pool) {
    pool = new Pool({
      connectionString: DATABASE_URL,
      max: parseInt(process.env.PG_POOL_MAX || '5', 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    // Without this handler, an idle-client error (e.g. dropped connection)
    // would crash the whole process via an unhandled 'error' event.
    pool.on('error', (err) => {
      console.error(`db: idle client error: ${err.message}`);
    });
  }
  return pool;
}

async function query(text, params) {
  const p = getPool();
  return p.query(text, params);
}

// For multi-statement operations that must succeed or fail together.
// Not currently required by store.js (single-statement INSERT ... ON CONFLICT
// covers the race-safe cases) but kept available for future use.
async function withTransaction(fn) {
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback failure — original error is what matters
    }
    throw e;
  } finally {
    client.release();
  }
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = {
  DATABASE_URL,
  isConfigured,
  getPool,
  query,
  withTransaction,
  closePool,
};
