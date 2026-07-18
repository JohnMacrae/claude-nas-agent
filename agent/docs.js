#!/usr/bin/env node
// Property documents CLI — search / list / get against property-docs Postgres.
// Uses shared db.js (pg Pool), same as store.js / maintenance.js.
//
//   node docs.js search --q "EICR damp" [--property 59BC] [--limit 10]
//   node docs.js list --property 59BC [--type eicr]
//   node docs.js get --id UUID

'use strict';

const db = require('./db');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
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

async function embedQuery(text) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return null;
  const url = process.env.OPENROUTER_URL || 'https://openrouter.ai/api/v1/embeddings';
  const model = process.env.EMBEDDING_MODEL || 'openai/text-embedding-3-small';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, input: text }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`embedding failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const vec = data?.data?.[0]?.embedding;
  if (!Array.isArray(vec)) throw new Error('embedding response missing vector');
  return vec;
}

function vectorLiteral(vec) {
  return `[${vec.join(',')}]`;
}

async function cmdSearch(args) {
  const q = args.q;
  if (!q) throw new Error('--q required');
  const limit = Math.min(parseInt(args.limit || '10', 10) || 10, 50);
  const property = args.property || null;

  let embedding = null;
  let embedError = null;
  try {
    embedding = await embedQuery(q);
  } catch (e) {
    embedError = e.message;
  }

  if (embedding) {
    const params = [vectorLiteral(embedding), limit];
    let sql = `
      SELECT d.id, d.title, d.original_filename, d.property_shortcode, d.doc_type,
             d.source, d.document_date, d.storage_path, d.created_at,
             c.chunk_index, left(c.text, 400) AS excerpt,
             (c.embedding <=> $1::vector) AS distance
      FROM document_chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE c.embedding IS NOT NULL
    `;
    if (property) {
      params.push(property);
      sql += ` AND d.property_shortcode = $${params.length}`;
    }
    sql += ` ORDER BY c.embedding <=> $1::vector ASC LIMIT $2`;
    const { rows } = await db.query(sql, params);
    if (rows.length) {
      return { ok: true, mode: 'vector', query: q, count: rows.length, results: rows };
    }
    // No embedded chunks yet — fall through to lexical
  }

  const params = [q, limit];
  let sql = `
    SELECT d.id, d.title, d.original_filename, d.property_shortcode, d.doc_type,
           d.source, d.document_date, d.storage_path, d.created_at,
           c.chunk_index, left(c.text, 400) AS excerpt,
           ts_rank(c.tsv, plainto_tsquery('english', $1)) AS rank
    FROM document_chunks c
    JOIN documents d ON d.id = c.document_id
    WHERE (
      c.tsv @@ plainto_tsquery('english', $1)
      OR c.text ILIKE '%' || $1 || '%'
      OR coalesce(d.title, '') ILIKE '%' || $1 || '%'
      OR coalesce(d.original_filename, '') ILIKE '%' || $1 || '%'
    )
  `;
  if (property) {
    params.push(property);
    sql += ` AND d.property_shortcode = $${params.length}`;
  }
  sql += ` ORDER BY rank DESC NULLS LAST, d.created_at DESC LIMIT $2`;
  const { rows } = await db.query(sql, params);
  return {
    ok: true,
    mode: 'lexical',
    query: q,
    count: rows.length,
    results: rows,
    embed_skipped: embedding
      ? 'no embedded chunks; used lexical'
      : (embedError || (!process.env.OPENROUTER_API_KEY ? 'OPENROUTER_API_KEY unset' : null)),
  };
}

async function cmdList(args) {
  const property = args.property;
  if (!property) throw new Error('--property required');
  const type = args.type || null;
  const params = [property];
  let sql = `
    SELECT id, title, original_filename, property_shortcode, doc_type, source,
           document_date, storage_path, mime, created_at, paperless_id
    FROM documents
    WHERE property_shortcode = $1
  `;
  if (type) {
    params.push(type);
    sql += ` AND doc_type = $${params.length}`;
  }
  sql += ` ORDER BY coalesce(document_date, created_at::date) DESC, created_at DESC`;
  const { rows } = await db.query(sql, params);
  return { ok: true, count: rows.length, documents: rows };
}

async function cmdGet(args) {
  const id = args.id;
  if (!id) throw new Error('--id required');
  const { rows: docs } = await db.query(
    `SELECT id, title, original_filename, property_shortcode, doc_type, source,
            document_date, storage_path, mime, sha256, paperless_id, created_at, metadata
     FROM documents WHERE id = $1`,
    [id]
  );
  if (!docs.length) throw new Error(`document not found: ${id}`);
  const { rows: chunks } = await db.query(
    `SELECT chunk_index, left(text, 2000) AS text
     FROM document_chunks WHERE document_id = $1
     ORDER BY chunk_index ASC LIMIT 20`,
    [id]
  );
  const { rows: tags } = await db.query(
    `SELECT tag FROM document_tags WHERE document_id = $1 ORDER BY tag`,
    [id]
  );
  return {
    ok: true,
    document: { ...docs[0], tags: tags.map((t) => t.tag) },
    chunks,
  };
}

async function main() {
  if (!db.isConfigured()) throw new Error('DATABASE_URL is not set');
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  let result;
  switch (cmd) {
    case 'search':
      result = await cmdSearch(args);
      break;
    case 'list':
      result = await cmdList(args);
      break;
    case 'get':
      result = await cmdGet(args);
      break;
    default:
      throw new Error('Usage: docs.js <search|list|get> [options]');
  }
  console.log(JSON.stringify(result, null, 2));
  await db.closePool();
}

main().catch(async (err) => {
  console.error(JSON.stringify({ ok: false, error: err.message }));
  try { await db.closePool(); } catch { /* ignore */ }
  process.exit(1);
});
